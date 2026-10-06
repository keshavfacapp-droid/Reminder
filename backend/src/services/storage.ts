import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileTypeFromFile } from 'file-type';
import sharp from 'sharp';
import type { Config } from '../config.js';
import { HttpError } from '../middleware/errors.js';

export type FileKind = 'photo' | 'video' | 'document';

export const STORAGE_DIRS = ['photos', 'videos', 'documents', 'thumbnails', 'tmp'] as const;

interface AllowedType {
  /** Canonical MIME type we store and serve (never the client-supplied one). */
  mime: string;
  /** MIME types that content sniffing may legitimately report for this extension. */
  detected: (string | undefined)[];
}

// Allow-lists keyed by lower-case extension.
const PHOTO_TYPES: Record<string, AllowedType> = {
  jpg: { mime: 'image/jpeg', detected: ['image/jpeg'] },
  jpeg: { mime: 'image/jpeg', detected: ['image/jpeg'] },
  png: { mime: 'image/png', detected: ['image/png'] },
  webp: { mime: 'image/webp', detected: ['image/webp'] },
  gif: { mime: 'image/gif', detected: ['image/gif'] },
};

const VIDEO_TYPES: Record<string, AllowedType> = {
  mp4: { mime: 'video/mp4', detected: ['video/mp4', 'video/x-m4v', 'video/quicktime'] },
  m4v: { mime: 'video/mp4', detected: ['video/mp4', 'video/x-m4v'] },
  mov: { mime: 'video/quicktime', detected: ['video/quicktime', 'video/mp4'] },
  webm: { mime: 'video/webm', detected: ['video/webm'] },
};

const CFB = 'application/x-cfb'; // legacy Office (OLE compound file)
const ZIP = 'application/zip';
const DOCUMENT_TYPES: Record<string, AllowedType> = {
  pdf: { mime: 'application/pdf', detected: ['application/pdf'] },
  doc: { mime: 'application/msword', detected: [CFB, 'application/msword'] },
  xls: { mime: 'application/vnd.ms-excel', detected: [CFB, 'application/vnd.ms-excel'] },
  ppt: { mime: 'application/vnd.ms-powerpoint', detected: [CFB, 'application/vnd.ms-powerpoint'] },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    detected: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    detected: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    detected: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ZIP],
  },
  zip: { mime: 'application/zip', detected: [ZIP] },
  txt: { mime: 'text/plain; charset=utf-8', detected: [undefined] },
};

const ALLOWED: Record<FileKind, Record<string, AllowedType>> = {
  photo: PHOTO_TYPES,
  video: VIDEO_TYPES,
  document: DOCUMENT_TYPES,
};

export const ALLOWED_EXTENSIONS: Record<FileKind, string[]> = {
  photo: Object.keys(PHOTO_TYPES),
  video: Object.keys(VIDEO_TYPES),
  document: Object.keys(DOCUMENT_TYPES),
};

/**
 * Produces a display-only file name: no path components, no control or
 * reserved characters, bounded length. It is only ever stored in the database
 * and sent in Content-Disposition — never used as a filesystem path.
 */
export function sanitizeFileName(original: string): string {
  let name = original.normalize('NFC');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*‪-‮⁦-⁩]/g, '');
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').replace(/\s+/g, ' ');
  if (name.length > 150) {
    const ext = path.extname(name).slice(0, 10);
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name || 'file';
}

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

async function looksLikeUtf8Text(filePath: string): Promise<boolean> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const chunk = buf.subarray(0, bytesRead);
    if (chunk.includes(0)) return false;
    try {
      // Allow a multi-byte character to be cut at the 64 KiB boundary.
      new TextDecoder('utf-8', { fatal: true }).decode(bytesRead === buf.length ? chunk.subarray(0, -4) : chunk);
      return true;
    } catch {
      return false;
    }
  } finally {
    await fh.close();
  }
}

export interface StoredFile {
  filePath: string;
  displayPath: string | null;
  thumbPath: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export class StorageService {
  readonly root: string;
  readonly ffmpegAvailable: Promise<boolean>;

  constructor(private readonly config: Config) {
    this.root = config.storageDir;
    for (const dir of STORAGE_DIRS) fs.mkdirSync(path.join(this.root, dir), { recursive: true, mode: 0o700 });
    this.ffmpegAvailable = new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
  }

  get tmpDir(): string {
    return path.join(this.root, 'tmp');
  }

  maxBytes(kind: FileKind): number {
    const u = this.config.uploads;
    return kind === 'photo' ? u.maxPhotoBytes : kind === 'video' ? u.maxVideoBytes : u.maxDocumentBytes;
  }

  get maxUploadBytes(): number {
    const u = this.config.uploads;
    return Math.max(u.maxPhotoBytes, u.maxVideoBytes, u.maxDocumentBytes);
  }

  /**
   * Resolves a stored relative path to an absolute path, refusing anything
   * that escapes the storage root (defence in depth: paths are generated by
   * the server and never taken from requests).
   */
  resolve(relative: string): string {
    const abs = path.resolve(this.root, relative);
    if (!abs.startsWith(this.root + path.sep)) throw new HttpError(400, 'bad_path');
    return abs;
  }

  /** Validates a temp upload and moves it into private storage. */
  async ingest(kind: FileKind, tmpPath: string, originalName: string, size: number): Promise<StoredFile> {
    try {
      const fileName = sanitizeFileName(originalName);
      const ext = extensionOf(fileName);
      const allowed = ALLOWED[kind][ext];
      if (!allowed) throw new HttpError(415, 'unsupported_type', `.${ext || '?'} files are not allowed here.`);
      if (size <= 0) throw new HttpError(400, 'empty_file');
      if (size > this.maxBytes(kind)) throw new HttpError(413, 'file_too_large');

      const sniffed = (await fileTypeFromFile(tmpPath))?.mime;
      if (!allowed.detected.includes(sniffed)) {
        throw new HttpError(415, 'type_mismatch', 'File content does not match its type.');
      }
      if (ext === 'txt' && !(await looksLikeUtf8Text(tmpPath))) {
        throw new HttpError(415, 'type_mismatch', 'Text files must be UTF-8.');
      }

      const id = crypto.randomUUID();
      const dir = kind === 'photo' ? 'photos' : kind === 'video' ? 'videos' : 'documents';
      const filePath = `${dir}/${id}.${ext}`;
      let displayPath: string | null = null;
      let thumbPath: string | null = null;

      if (kind === 'photo') {
        ({ displayPath, thumbPath } = await this.processImage(tmpPath, id));
      }
      await fsp.rename(tmpPath, this.resolve(filePath));
      if (kind === 'video') thumbPath = await this.videoThumbnail(this.resolve(filePath), id);

      return { filePath, displayPath, thumbPath, fileName, mimeType: allowed.mime, fileSize: size };
    } finally {
      await fsp.rm(tmpPath, { force: true });
    }
  }

  private async processImage(src: string, id: string): Promise<{ displayPath: string; thumbPath: string }> {
    const displayPath = `photos/${id}.display.webp`;
    const thumbPath = `thumbnails/${id}.webp`;
    try {
      // sharp strips EXIF (including GPS) from the derived files by default.
      // The original is preserved untouched for download.
      const base = sharp(src, { limitInputPixels: 100_000_000, animated: false }).rotate();
      await base
        .clone()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(this.resolve(displayPath));
      await base
        .clone()
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 70 })
        .toFile(this.resolve(thumbPath));
    } catch {
      await this.remove(displayPath, thumbPath);
      throw new HttpError(415, 'invalid_image', 'The image could not be processed.');
    }
    return { displayPath, thumbPath };
  }

  private async videoThumbnail(videoAbs: string, id: string): Promise<string | null> {
    if (!(await this.ffmpegAvailable)) return null;
    const tmpJpg = path.join(this.tmpDir, `${id}.thumb.jpg`);
    const thumbPath = `thumbnails/${id}.webp`;
    const extract = (seek: string) =>
      new Promise<boolean>((resolve) => {
        const p = spawn(
          'ffmpeg',
          ['-nostdin', '-loglevel', 'error', '-y', '-ss', seek, '-i', videoAbs, '-frames:v', '1', '-vf', 'scale=480:-2', tmpJpg],
          { stdio: 'ignore' },
        );
        const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
        p.on('error', () => resolve(false));
        p.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code === 0 && fs.existsSync(tmpJpg));
        });
      });
    try {
      if (!(await extract('1')) && !(await extract('0'))) return null;
      await sharp(tmpJpg).webp({ quality: 70 }).toFile(this.resolve(thumbPath));
      return thumbPath;
    } catch {
      return null;
    } finally {
      await fsp.rm(tmpJpg, { force: true });
    }
  }

  async remove(...relativePaths: (string | null | undefined)[]): Promise<void> {
    for (const rel of relativePaths) {
      if (!rel) continue;
      try {
        await fsp.rm(this.resolve(rel), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** Removes abandoned temp uploads older than an hour. */
  async cleanTmp(): Promise<void> {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of await fsp.readdir(this.tmpDir)) {
      const p = path.join(this.tmpDir, name);
      try {
        if ((await fsp.stat(p)).mtimeMs < cutoff) await fsp.rm(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
