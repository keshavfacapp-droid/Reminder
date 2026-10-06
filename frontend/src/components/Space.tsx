import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { syncPush } from '../lib/push';
import { Realtime } from '../lib/realtime';
import type { Message, ServerEvent } from '../lib/types';
import { Chat } from './Chat';
import { Shared } from './Shared';
import { Settings } from './Settings';

type View = 'chat' | 'shared' | 'settings';

function upsert(list: Message[], message: Message): Message[] {
  const idx = list.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = message;
    return next;
  }
  const next = [...list, message];
  next.sort((a, b) => a.id - b.id);
  return next;
}

export function Space({ onLogout, onExpired }: { onLogout: () => void; onExpired: () => void }) {
  const [view, setView] = useState<View>('chat');
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [connected, setConnected] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const realtime = useMemo(() => new Realtime(), []);
  const lastReadSent = useRef(0);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onExpired();
    },
    [onExpired],
  );

  const refresh = useCallback(async () => {
    try {
      const { messages: latest } = await api.messages();
      setMessages((prev) => {
        // Keep older pages already loaded; replace the newest window wholesale
        // so edits and deletions made while offline are reflected.
        if (!latest.length) return [];
        const minId = latest[0].id;
        return [...prev.filter((m) => m.id < minId), ...latest];
      });
      if (latest.length < 50) setHasMore(false);
      setLoaded(true);
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  useEffect(() => {
    const off = realtime.on((event: ServerEvent) => {
      switch (event.type) {
        case 'hello':
          void refresh(); // catch up on anything missed while disconnected
          break;
        case 'message:new':
        case 'message:updated':
          setMessages((prev) => upsert(prev, event.message));
          break;
        case 'message:deleted':
          setMessages((prev) => prev.filter((m) => m.id !== event.id));
          break;
        case 'message:read': {
          const ids = new Set(event.ids);
          setMessages((prev) => prev.map((m) => (ids.has(m.id) ? { ...m, readAt: event.readAt } : m)));
          break;
        }
      }
    });
    const offStatus = realtime.onStatus(setConnected);
    realtime.start();
    void refresh();
    void syncPush();
    return () => {
      off();
      offStatus();
      realtime.stop();
    };
  }, [realtime, refresh]);

  const loadOlder = useCallback(async () => {
    const oldest = messages[0]?.id;
    if (!oldest) return;
    try {
      const { messages: older } = await api.messages(oldest);
      if (older.length < 50) setHasMore(false);
      setMessages((prev) => older.reduce(upsert, prev));
    } catch (err) {
      handleError(err);
    }
  }, [messages, handleError]);

  // Mark the other person's messages as read while the chat is on screen.
  useEffect(() => {
    if (view !== 'chat') return;
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
      const latestUnread = messages.reduce((max, m) => (!m.mine && !m.readAt && m.id > max ? m.id : max), 0);
      if (!latestUnread || latestUnread <= lastReadSent.current) return;
      lastReadSent.current = latestUnread;
      if (!realtime.send({ type: 'read', upToId: latestUnread })) void api.markRead(latestUnread).catch(handleError);
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [messages, view, realtime, handleError]);

  const added = useCallback((m: Message) => setMessages((prev) => upsert(prev, m)), []);
  const removed = useCallback((id: number) => setMessages((prev) => prev.filter((m) => m.id !== id)), []);

  return (
    <div className="space">
      <header className="topbar">
        {view === 'chat' ? (
          <span className="topbar-spacer" />
        ) : (
          <button className="icon-btn" onClick={() => setView('chat')} aria-label="Back">
            ‹
          </button>
        )}
        <h1>{view === 'shared' ? 'Shared' : view === 'settings' ? 'Settings' : 'Private Space'}</h1>
        {view === 'chat' ? (
          <div className="topbar-actions">
            <button className="icon-btn" onClick={() => setView('shared')} aria-label="Shared media" title="Shared">
              ▦
            </button>
            <button className="icon-btn" onClick={() => setView('settings')} aria-label="Settings" title="Settings">
              ⋯
            </button>
          </div>
        ) : (
          <span className="topbar-spacer" />
        )}
      </header>
      {!connected && <div className="banner">Reconnecting…</div>}

      {view === 'chat' && (
        <Chat
          messages={messages}
          loaded={loaded}
          hasMore={hasMore}
          onLoadOlder={loadOlder}
          onAdded={added}
          onRemoved={removed}
          onError={handleError}
        />
      )}
      {view === 'shared' && <Shared onError={handleError} />}
      {view === 'settings' && <Settings onLogout={onLogout} />}
    </div>
  );
}
