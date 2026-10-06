import { useEffect, useState } from 'react';
import { api, fileUrl } from '../lib/api';
import type { Message } from '../lib/types';
import { DocumentCard, LinkCard } from './MessageBubble';
import { Lightbox } from './Lightbox';

type Tab = 'photo' | 'video' | 'document' | 'link';
const TABS: [Tab, string][] = [
  ['photo', 'Photos'],
  ['video', 'Videos'],
  ['document', 'Documents'],
  ['link', 'Links'],
];

export function Shared({ onError }: { onError: (err: unknown) => void }) {
  const [tab, setTab] = useState<Tab>('photo');
  const [items, setItems] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [viewing, setViewing] = useState<Message | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    api
      .shared(tab)
      .then(({ messages }) => {
        if (cancelled) return;
        setItems(messages);
        setHasMore(messages.length === 60);
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [tab, onError]);

  const more = async () => {
    const last = items?.[items.length - 1];
    if (!last) return;
    try {
      const { messages } = await api.shared(tab, last.id);
      setItems((prev) => [...(prev ?? []), ...messages]);
      setHasMore(messages.length === 60);
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="shared">
      <nav className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="shared-body">
        {items === null && <div className="muted center">Loading…</div>}
        {items?.length === 0 && <div className="muted center empty">Nothing shared yet.</div>}
        {items && items.length > 0 && tab === 'photo' && (
          <div className="grid">
            {items.map((m) => (
              <button key={m.id} className="grid-item" onClick={() => setViewing(m)} aria-label="Open photo">
                <img src={fileUrl(m.id, m.file?.thumb ? 'thumb' : 'original')} alt="Photo" loading="lazy" />
              </button>
            ))}
          </div>
        )}
        {items && items.length > 0 && tab === 'video' && (
          <div className="list">
            {items.map((m) => (
              <video
                key={m.id}
                className="video"
                controls
                playsInline
                preload="none"
                poster={m.file?.thumb ? fileUrl(m.id, 'thumb') : undefined}
                src={fileUrl(m.id, 'original')}
              />
            ))}
          </div>
        )}
        {items && items.length > 0 && tab === 'document' && (
          <div className="list">
            {items.map((m) => (
              <DocumentCard key={m.id} message={m} />
            ))}
          </div>
        )}
        {items && items.length > 0 && tab === 'link' && (
          <div className="list">{items.map((m) => m.link && <LinkCard key={m.id} link={m.link} />)}</div>
        )}
        {hasMore && (
          <button className="secondary more" onClick={() => void more()}>
            Load more
          </button>
        )}
      </div>
      {viewing && <Lightbox message={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
