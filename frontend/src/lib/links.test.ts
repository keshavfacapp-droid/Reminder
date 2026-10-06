import { describe, expect, it } from 'vitest';
import { linkify, safeHref } from './links';

describe('linkify', () => {
  it('detects http(s) links and keeps the rest as text', () => {
    expect(linkify('see https://example.com/a, ok')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'https://example.com/a', href: 'https://example.com/a' },
      { kind: 'text', value: ', ok' },
    ]);
  });

  it('never turns script URLs into links', () => {
    for (const s of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox']) {
      expect(linkify(s)).toEqual([{ kind: 'text', value: s }]);
      expect(safeHref(s)).toBeNull();
    }
  });

  it('keeps HTML as plain text', () => {
    expect(linkify('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', value: '<img src=x onerror=alert(1)>' }]);
  });
});
