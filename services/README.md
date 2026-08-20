# Services

`platform-api` is the deployable, PostgreSQL-backed boundary for optional
wallet profiles and future paid-match orchestration. It is deliberately
separate from the authoritative Colyseus process and does not sign, send, or
custody USDC.

Free Mode requires only `apps/game-server`. Do not create matchmaking,
payment, administrative, or chain-service stubs merely to simulate a feature;
their authority boundaries are documented in `../docs/architecture.md` and
`../docs/paid-mode.md`.
