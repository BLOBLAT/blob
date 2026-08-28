# BLOB referral points

## Scope and current status

The native referral program is implemented in `services/platform-api` and is
available only for a wallet-backed BLOB profile. It is intentionally separate
from Free Mode simulation, token contracts, wallet custody, Paid Mode, and
browser state.

The program currently records **BLOB Points** only. A point is an internal,
integer ledger entry; it is not $BLOB, USDC, a wallet balance, a financial
product, a redemption promise, or a gameplay advantage. Do not present points
as having future value until a separately reviewed program defines one.

Default server configuration is:

| Event | Referrer | Invited profile |
| --- | ---: | ---: |
| First qualified authoritative Free round | 100 points | 25 points |

The values are controlled only through Platform API environment variables and
are never accepted from the browser or game client.

## User flow

1. A user connects a wallet and signs BLOB's off-chain login message. This
   creates an internal user/profile; it is not a transaction.
2. The user reads the current Privacy Notice, submits an email, and confirms a
   six-digit email code. This is required to open referral membership; Free
   Mode itself remains available without an email.
3. Platform API keeps only an HMAC fingerprint of the normalized address,
   verification/consent timestamps, and the notice version. It never persists
   the raw address or code. The configured transactional-email provider sees
   the raw address only to deliver the one verification email.
4. Only then does Platform API create one opaque code for that user. The profile panel shows
   `https://blob.lat/?ref=<CODE>` and supports copying it.
5. A visitor opening that URL has the code kept only in session storage. The
   URL is immediately cleaned with `history.replaceState` so it is not kept in
   navigation history.
6. After the visitor has authenticated **and verified their own referral
   email**, the browser submits the code once to
   Platform API. PostgreSQL accepts only the first valid attribution. A user
   cannot refer themself or overwrite a prior referrer. The account must be
   inside the server-configured new-profile attribution window.
7. The user must complete a real authoritative Free Mode round while their
   signed profile identity is present. Link clicks, chat messages, client
   scores, and wallet connection never qualify a reward. The immutable result
   must meet the configured server-side food and survival thresholds.
8. When the game server finalizes that immutable round result, it sends a
   compact signed completion fact over Railway private networking. Platform API
   verifies the Ed25519 signature and time window, then records the
   qualification and two immutable point ledger entries in one serializable
   database transaction.

Every qualifying event has a deterministic idempotency key built from the
Free match, round, and internal profile ID. Database unique constraints cover
attribution, one initial qualification, source events, and ledger rows, so a
retry cannot create a second award.

## When a referral qualifies

The profile card shows the current server configuration. With the production
defaults, a referral is recorded only when all of the following are true:

1. The invited wallet signs in through an opaque referral link within seven
   days of creating its BLOB profile.
2. It is not the referrer's own profile, and that profile has not already
   consumed a referral attribution.
3. The invited player completes an authoritative Free Mode round, has eaten at
   least 20 food pellets, and has spent at least two minutes alive. These are
   server-finalized game statistics, not browser values.
4. The referrer remains below the durable limit of 10 newly qualified referrals
   in the applicable UTC day.
5. Both the referrer and invited profile have a verified referral email at the
   moment the immutable result is processed. A browser cannot bypass this
   server-side database check.

The exact thresholds are platform-api environment configuration. Failing an
activity check does not create an award or a ledger row. The browser cannot
submit a result, alter the threshold, or turn clicks into points.

## Privacy and authority

- Referral URLs contain a random opaque code, never a wallet address.
- The game server gets only the internal profile ID from an existing signed
  game-identity ticket. It never receives cookies or wallet addresses.
- Platform API, not the browser, owns code generation, attribution, totals,
  and the append-only ledger.
- The game server, not the browser, is the sole source of the qualifying
  completion fact.
- The browser reads only its own dashboard and cannot request points, set a
  total, or redeem a point.
- A disabled or misconfigured signed handoff fails closed for points while
  Free Mode remains playable.

## Email membership delivery

Referral membership is deliberately unavailable until the wallet-backed
profile accepts the current Privacy Notice and confirms a six-digit code. The
email address is normalized only in request memory, sent to the configured
delivery provider for the code, and never written to the BLOB PostgreSQL
database, game state, chat, URLs, browser storage, or logs. PostgreSQL stores
only a server-keyed HMAC fingerprint, a hash of the short-lived code, consent
version/time, expiry, and verification state.

**MANUAL DASHBOARD ACTION REQUIRED:** configure a transactional email provider
and a verified sender domain before enabling this. For the current Resend
adapter, add these three variables to Railway's `platform-api` service as one
atomic configuration change:

```sh
PLATFORM_REFERRAL_EMAIL_HMAC_SECRET_BASE64=<new-random-32-byte-base64-secret>
RESEND_API_KEY=<Resend-server-api-key>
BLOB_REFERRAL_EMAIL_FROM=BLOB <verify@blob.lat>
```

Keep the HMAC secret stable: replacing it changes email fingerprints and makes
existing verified membership records unrecognizable. Do not place any of these
values in Vercel, Vite variables, Git, screenshots, or browser code. Railway
will apply the committed migration at deployment. If one or more of the three
variables is absent, referral membership remains visibly unavailable and
points fail closed; Free Mode continues normally.

## Neon database setup

Neon is PostgreSQL-compatible; no Neon-specific browser SDK belongs in this
repository. Prisma uses the server-only `DATABASE_URL` directly.

**MANUAL DASHBOARD ACTION REQUIRED:** create a Neon project/database and copy
its pooled PostgreSQL connection string. It must include Neon TLS settings,
normally `sslmode=require`. Never put this value in Vite, a URL, Git, a
screenshot, or a committed `.env` file.

For a new Platform API database:

1. In Neon, create the database and obtain its pooled connection string.
2. In Railway's `platform-api` service, set `DATABASE_URL` to that exact
   server-only string.
3. Keep `RAILWAY_SERVICE_NAME=platform-api`. The repository-owned
   `railway.toml` runs `npm run prisma:migrate:deploy --workspace=@blob/platform-api`
   before starting the service, including the referral migration.
4. Deploy, then verify `https://api.blob.lat/health` returns HTTP 200. This
   health endpoint checks the configured PostgreSQL store.

For an existing production database, migrate/copy its data with a planned
PostgreSQL migration procedure first; do **not** replace `DATABASE_URL` until
you have a verified backup and the destination contains the existing Prisma
migration history. A database move is an infrastructure change, not a browser
deployment.

## Signing handoff configuration

Generate a dedicated random 32-byte Ed25519 key pair outside the repository.
It must be distinct from profile-ticket, chat-audit, and future paid-admission
keys.

Set only the **public base58 key** on Railway `platform-api`:

```sh
BLOB_REFERRAL_QUALIFICATION_PUBLIC_KEY_BASE58=<matching-public-key>
BLOB_REFERRAL_REFERRER_POINTS=100
BLOB_REFERRAL_REFEREE_POINTS=25
BLOB_REFERRAL_ATTRIBUTION_WINDOW_MS=604800000
BLOB_REFERRAL_MIN_FOOD_COLLECTED=20
BLOB_REFERRAL_MIN_SURVIVAL_TIME_MS=120000
BLOB_REFERRAL_MAX_QUALIFICATIONS_PER_REFERRER_PER_DAY=10
BLOB_REFERRAL_ATTRIBUTION_RATE_LIMIT=4
BLOB_REFERRAL_ATTRIBUTION_GLOBAL_RATE_LIMIT=120
```

Set only the matching **private base64 key** on Railway `blob`:

```sh
PLATFORM_REFERRAL_ORIGIN=http://platform-api.railway.internal:8080
BLOB_REFERRAL_QUALIFICATION_PRIVATE_KEY_BASE64=<matching-private-key>
```

The origin is Railway-private. It must not be a `VITE_` variable and must not
be configured as a public browser endpoint. If either side is omitted, points
are disabled rather than inferred or faked.

## Operations and future work

The user profile shows the referral link, current server-computed total,
invited count, and qualified count. There is deliberately no public referral
leaderboard and no referral activity metric presented as user demand.

Admin grants, blocks, reversals, or a future points utility require a separate
audited administrative workflow. Do not add a direct database console update,
frontend control, or display-name-based moderator power. Before any points
become redeemable, tradeable, transferable, token-related, or relevant to paid
matches, require a new product, security, legal, accounting, and abuse review.
