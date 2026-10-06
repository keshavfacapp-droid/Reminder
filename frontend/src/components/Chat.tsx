import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatDay } from '../lib/format';
import type { Message } from '../lib/types';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { Lightbox } from './Lightbox';

interface Props {
  messages: Message[];
  loaded: boolean;
  hasMore: boolean;
  onLoadOlder: () => Promise<void>;
  onAdded: (m: Message) => void;
  onRemoved: (id: number) => void;
  onError: (err: unknown) => void;
}

export function Chat({ messages, loaded, hasMore, onLoadOlder, onAdded, onRemoved, onError }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const lastId = useRef(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [viewing, setViewing] = useState<Message | null>(null);

  // Stick to the bottom for new messages; keep position when older ones load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const newest = messages[messages.length - 1];
    if (loadingOlder.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (newest && newest.id !== lastId.current && (nearBottom.current || newest.mine)) {
      el.scrollTop = el.scrollHeight;
    }
    lastId.current = newest?.id ?? 0;
  }, [messages]);

  useEffect(() => {
    const el = scroller.current;
    if (el && loaded) el.scrollTop = el.scrollHeight;
  }, [loaded]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 80 && hasMore && !loadingOlder.current && messages.length) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      void onLoadOlder().finally(() => {
        if (prevHeight.current === el.scrollHeight) loadingOlder.current = false;
      });
    }
  };

  const remove = async (id: number) => {
    if (!window.confirm('Delete this message for both of you?')) return;
    try {
      await api.deleteMessage(id);
      onRemoved(id);
    } catch (err) {
      onError(err);
    }
    setSelected(null);
  };

  return (
    <>
      <div className="messages" ref={scroller} onScroll={onScroll} onClick={() => setSelected(null)}>
        {!loaded && <div className="muted center">Loading…</div>}
        {loaded && messages.length === 0 && <div className="muted center empty">Nothing here yet.</div>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day">{formatDay(m.createdAt)}</div>}
              <MessageBubble
                message={m}
                selected={selected === m.id}
                onSelect={(e) => {
                  e.stopPropagation();
                  if (m.mine) setSelected(selected === m.id ? null : m.id);
                }}
                onDelete={() => void remove(m.id)}
                onOpenPhoto={() => setViewing(m)}
              />
            </Fragment>
          );
        })}
      </div>
      <Composer onSent={onAdded} onError={onError} />
      {viewing && <Lightbox message={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
