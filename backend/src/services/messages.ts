import type { Db } from '../database/index.js';
import { HttpError } from '../middleware/errors.js';
import type { StorageService, StoredFile, FileKind } from './storage.js';

export type MessageType = 'text' | 'link' | 'photo' | 'video' | 'document';
export const MAX_TEXT_LENGTH = 10_000;

export interface MessageRow {
  id: number;
  sender_id: number;
  message_type: MessageType;
  text_content: string | null;
  file_path: string | null;
  display_path: string | null;
  thumb_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  link_url: string | null;
  link_title: string | null;
  link_site: string | null;
  created_at: number;
  read_at: number | null;
  deleted_at: number | null;
}

export interface MessageDto {
  id: number;
  senderId: number;
  mine: boolean;
  type: MessageType;
  text: string | null;
  file: { name: string; mime: string; size: number; thumb: boolean; display: boolean } | null;
  link: { url: string; host: string; title: string | null; site: string | null } | null;
  createdAt: number;
  readAt: number | null;
}

export function toDto(row: MessageRow, viewerId: number): MessageDto {
  let host = '';
  if (row.link_url) {
    try {
      host = new URL(row.link_url).hostname;
    } catch {
      /* stored URLs are already sanitised */
    }
  }
  return {
    id: Number(row.id),
    senderId: Number(row.sender_id),
    mine: Number(row.sender_id) === viewerId,
    type: row.message_type,
    text: row.text_content,
    file: row.file_path
      ? {
          name: row.file_name ?? 'file',
          mime: row.mime_type ?? 'application/octet-stream',
          size: Number(row.file_size ?? 0),
          thumb: Boolean(row.thumb_path),
          display: Boolean(row.display_path),
        }
      : null,
    link: row.link_url ? { url: row.link_url, host, title: row.link_title, site: row.link_site } : null,
    createdAt: Number(row.created_at),
    readAt: row.read_at === null ? null : Number(row.read_at),
  };
}

export class MessageService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  private live() {
    return this.db<MessageRow>('messages').whereNull('deleted_at');
  }

  async get(id: number): Promise<MessageRow | undefined> {
    return this.live().where({ id }).first();
  }

  async list(opts: { before?: number; limit: number }): Promise<MessageRow[]> {
    const q = this.live().orderBy('id', 'desc').limit(opts.limit);
    if (opts.before) q.where('id', '<', opts.before);
    const rows = await q;
    return rows.reverse();
  }

  async shared(type: 'photo' | 'video' | 'document' | 'link', opts: { before?: number; limit: number }): Promise<MessageRow[]> {
    const q = this.live().where({ message_type: type }).orderBy('id', 'desc').limit(opts.limit);
    if (opts.before) q.where('id', '<', opts.before);
    return q;
  }

  async createText(senderId: number, text: string, linkUrl: string | null): Promise<MessageRow> {
    const trimmed = text.trim();
    if (!trimmed) throw new HttpError(400, 'empty_message');
    if (trimmed.length > MAX_TEXT_LENGTH) throw new HttpError(413, 'message_too_long');
    return this.insert({
      sender_id: senderId,
      message_type: linkUrl ? 'link' : 'text',
      text_content: trimmed,
      link_url: linkUrl,
    });
  }

  async createFile(senderId: number, kind: FileKind, file: StoredFile, caption: string | null): Promise<MessageRow> {
    if (caption && caption.length > MAX_TEXT_LENGTH) throw new HttpError(413, 'message_too_long');
    try {
      return await this.insert({
        sender_id: senderId,
        message_type: kind,
        text_content: caption?.trim() || null,
        file_path: file.filePath,
        display_path: file.displayPath,
        thumb_path: file.thumbPath,
        file_name: file.fileName,
        mime_type: file.mimeType,
        file_size: file.fileSize,
      });
    } catch (err) {
      await this.storage.remove(file.filePath, file.displayPath, file.thumbPath);
      throw err;
    }
  }

  private async insert(values: Partial<MessageRow>): Promise<MessageRow> {
    const [row] = await this.db<MessageRow>('messages')
      .insert({ ...values, created_at: Date.now() } as MessageRow)
      .returning('*');
    return row as MessageRow;
  }

  async setLinkMetadata(id: number, title: string | null, site: string | null): Promise<MessageRow | undefined> {
    await this.live().where({ id }).update({ link_title: title, link_site: site });
    return this.get(id);
  }

  /**
   * Marks every unread message *sent by the other person* up to `upToId` as
   * read. A user can never mark their own messages as read.
   */
  async markRead(readerId: number, upToId: number): Promise<{ ids: number[]; readAt: number }> {
    const readAt = Date.now();
    const rows = await this.live()
      .whereNot({ sender_id: readerId })
      .whereNull('read_at')
      .where('id', '<=', upToId)
      .select('id');
    const ids = rows.map((r) => Number(r.id));
    if (ids.length) await this.db('messages').whereIn('id', ids).update({ read_at: readAt });
    return { ids, readAt };
  }

  /** Only the sender may delete a message. Files are removed from disk. */
  async delete(userId: number, id: number): Promise<void> {
    const row = await this.get(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (Number(row.sender_id) !== userId) throw new HttpError(403, 'forbidden');
    await this.db('messages').where({ id }).update({
      deleted_at: Date.now(),
      text_content: null,
      file_path: null,
      display_path: null,
      thumb_path: null,
      file_name: null,
      mime_type: null,
      file_size: null,
      link_url: null,
      link_title: null,
      link_site: null,
    });
    await this.storage.remove(row.file_path, row.display_path, row.thumb_path);
  }

  async unreadCount(userId: number): Promise<number> {
    const row = await this.live().whereNot({ sender_id: userId }).whereNull('read_at').count<{ c: number | string }[]>({ c: '*' }).first();
    return Number(row?.c ?? 0);
  }
}
