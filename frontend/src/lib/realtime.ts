import type { ServerEvent } from './types';

type Listener = (event: ServerEvent) => void;
type StatusListener = (connected: boolean) => void;

/** Same-origin WebSocket with automatic reconnect and visibility reporting. */
export class Realtime {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: number | undefined;
  private stopped = false;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.reconnectNow);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.reconnectNow);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  send(data: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(data));
    return true;
  }

  private connect = () => {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.reportVisibility();
      this.statusListeners.forEach((l) => l(true));
    };
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as ServerEvent;
        this.listeners.forEach((l) => l(event));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.statusListeners.forEach((l) => l(false));
      if (e.code === 4001) return; // logged out
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++) * (0.5 + Math.random() / 2);
      this.timer = window.setTimeout(this.connect, delay);
    };
  };

  private reconnectNow = () => {
    if (this.ws || this.stopped) return;
    window.clearTimeout(this.timer);
    this.retry = 0;
    this.connect();
  };

  private reportVisibility() {
    this.send({ type: 'visibility', visible: document.visibilityState === 'visible' });
  }

  private onVisibility = () => {
    this.reportVisibility();
    if (document.visibilityState === 'visible') this.reconnectNow();
  };
}
