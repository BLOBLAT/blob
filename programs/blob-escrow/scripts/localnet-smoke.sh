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
validator_pid=""

cleanup() {
  if [[ -n "${validator_pid}" ]] && kill -0 "${validator_pid}" 2>/dev/null; then
    kill "${validator_pid}" 2>/dev/null || true
    wait "${validator_pid}" 2>/dev/null || true
  fi
  rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT

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

cp -a "${SOURCE_DIR}" "${WORKSPACE_DIR}"
mkdir -p "${WORKSPACE_DIR}/target/deploy"

# Both keypairs are local-test-only and are destroyed by cleanup. Suppress
# key-generation output so a seed phrase can never enter a CI or agent log.
solana-keygen new --no-bip39-passphrase --force --outfile "${PAYER_KEYPAIR}" >/dev/null 2>&1
solana-keygen new --no-bip39-passphrase --force \
  --outfile "${WORKSPACE_DIR}/target/deploy/blob_escrow-keypair.json" >/dev/null 2>&1
solana config set --url http://127.0.0.1:8899 --keypair "${PAYER_KEYPAIR}" >/dev/null
PROGRAM_ID="$(solana address --keypair "${WORKSPACE_DIR}/target/deploy/blob_escrow-keypair.json")"
PAYER_ADDRESS="$(solana address --keypair "${PAYER_KEYPAIR}")"

# The checked-in all-zero ID is intentionally non-deployable. Substitute a
# random throwaway public key only in the copied local-test workspace.
sed -i "s/${PLACEHOLDER_PROGRAM_ID}/${PROGRAM_ID}/g" \
  "${WORKSPACE_DIR}/Anchor.toml" \
  "${WORKSPACE_DIR}/programs/blob_escrow/src/lib.rs"
sed -i "s|~/.config/solana/id.json|${PAYER_KEYPAIR}|" \
  "${WORKSPACE_DIR}/Anchor.toml"

(
  cd "${WORKSPACE_DIR}"
  anchor build
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

solana --url http://127.0.0.1:8899 airdrop 100 "${PAYER_ADDRESS}" >/dev/null
solana --url http://127.0.0.1:8899 program deploy \
  --keypair "${PAYER_KEYPAIR}" \
  --program-id "${WORKSPACE_DIR}/target/deploy/blob_escrow-keypair.json" \
  "${WORKSPACE_DIR}/target/deploy/blob_escrow.so" >/dev/null
solana --url http://127.0.0.1:8899 program show "${PROGRAM_ID}" >/dev/null

echo "Localnet escrow build and deployment passed: ${PROGRAM_ID}"
