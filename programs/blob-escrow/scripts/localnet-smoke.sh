#!/usr/bin/env bash
# Builds and deploys the escrow only to an ephemeral local validator. It never
# uses the caller's Solana config, wallet, RPC endpoint, or a persistent key.
set -Eeuo pipefail

readonly SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/blob-escrow-localnet.XXXXXX")"
readonly WORKSPACE_DIR="${TEMP_ROOT}/workspace"
readonly LEDGER_DIR="${TEMP_ROOT}/ledger"
readonly CONFIG_FILE="${TEMP_ROOT}/solana-config.yml"
readonly PAYER_KEYPAIR="${TEMP_ROOT}/payer.json"
readonly VALIDATOR_LOG="${TEMP_ROOT}/validator.log"
readonly PLACEHOLDER_PROGRAM_ID="11111111111111111111111111111111"
readonly BUILD_TIMEOUT_SECONDS="${BLOB_ESCROW_LOCALNET_BUILD_TIMEOUT_SECONDS:-900}"
readonly DEPLOY_TIMEOUT_SECONDS="${BLOB_ESCROW_LOCALNET_DEPLOY_TIMEOUT_SECONDS:-300}"
validator_pid=""

cleanup() {
  if [[ -n "${validator_pid}" ]] && kill -0 "${validator_pid}" 2>/dev/null; then
    kill "${validator_pid}" 2>/dev/null || true
    wait "${validator_pid}" 2>/dev/null || true
  fi
  rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT

# A local smoke run must never leave a compiler, validator, ledger, or
# throwaway keypair running forever. `timeout --foreground` preserves normal
# Ctrl-C/TERM handling so the EXIT trap still removes the temporary directory.
run_with_timeout() {
  local seconds="$1"
  shift
  timeout --foreground "${seconds}" "$@"
}

if [[ -x "${HOME}/.local/share/solana/install/active_release/bin/solana" ]]; then
  SOLANA_BIN_DIR="${HOME}/.local/share/solana/install/active_release/bin"
else
  SOLANA_BIN_DIR="$(find "${HOME}/.local/share/solana/install/releases" -type f -name solana -printf '%h\n' 2>/dev/null | sort -V | tail -n 1)"
fi
export PATH="${HOME}/.cargo/bin:${HOME}/.avm/bin:${SOLANA_BIN_DIR}:${PATH}"
export SOLANA_CONFIG_FILE="${CONFIG_FILE}"

for command in anchor solana solana-keygen solana-test-validator; do
  command -v "${command}" >/dev/null || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done

# Copy source only. Never copy Anchor/Cargo output from the Windows worktree:
# that cache can be very large and makes an otherwise isolated smoke test look
# hung before compilation even begins.
mkdir -p "${WORKSPACE_DIR}"
(
  cd "${SOURCE_DIR}"
  tar \
    --exclude='./target' \
    --exclude='./.anchor' \
    --exclude='./node_modules' \
    -cf - .
) | tar -xf - -C "${WORKSPACE_DIR}"
mkdir -p "${WORKSPACE_DIR}/target/deploy"

# Both keypairs are local-test-only and are destroyed by cleanup. Suppress
# key-generation output so a seed phrase can never enter a CI or agent log.
solana-keygen new --no-bip39-passphrase --force --outfile "${PAYER_KEYPAIR}" >/dev/null 2>&1
solana-keygen new --no-bip39-passphrase --force \
  --outfile "${WORKSPACE_DIR}/target/deploy/blob_escrow-keypair.json" >/dev/null 2>&1
solana config set --url http://127.0.0.1:8899 --keypair "${PAYER_KEYPAIR}" >/dev/null
PROGRAM_ID="$(solana address --keypair "${WORKSPACE_DIR}/target/deploy/blob_escrow-keypair.json")"
PAYER_ADDRESS="$(solana address --keypair "${PAYER_KEYPAIR}")"

# The checked-in all-zero ID is intentionally non-deployable. Replace only
# the two program-declaration fields in the copied workspace. A broad text
# replacement would corrupt valid test fixture keys such as So111... that
# happen to contain a run of `1` characters.
sed -Ei "s#(blob_escrow = \")${PLACEHOLDER_PROGRAM_ID}(\")#\\1${PROGRAM_ID}\\2#" \
  "${WORKSPACE_DIR}/Anchor.toml"
sed -Ei "s#(declare_id!\(\")${PLACEHOLDER_PROGRAM_ID}(\"\);)#\\1${PROGRAM_ID}\\2#" \
  "${WORKSPACE_DIR}/programs/blob_escrow/src/lib.rs"
sed -i "s|~/.config/solana/id.json|${PAYER_KEYPAIR}|" \
  "${WORKSPACE_DIR}/Anchor.toml"

# Fail before an expensive SBF build if a future edit makes either precise
# substitution stop matching. The fixture checks ensure this guard cannot be
# weakened back into a broad placeholder replacement that mutates real public
# keys embedded in the program's deterministic test vectors.
grep -Fqx "blob_escrow = \"${PROGRAM_ID}\"" "${WORKSPACE_DIR}/Anchor.toml" || {
  echo "Temporary localnet program ID was not written to Anchor.toml." >&2
  exit 1
}
grep -Fqx "declare_id!(\"${PROGRAM_ID}\");" \
  "${WORKSPACE_DIR}/programs/blob_escrow/src/lib.rs" || {
  echo "Temporary localnet program ID was not written to lib.rs." >&2
  exit 1
}
grep -Fq "Stake11111111111111111111111111111111111111" \
  "${WORKSPACE_DIR}/programs/blob_escrow/src/lib.rs" || {
  echo "Localnet setup unexpectedly changed the PDA test fixture." >&2
  exit 1
}
grep -Fq "So11111111111111111111111111111111111111112" \
  "${WORKSPACE_DIR}/programs/blob_escrow/src/lib.rs" || {
  echo "Localnet setup unexpectedly changed the native-token test fixture." >&2
  exit 1
}

# Run the program's pure Rust regression tests before compiling/deploying the
# temporary local copy. In particular this catches account-space mistakes that
# a successful program deployment alone would not exercise.
(
  cd "${WORKSPACE_DIR}/programs/blob_escrow"
  run_with_timeout "${BUILD_TIMEOUT_SECONDS}" cargo test
)

(
  cd "${WORKSPACE_DIR}"
  run_with_timeout "${BUILD_TIMEOUT_SECONDS}" anchor build
)

solana-test-validator --reset --quiet --ledger "${LEDGER_DIR}" >"${VALIDATOR_LOG}" 2>&1 &
validator_pid="$!"

for _ in $(seq 1 60); do
  if solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; then
  cat "${VALIDATOR_LOG}" >&2 || true
  echo "Local validator did not become ready." >&2
  exit 1
fi

run_with_timeout "${DEPLOY_TIMEOUT_SECONDS}" solana --url http://127.0.0.1:8899 airdrop 100 "${PAYER_ADDRESS}" >/dev/null
run_with_timeout "${DEPLOY_TIMEOUT_SECONDS}" solana --url http://127.0.0.1:8899 program deploy \
  --keypair "${PAYER_KEYPAIR}" \
  --program-id "${WORKSPACE_DIR}/target/deploy/blob_escrow-keypair.json" \
  "${WORKSPACE_DIR}/target/deploy/blob_escrow.so" >/dev/null
run_with_timeout "${DEPLOY_TIMEOUT_SECONDS}" solana --url http://127.0.0.1:8899 program show "${PROGRAM_ID}" >/dev/null

echo "Localnet escrow build and deployment passed: ${PROGRAM_ID}"
