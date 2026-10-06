import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** Returns a normalised http(s) URL, or null if the input is not a safe link. */
export function sanitizeUrl(input: string): string | null {
  if (input.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url.toString();
}

export function extractFirstUrl(text: string): string | null {
  for (const match of text.matchAll(URL_RE)) {
    const candidate = sanitizeUrl(match[0].replace(TRAILING_PUNCTUATION, ''));
    if (candidate) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSRF-safe metadata fetching
// ---------------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return !blocked.check(mapped[1], 'ipv4');
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

/** DNS lookup that refuses to connect to private / reserved addresses. */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const ok = list.find((a) => isPublicAddress(a.address));
    if (!ok || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new Error('blocked address'), '', 0);
    }
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, [ok]);
    callback(null, ok.address, ok.family);
  });
};

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5000;

function fetchHtml(urlString: string, redirectsLeft = 3): Promise<{ url: string; html: string } | null> {
  return new Promise((resolve) => {
    const url = new URL(urlString);
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      return resolve(null);
    }
    if (url.port && url.port !== '80' && url.port !== '443') return resolve(null);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      {
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; PrivateSpaceLinkPreview/1.0)',
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = sanitizeUrl(new URL(res.headers.location, url).toString());
          return resolve(next ? fetchHtml(next, redirectsLeft - 1) : null);
        }
        const type = String(res.headers['content-type'] ?? '');
        if (status !== 200 || !/text\/html|application\/xhtml/i.test(type)) {
          res.resume();
          return resolve(null);
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          chunks.push(chunk);
          if (total >= MAX_BYTES) res.destroy();
        });
        const finish = () => resolve({ url: url.toString(), html: Buffer.concat(chunks).toString('utf8') });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), m);
    if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10), m);
    return ENTITIES[lower] ?? m;
  });
}

function safeCodePoint(cp: number, fallback: string): string {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

function cleanText(s: string | undefined, max: number): string | null {
  if (!s) return null;
  // Output is plain text: strip any tags and control characters.
  const text = decodeEntities(s)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

function metaContent(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  return tag ? /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)?.slice(1).find((v) => v !== undefined) : undefined;
}

export function parseMetadata(html: string): { title: string | null; site: string | null } {
  const title = metaContent(html, 'og:title') ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const site = metaContent(html, 'og:site_name');
  return { title: cleanText(title, 300), site: cleanText(site, 200) };
}

/**
 * Fetches only the title and site name of a page. No images are fetched or
 * stored, so a link card never loads third-party content in the browser.
 */
export async function fetchLinkMetadata(url: string): Promise<{ title: string | null; site: string | null } | null> {
  const page = await fetchHtml(url);
  return page ? parseMetadata(page.html) : null;
}
