import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { PushService, type PushSender } from '../src/services/push.js';
import { loadConfig } from '../src/config.js';

const require = createRequire(import.meta.url);
const ece = require('http_ece') as { decrypt(buf: Buffer, params: object): Buffer };

/**
 * End-to-end check of what actually travels to the push service: build the
 * real encrypted Web Push request with the web-push library, decrypt it as
 * the browser would, and confirm the plaintext is only "Reminder".
 */
describe('Web Push wire format', () => {
  it('the encrypted payload decrypts to the fixed Reminder title only', async () => {
    const vapid = webpush.generateVAPIDKeys();
    const browserKey = crypto.createECDH('prime256v1');
    browserKey.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const subscription = {
      endpoint: 'https://push.example.org/send/abc',
      keys: { p256dh: browserKey.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
    };

    const requests: ReturnType<typeof webpush.generateRequestDetails>[] = [];
    const sender: PushSender = {
      async sendNotification(sub, payload, options) {
        requests.push(
          webpush.generateRequestDetails(sub, payload, {
            ...options,
            vapidDetails: { subject: 'mailto:test@example.org', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          }),
        );
      },
    };

    const db = Object.assign(() => ({ where: async () => [{ id: 1, endpoint: subscription.endpoint, public_key: subscription.keys.p256dh, auth_key: subscription.keys.auth }] }), {});
    const config = loadConfig({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey });
    const service = new PushService(db as never, config, sender);
    await service.notify(2);

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.headers.Topic).toBe('reminder');
    const plaintext = ece.decrypt(req.body as Buffer, { version: 'aes128gcm', privateKey: browserKey, authSecret: authSecret.toString('base64url') });
    expect(plaintext.toString('utf8')).toBe('{"title":"Reminder"}');
    // The only non-encrypted metadata are the standard push headers.
    expect(JSON.stringify(req.headers)).not.toMatch(/alpha|bravo|message|file/i);
  });
});
