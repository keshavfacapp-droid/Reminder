# Architecture

```
 Phone / desktop browser (PWA)
 ┌──────────────────────────────────────────┐
 │ React UI ── fetch (cookie + CSRF header) ─┼──┐
 │          └─ WebSocket /ws (cookie) ───────┼──┤
 │ Service worker: app-shell cache,         │  │
 │   push → showNotification("Reminder")    │  │
 └──────────────────────────────────────────┘  │ HTTPS
                                               ▼
 ┌────────────────────────── Caddy (frontend container) ─────┐
 │ static PWA files · TLS · security headers · /api, /ws → ──┼──┐
 └───────────────────────────────────────────────────────────┘  │
 ┌────────────────────────── Node.js backend ─────────────────┐ │
 │ Express routes ── requireAuth ── requireCsrf ── handlers  ◄─┼─┘
 │ ws RealtimeHub (session-authenticated, Origin-checked)     │
 │ StorageService → /data/storage/{photos,videos,documents,   │
 │                                   thumbnails}  (private)   │
 │ PushService (web-push, VAPID) ── encrypted push ──────────►│ browser vendor's push service
 └───────────────┬────────────────────────────────────────────┘
                 ▼
        PostgreSQL  (or SQLite)
```

## Request authorisation

Every private HTTP request and WebSocket upgrade goes through the same chain:

1. **Authenticated?** The `HttpOnly` session cookie is hashed (SHA-256) and
   looked up in `sessions`; idle and absolute expiry are enforced.
2. **One of the two authorised users?** The session's user must be among
   the first two rows of `users` (`UserService.authorizedIds`). An account
   inserted any other way is refused.
3. **Part of their private conversation?** There is exactly one
   conversation, so every live message belongs to it; ownership-sensitive
   actions are checked additionally: only the sender can delete a message, a
   reader can only mark the *other* person's messages as read, push
   subscriptions are bound to and removable by their own user only.
4. **CSRF:** state-changing requests need the per-session `X-CSRF-Token`
   header and a same-origin `Origin`/`Referer`.

User identity is always taken from the session — the API never accepts a
user ID from the client.

## Data model

All timestamps are epoch milliseconds (`BIGINT`) so SQLite and PostgreSQL
behave identically. Migrations are written with the Knex schema builder and
run automatically at startup.

| Table | Columns |
| --- | --- |
| `users` | id, username, password_hash (Argon2id), created_at, last_seen |
| `sessions` | id (SHA-256 of token), user_id, csrf_token, created_at, expires_at, absolute_expires_at |
| `messages` | id, sender_id, message_type (text/link/photo/video/document), text_content, file_path, display_path, thumb_path, file_name, mime_type, file_size, link_url, link_title, link_site, created_at, read_at, deleted_at |
| `push_subscriptions` | id, user_id, endpoint, endpoint_hash, public_key, auth_key, created_at |

Switch database with `DB_CLIENT=sqlite|postgres` — no code changes.

## Files

- Uploads stream to `storage/tmp/` under a random name, are validated
  (extension allow-list **and** content sniffing must agree; size limit per
  kind; UTF-8 check for `.txt`), then moved to
  `storage/<kind>/<uuid>.<ext>`. The user's file name is stored only in the
  database as a display label.
- Photos: the original is kept untouched; a ≤2048 px WebP "display" copy and
  a ≤480 px thumbnail are generated with sharp (EXIF/GPS stripped from both).
- Videos: a thumbnail frame is extracted with ffmpeg when available.
- Files are served only by `GET /api/files/:messageId/:variant` after
  authentication. Paths come from the database, never from the request.
  Responses carry `X-Content-Type-Options: nosniff`, a `sandbox` CSP and
  `Cache-Control: private, no-cache`; anything not safely viewable is forced
  to download. Range requests are supported for video seeking.
- Deleting a message removes its files from disk.

## Real-time flow

```
A: POST /api/messages ─► store ─► hub.broadcast(message:new) ─► A's and B's sockets
                               └► B not looking at the app? ─► Web Push ─► "Reminder"
B (viewing chat) ─ ws {type:"read", upToId} ─► mark read ─► broadcast(message:read) ─► A sees ✓✓
```

Clients report page visibility over the socket so that a user who is
actively looking at the conversation does not also get a notification. On
reconnect the client re-fetches the latest page to catch up.

## Notifications

`PushService.notify()` sends the constant payload `{"title":"Reminder"}`
(encrypted end-to-end to the browser per RFC 8291), with `Topic: reminder`
so several pending pushes collapse into one. The service worker never reads
the payload and always calls
`showNotification("Reminder", { tag: "reminder", renotify: true })`. Tapping
it focuses or opens the app.

Push delivery uses each browser's standard push service (that is how the
Web Push standard works; there is no way for a website to avoid it). The
service only ever sees an opaque encrypted blob.

## PWA

- `manifest.json` (standalone display, icons incl. maskable, name "Reminder").
- `service-worker.js`: caches the application shell (HTML, hashed assets,
  icons) so the app opens offline; **never caches `/api/` responses**.
- iOS meta tags for Home Screen installation.

## End-to-end encryption (roadmap)

E2EE is not implemented yet, but the design leaves room for it:

- Authentication/authorisation are independent of message content: the
  server authorises by session and message ownership, never by reading text.
- `text_content` is treated as an opaque string by the server; files are
  treated as opaque blobs except for validation/thumbnailing.

Suggested approach, using only established primitives:

1. Each device generates an X25519 key pair (Web Crypto `X25519` where
   available, otherwise libsodium.js) and an Ed25519 signing key; public keys
   are uploaded, private keys stay in IndexedDB as non-extractable keys.
2. The two users verify each other's key fingerprints once, in person.
3. Messages and files are encrypted with AES-256-GCM using keys derived via
   HKDF from an X25519 shared secret (or, better, adopt an audited protocol
   such as the Signal double ratchet via libsignal / MLS).
4. Thumbnails are generated client-side before encryption; server-side
   validation becomes size/rate limiting only, and link previews move to the
   client (or are dropped).
5. Notifications are unaffected — they already contain nothing.

Do not invent custom cryptography; use the platform Web Crypto API or an
audited library.
