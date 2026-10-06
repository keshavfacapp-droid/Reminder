import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { safeHref } from '../lib/links';
import type { Message, UploadKind } from '../lib/types';

interface Upload {
  key: number;
  name: string;
  progress: number;
  error?: string;
  abort: () => void;
}

const ACCEPT: Record<UploadKind | 'camera', string> = {
  camera: 'image/*',
  photo: 'image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif',
  video: 'video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm',
  document: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip',
};

const ERRORS: Record<string, string> = {
  file_too_large: 'File is too large.',
  unsupported_type: 'This file type is not supported.',
  type_mismatch: 'File content does not match its type.',
  invalid_image: 'Image could not be read.',
  rate_limited: 'Too many uploads. Wait a moment.',
  network: 'Network error.',
  aborted: 'Cancelled.',
};

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

export function Composer({ onSent, onError }: { onSent: (m: Message) => void; onError: (err: unknown) => void }) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [link, setLink] = useState('');
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingKind = useRef<UploadKind>('photo');
  const nextKey = useRef(1);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const { message } = await api.sendText(value);
      onSent(message);
      setText('');
      textarea.current?.focus();
    } catch (err) {
      onError(err);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch() && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const pick = (kind: UploadKind | 'camera') => {
    setMenu(false);
    const input = fileInput.current!;
    pendingKind.current = kind === 'camera' ? 'photo' : kind;
    input.accept = ACCEPT[kind];
    if (kind === 'camera') input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    input.multiple = kind !== 'camera';
    input.value = '';
    input.click();
  };

  const startUpload = (file: File, kind: UploadKind) => {
    const key = nextKey.current++;
    const { promise, abort } = api.upload(kind, file, (progress) =>
      setUploads((list) => list.map((u) => (u.key === key ? { ...u, progress } : u))),
    );
    setUploads((list) => [...list, { key, name: file.name, progress: 0, abort }]);
    promise
      .then((message) => {
        onSent(message);
        setUploads((list) => list.filter((u) => u.key !== key));
      })
      .catch((err) => {
        onError(err);
        const code = err instanceof ApiError ? err.code : 'network';
        setUploads((list) => list.map((u) => (u.key === key ? { ...u, error: ERRORS[code] ?? 'Upload failed.' } : u)));
      });
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    for (const file of Array.from(e.target.files ?? [])) startUpload(file, pendingKind.current);
  };

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(link.trim()) ? link.trim() : `https://${link.trim()}`;
    if (!safeHref(candidate)) return;
    try {
      const { message } = await api.sendLink(candidate);
      onSent(message);
      setLink('');
      setLinkMode(false);
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="composer-wrap">
      {uploads.length > 0 && (
        <ul className="uploads">
          {uploads.map((u) => (
            <li key={u.key}>
              <span className="upload-name">{u.name}</span>
              {u.error ? (
                <span className="error">{u.error}</span>
              ) : (
                <progress max={1} value={u.progress} aria-label="Upload progress" />
              )}
              <button
                className="link-btn"
                onClick={() => {
                  if (!u.error) u.abort();
                  setUploads((list) => list.filter((x) => x.key !== u.key));
                }}
              >
                {u.error ? 'Dismiss' : 'Cancel'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(false)} />
          <div className="attach-menu" role="menu">
            <button role="menuitem" onClick={() => pick('camera')}>
              <span aria-hidden>📷</span> Camera
            </button>
            <button role="menuitem" onClick={() => pick('photo')}>
              <span aria-hidden>🖼</span> Photo
            </button>
            <button role="menuitem" onClick={() => pick('video')}>
              <span aria-hidden>🎥</span> Video
            </button>
            <button role="menuitem" onClick={() => pick('document')}>
              <span aria-hidden>📄</span> Document
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(false);
                setLinkMode(true);
              }}
            >
              <span aria-hidden>🔗</span> Link
            </button>
          </div>
        </>
      )}

      {linkMode ? (
        <form className="composer" onSubmit={sendLink}>
          <button type="button" className="round-btn" onClick={() => setLinkMode(false)} aria-label="Cancel link">
            ×
          </button>
          <input
            className="composer-input"
            type="text"
            inputMode="url"
            enterKeyHint="send"
            placeholder="https://"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button className="round-btn send" type="submit" disabled={!link.trim()} aria-label="Send link">
            ➤
          </button>
        </form>
      ) : (
        <form className="composer" onSubmit={send}>
          <button type="button" className="round-btn" onClick={() => setMenu((v) => !v)} aria-label="Attach" aria-expanded={menu}>
            +
          </button>
          <textarea
            ref={textarea}
            className="composer-input"
            rows={1}
            placeholder="Type a message..."
            value={text}
            maxLength={10000}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={onKeyDown}
          />
          <button className="round-btn send" type="submit" disabled={!text.trim() || sending} aria-label="Send">
            ➤
          </button>
        </form>
      )}
      <input ref={fileInput} type="file" hidden onChange={onFiles} />
    </div>
  );
}
