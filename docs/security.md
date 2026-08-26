# Security and incident response

This document describes the protections implemented in this repository and
the operational actions that still require the Cloudflare, Vercel, and Railway
accounts. It is not a claim that a DDoS attack happened, that no future attack
is possible, or that the paid USDC system is ready to launch.

## Security boundary

- `apps/web` is a static Vercel deployment. It does not hold secrets, private
  keys, payment authority, or authoritative game logic.
- `apps/game-server` is the authoritative Colyseus process. Browser clients
  send validated input only. It owns simulation, score, rank, round state and
  chat delivery.
- `services/platform-api` is a separate PostgreSQL-backed profile and future
  settlement boundary. It owns session and ticket signing keys. It is never a
  Vite dependency or a Colyseus dependency.
- `programs/blob-escrow` is deliberately non-deployable source with a
  placeholder program ID. Paid entry, USDC transfers, and escrow must remain
  disabled until a separate independent smart-contract audit, production
  deployment ceremony, reconciliation process, legal review, and incident
  runbook are complete.

## Repository protections

### Game server

- Production requires an explicit comma-separated `BLOB_WEB_ORIGIN` allowlist;
  it has no production localhost fallback.
- Both HTTP and Colyseus matchmaking CORS reflect only an allowed browser
  origin. Direct requests do not receive wildcard CORS headers.
- WebSocket upgrades require an allowed origin, use a 4 KiB maximum payload,
  disable per-message compression, and have a bounded per-source admission
  brake. The process does not retain source IP addresses in the limiter.
- A room limits inbound client messages, shortens half-open seat reservations,
  and limits Free Mode to the single canonical arena rather than creating
  unlimited simulation rooms during a join flood.
- HTTP header, request, keep-alive, and per-socket request limits bound
  incomplete or long-lived HTTP requests. `/health` and the origin-protected
  `/presence` response are never cached; no unauthenticated metrics endpoint is
  exposed.

### Platform API

- Browser CORS accepts only `PLATFORM_WEB_ORIGIN`; requests without an Origin
  get no CORS capability. CORS is not used as authentication.
- JSON and signed internal bodies are size-bounded. Oversized data receives a
  neutral `413` response, not a stack trace.
- Wallet challenge, signature verification, and profile-ticket issuance each
  have per-subject and bounded process-wide limits. The shared window is short
  (`PLATFORM_GLOBAL_RATE_LIMIT_WINDOW_MS`, 60 seconds by default) so random
  wallet spam cannot impose a ten-minute global lockout.
- `/health` coalesces concurrent PostgreSQL probes and briefly caches the
  result, avoiding a database-query amplification endpoint.
- Sessions are opaque, secure HTTP-only cookies; only a token hash is stored.
  A wallet signs a short-lived message, never a login transaction. No wallet
  key, private key, or seed phrase belongs in the browser or repository.
- Vercel holds only variables required to build or proxy the web application.
  A game-server or Platform API signing key is never a web deployment value.
  If a service key is ever discovered in Vercel, a browser-visible build
  variable, logs, or another unauthorised scope, removing that value is not
  sufficient: rotate the affected key or key pair in its two private services
  before trusting the boundary again.

### Web client

- Vercel response headers disable framing, MIME sniffing, unnecessary browser
  capabilities, and overly broad referrer forwarding. Its CSP permits only
  same-origin resources plus BLOB and Railway HTTPS/WSS endpoints required by
  the configurable game client; it blocks object embedding and framing.

### Supply chain and regression checks

- GitHub Actions runs the complete Node typecheck, test, and production-build
  suite for every pull request and `main` push. It also fails for critical
  production dependency advisories.
- Dependabot opens weekly update proposals for npm dependencies and GitHub
  Actions. Review and test each proposal; do not use a blanket forced audit
  downgrade or upgrade as an incident response.

## Incident procedure

1. Do not call an event an attack based solely on a slow page. Capture the
   time range, affected host, browser error, and a screenshot first.
2. Inspect **Cloudflare → Security events**, **Vercel → Firewall → Traffic**,
   and Railway service metrics/logs for the same time range. Check HTTP
   4xx/5xx, request volume, network ingress, CPU, memory, restarts, and
   repeated paths before changing rules.
3. For an active Layer-7 flood of `blob.lat`, the owner may enable Cloudflare
   **Under Attack mode** as a temporary last resort. It presents visitors with
   an interstitial and can affect normal use, so turn it off after the event.
   Do not disable Vercel's automatic system mitigations.
4. Do not block broad user-agent strings, entire countries, or JA4 fingerprints
   based on a hunch. Stage any Vercel custom rule in `log` mode, review its
   real matches, then publish a narrow rate limit/challenge only after that
   review.
5. If the Railway game service is under pressure, do not expose a new direct
   Railway hostname in browser code. Create `game.blob.lat` as the Railway
   custom domain, proxy it through the intended edge configuration, verify
   `https://game.blob.lat/health`, then update the Vercel build variable and
   redeploy. Do not point it through Vercel serverless functions.
6. If any signing key, wallet session, Railway/Vercel/Cloudflare credential,
   or DNS account may be compromised: pause paid launch, revoke and rotate the
   affected credential, invalidate sessions as applicable, and preserve logs.
   For an asymmetric service boundary, rotate both the private signer and the
   matching verifier together; deleting a leaked web variable alone leaves
   old signatures trustworthy. Do not rotate by committing replacement values
   to `.env` or Git.

## Launch gate

Free Mode can run only with the production environment variables documented in
[`deployment.md`](deployment.md). A token or paid-match launch has additional
mandatory gates: an independent program audit, a non-placeholder deployed
program ID, native-USDC mint verification, separated operational keys,
multisig/governance controls, durable payment reconciliation, monitoring and
alerting, written refunds/dispute handling, and legal/compliance approval.
Until those gates are met, no one should be asked to send USDC to BLOB.
