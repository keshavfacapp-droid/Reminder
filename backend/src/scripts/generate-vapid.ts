/**
 * Generates a VAPID key pair for Web Push. Put the output in your .env file —
 * never commit it.
 */
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('# Add these lines to .env (keep the private key secret):');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
