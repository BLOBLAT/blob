# BLOB on-chain programs

This directory is deliberately isolated from the website, Colyseus game
server, npm workspaces, and Free Mode. Its current source is an **unreleased
Anchor escrow foundation**, not an enabled payment product.

## Current status

- `blob-escrow` compiles and has host-side accounting/ABI regression tests.
- Its checked-in program ID is the all-zero system address on purpose. That
  placeholder is non-deployable and must stay in source control until a
  reviewed controlled deployment ceremony supplies a separate program keypair.
- No deployment, wallet transaction construction, entry, revive, or payout
  flow is enabled by this repository.
- Never add a user wallet, seed phrase, deployer keypair, treasury value,
  production mint, RPC credential, or other secret to this directory.

Read [`../docs/paid-mode.md`](../docs/paid-mode.md) before changing the
program. It defines the immutable rules and the boundary between gameplay,
the Platform API, wallet transaction orchestration, and settlement.

## Safe verification

Host-side Rust tests do not start a validator or create a keypair. From the
repository root on Windows:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP "blob-escrow-cargo-target"
& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --manifest-path programs\blob-escrow\programs\blob_escrow\Cargo.toml
Remove-Item Env:CARGO_TARGET_DIR
```

Do not substitute host `cargo clippy` for SBF validation: the pinned
Anchor/Solana macro graph is tested through Anchor's SBF build, and its native
Windows clippy path is not a supported release gate for this program.

Full Anchor/SBF validation and formatting are performed through Ubuntu WSL. The smoke
script copies source to an automatically removed temporary directory,
generates throwaway local keypairs there, starts `solana-test-validator`, and
deploys only to that validator:

```sh
cd /mnt/c/Users/user/Desktop/BLOBsite/programs/blob-escrow
npm ci --ignore-scripts
./scripts/localnet-smoke.sh
```

Run `cargo fmt --check` from the copied WSL workspace or the escrow source
before a change is committed.

The script never reads the caller's Solana configuration, persistent keypair,
or RPC endpoint. It replaces the placeholder program ID only in the copied
`Anchor.toml` declaration and `declare_id!` source declaration. It also fails
before compiling if either replacement did not occur or if known public-key
test fixtures were altered. A successful local smoke run is **not** a devnet
or mainnet deployment and does not make Paid Mode available.

The instruction run uses six generated players and a generated 6-decimal SPL
test mint. It proves platform initialization, rejection of a non-canonical
rules hash, six exact entry contributions, pre-game cancellation, exact
pull-only refunds, rejected refund replay, minimum-player start admission,
authority-attested revive purchase, exact revive-pool accounting, and the
ban on live refunds, cancellation, rebates, or settlement before the
authoritative result window. It does not use a real
wallet, native USDC, a public RPC, or a production program address. The
current run does **not** time-warp a 10-minute live match, so final
attestation, completed podium settlement, rebates, and payouts remain explicit
required localnet coverage before a controlled deployment.

## Before any controlled deployment

Do not skip these gates:

1. Extend the instruction-level localnet integration tests to cover the
   remaining time-gated live-match paths: final attestation, podium settlement,
   and non-podium participation rebates.
2. Obtain an independent security review of the exact program binary and
   deployment configuration.
3. Use separate governance, controller, result-authority, and treasury roles;
   the game server must not hold any signing key.
4. Decide the native-USDC mint, audited program ID, RPC/reconciliation
   operation, incident procedure, and legal requirements outside this
   repository.
5. Run a controlled devnet ceremony before considering any mainnet action.

The checked-in code must never be treated as authorization to collect or
custody real funds.
