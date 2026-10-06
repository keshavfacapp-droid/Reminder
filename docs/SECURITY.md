# Security

## Threat model (summary)

| Asset | Threat | Main controls |
| --- | --- | --- |
| Conversation & files | Outsider on the Internet | No public registration; Argon2id passwords; rate limiting + per-user lockout; all routes authenticated; no static file directory |
| Sessions | Theft / fixation / CSRF | 256-bit random token in `HttpOnly; Secure; SameSite=Strict` `__Host-` cookie; only its SHA-256 stored; fresh session per login; idle + absolute expiry; logout & password reset revoke server-side; CSRF token + Origin check |
| Browser | XSS | React text rendering only (no `dangerouslySetInnerHTML`); http(s)-only link allow-list; strict CSP (`script-src 'self'`, no inline); files served with `nosniff` + `sandbox` CSP and download disposition for active types |
| Server | Malicious uploads | Extension allow-list + magic-byte sniffing must agree; size limits; random on-disk names; image re-encoding; ffmpeg time limit; temp cleanup |
| Server | SSRF via link previews | http/https only, ports 80/443, DNS resolved and all private/reserved ranges rejected at connect time, 5 s timeout, 256 KB cap, ≤3 redirects re-validated; only title/site name kept as plain text; can be disabled (`LINK_PREVIEWS=false`) |
| Database | SQL injection | Knex parameterised queries everywhere; zod validation of all inputs |
| Privacy | Notification leaks | Payload carries no data; service worker ignores payload; fixed title "Reminder"; no body/icon/image |
| Privacy | Shoulder-surfing / app switcher | Lock screen overlay whenever the page is hidden; no names shown in UI; `noindex`; no third-party requests |

## Notifications

The notification is always exactly the title **Reminder** with no body.

Enforced in three places, each covered by tests
(`backend/test/notifications.test.ts`, `backend/test/push-wire.test.ts`):

1. **Server** — `PUSH_PAYLOAD` is the constant `{"title":"Reminder"}`; it is
   built without any message, sender, file or link data. The test decrypts
   the real RFC 8291 request body produced by `web-push` and compares it.
2. **Service worker** — `push` handler ignores `event.data`; the test runs
   the real `service-worker.js` and feeds it hostile payloads (e.g.
   `{"title":"Keshav sent you a message","body":"…","image":"…"}`) and
   asserts the shown notification is `("Reminder", {tag, renotify})` only.
3. **Static check** — the test asserts the worker source never touches
   `event.data`, `.json()`, `.text()` or a `body:` option.

Platform note: the operating system frames every web notification with its
own metadata (app name, time, and on some desktop browsers the site's
domain). The installed app is named "Reminder" to keep that neutral. Choose a
neutral domain name if this matters to you.

## Security test matrix

Run with `npm test` (SQLite) and with `TEST_DB_CLIENT=postgres` (PostgreSQL).
Both pass in CI-equivalent runs.

| Area | Test | File |
| --- | --- | --- |
| Invalid login | unknown user vs wrong password → identical 401 | `auth.test.ts` |
| Password security | Argon2id hashes only; min length; tokens hashed at rest | `auth.test.ts` |
| Session expiration | idle expiry; absolute expiry | `auth.test.ts` |
| Logout | server-side revocation, replayed cookie rejected; requires CSRF; sockets closed | `auth.test.ts`, `realtime.test.ts` |
| Brute force | per-IP rate limit; per-username lockout | `auth.test.ts` |
| Registration | no endpoint; third user refused; injected third user not authorised | `auth.test.ts`, `authorization.test.ts` |
| Unauthorised API access | every private route → 401 without session; forged cookies | `authorization.test.ts` |
| User 1 ↔ User 2 resources | cannot delete other's message; cannot mark own as read; push subscription bound to session; client-supplied IDs ignored | `authorization.test.ts` |
| Direct file URL access | unauthenticated file → 401; no `/storage/...` route | `files.test.ts` |
| Malicious file names | traversal names, control/bidi characters, HTML in name | `files.test.ts`, `web-security.test.ts` |
| Oversized files | 413 + temp cleanup; oversized JSON/messages | `files.test.ts`, `web-security.test.ts` |
| Invalid MIME types | disallowed extensions; spoofed content; client Content-Type ignored | `files.test.ts` |
| XSS | script text returned as data; `javascript:`/`data:` links rejected; metadata stripped to text; CSP | `web-security.test.ts`, `frontend/src/lib/links.test.ts` |
| CSRF | missing/wrong token; cross-origin `Origin`/`Referer`/`null`; form-encoded bodies; cross-site WebSocket | `authorization.test.ts`, `realtime.test.ts` |
| SQL injection | login, message text, query params, WebSocket frames | `web-security.test.ts`, `realtime.test.ts` |
| Path traversal | encoded `..`, NUL, negative/decimal IDs | `files.test.ts` |
| SSRF | private/reserved address classification; loopback fetch refused | `web-security.test.ts` |
| Notifications | exactly "Reminder" (server payload, decrypted wire payload, service worker) | `notifications.test.ts`, `push-wire.test.ts` |

## Operational recommendations

- Always run behind HTTPS (the provided Caddy config does this automatically).
- Keep `.env` readable only by root (`chmod 600 .env`).
- Use long, unique passwords (a passphrase of 4+ random words).
- Keep the host and images updated: `git pull && docker compose up -d --build`.
- Back up regularly to storage you control, preferably `--encrypt`ed.
- Known limitation: data is encrypted in transit (TLS) but not at rest and
  not end-to-end; the server administrator can read it. Use full-disk
  encryption on the server; see the E2EE roadmap in ARCHITECTURE.md.
- The per-username lockout means someone who knows a username can lock that
  account for 15 minutes. That is an intentional trade-off against password
  guessing.
