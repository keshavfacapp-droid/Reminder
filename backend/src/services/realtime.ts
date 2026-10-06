import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../config.js';
import { sessionCookieName } from '../middleware/auth.js';
import type { SessionService } from './sessions.js';
import type { UserService } from './users.js';

interface Client {
  socket: WebSocket;
  userId: number;
  sessionId: string;
  visible: boolean;
  alive: boolean;
}

export type EventFactory = (viewerId: number) => unknown;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Real-time channel. Every connection is authenticated with the same session
 * cookie as HTTP requests, and the Origin is checked to prevent cross-site
 * WebSocket hijacking. Clients only ever receive events from their own
 * two-person conversation.
 */
export class RealtimeHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  private readonly clients = new Set<Client>();
  private heartbeat?: NodeJS.Timeout;
  onRead?: (userId: number, upToId: number) => void;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionService,
    private readonly users: UserService,
  ) {}

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => void this.handleUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.socket.terminate();
          continue;
        }
        c.alive = false;
        c.socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  private reject(socket: Duplex, status: number): void {
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private expectedOrigin(req: IncomingMessage): string {
    if (this.config.publicOrigin) return this.config.publicOrigin;
    const forwardedProto = this.config.trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() : '';
    const proto = forwardedProto || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
    return `${proto}://${req.headers.host}`;
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') return this.reject(socket, 403);

      const origin = req.headers.origin;
      if (!origin || origin !== this.expectedOrigin(req)) return this.reject(socket, 403);

      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[sessionCookieName(this.config)];
      const info = await this.sessions.resolve(token, await this.users.authorizedIds());
      if (!info) return this.reject(socket, 401);

      this.wss.handleUpgrade(req, socket, head, (ws) => this.register(ws, info.user.id, info.id));
    } catch {
      this.reject(socket, 403);
    }
  }

  private register(socket: WebSocket, userId: number, sessionId: string): void {
    const client: Client = { socket, userId, sessionId, visible: true, alive: true };
    this.clients.add(client);
    void this.users.touchLastSeen(userId);
    socket.on('pong', () => (client.alive = true));
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => socket.terminate());
    socket.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown; visible?: unknown; upToId?: unknown };
      if (m.type === 'visibility' && typeof m.visible === 'boolean') {
        client.visible = m.visible;
      } else if (m.type === 'read' && Number.isSafeInteger(m.upToId) && (m.upToId as number) > 0) {
        this.onRead?.(userId, m.upToId as number);
      } else if (m.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });
    socket.send(JSON.stringify({ type: 'hello' }));
  }

  /** Sends a per-viewer event to every connected device of both users. */
  broadcast(factory: EventFactory): void {
    const cache = new Map<number, string>();
    for (const c of this.clients) {
      if (c.socket.readyState !== c.socket.OPEN) continue;
      let payload = cache.get(c.userId);
      if (payload === undefined) {
        payload = JSON.stringify(factory(c.userId));
        cache.set(c.userId, payload);
      }
      c.socket.send(payload);
    }
  }

  /** True if the user is currently looking at the app on any device. */
  isActivelyViewing(userId: number): boolean {
    for (const c of this.clients) if (c.userId === userId && c.visible) return true;
    return false;
  }

  disconnectSession(sessionId: string): void {
    for (const c of this.clients) if (c.sessionId === sessionId) c.socket.close(4001, 'logged out');
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.socket.terminate();
    this.wss.close();
  }
}
