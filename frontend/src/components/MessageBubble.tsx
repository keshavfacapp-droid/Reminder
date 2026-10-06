import type { MouseEvent } from 'react';
import { fileUrl } from '../lib/api';
import { formatSize, formatTime } from '../lib/format';
import { linkify, safeHref } from '../lib/links';
import type { Message } from '../lib/types';

interface Props {
  message: Message;
  selected: boolean;
  onSelect: (e: MouseEvent) => void;
  onDelete: () => void;
  onOpenPhoto: () => void;
}

export function RichText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, i) =>
        part.kind === 'link' ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow">
            {part.value}
          </a>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </>
  );
}

export function LinkCard({ link }: { link: NonNullable<Message['link']> }) {
  const href = safeHref(link.url);
  if (!href) return null;
  return (
    <a className="link-card" href={href} target="_blank" rel="noopener noreferrer nofollow">
      {link.title && <span className="link-title">{link.title}</span>}
      <span className="link-host">{link.site ?? link.host}</span>
      <span className="link-url">{link.url}</span>
    </a>
  );
}

export function DocumentCard({ message }: { message: Message }) {
  const file = message.file!;
  return (
    <div className="doc-card">
      <div className="doc-name">
        <span aria-hidden>📄</span> <span className="doc-filename">{file.name}</span>
      </div>
      <div className="doc-size">{formatSize(file.size)}</div>
      <div className="doc-actions">
        <a href={fileUrl(message.id, 'original')} target="_blank" rel="noopener noreferrer">
          Open
        </a>
        <a href={fileUrl(message.id, 'original', true)} download={file.name}>
          Download
        </a>
      </div>
    </div>
  );
}

export function MessageBubble({ message: m, selected, onSelect, onDelete, onOpenPhoto }: Props) {
  // The text of a link message is shown, plus a card for the detected URL.
  const bare = (u: string) => u.trim().replace(/\/$/, '');
  const showText = m.text && !(m.type === 'link' && m.link && bare(m.text) === bare(m.link.url));
  return (
    <div className={`row ${m.mine ? 'mine' : 'theirs'}`}>
      <div className={`bubble ${m.type}${selected ? ' selected' : ''}`} onClick={onSelect} aria-label={m.mine ? 'You' : 'Other person'}>
        {m.type === 'photo' && m.file && (
          <button className="media-btn" onClick={(e) => (e.stopPropagation(), onOpenPhoto())} aria-label="Open photo">
            <img
              className="photo"
              src={fileUrl(m.id, m.file.thumb ? 'thumb' : 'original')}
              alt="Photo"
              loading="lazy"
              decoding="async"
            />
          </button>
        )}
        {m.type === 'video' && m.file && (
          <video
            className="video"
            controls
            playsInline
            preload="metadata"
            poster={m.file.thumb ? fileUrl(m.id, 'thumb') : undefined}
            src={fileUrl(m.id, 'original')}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {m.type === 'document' && m.file && <DocumentCard message={m} />}
        {showText && (
          <div className="text">
            <RichText text={m.text!} />
          </div>
        )}
        {m.type === 'link' && m.link && <LinkCard link={m.link} />}
        <div className="meta">
          <span>{formatTime(m.createdAt)}</span>
          {m.mine && (
            <span className={`ticks${m.readAt ? ' read' : ''}`} title={m.readAt ? 'Read' : 'Delivered'}>
              {m.readAt ? '✓✓' : '✓'}
            </span>
          )}
        </div>
      </div>
      {selected && m.mine && (
        <button className="delete-btn" onClick={(e) => (e.stopPropagation(), onDelete())}>
          Delete
        </button>
      )}
    </div>
  );
}
