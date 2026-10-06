import webpush from 'web-push';
import type { Config } from '../config.js';
import type { Db } from '../database/index.js';
import { sha256 } from './sessions.js';

/**
 * PRIVACY INVARIANT — the notification is exactly one word: "Reminder".
 *
 * The push payload carries no message data at all (no sender, text, file
 * name, link or image). The service worker ignores whatever payload arrives
 * and always displays the fixed title below with no body. Keep both in sync
 * with frontend/public/service-worker.js.
 */
export const NOTIFICATION_TITLE = 'Reminder';
export const PUSH_PAYLOAD = JSON.stringify({ title: NOTIFICATION_TITLE });

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSender {
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: webpush.RequestOptions,
  ): Promise<unknown>;
}

export class PushService {
  readonly enabled: boolean;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly sender: PushSender = webpush,
  ) {
    const { publicKey, privateKey, subject } = config.vapid;
    this.enabled = Boolean(publicKey && privateKey);
    if (this.enabled && sender === webpush) webpush.setVapidDetails(subject, publicKey!, privateKey!);
  }

  get publicKey(): string | undefined {
    return this.config.vapid.publicKey;
  }

  async subscribe(userId: number, sub: PushSubscriptionInput): Promise<void> {
    const endpointHash = sha256(sub.endpoint);
    await this.db.transaction(async (trx) => {
      // A browser endpoint belongs to whichever user subscribed it last.
      await trx('push_subscriptions').where({ endpoint_hash: endpointHash }).delete();
      await trx('push_subscriptions').insert({
        user_id: userId,
        endpoint: sub.endpoint,
        endpoint_hash: endpointHash,
        public_key: sub.keys.p256dh,
        auth_key: sub.keys.auth,
        created_at: Date.now(),
      });
    });
  }

  async unsubscribe(userId: number, endpoint: string): Promise<void> {
    // Users can only remove their own subscriptions.
    await this.db('push_subscriptions').where({ user_id: userId, endpoint_hash: sha256(endpoint) }).delete();
  }

  /** Sends the fixed "Reminder" notification to every device of a user. */
  async notify(userId: number): Promise<void> {
    if (!this.enabled) return;
    const subs = await this.db('push_subscriptions').where({ user_id: userId });
    await Promise.all(
      subs.map(async (s: { id: number; endpoint: string; public_key: string; auth_key: string }) => {
        try {
          await this.sender.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.public_key, auth: s.auth_key } },
            PUSH_PAYLOAD,
            { TTL: 24 * 60 * 60, urgency: 'normal', topic: 'reminder' },
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await this.db('push_subscriptions').where({ id: s.id }).delete();
          } else {
            console.warn('[push] delivery failed', status ?? '');
          }
        }
      }),
    );
  }
}
