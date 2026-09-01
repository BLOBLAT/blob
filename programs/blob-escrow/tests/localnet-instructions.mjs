import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo
} from "@solana/spl-token";

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = anchor.web3;
const { AnchorProvider, Program } = anchor;

const [idlPath, programIdText, localnetUrl] = process.argv.slice(2);
const LOCALNET_URL = localnetUrl ?? "http://127.0.0.1:8899";

if (!idlPath || !programIdText) {
  throw new Error("Usage: localnet-instructions.mjs <temporary-idl-path> <temporary-program-id> [localnet-url]");
}

const programId = new PublicKey(programIdText);
const idl = JSON.parse(readFileSync(idlPath, "utf8"));
// The smoke harness produces this IDL after replacing the intentionally
// non-deployable source placeholder. Set it defensively here as well so a
// stale generated IDL cannot ever direct a test transaction elsewhere.
idl.address = programId.toBase58();

const connection = new Connection(LOCALNET_URL, "confirmed");
const authority = Keypair.generate();
const controller = Keypair.generate();
const resultAuthority = Keypair.generate();
const treasury = Keypair.generate();
const players = Array.from({ length: 6 }, () => Keypair.generate());
const provider = new AnchorProvider(connection, keypairWallet(authority), {
  commitment: "confirmed",
  preflightCommitment: "confirmed"
});
const program = new Program(idl, provider);

const ENTRY_AMOUNT = 100_000n; // 0.10 test-USDC at 6 decimals.
const PLAYER_BALANCE = 1_000_000n;
const MINIMUM_PLAYERS = 6;
const MAXIMUM_PLAYERS = 6;
const PLATFORM_FEE_BPS = 1_000;
const PARTICIPATION_REBATE_BPS = 1_000;
const ROUND_DURATION_SECONDS = 600n;
const FUNDING_WINDOW_SECONDS = 120n;
const PAYOUT_BPS = [5_500, 3_000, 1_500];
const REVIVE_AMOUNT = 500_000n;
const REVIVE_WINDOW_SECONDS = 30n;
const REVIVE_CUTOFF_SECONDS = 180n;

await run();

async function run() {
  await Promise.all(
    [authority, controller, resultAuthority, treasury, ...players].map((keypair) =>
      airdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL)
    )
  );

  const mint = await createMint(connection, authority, authority.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  const [platformConfig] = PublicKey.findProgramAddressSync([Buffer.from("platform-config")], programId);

  await program.methods
    .initializePlatform(controller.publicKey, resultAuthority.publicKey, treasury.publicKey)
    .accounts({
      authority: authority.publicKey,
      platformConfig,
      nativeUsdcMint: mint,
      systemProgram: SystemProgram.programId
    })
    .rpc();

  const playerTokenAccounts = await Promise.all(
    players.map(async (player) => {
      const account = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mint,
        player.publicKey,
        false,
        "confirmed",
        undefined,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await mintTo(connection, authority, mint, account.address, authority, PLAYER_BALANCE, [], undefined, TOKEN_PROGRAM_ID);
      return account.address;
    })
  );

  const matchIdHash = digest("instruction-refund-match");
  const roundIdHash = digest("instruction-refund-round");
  const [matchEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("match"), matchIdHash],
    programId
  );
  const escrowTokenAccount = getAssociatedTokenAddressSync(mint, matchEscrow, true, TOKEN_PROGRAM_ID);
  const fundingDeadlineAt = BigInt(await unixTime()) + FUNDING_WINDOW_SECONDS;
  const rulesHash = canonicalRulesHash({
    matchIdHash,
    roundIdHash,
    nativeUsdcMint: mint,
    platformAuthority: authority.publicKey,
    controller: controller.publicKey,
    resultAuthority: resultAuthority.publicKey,
    treasury: treasury.publicKey,
    entryAmount: ENTRY_AMOUNT,
    payoutDeliveryFeeBps: 0,
    reviveEnabled: false,
    reviveAmount: 0n,
    participationRebateBps: PARTICIPATION_REBATE_BPS,
    payoutBps: PAYOUT_BPS,
    minimumPlayers: MINIMUM_PLAYERS,
    maximumPlayers: MAXIMUM_PLAYERS,
    fundingDeadlineAt,
    roundDurationSeconds: ROUND_DURATION_SECONDS,
    reviveWindowSeconds: 0n,
    reviveCutoffSeconds: 0n
  });

  await assert.rejects(
    () =>
      createMatch({
        matchIdHash,
        roundIdHash,
        rulesHash: Buffer.alloc(32, 7),
        fundingDeadlineAt,
        mint,
        platformConfig,
        matchEscrow,
        escrowTokenAccount
      }),
    /Transaction simulation failed|custom program error|RulesHash|rules/i,
    "a controller must not create a match with an arbitrary rules hash"
  );

  await createMatch({
    matchIdHash,
    roundIdHash,
    rulesHash,
    fundingDeadlineAt,
    mint,
    platformConfig,
    matchEscrow,
    escrowTokenAccount
  });

  const entries = await Promise.all(
    players.map(async (player, index) => {
      const [entry] = PublicKey.findProgramAddressSync(
        [Buffer.from("entry"), matchEscrow.toBuffer(), player.publicKey.toBuffer()],
        programId
      );
      await program.methods
        .enterMatch()
        .accounts({
          player: player.publicKey,
          matchEscrow,
          entry,
          mint,
          playerTokenAccount: playerTokenAccounts[index],
          escrowTokenAccount,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID
        })
        .signers([player])
        .rpc();
      return entry;
    })
  );

  const fundedEscrow = await program.account.matchEscrow.fetch(matchEscrow);
  assert.equal(Number(fundedEscrow.participantCount), MINIMUM_PLAYERS, "all six entrants must be recorded");
  assert.equal(fundedEscrow.totalContributions.toString(), (ENTRY_AMOUNT * 6n).toString());
  assert.equal((await getAccount(connection, escrowTokenAccount, "confirmed", TOKEN_PROGRAM_ID)).amount, ENTRY_AMOUNT * 6n);

  await program.methods
    .cancelMatch()
    .accounts({ controller: controller.publicKey, matchEscrow })
    .signers([controller])
    .rpc();

  for (let index = 0; index < players.length; index += 1) {
    const player = players[index];
    await program.methods
      .claimRefund()
      .accounts({
        player: player.publicKey,
        matchEscrow,
        entry: entries[index],
        mint,
        playerTokenAccount: playerTokenAccounts[index],
        escrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([player])
      .rpc();

    const refundedBalance = (await getAccount(connection, playerTokenAccounts[index], "confirmed", TOKEN_PROGRAM_ID)).amount;
    assert.equal(refundedBalance, PLAYER_BALANCE, "each player must pull back exactly the recorded contribution");
  }

  await assert.rejects(
    () =>
      program.methods
        .claimRefund()
        .accounts({
          player: players[0].publicKey,
          matchEscrow,
          entry: entries[0],
          mint,
          playerTokenAccount: playerTokenAccounts[0],
          escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID
        })
        .signers([players[0]])
        .rpc(),
    /Transaction simulation failed|custom program error|EntryRefunded|MatchNotRefunding|not refunding|refunded/i,
    "the same entry must never claim a refund twice"
  );

  const refundedEscrow = await program.account.matchEscrow.fetch(matchEscrow);
  assert.equal(refundedEscrow.totalRefunded.toString(), (ENTRY_AMOUNT * 6n).toString());
  assert.equal((await getAccount(connection, escrowTokenAccount, "confirmed", TOKEN_PROGRAM_ID)).amount, 0n);

  await exerciseLiveRevivePath({ mint, platformConfig, playerTokenAccounts });
  console.log("Localnet instruction test passed: platform init, immutable rules, funding refunds, start admission, authority-attested revive, and live refund/rebate/cancellation/early-settlement rejection.");
}

async function exerciseLiveRevivePath({ mint, platformConfig, playerTokenAccounts }) {
  const matchIdHash = digest("instruction-revive-match");
  const roundIdHash = digest("instruction-revive-round");
  const [matchEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("match"), matchIdHash],
    programId
  );
  const escrowTokenAccount = getAssociatedTokenAddressSync(mint, matchEscrow, true, TOKEN_PROGRAM_ID);
  const fundingDeadlineAt = BigInt(await unixTime()) + FUNDING_WINDOW_SECONDS;
  const rulesHash = canonicalRulesHash({
    matchIdHash,
    roundIdHash,
    nativeUsdcMint: mint,
    platformAuthority: authority.publicKey,
    controller: controller.publicKey,
    resultAuthority: resultAuthority.publicKey,
    treasury: treasury.publicKey,
    entryAmount: ENTRY_AMOUNT,
    payoutDeliveryFeeBps: 0,
    reviveEnabled: true,
    reviveAmount: REVIVE_AMOUNT,
    participationRebateBps: PARTICIPATION_REBATE_BPS,
    payoutBps: PAYOUT_BPS,
    minimumPlayers: MINIMUM_PLAYERS,
    maximumPlayers: MAXIMUM_PLAYERS,
    fundingDeadlineAt,
    roundDurationSeconds: ROUND_DURATION_SECONDS,
    reviveWindowSeconds: REVIVE_WINDOW_SECONDS,
    reviveCutoffSeconds: REVIVE_CUTOFF_SECONDS
  });

  await createMatch({
    matchIdHash,
    roundIdHash,
    rulesHash,
    fundingDeadlineAt,
    mint,
    platformConfig,
    matchEscrow,
    escrowTokenAccount,
    reviveEnabled: true,
    reviveAmount: REVIVE_AMOUNT,
    reviveWindowSeconds: REVIVE_WINDOW_SECONDS,
    reviveCutoffSeconds: REVIVE_CUTOFF_SECONDS
  });

  await assert.rejects(
    () =>
      program.methods
        .startMatch()
        .accounts({ controller: controller.publicKey, matchEscrow })
        .signers([controller])
        .rpc(),
    /Transaction simulation failed|custom program error|MinimumPlayersNotMet|minimum player/i,
    "a controller must not start a match before the disclosed minimum is funded"
  );

  const entries = await Promise.all(
    players.map(async (player, index) => {
      const [entry] = PublicKey.findProgramAddressSync(
        [Buffer.from("entry"), matchEscrow.toBuffer(), player.publicKey.toBuffer()],
        programId
      );
      await program.methods
        .enterMatch()
        .accounts({
          player: player.publicKey,
          matchEscrow,
          entry,
          mint,
          playerTokenAccount: playerTokenAccounts[index],
          escrowTokenAccount,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID
        })
        .signers([player])
        .rpc();
      return entry;
    })
  );

  await program.methods
    .startMatch()
    .accounts({ controller: controller.publicKey, matchEscrow })
    .signers([controller])
    .rpc();

  const playerClaimAccounts = {
    player: players[3].publicKey,
    matchEscrow,
    entry: entries[3],
    mint,
    playerTokenAccount: playerTokenAccounts[3],
    escrowTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID
  };

  await assert.rejects(
    () =>
      program.methods
        .claimRefund()
        .accounts(playerClaimAccounts)
        .signers([players[3]])
        .rpc(),
    /Transaction simulation failed|custom program error|MatchNotRefunding|not refunding/i,
    "a live player must not turn an active match into a personal refund"
  );

  await assert.rejects(
    () =>
      program.methods
        .claimParticipationRebate()
        .accounts(playerClaimAccounts)
        .signers([players[3]])
        .rpc(),
    /Transaction simulation failed|custom program error|ParticipationRebateUnavailable|rebate/i,
    "a participation rebate must remain unavailable until a match is settled"
  );

  const deathIdHash = digest("instruction-revive-death");
  const [reviveReceipt] = PublicKey.findProgramAddressSync(
    [Buffer.from("revive"), matchEscrow.toBuffer(), deathIdHash],
    programId
  );
  const deathAt = BigInt(await unixTime());
  const reviveAccounts = {
    player: players[0].publicKey,
    resultAuthority: resultAuthority.publicKey,
    matchEscrow,
    entry: entries[0],
    reviveReceipt,
    mint,
    playerTokenAccount: playerTokenAccounts[0],
    escrowTokenAccount,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID
  };

  await assert.rejects(
    () =>
      program.methods
        .purchaseRevive([...deathIdHash], new BN(deathAt.toString()))
        .accounts({ ...reviveAccounts, resultAuthority: players[1].publicKey })
        .signers([players[0], players[1]])
        .rpc(),
    /Transaction simulation failed|custom program error|Unauthorized|unauthorized/i,
    "a player must not substitute a browser-controlled signer for result authority"
  );

  await program.methods
    .purchaseRevive([...deathIdHash], new BN(deathAt.toString()))
    .accounts(reviveAccounts)
    .signers([players[0], resultAuthority])
    .rpc();

  const revivedEntry = await program.account.matchEntry.fetch(entries[0]);
  const liveEscrow = await program.account.matchEscrow.fetch(matchEscrow);
  assert.equal(revivedEntry.reviveCount, 1, "one accepted revive must be recorded on the entry");
  assert.equal(revivedEntry.contributedAmount.toString(), (ENTRY_AMOUNT + REVIVE_AMOUNT).toString());
  assert.equal(liveEscrow.confirmedRevives, 1, "only authority-attested revives count toward the pool");
  assert.equal(liveEscrow.totalContributions.toString(), (ENTRY_AMOUNT * 6n + REVIVE_AMOUNT).toString());
  assert.equal(
    (await getAccount(connection, playerTokenAccounts[0], "confirmed", TOKEN_PROGRAM_ID)).amount,
    PLAYER_BALANCE - ENTRY_AMOUNT - REVIVE_AMOUNT,
    "the player must pay exactly the immutable revive amount"
  );
  assert.equal(
    (await getAccount(connection, escrowTokenAccount, "confirmed", TOKEN_PROGRAM_ID)).amount,
    ENTRY_AMOUNT * 6n + REVIVE_AMOUNT,
    "the revive must be added to the same escrow pool"
  );

  await assert.rejects(
    () =>
      program.methods
        .purchaseRevive([...deathIdHash], new BN(deathAt.toString()))
        .accounts(reviveAccounts)
        .signers([players[0], resultAuthority])
        .rpc(),
    /Transaction simulation failed|custom program error|AccountAlreadyInitialized|ReviveLimitReached|revive/i,
    "one player and one death receipt must not fund a second revive"
  );

  await assert.rejects(
    () =>
      program.methods
        .cancelMatch()
        .accounts({ controller: controller.publicKey, matchEscrow })
        .signers([controller])
        .rpc(),
    /Transaction simulation failed|custom program error|MatchCancellationUnavailable|cancel/i,
    "a live match must never be converted into a controller-selected refund"
  );

  const treasuryTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    treasury.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const settleAccounts = {
    resultAuthority: resultAuthority.publicKey,
    matchEscrow,
    mint,
    escrowTokenAccount,
    treasuryTokenAccount: treasuryTokenAccount.address,
    winnerOne: entries[0],
    winnerOneTokenAccount: playerTokenAccounts[0],
    winnerTwo: entries[1],
    winnerTwoTokenAccount: playerTokenAccounts[1],
    winnerThree: entries[2],
    winnerThreeTokenAccount: playerTokenAccounts[2],
    tokenProgram: TOKEN_PROGRAM_ID
  };
  const finalResultHash = digest("instruction-revive-final-result");

  await assert.rejects(
    () =>
      program.methods
        .settleMatch([...finalResultHash])
        .accounts({ ...settleAccounts, resultAuthority: players[3].publicKey })
        .signers([players[3]])
        .rpc(),
    /Transaction simulation failed|custom program error|Unauthorized|unauthorized/i,
    "a player must not substitute a browser-controlled signer for final-result authority"
  );

  await assert.rejects(
    () =>
      program.methods
        .settleMatch([...finalResultHash])
        .accounts(settleAccounts)
        .signers([resultAuthority])
        .rpc(),
    /Transaction simulation failed|custom program error|RoundStillActive|round is still active/i,
    "settlement must not transfer a live pool before the authoritative round end"
  );
  assert.equal(
    (await getAccount(connection, escrowTokenAccount, "confirmed", TOKEN_PROGRAM_ID)).amount,
    ENTRY_AMOUNT * 6n + REVIVE_AMOUNT,
    "rejected early settlement must leave the live escrow untouched"
  );
}

function createMatch({
  matchIdHash,
  roundIdHash,
  rulesHash,
  fundingDeadlineAt,
  mint,
  platformConfig,
  matchEscrow,
  escrowTokenAccount,
  reviveEnabled = false,
  reviveAmount = 0n,
  reviveWindowSeconds = 0n,
  reviveCutoffSeconds = 0n
}) {
  return program.methods
    .createMatch(
      [...matchIdHash],
      [...roundIdHash],
      [...rulesHash],
      new BN(ENTRY_AMOUNT.toString()),
      0,
      reviveEnabled,
      new BN(reviveAmount.toString()),
      PARTICIPATION_REBATE_BPS,
      PAYOUT_BPS,
      MINIMUM_PLAYERS,
      MAXIMUM_PLAYERS,
      new BN(fundingDeadlineAt.toString()),
      new BN(ROUND_DURATION_SECONDS.toString()),
      new BN(reviveWindowSeconds.toString()),
      new BN(reviveCutoffSeconds.toString())
    )
    .accounts({
      controller: controller.publicKey,
      platformConfig,
      matchEscrow,
      nativeUsdcMint: mint,
      escrowTokenAccount,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID
    })
    .signers([controller])
    .rpc();
}

async function airdrop(publicKey, lamports) {
  const signature = await connection.requestAirdrop(publicKey, lamports);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

async function unixTime() {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) {
    throw new Error("The local validator did not return a block time.");
  }
  return blockTime;
}

function canonicalRulesHash(input) {
  return createHash("sha256")
    .update("blob-escrow-rules-v1", "utf8")
    .update(input.matchIdHash)
    .update(input.roundIdHash)
    .update(input.nativeUsdcMint.toBuffer())
    .update(input.platformAuthority.toBuffer())
    .update(input.controller.toBuffer())
    .update(input.resultAuthority.toBuffer())
    .update(input.treasury.toBuffer())
    .update(u64(input.entryAmount))
    .update(u16(PLATFORM_FEE_BPS))
    .update(u16(input.payoutDeliveryFeeBps))
    .update(Buffer.from([input.reviveEnabled ? 1 : 0]))
    .update(u64(input.reviveAmount))
    .update(u16(input.participationRebateBps))
    .update(u16(input.payoutBps[0]))
    .update(u16(input.payoutBps[1]))
    .update(u16(input.payoutBps[2]))
    .update(u16(input.minimumPlayers))
    .update(u16(input.maximumPlayers))
    .update(i64(input.fundingDeadlineAt))
    .update(i64(input.roundDurationSeconds))
    .update(i64(input.reviveWindowSeconds))
    .update(i64(input.reviveCutoffSeconds))
    .digest();
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

// Keep the localnet runner ESM-only. Anchor's internal CJS NodeWallet export
// differs between Node loaders, while this minimal signer is the exact wallet
// surface AnchorProvider needs for temporary test keypairs.
function keypairWallet(payer) {
  return {
    payer,
    publicKey: payer.publicKey,
    async signTransaction(transaction) {
      transaction.partialSign(payer);
      return transaction;
    },
    async signAllTransactions(transactions) {
      return transactions.map((transaction) => {
        transaction.partialSign(payer);
        return transaction;
      });
    }
  };
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function i64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}
