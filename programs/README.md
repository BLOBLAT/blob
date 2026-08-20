# Solana programs

`blob-escrow` is the isolated Anchor program for the future paid-match
settlement boundary. It is not used by Free Mode, Vercel, Railway game-server,
or the browser build.

The source intentionally uses Solana's all-zero system address as a
non-deployable placeholder program ID. Before any devnet deployment, a
controlled deployment keypair must be created outside this repository, then
the resulting public program ID must replace the placeholder in both
`blob-escrow/Anchor.toml` and `blob-escrow/programs/blob_escrow/src/lib.rs`.
Never commit the matching private key.

The production deployment must also supply, outside source control:

- the native-Solana USDC mint;
- an audited treasury token account;
- a controller multisig for start/cancel actions;
- a distinct result-authority multisig or signing service;
- reviewed upgrade-authority policy and incident/refund runbook.

Each escrow also fixes a short funding deadline. If the match cannot start by
that deadline, anyone can switch its still-pre-game escrow into individual
refund claims; no controller key is needed to unlock those funds.

## Localnet smoke test

After installing the pinned WSL toolchain, run this only from a Linux/WSL
terminal:

```sh
cd /mnt/c/Users/user/Desktop/BLOBsite/programs/blob-escrow
bash scripts/localnet-smoke.sh
```

The script copies the program to a temporary directory, replaces the
checked-in all-zero placeholder ID there with a throwaway local key, builds
SBF, starts an ephemeral `solana-test-validator`, airdrops only local test
SOL, deploys the program, verifies it, and removes the workspace, ledger, and
all generated keypairs. It refuses to use the caller's Solana configuration
or a non-local RPC endpoint.

`blob-escrow/Cargo.lock` is intentionally committed. Solana/Agave 2.3.0's SBF
toolchain embeds Rust/Cargo 1.84, so refresh it only together with a successful
SBF/localnet smoke test; current registry releases can otherwise select
unsupported Rust 2024 or Rust 1.85 dependencies.

See `docs/paid-mode.md` for the enablement gates. No program from this folder
has been deployed to devnet or mainnet.
