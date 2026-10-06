/** Only http(s) URLs ever become clickable links. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type TextPart = { kind: 'text'; value: string } | { kind: 'link'; value: string; href: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;

/**
 * Splits text into plain-text and link parts. The result is rendered as React
 * text nodes and <a> elements — never as HTML — so message content cannot
 * inject markup.
 */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0].replace(TRAILING, '');
    const start = match.index ?? 0;
    const href = safeHref(raw);
    if (!href) continue;
    if (start > last) parts.push({ kind: 'text', value: text.slice(last, start) });
    parts.push({ kind: 'link', value: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}
