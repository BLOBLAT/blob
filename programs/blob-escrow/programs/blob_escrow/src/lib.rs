use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::ID as LEGACY_TOKEN_PROGRAM_ID,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("11111111111111111111111111111111");

const BASIS_POINTS: u64 = 10_000;
const PLATFORM_FEE_BPS: u16 = 1_000;
const PARTICIPATION_REBATE_BPS: u16 = 1_000;
pub const DEFAULT_PAYOUT_BPS: [u16; 3] = [5_500, 3_000, 1_500];
#[cfg(test)]
const MIN_ENTRY_AMOUNT_BASE_UNITS: u64 = 100_000;
const SUPPORTED_STAKE_TIERS_BASE_UNITS: [u64; 4] = [100_000, 1_000_000, 5_000_000, 10_000_000];
const MAX_PAYOUT_DELIVERY_FEE_BPS: u16 = 100;
const REBUY_AMOUNT_BASE_UNITS: u64 = 500_000;
const NATIVE_USDC_DECIMALS: u8 = 6;
const MAX_PLAYERS: u16 = 32;
const WINNER_COUNT: usize = 3;
const MINIMUM_PLAYERS: u16 = 6;
const MAX_FUNDING_DURATION_SECONDS: i64 = 15 * 60;
const ROUND_DURATION_SECONDS: i64 = 10 * 60;
const REBUY_WINDOW_SECONDS: i64 = 30;
const REBUY_CUTOFF_SECONDS: i64 = 180;

#[program]
pub mod blob_escrow {
    use super::*;

    /// Creates the one platform configuration PDA. Its authority must be a
    /// governance-controlled signer in production, not the game server.
    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        match_controller: Pubkey,
        result_authority: Pubkey,
        treasury: Pubkey,
    ) -> Result<()> {
        validate_platform_roles(
            ctx.accounts.authority.key(),
            match_controller,
            result_authority,
            treasury,
        )?;
        validate_native_usdc_decimals(ctx.accounts.native_usdc_mint.decimals)?;
        let platform_config = &mut ctx.accounts.platform_config;
        platform_config.authority = ctx.accounts.authority.key();
        platform_config.match_controller = match_controller;
        platform_config.result_authority = result_authority;
        platform_config.treasury = treasury;
        platform_config.native_usdc_mint = ctx.accounts.native_usdc_mint.key();
        platform_config.bump = ctx.bumps.platform_config;
        Ok(())
    }

    /// Rotates operational roles for future matches without changing the USDC
    /// mint or authorities stored in any existing match escrow.
    pub fn update_platform_config(
        ctx: Context<UpdatePlatformConfig>,
        match_controller: Pubkey,
        result_authority: Pubkey,
        treasury: Pubkey,
    ) -> Result<()> {
        validate_platform_roles(
            ctx.accounts.platform_config.authority,
            match_controller,
            result_authority,
            treasury,
        )?;
        let platform_config = &mut ctx.accounts.platform_config;
        platform_config.match_controller = match_controller;
        platform_config.result_authority = result_authority;
        platform_config.treasury = treasury;
        Ok(())
    }

    /// Creates an immutable native-USDC match escrow. The controller and
    /// result authority are separate public keys so a game process cannot
    /// unilaterally pay itself or alter an in-progress game's rules.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id_hash: [u8; 32],
        round_id_hash: [u8; 32],
        rules_hash: [u8; 32],
        entry_amount: u64,
        payout_delivery_fee_bps: u16,
        revive_enabled: bool,
        revive_amount: u64,
        participation_rebate_bps: u16,
        payout_bps: [u16; 3],
        minimum_players: u16,
        maximum_players: u16,
        funding_deadline_at: i64,
        round_duration_seconds: i64,
        revive_window_seconds: i64,
        revive_cutoff_seconds: i64,
    ) -> Result<()> {
        validate_native_usdc_decimals(ctx.accounts.native_usdc_mint.decimals)?;
        validate_match_configuration(
            entry_amount,
            payout_delivery_fee_bps,
            revive_enabled,
            revive_amount,
            participation_rebate_bps,
            payout_bps,
            minimum_players,
            maximum_players,
            round_duration_seconds,
            revive_window_seconds,
            revive_cutoff_seconds,
        )?;
        validate_funding_deadline(Clock::get()?.unix_timestamp, funding_deadline_at)?;
        require!(
            match_id_hash != [0; 32] && round_id_hash != [0; 32] && rules_hash != [0; 32],
            EscrowError::InvalidIdentifierHash
        );
        let escrow = &mut ctx.accounts.match_escrow;
        escrow.version = 3;
        escrow.lifecycle = MatchLifecycle::Funding;
        escrow.match_id_hash = match_id_hash;
        escrow.round_id_hash = round_id_hash;
        escrow.rules_hash = rules_hash;
        escrow.final_result_hash = [0; 32];
        escrow.mint = ctx.accounts.native_usdc_mint.key();
        // Snapshot the governance authority alongside every other platform
        // role. Configuration updates affect future matches only, and this
        // key is ineligible to enter the immutable match it governs.
        escrow.platform_authority = ctx.accounts.platform_config.authority;
        escrow.controller = ctx.accounts.controller.key();
        escrow.result_authority = ctx.accounts.platform_config.result_authority;
        escrow.treasury = ctx.accounts.platform_config.treasury;
        escrow.entry_amount = entry_amount;
        escrow.revive_enabled = revive_enabled;
        escrow.revive_amount = revive_amount;
        escrow.platform_fee_bps = PLATFORM_FEE_BPS;
        escrow.payout_delivery_fee_bps = payout_delivery_fee_bps;
        escrow.participation_rebate_bps = participation_rebate_bps;
        escrow.payout_bps = payout_bps;
        escrow.minimum_players = minimum_players;
        escrow.maximum_players = maximum_players;
        escrow.round_duration_seconds = round_duration_seconds;
        escrow.revive_window_seconds = revive_window_seconds;
        escrow.revive_cutoff_seconds = revive_cutoff_seconds;
        escrow.funding_deadline_at = funding_deadline_at;
        escrow.round_ends_at = 0;
        escrow.participant_count = 0;
        escrow.confirmed_revives = 0;
        escrow.total_contributions = 0;
        escrow.total_refunded = 0;
        escrow.total_participation_rebates_paid = 0;
        escrow.bump = ctx.bumps.match_escrow;
        Ok(())
    }

    /// Locks verified entrants into the match by moving exactly the
    /// pre-disclosed entry amount to the match PDA's USDC associated account.
    pub fn enter_match(ctx: Context<EnterMatch>) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            escrow.lifecycle == MatchLifecycle::Funding,
            EscrowError::MatchNotFunding
        );
        validate_funding_open(Clock::get()?.unix_timestamp, escrow.funding_deadline_at)?;
        validate_player_is_not_platform_role(ctx.accounts.player.key(), escrow)?;
        require!(
            escrow.participant_count < escrow.maximum_players,
            EscrowError::MaximumPlayersReached
        );

        let entry = &mut ctx.accounts.entry;
        entry.match_escrow = escrow.key();
        entry.player = ctx.accounts.player.key();
        entry.contributed_amount = escrow.entry_amount;
        entry.revive_count = 0;
        entry.refunded = false;
        entry.prize_paid = false;
        entry.participation_rebate_claimed = false;
        entry.bump = ctx.bumps.entry;

        transfer_from_player(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.player_token_account.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.player.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            escrow.entry_amount,
            ctx.accounts.mint.decimals,
        )?;

        escrow.participant_count = escrow
            .participant_count
            .checked_add(1)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        escrow.total_contributions = escrow
            .total_contributions
            .checked_add(escrow.entry_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        Ok(())
    }

    /// Starts the on-chain paid-match window after the controller has selected
    /// a funded player set. The game server still owns gameplay and rankings.
    pub fn start_match(ctx: Context<ControlMatch>) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            escrow.lifecycle == MatchLifecycle::Funding,
            EscrowError::MatchNotFunding
        );
        require!(
            escrow.participant_count >= escrow.minimum_players,
            EscrowError::MinimumPlayersNotMet
        );
        let now = Clock::get()?.unix_timestamp;
        validate_funding_open(now, escrow.funding_deadline_at)?;
        escrow.round_ends_at = now
            .checked_add(escrow.round_duration_seconds)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        escrow.lifecycle = MatchLifecycle::Live;
        Ok(())
    }

    /// Records one authority-attested Rebuy Arena revive and transfers exactly
    /// the immutable revive amount. A browser cannot call this alone: both the
    /// player and independent result authority must sign the transaction.
    pub fn purchase_revive(
        ctx: Context<PurchaseRevive>,
        death_id_hash: [u8; 32],
        death_at: i64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            escrow.lifecycle == MatchLifecycle::Live,
            EscrowError::MatchNotLive
        );
        require!(escrow.revive_enabled, EscrowError::ReviveDisabled);
        require!(death_id_hash != [0; 32], EscrowError::InvalidDeathHash);
        let now = Clock::get()?.unix_timestamp;
        validate_rebuy_window(
            now,
            death_at,
            escrow.round_ends_at,
            escrow.round_duration_seconds,
            escrow.revive_window_seconds,
            escrow.revive_cutoff_seconds,
        )?;

        let entry = &mut ctx.accounts.entry;
        require!(!entry.refunded, EscrowError::EntryRefunded);
        require!(entry.revive_count == 0, EscrowError::ReviveLimitReached);

        transfer_from_player(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.player_token_account.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.player.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            escrow.revive_amount,
            ctx.accounts.mint.decimals,
        )?;

        entry.revive_count = 1;
        entry.contributed_amount = entry
            .contributed_amount
            .checked_add(escrow.revive_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        escrow.confirmed_revives = escrow
            .confirmed_revives
            .checked_add(1)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        escrow.total_contributions = escrow
            .total_contributions
            .checked_add(escrow.revive_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let receipt = &mut ctx.accounts.revive_receipt;
        receipt.match_escrow = escrow.key();
        receipt.entry = entry.key();
        receipt.player = ctx.accounts.player.key();
        receipt.death_id_hash = death_id_hash;
        receipt.death_at = death_at;
        receipt.amount = escrow.revive_amount;
        receipt.bump = ctx.bumps.revive_receipt;
        Ok(())
    }

    /// Settles a frozen authoritative result. Payout arithmetic is calculated
    /// from immutable on-chain rules and total confirmed contributions; the
    /// result authority can select only three distinct enrolled winners.
    pub fn settle_match(ctx: Context<SettleMatch>, final_result_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            escrow.lifecycle == MatchLifecycle::Live,
            EscrowError::MatchNotLive
        );
        require!(
            Clock::get()?.unix_timestamp >= escrow.round_ends_at,
            EscrowError::RoundStillActive
        );
        require!(final_result_hash != [0; 32], EscrowError::InvalidResultHash);
        validate_distinct_winners(
            &ctx.accounts.winner_one,
            &ctx.accounts.winner_two,
            &ctx.accounts.winner_three,
        )?;

        let settlement = calculate_settlement(
            escrow.total_contributions,
            escrow.participant_count,
            escrow.entry_amount,
            escrow.platform_fee_bps,
            escrow.payout_delivery_fee_bps,
            escrow.participation_rebate_bps,
            escrow.payout_bps,
        )?;
        // The fixed six-player minimum and positive entry amount make this
        // reserve mandatory. Assert it here so an impossible serialized match
        // cannot settle three prizes while silently omitting the lower-rank
        // participation-rebate reserve.
        require!(
            settlement.participation_rebate_per_player > 0
                && settlement.participation_rebate_pool > 0,
            EscrowError::InvalidSettlement
        );
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"match", escrow.match_id_hash.as_ref(), &[escrow.bump]]];

        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.treasury_token_account.to_account_info(),
            escrow.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            settlement
                .platform_fee
                .checked_add(settlement.payout_delivery_fee_total)
                .ok_or(EscrowError::ArithmeticOverflow)?,
            ctx.accounts.mint.decimals,
            signer_seeds,
        )?;
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.winner_one_token_account.to_account_info(),
            escrow.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            settlement.payouts[0],
            ctx.accounts.mint.decimals,
            signer_seeds,
        )?;
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.winner_two_token_account.to_account_info(),
            escrow.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            settlement.payouts[1],
            ctx.accounts.mint.decimals,
            signer_seeds,
        )?;
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            escrow.to_account_info(),
            ctx.accounts.winner_three_token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            settlement.payouts[2],
            ctx.accounts.mint.decimals,
            signer_seeds,
        )?;
        ctx.accounts.winner_one.prize_paid = true;
        ctx.accounts.winner_two.prize_paid = true;
        ctx.accounts.winner_three.prize_paid = true;
        escrow.final_result_hash = final_result_hash;
        escrow.lifecycle = MatchLifecycle::Settled;
        Ok(())
    }

    /// The controller may cancel only before a round starts. Individual
    /// enrolled players then withdraw their exact recorded contributions
    /// themselves. Once a match is live, its pool can only be settled from the
    /// result-authority-attested outcome; it cannot be replaced with a
    /// controller-selected blanket refund.
    pub fn cancel_match(ctx: Context<ControlMatch>) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        validate_cancellable_lifecycle(escrow.lifecycle)?;
        escrow.lifecycle = MatchLifecycle::Refunding;
        Ok(())
    }

    /// Lets anyone unlock a failed funding round after its disclosed deadline.
    /// This does not refund anyone automatically: every player still withdraws
    /// only their recorded contribution through `claim_refund`.
    pub fn expire_funding(ctx: Context<ExpireFunding>) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            escrow.lifecycle == MatchLifecycle::Funding,
            EscrowError::MatchNotFunding
        );
        require!(
            Clock::get()?.unix_timestamp >= escrow.funding_deadline_at,
            EscrowError::FundingDeadlineNotReached
        );
        escrow.lifecycle = MatchLifecycle::Refunding;
        Ok(())
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            escrow.lifecycle == MatchLifecycle::Refunding,
            EscrowError::MatchNotRefunding
        );
        let entry = &mut ctx.accounts.entry;
        require!(!entry.refunded, EscrowError::EntryRefunded);
        let amount = entry.contributed_amount;
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"match", escrow.match_id_hash.as_ref(), &[escrow.bump]]];
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.player_token_account.to_account_info(),
            escrow.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            amount,
            ctx.accounts.mint.decimals,
            signer_seeds,
        )?;
        entry.refunded = true;
        escrow.total_refunded = escrow
            .total_refunded
            .checked_add(amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        if escrow.total_refunded == escrow.total_contributions {
            escrow.lifecycle = MatchLifecycle::Refunded;
        }
        Ok(())
    }

    /// After settlement, each non-podium entrant may pull exactly the
    /// disclosed partial rebate of the original entry. Revive contributions
    /// are deliberately excluded from this calculation.
    pub fn claim_participation_rebate(ctx: Context<ClaimParticipationRebate>) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            escrow.lifecycle == MatchLifecycle::Settled,
            EscrowError::ParticipationRebateUnavailable
        );
        let entry = &mut ctx.accounts.entry;
        require!(
            !entry.refunded && !entry.prize_paid,
            EscrowError::ParticipationRebateUnavailable
        );
        require!(
            !entry.participation_rebate_claimed,
            EscrowError::ParticipationRebateAlreadyClaimed
        );

        let amount =
            participation_rebate_amount(escrow.entry_amount, escrow.participation_rebate_bps)?;
        let maximum_rebate_pool = amount
            .checked_mul(
                escrow
                    .participant_count
                    .checked_sub(WINNER_COUNT as u16)
                    .ok_or(EscrowError::InvalidSettlement)? as u64,
            )
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let next_total = escrow
            .total_participation_rebates_paid
            .checked_add(amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        require!(
            next_total <= maximum_rebate_pool,
            EscrowError::ParticipationRebateUnavailable
        );

        let signer_seeds: &[&[&[u8]]] =
            &[&[b"match", escrow.match_id_hash.as_ref(), &[escrow.bump]]];
        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.player_token_account.to_account_info(),
            escrow.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            amount,
            ctx.accounts.mint.decimals,
            signer_seeds,
        )?;
        entry.participation_rebate_claimed = true;
        escrow.total_participation_rebates_paid = next_total;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = PlatformConfig::SPACE,
        seeds = [b"platform-config"],
        bump
    )]
    pub platform_config: Account<'info, PlatformConfig>,
    #[account(constraint = native_usdc_mint.to_account_info().owner == &LEGACY_TOKEN_PROGRAM_ID @ EscrowError::NativeUsdcOnly)]
    pub native_usdc_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePlatformConfig<'info> {
    #[account(address = platform_config.authority @ EscrowError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"platform-config"], bump = platform_config.bump)]
    pub platform_config: Account<'info, PlatformConfig>,
}

#[derive(Accounts)]
#[instruction(match_id_hash: [u8; 32])]
pub struct CreateMatch<'info> {
    #[account(mut, address = platform_config.match_controller @ EscrowError::Unauthorized)]
    pub controller: Signer<'info>,
    #[account(seeds = [b"platform-config"], bump = platform_config.bump)]
    pub platform_config: Account<'info, PlatformConfig>,
    #[account(
        init,
        payer = controller,
        space = MatchEscrow::SPACE,
        seeds = [b"match", match_id_hash.as_ref()],
        bump
    )]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(address = platform_config.native_usdc_mint @ EscrowError::NativeUsdcOnly)]
    pub native_usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = controller,
        associated_token::mint = native_usdc_mint,
        associated_token::authority = match_escrow,
        associated_token::token_program = token_program
    )]
    pub escrow_token_account: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    #[account(address = LEGACY_TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct EnterMatch<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"match", match_escrow.match_id_hash.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(
        init,
        payer = player,
        space = MatchEntry::SPACE,
        seeds = [b"entry", match_escrow.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub entry: Account<'info, MatchEntry>,
    #[account(address = match_escrow.mint @ EscrowError::IncorrectMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = player_token_account.owner == player.key() @ EscrowError::InvalidPlayerTokenAccount,
        constraint = player_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub player_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = match_escrow,
        associated_token::token_program = token_program
    )]
    pub escrow_token_account: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    #[account(address = LEGACY_TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ControlMatch<'info> {
    #[account(address = match_escrow.controller @ EscrowError::Unauthorized)]
    pub controller: Signer<'info>,
    #[account(mut, seeds = [b"match", match_escrow.match_id_hash.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
}

#[derive(Accounts)]
pub struct ExpireFunding<'info> {
    #[account(mut, seeds = [b"match", match_escrow.match_id_hash.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
}

#[derive(Accounts)]
#[instruction(death_id_hash: [u8; 32], death_at: i64)]
pub struct PurchaseRevive<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(address = match_escrow.result_authority @ EscrowError::Unauthorized)]
    pub result_authority: Signer<'info>,
    #[account(mut, seeds = [b"match", match_escrow.match_id_hash.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(
        mut,
        seeds = [b"entry", match_escrow.key().as_ref(), player.key().as_ref()],
        bump = entry.bump,
        constraint = entry.match_escrow == match_escrow.key() @ EscrowError::InvalidEntry,
        constraint = entry.player == player.key() @ EscrowError::InvalidEntry
    )]
    pub entry: Account<'info, MatchEntry>,
    #[account(
        init,
        payer = player,
        space = ReviveReceipt::SPACE,
        seeds = [b"revive", match_escrow.key().as_ref(), death_id_hash.as_ref()],
        bump
    )]
    pub revive_receipt: Account<'info, ReviveReceipt>,
    #[account(address = match_escrow.mint @ EscrowError::IncorrectMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = player_token_account.owner == player.key() @ EscrowError::InvalidPlayerTokenAccount,
        constraint = player_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub player_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = match_escrow,
        associated_token::token_program = token_program
    )]
    pub escrow_token_account: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    #[account(address = LEGACY_TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SettleMatch<'info> {
    #[account(address = match_escrow.result_authority @ EscrowError::Unauthorized)]
    pub result_authority: Signer<'info>,
    #[account(mut, seeds = [b"match", match_escrow.match_id_hash.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Box<Account<'info, MatchEscrow>>,
    #[account(address = match_escrow.mint @ EscrowError::IncorrectMint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = match_escrow,
        associated_token::token_program = token_program
    )]
    pub escrow_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = treasury_token_account.owner == match_escrow.treasury @ EscrowError::InvalidTreasuryTokenAccount,
        constraint = treasury_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"entry", match_escrow.key().as_ref(), winner_one.player.as_ref()],
        bump = winner_one.bump,
        constraint = winner_one.match_escrow == match_escrow.key() @ EscrowError::InvalidWinner,
        constraint = !winner_one.refunded && !winner_one.prize_paid @ EscrowError::InvalidWinner
    )]
    pub winner_one: Box<Account<'info, MatchEntry>>,
    #[account(
        mut,
        constraint = winner_one_token_account.owner == winner_one.player @ EscrowError::InvalidWinnerTokenAccount,
        constraint = winner_one_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub winner_one_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"entry", match_escrow.key().as_ref(), winner_two.player.as_ref()],
        bump = winner_two.bump,
        constraint = winner_two.match_escrow == match_escrow.key() @ EscrowError::InvalidWinner,
        constraint = !winner_two.refunded && !winner_two.prize_paid @ EscrowError::InvalidWinner
    )]
    pub winner_two: Box<Account<'info, MatchEntry>>,
    #[account(
        mut,
        constraint = winner_two_token_account.owner == winner_two.player @ EscrowError::InvalidWinnerTokenAccount,
        constraint = winner_two_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub winner_two_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"entry", match_escrow.key().as_ref(), winner_three.player.as_ref()],
        bump = winner_three.bump,
        constraint = winner_three.match_escrow == match_escrow.key() @ EscrowError::InvalidWinner,
        constraint = !winner_three.refunded && !winner_three.prize_paid @ EscrowError::InvalidWinner
    )]
    pub winner_three: Box<Account<'info, MatchEntry>>,
    #[account(
        mut,
        constraint = winner_three_token_account.owner == winner_three.player @ EscrowError::InvalidWinnerTokenAccount,
        constraint = winner_three_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub winner_three_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = LEGACY_TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"match", match_escrow.match_id_hash.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(
        mut,
        seeds = [b"entry", match_escrow.key().as_ref(), player.key().as_ref()],
        bump = entry.bump,
        constraint = entry.match_escrow == match_escrow.key() @ EscrowError::InvalidEntry,
        constraint = entry.player == player.key() @ EscrowError::InvalidEntry
    )]
    pub entry: Account<'info, MatchEntry>,
    #[account(address = match_escrow.mint @ EscrowError::IncorrectMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = player_token_account.owner == player.key() @ EscrowError::InvalidPlayerTokenAccount,
        constraint = player_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub player_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = match_escrow,
        associated_token::token_program = token_program
    )]
    pub escrow_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(address = LEGACY_TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimParticipationRebate<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"match", match_escrow.match_id_hash.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(
        mut,
        seeds = [b"entry", match_escrow.key().as_ref(), player.key().as_ref()],
        bump = entry.bump,
        constraint = entry.match_escrow == match_escrow.key() @ EscrowError::InvalidEntry,
        constraint = entry.player == player.key() @ EscrowError::InvalidEntry
    )]
    pub entry: Account<'info, MatchEntry>,
    #[account(address = match_escrow.mint @ EscrowError::IncorrectMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = player_token_account.owner == player.key() @ EscrowError::InvalidPlayerTokenAccount,
        constraint = player_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub player_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = match_escrow,
        associated_token::token_program = token_program
    )]
    pub escrow_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(address = LEGACY_TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct MatchEscrow {
    pub version: u8,
    pub lifecycle: MatchLifecycle,
    pub match_id_hash: [u8; 32],
    pub round_id_hash: [u8; 32],
    pub rules_hash: [u8; 32],
    pub final_result_hash: [u8; 32],
    pub mint: Pubkey,
    pub platform_authority: Pubkey,
    pub controller: Pubkey,
    pub result_authority: Pubkey,
    pub treasury: Pubkey,
    pub entry_amount: u64,
    pub revive_enabled: bool,
    pub revive_amount: u64,
    pub platform_fee_bps: u16,
    pub payout_delivery_fee_bps: u16,
    pub participation_rebate_bps: u16,
    pub payout_bps: [u16; 3],
    pub minimum_players: u16,
    pub maximum_players: u16,
    pub round_duration_seconds: i64,
    pub revive_window_seconds: i64,
    pub revive_cutoff_seconds: i64,
    pub funding_deadline_at: i64,
    pub round_ends_at: i64,
    pub participant_count: u16,
    pub confirmed_revives: u16,
    pub total_contributions: u64,
    pub total_refunded: u64,
    pub total_participation_rebates_paid: u64,
    pub bump: u8,
}

#[account]
pub struct PlatformConfig {
    pub authority: Pubkey,
    pub match_controller: Pubkey,
    pub result_authority: Pubkey,
    pub treasury: Pubkey,
    pub native_usdc_mint: Pubkey,
    pub bump: u8,
}

impl PlatformConfig {
    pub const SPACE: usize = 8 + 161;
}

impl MatchEscrow {
    // Anchor account allocation must include the eight-byte discriminator.
    // Keep the Borsh payload calculation beside the account definition rather
    // than a stale hand-counted total: an undersized account makes
    // `create_match` fail while serializing the freshly initialized escrow.
    pub const DATA_LEN: usize = 1 // version
        + 1 // lifecycle enum
        + (4 * 32) // match, round, rules, and final-result hashes
        + (5 * 32) // mint, governance authority, controller, result authority, and treasury
        + 8 // entry amount
        + 1 // revive enabled
        + 8 // revive amount
        + 2 // platform fee basis points
        + 2 // optional podium-payout delivery fee basis points
        + 2 // participation rebate basis points
        + (WINNER_COUNT * 2) // three payout basis-point values
        + (2 * 2) // minimum and maximum player counts
        + (5 * 8) // round/revive/funding timestamps and duration
        + (2 * 2) // participant and revive counters
        + (3 * 8) // total contributions, refunds, and participation rebates
        + 1; // PDA bump
    pub const SPACE: usize = 8 + Self::DATA_LEN;
}

#[account]
pub struct MatchEntry {
    pub match_escrow: Pubkey,
    pub player: Pubkey,
    pub contributed_amount: u64,
    pub revive_count: u8,
    pub refunded: bool,
    pub prize_paid: bool,
    pub participation_rebate_claimed: bool,
    pub bump: u8,
}

impl MatchEntry {
    pub const SPACE: usize = 8 + 77;
}

#[account]
pub struct ReviveReceipt {
    pub match_escrow: Pubkey,
    pub entry: Pubkey,
    pub player: Pubkey,
    pub death_id_hash: [u8; 32],
    pub death_at: i64,
    pub amount: u64,
    pub bump: u8,
}

impl ReviveReceipt {
    pub const SPACE: usize = 8 + 145;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MatchLifecycle {
    Funding,
    Live,
    Settled,
    Refunding,
    Refunded,
}

struct SettlementAmounts {
    platform_fee: u64,
    payout_delivery_fee_total: u64,
    participation_rebate_per_player: u64,
    participation_rebate_pool: u64,
    // These values make the integer accounting directly regression-testable.
    // The deployed program only needs the net payouts and aggregate fee.
    #[cfg(test)]
    gross_payouts: [u64; WINNER_COUNT],
    #[cfg(test)]
    payout_delivery_fees: [u64; WINNER_COUNT],
    payouts: [u64; WINNER_COUNT],
}

fn validate_match_configuration(
    entry_amount: u64,
    payout_delivery_fee_bps: u16,
    revive_enabled: bool,
    revive_amount: u64,
    participation_rebate_bps: u16,
    payout_bps: [u16; 3],
    minimum_players: u16,
    maximum_players: u16,
    round_duration_seconds: i64,
    revive_window_seconds: i64,
    revive_cutoff_seconds: i64,
) -> Result<()> {
    // Every paid round commits to one disclosed tier, avoiding accidental
    // browser-selected entry amounts and isolated dust pools.
    require!(
        is_supported_stake_tier(entry_amount),
        EscrowError::UnsupportedEntryAmount
    );
    require!(
        payout_delivery_fee_bps <= MAX_PAYOUT_DELIVERY_FEE_BPS,
        EscrowError::InvalidPayoutDeliveryFee
    );
    require!(
        minimum_players >= MINIMUM_PLAYERS,
        EscrowError::InvalidConfiguration
    );
    require!(
        maximum_players >= minimum_players && maximum_players <= MAX_PLAYERS,
        EscrowError::InvalidConfiguration
    );
    require!(
        round_duration_seconds == ROUND_DURATION_SECONDS,
        EscrowError::InvalidConfiguration
    );
    validate_payout_bps(payout_bps)?;
    require!(
        participation_rebate_bps == PARTICIPATION_REBATE_BPS,
        EscrowError::ImmutableRulesViolation
    );
    if revive_enabled {
        require!(
            revive_amount == REBUY_AMOUNT_BASE_UNITS,
            EscrowError::InvalidConfiguration
        );
        require!(
            revive_window_seconds == REBUY_WINDOW_SECONDS
                && revive_cutoff_seconds == REBUY_CUTOFF_SECONDS,
            EscrowError::InvalidConfiguration
        );
    } else {
        require!(
            revive_amount == 0 && revive_window_seconds == 0 && revive_cutoff_seconds == 0,
            EscrowError::InvalidConfiguration
        );
    }
    Ok(())
}

fn validate_funding_deadline(now: i64, funding_deadline_at: i64) -> Result<()> {
    require!(
        funding_deadline_at > now,
        EscrowError::FundingDeadlineInvalid
    );
    let maximum_deadline = now
        .checked_add(MAX_FUNDING_DURATION_SECONDS)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    require!(
        funding_deadline_at <= maximum_deadline,
        EscrowError::FundingDeadlineInvalid
    );
    Ok(())
}

/// Entry and match start share the same strict deadline: a contribution at
/// the exact funding deadline is too late. This prevents a stale funding
/// escrow from accepting a new USDC transfer while it awaits its permissionless
/// expiry/refund transition.
fn validate_funding_open(now: i64, funding_deadline_at: i64) -> Result<()> {
    require!(
        now < funding_deadline_at,
        EscrowError::FundingDeadlineExpired
    );
    Ok(())
}

fn validate_platform_roles(
    authority: Pubkey,
    match_controller: Pubkey,
    result_authority: Pubkey,
    treasury: Pubkey,
) -> Result<()> {
    require!(
        authority != Pubkey::default()
            && match_controller != Pubkey::default()
            && result_authority != Pubkey::default()
            && treasury != Pubkey::default(),
        EscrowError::InvalidAuthority
    );
    require!(
        authority != match_controller
            && authority != result_authority
            && authority != treasury
            && match_controller != result_authority
            && match_controller != treasury
            && result_authority != treasury,
        EscrowError::AuthoritySeparationRequired
    );
    Ok(())
}

/// Operational escrow roles are deliberately ineligible to play. This keeps
/// the governance authority, controller, result-attestation key, and
/// fee-recipient owner outside the funded participant and winner sets even
/// before off-chain identity policy is applied.
fn validate_player_is_not_platform_role(player: Pubkey, escrow: &MatchEscrow) -> Result<()> {
    require!(
        player != Pubkey::default()
            && player != escrow.platform_authority
            && player != escrow.controller
            && player != escrow.result_authority
            && player != escrow.treasury,
        EscrowError::PlatformRoleIneligible
    );
    Ok(())
}

fn validate_native_usdc_decimals(decimals: u8) -> Result<()> {
    require!(
        decimals == NATIVE_USDC_DECIMALS,
        EscrowError::NativeUsdcOnly
    );
    Ok(())
}

fn calculate_settlement(
    total_contributions: u64,
    participant_count: u16,
    entry_amount: u64,
    fee_bps: u16,
    payout_delivery_fee_bps: u16,
    participation_rebate_bps: u16,
    payout_bps: [u16; 3],
) -> Result<SettlementAmounts> {
    require!(total_contributions > 0, EscrowError::InvalidSettlement);
    require!(
        participant_count >= MINIMUM_PLAYERS,
        EscrowError::InvalidSettlement
    );
    require!(
        is_supported_stake_tier(entry_amount),
        EscrowError::UnsupportedEntryAmount
    );
    require!(
        fee_bps == PLATFORM_FEE_BPS,
        EscrowError::ImmutableRulesViolation
    );
    require!(
        payout_delivery_fee_bps <= MAX_PAYOUT_DELIVERY_FEE_BPS,
        EscrowError::InvalidPayoutDeliveryFee
    );
    require!(
        participation_rebate_bps == PARTICIPATION_REBATE_BPS,
        EscrowError::ImmutableRulesViolation
    );
    validate_payout_bps(payout_bps)?;
    let platform_fee = total_contributions
        .checked_mul(fee_bps as u64)
        .ok_or(EscrowError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    let participation_rebate_per_player =
        participation_rebate_amount(entry_amount, participation_rebate_bps)?;
    let participation_rebate_pool = participation_rebate_per_player
        .checked_mul((participant_count - WINNER_COUNT as u16) as u64)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    let prize_pool = total_contributions
        .checked_sub(platform_fee)
        .ok_or(EscrowError::ArithmeticOverflow)?
        .checked_sub(participation_rebate_pool)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    let mut gross_payouts = [0u64; WINNER_COUNT];
    let mut distributed = 0u64;
    for (index, payout_bps) in payout_bps.iter().enumerate() {
        let amount = prize_pool
            .checked_mul(*payout_bps as u64)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_div(BASIS_POINTS)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        gross_payouts[index] = amount;
        distributed = distributed
            .checked_add(amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
    }
    let remainder = prize_pool
        .checked_sub(distributed)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    gross_payouts[0] = gross_payouts[0]
        .checked_add(remainder)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    #[cfg(test)]
    let mut payout_delivery_fees = [0u64; WINNER_COUNT];
    let mut payouts = [0u64; WINNER_COUNT];
    let mut payout_delivery_fee_total = 0u64;
    for index in 0..WINNER_COUNT {
        let delivery_fee = gross_payouts[index]
            .checked_mul(payout_delivery_fee_bps as u64)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_div(BASIS_POINTS)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        #[cfg(test)]
        {
            payout_delivery_fees[index] = delivery_fee;
        }
        payouts[index] = gross_payouts[index]
            .checked_sub(delivery_fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        payout_delivery_fee_total = payout_delivery_fee_total
            .checked_add(delivery_fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;
    }
    Ok(SettlementAmounts {
        platform_fee,
        payout_delivery_fee_total,
        participation_rebate_per_player,
        participation_rebate_pool,
        #[cfg(test)]
        gross_payouts,
        #[cfg(test)]
        payout_delivery_fees,
        payouts,
    })
}

fn participation_rebate_amount(entry_amount: u64, participation_rebate_bps: u16) -> Result<u64> {
    entry_amount
        .checked_mul(participation_rebate_bps as u64)
        .ok_or(EscrowError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS)
        .ok_or(EscrowError::ArithmeticOverflow.into())
}

fn is_supported_stake_tier(entry_amount: u64) -> bool {
    SUPPORTED_STAKE_TIERS_BASE_UNITS.contains(&entry_amount)
}

fn validate_payout_bps(payout_bps: [u16; 3]) -> Result<()> {
    let total = payout_bps.iter().try_fold(0u64, |sum, value| {
        sum.checked_add(*value as u64)
            .ok_or(EscrowError::ArithmeticOverflow)
    })?;
    require!(
        total == BASIS_POINTS && payout_bps.iter().all(|value| *value > 0),
        EscrowError::InvalidPayoutDistribution
    );
    Ok(())
}

fn validate_rebuy_window(
    now: i64,
    death_at: i64,
    round_ends_at: i64,
    round_duration_seconds: i64,
    revive_window_seconds: i64,
    revive_cutoff_seconds: i64,
) -> Result<()> {
    let round_starts_at = round_ends_at
        .checked_sub(round_duration_seconds)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    require!(
        death_at >= round_starts_at,
        EscrowError::InvalidDeathTimestamp
    );
    require!(death_at <= now, EscrowError::InvalidDeathTimestamp);
    require!(death_at < round_ends_at, EscrowError::InvalidDeathTimestamp);
    let revive_expires_at = death_at
        .checked_add(revive_window_seconds)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    require!(now <= revive_expires_at, EscrowError::ReviveWindowExpired);
    let revive_cutoff_at = round_ends_at
        .checked_sub(revive_cutoff_seconds)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    require!(now < revive_cutoff_at, EscrowError::ReviveCutoffReached);
    Ok(())
}

/// A refund is a pre-game funding failure path, never a replacement for the
/// outcome of an active paid match. This is deliberately separate from the
/// generic lifecycle checks so it remains easy to audit.
fn validate_cancellable_lifecycle(lifecycle: MatchLifecycle) -> Result<()> {
    require!(
        lifecycle == MatchLifecycle::Funding,
        EscrowError::MatchCancellationUnavailable
    );
    Ok(())
}

fn validate_distinct_winners(
    one: &Account<MatchEntry>,
    two: &Account<MatchEntry>,
    three: &Account<MatchEntry>,
) -> Result<()> {
    require!(
        one.player != two.player && one.player != three.player && two.player != three.player,
        EscrowError::DuplicateWinner
    );
    Ok(())
}

fn transfer_from_player<'info>(
    token_program: AccountInfo<'info>,
    source: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    transfer_checked(
        CpiContext::new(
            token_program,
            TransferChecked {
                from: source,
                mint,
                to: destination,
                authority,
            },
        ),
        amount,
        decimals,
    )
}

fn transfer_from_escrow<'info>(
    token_program: AccountInfo<'info>,
    source: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: source,
                mint,
                to: destination,
                authority,
            },
            signer_seeds,
        ),
        amount,
        decimals,
    )
}

#[error_code]
pub enum EscrowError {
    #[msg("The match configuration is invalid.")]
    InvalidConfiguration,
    #[msg("The entry amount is not one of the disclosed native-USDC stake tiers.")]
    UnsupportedEntryAmount,
    #[msg("The disclosed podium-payout delivery fee exceeds the permitted maximum.")]
    InvalidPayoutDeliveryFee,
    #[msg("The immutable match, round, or rules hash is required.")]
    InvalidIdentifierHash,
    #[msg(
        "The governance authority, controller, result authority, and treasury must be distinct."
    )]
    AuthoritySeparationRequired,
    #[msg(
        "The governance authority, controller, result authority, and treasury must be configured."
    )]
    InvalidAuthority,
    #[msg("Platform operational accounts cannot enter a paid match.")]
    PlatformRoleIneligible,
    #[msg("Only legacy SPL native USDC is accepted.")]
    NativeUsdcOnly,
    #[msg("The supplied mint does not match this escrow.")]
    IncorrectMint,
    #[msg("The match is not accepting entries.")]
    MatchNotFunding,
    #[msg("The funding deadline is invalid.")]
    FundingDeadlineInvalid,
    #[msg("The funding deadline has expired.")]
    FundingDeadlineExpired,
    #[msg("The funding deadline has not been reached.")]
    FundingDeadlineNotReached,
    #[msg("The match is not live.")]
    MatchNotLive,
    #[msg("The match has reached its player limit.")]
    MaximumPlayersReached,
    #[msg("The minimum player count has not been met.")]
    MinimumPlayersNotMet,
    #[msg("Only the designated controller or result authority may perform this action.")]
    Unauthorized,
    #[msg("The provided player token account is invalid.")]
    InvalidPlayerTokenAccount,
    #[msg("The provided treasury token account is invalid.")]
    InvalidTreasuryTokenAccount,
    #[msg("The provided match entry is invalid.")]
    InvalidEntry,
    #[msg("The supplied winner is not eligible.")]
    InvalidWinner,
    #[msg("The supplied winner token account is invalid.")]
    InvalidWinnerTokenAccount,
    #[msg("A winner cannot occupy multiple final places.")]
    DuplicateWinner,
    #[msg("Paid revive is disabled for this match.")]
    ReviveDisabled,
    #[msg("The revive cutoff has been reached.")]
    ReviveCutoffReached,
    #[msg("The authoritative death timestamp is invalid.")]
    InvalidDeathTimestamp,
    #[msg("The authoritative death hash is required.")]
    InvalidDeathHash,
    #[msg("The revive window after this death has expired.")]
    ReviveWindowExpired,
    #[msg("The player has already used the permitted revive.")]
    ReviveLimitReached,
    #[msg("The round is still active.")]
    RoundStillActive,
    #[msg("The match has already been settled.")]
    MatchAlreadySettled,
    #[msg("The match is already refunding.")]
    MatchAlreadyRefunding,
    #[msg("Only a funding match may be cancelled and refunded.")]
    MatchCancellationUnavailable,
    #[msg("The match is not refunding.")]
    MatchNotRefunding,
    #[msg("This entry has already been refunded.")]
    EntryRefunded,
    #[msg("The settlement inputs are invalid.")]
    InvalidSettlement,
    #[msg("This entry is not eligible to claim a participation rebate.")]
    ParticipationRebateUnavailable,
    #[msg("This participation rebate was already claimed.")]
    ParticipationRebateAlreadyClaimed,
    #[msg("An escrow arithmetic operation overflowed.")]
    ArithmeticOverflow,
    #[msg("The immutable on-chain fee or payout rules were altered.")]
    ImmutableRulesViolation,
    #[msg("The three-place payout split must use all 10000 basis points.")]
    InvalidPayoutDistribution,
    #[msg("The final authoritative result hash is required.")]
    InvalidResultHash,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_the_fixed_fee_and_default_prize_split() {
        let settlement = calculate_settlement(
            100_000_000,
            10,
            10_000_000,
            PLATFORM_FEE_BPS,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
        )
        .unwrap();
        assert_eq!(settlement.platform_fee, 10_000_000);
        assert_eq!(settlement.participation_rebate_per_player, 1_000_000);
        assert_eq!(settlement.participation_rebate_pool, 7_000_000);
        assert_eq!(settlement.payout_delivery_fee_total, 0);
        assert_eq!(settlement.gross_payouts, settlement.payouts);
        assert_eq!(settlement.payouts, [45_650_000, 24_900_000, 12_450_000]);
        assert_eq!(
            settlement.platform_fee
                + settlement.payout_delivery_fee_total
                + settlement.participation_rebate_pool
                + settlement.payouts.iter().sum::<u64>(),
            100_000_000
        );
    }

    #[test]
    fn adds_a_token_rounding_remainder_to_first_place() {
        let settlement = calculate_settlement(
            1_000_003,
            MINIMUM_PLAYERS,
            MIN_ENTRY_AMOUNT_BASE_UNITS,
            PLATFORM_FEE_BPS,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
        )
        .unwrap();
        assert_eq!(
            settlement.platform_fee
                + settlement.payout_delivery_fee_total
                + settlement.participation_rebate_pool
                + settlement.payouts.iter().sum::<u64>(),
            1_000_003
        );
        assert!(settlement.payouts[0] >= settlement.payouts[1]);
    }

    #[test]
    fn accepts_immutable_configuration_driven_payouts() {
        let settlement = calculate_settlement(
            100_000_000,
            10,
            10_000_000,
            PLATFORM_FEE_BPS,
            0,
            PARTICIPATION_REBATE_BPS,
            [5_000, 3_000, 2_000],
        )
        .unwrap();
        assert_eq!(settlement.payouts, [41_500_000, 24_900_000, 16_600_000]);
    }

    #[test]
    fn deducts_a_bounded_delivery_charge_from_podium_prizes_only() {
        let settlement = calculate_settlement(
            100_000_000,
            10,
            10_000_000,
            PLATFORM_FEE_BPS,
            100,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
        )
        .unwrap();
        assert_eq!(
            settlement.gross_payouts,
            [45_650_000, 24_900_000, 12_450_000]
        );
        assert_eq!(settlement.payout_delivery_fees, [456_500, 249_000, 124_500]);
        assert_eq!(settlement.payout_delivery_fee_total, 830_000);
        assert_eq!(settlement.payouts, [45_193_500, 24_651_000, 12_325_500]);
        assert_eq!(
            settlement.platform_fee
                + settlement.payout_delivery_fee_total
                + settlement.participation_rebate_pool
                + settlement.payouts.iter().sum::<u64>(),
            100_000_000
        );
    }

    #[test]
    fn conserves_every_disclosed_pool_across_tiers_players_and_revives() {
        // Exercise every supported stake, every permitted roster size, and
        // every possible count of one-per-player revives. This mirrors the
        // full contribution range reachable through the on-chain instructions
        // without relying on browser or off-chain arithmetic.
        for entry_amount in SUPPORTED_STAKE_TIERS_BASE_UNITS {
            for participant_count in MINIMUM_PLAYERS..=MAX_PLAYERS {
                for confirmed_revives in 0..=participant_count {
                    let total_contributions = entry_amount
                        .checked_mul(participant_count as u64)
                        .unwrap()
                        .checked_add(
                            REBUY_AMOUNT_BASE_UNITS
                                .checked_mul(confirmed_revives as u64)
                                .unwrap(),
                        )
                        .unwrap();

                    for delivery_fee_bps in [0, MAX_PAYOUT_DELIVERY_FEE_BPS] {
                        let settlement = calculate_settlement(
                            total_contributions,
                            participant_count,
                            entry_amount,
                            PLATFORM_FEE_BPS,
                            delivery_fee_bps,
                            PARTICIPATION_REBATE_BPS,
                            DEFAULT_PAYOUT_BPS,
                        )
                        .unwrap();

                        let distributed = settlement
                            .platform_fee
                            .checked_add(settlement.payout_delivery_fee_total)
                            .unwrap()
                            .checked_add(settlement.participation_rebate_pool)
                            .unwrap()
                            .checked_add(settlement.payouts.iter().sum::<u64>())
                            .unwrap();
                        assert_eq!(distributed, total_contributions);
                        assert_eq!(
                            settlement.participation_rebate_pool,
                            participation_rebate_amount(entry_amount, PARTICIPATION_REBATE_BPS,)
                                .unwrap()
                                .checked_mul((participant_count - WINNER_COUNT as u16) as u64)
                                .unwrap()
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn rejects_invalid_fee_or_payout_splits() {
        assert!(calculate_settlement(
            100,
            MINIMUM_PLAYERS,
            10,
            499,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS
        )
        .is_err());
        assert!(calculate_settlement(
            100,
            MINIMUM_PLAYERS,
            10,
            PLATFORM_FEE_BPS,
            101,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS
        )
        .is_err());
        assert!(calculate_settlement(
            100,
            MINIMUM_PLAYERS,
            10,
            PLATFORM_FEE_BPS,
            0,
            999,
            DEFAULT_PAYOUT_BPS
        )
        .is_err());
        assert!(calculate_settlement(
            100,
            MINIMUM_PLAYERS,
            10,
            PLATFORM_FEE_BPS,
            0,
            PARTICIPATION_REBATE_BPS,
            [5_000, 3_000, 1_000]
        )
        .is_err());
        assert!(calculate_settlement(
            100,
            MINIMUM_PLAYERS,
            10,
            PLATFORM_FEE_BPS,
            0,
            PARTICIPATION_REBATE_BPS,
            [5_000, 5_000, 0]
        )
        .is_err());
    }

    #[test]
    fn rejects_settlement_for_an_undisclosed_stake_tier() {
        assert!(calculate_settlement(
            1_500_000,
            MINIMUM_PLAYERS,
            250_000,
            PLATFORM_FEE_BPS,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
        )
        .is_err());
    }

    #[test]
    fn keeps_standard_and_rebuy_rules_separate() {
        assert!(validate_match_configuration(
            MIN_ENTRY_AMOUNT_BASE_UNITS - 1,
            0,
            false,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            600,
            0,
            0
        )
        .is_err());
        assert!(validate_match_configuration(
            MIN_ENTRY_AMOUNT_BASE_UNITS,
            0,
            false,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            600,
            0,
            0
        )
        .is_ok());
        assert!(validate_match_configuration(
            250_000,
            0,
            false,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            600,
            0,
            0
        )
        .is_err());
        assert!(validate_match_configuration(
            1_000_000,
            MAX_PAYOUT_DELIVERY_FEE_BPS + 1,
            false,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            600,
            0,
            0
        )
        .is_err());
        assert!(validate_match_configuration(
            1_000_000,
            0,
            false,
            500_000,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            600,
            30,
            REBUY_CUTOFF_SECONDS
        )
        .is_err());
        assert!(validate_match_configuration(
            1_000_000,
            0,
            true,
            REBUY_AMOUNT_BASE_UNITS,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            600,
            30,
            REBUY_CUTOFF_SECONDS
        )
        .is_ok());
    }

    #[test]
    fn keeps_round_and_rebuy_timers_immutable() {
        assert!(validate_match_configuration(
            1_000_000,
            0,
            false,
            0,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            ROUND_DURATION_SECONDS + 1,
            0,
            0
        )
        .is_err());
        assert!(validate_match_configuration(
            1_000_000,
            0,
            true,
            REBUY_AMOUNT_BASE_UNITS,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS + 1,
            REBUY_CUTOFF_SECONDS
        )
        .is_err());
        assert!(validate_match_configuration(
            1_000_000,
            0,
            true,
            REBUY_AMOUNT_BASE_UNITS,
            PARTICIPATION_REBATE_BPS,
            DEFAULT_PAYOUT_BPS,
            MINIMUM_PLAYERS,
            10,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS,
            REBUY_CUTOFF_SECONDS - 1
        )
        .is_err());
    }

    #[test]
    fn bounds_the_funding_deadline() {
        assert!(validate_funding_deadline(1_000, 1_001).is_ok());
        assert!(validate_funding_deadline(1_000, 1_000).is_err());
        assert!(
            validate_funding_deadline(1_000, 1_000 + MAX_FUNDING_DURATION_SECONDS + 1).is_err()
        );
        assert!(validate_funding_open(1_000, 1_001).is_ok());
        assert!(validate_funding_open(1_000, 1_000).is_err());
    }

    #[test]
    fn enforces_authoritative_rebuy_timing() {
        assert!(validate_rebuy_window(
            130,
            100,
            600,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS,
            REBUY_CUTOFF_SECONDS
        )
        .is_ok());
        assert!(validate_rebuy_window(
            131,
            100,
            600,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS,
            REBUY_CUTOFF_SECONDS
        )
        .is_err());
        assert!(validate_rebuy_window(
            420,
            410,
            600,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS,
            REBUY_CUTOFF_SECONDS
        )
        .is_err());
        assert!(validate_rebuy_window(
            99,
            100,
            600,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS,
            REBUY_CUTOFF_SECONDS
        )
        .is_err());
        assert!(validate_rebuy_window(
            130,
            -1,
            600,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS,
            REBUY_CUTOFF_SECONDS
        )
        .is_err());
    }

    #[test]
    fn allows_cancellation_only_before_the_paid_round_starts() {
        assert!(validate_cancellable_lifecycle(MatchLifecycle::Funding).is_ok());
        assert!(validate_cancellable_lifecycle(MatchLifecycle::Live).is_err());
        assert!(validate_cancellable_lifecycle(MatchLifecycle::Settled).is_err());
        assert!(validate_cancellable_lifecycle(MatchLifecycle::Refunding).is_err());
        assert!(validate_cancellable_lifecycle(MatchLifecycle::Refunded).is_err());
    }

    #[test]
    fn requires_configured_distinct_roles_and_six_decimal_native_usdc() {
        let authority = Pubkey::new_from_array([1; 32]);
        let controller = Pubkey::new_from_array([2; 32]);
        let result_authority = Pubkey::new_from_array([3; 32]);
        let treasury = Pubkey::new_from_array([4; 32]);
        assert!(validate_platform_roles(authority, controller, result_authority, treasury).is_ok());
        assert!(validate_platform_roles(authority, authority, result_authority, treasury).is_err());
        assert!(validate_platform_roles(authority, controller, authority, treasury).is_err());
        assert!(
            validate_platform_roles(authority, controller, result_authority, authority).is_err()
        );
        assert!(validate_platform_roles(authority, controller, controller, treasury).is_err());
        assert!(
            validate_platform_roles(authority, controller, result_authority, controller).is_err()
        );
        assert!(
            validate_platform_roles(authority, controller, result_authority, result_authority)
                .is_err()
        );
        assert!(validate_platform_roles(
            authority,
            controller,
            result_authority,
            Pubkey::default()
        )
        .is_err());
        assert!(validate_native_usdc_decimals(NATIVE_USDC_DECIMALS).is_ok());
        assert!(validate_native_usdc_decimals(9).is_err());
    }

    #[test]
    fn keeps_platform_operational_roles_out_of_the_player_roster() {
        let platform_authority = Pubkey::new_from_array([1; 32]);
        let controller = Pubkey::new_from_array([2; 32]);
        let result_authority = Pubkey::new_from_array([3; 32]);
        let treasury = Pubkey::new_from_array([4; 32]);
        let escrow = MatchEscrow {
            version: 1,
            lifecycle: MatchLifecycle::Funding,
            match_id_hash: [4; 32],
            round_id_hash: [5; 32],
            rules_hash: [6; 32],
            final_result_hash: [0; 32],
            mint: Pubkey::new_from_array([7; 32]),
            platform_authority,
            controller,
            result_authority,
            treasury,
            entry_amount: MIN_ENTRY_AMOUNT_BASE_UNITS,
            revive_enabled: false,
            revive_amount: 0,
            platform_fee_bps: PLATFORM_FEE_BPS,
            payout_delivery_fee_bps: 0,
            participation_rebate_bps: PARTICIPATION_REBATE_BPS,
            payout_bps: DEFAULT_PAYOUT_BPS,
            minimum_players: 3,
            maximum_players: MAX_PLAYERS,
            round_duration_seconds: ROUND_DURATION_SECONDS,
            revive_window_seconds: 0,
            revive_cutoff_seconds: 0,
            funding_deadline_at: 10,
            round_ends_at: 0,
            participant_count: 0,
            confirmed_revives: 0,
            total_contributions: 0,
            total_refunded: 0,
            total_participation_rebates_paid: 0,
            bump: 1,
        };
        assert!(
            validate_player_is_not_platform_role(Pubkey::new_from_array([8; 32]), &escrow).is_ok()
        );
        assert!(validate_player_is_not_platform_role(controller, &escrow).is_err());
        assert!(validate_player_is_not_platform_role(platform_authority, &escrow).is_err());
        assert!(validate_player_is_not_platform_role(result_authority, &escrow).is_err());
        assert!(validate_player_is_not_platform_role(treasury, &escrow).is_err());
        assert!(validate_player_is_not_platform_role(Pubkey::default(), &escrow).is_err());
    }

    #[test]
    fn allocates_the_entire_serialized_match_escrow() {
        let escrow = MatchEscrow {
            version: 1,
            lifecycle: MatchLifecycle::Funding,
            match_id_hash: [1; 32],
            round_id_hash: [2; 32],
            rules_hash: [3; 32],
            final_result_hash: [0; 32],
            mint: Pubkey::new_from_array([4; 32]),
            platform_authority: Pubkey::new_from_array([5; 32]),
            controller: Pubkey::new_from_array([6; 32]),
            result_authority: Pubkey::new_from_array([7; 32]),
            treasury: Pubkey::new_from_array([8; 32]),
            entry_amount: 1_000_000,
            revive_enabled: true,
            revive_amount: REBUY_AMOUNT_BASE_UNITS,
            platform_fee_bps: PLATFORM_FEE_BPS,
            payout_delivery_fee_bps: 0,
            participation_rebate_bps: PARTICIPATION_REBATE_BPS,
            payout_bps: DEFAULT_PAYOUT_BPS,
            minimum_players: 3,
            maximum_players: 32,
            round_duration_seconds: ROUND_DURATION_SECONDS,
            revive_window_seconds: REBUY_WINDOW_SECONDS,
            revive_cutoff_seconds: REBUY_CUTOFF_SECONDS,
            funding_deadline_at: 100,
            round_ends_at: 700,
            participant_count: 3,
            confirmed_revives: 0,
            total_contributions: 3_000_000,
            total_refunded: 0,
            total_participation_rebates_paid: 0,
            bump: 1,
        };
        let mut serialized = Vec::new();
        escrow.try_serialize(&mut serialized).unwrap();

        assert_eq!(MatchEscrow::DATA_LEN, 392);
        assert_eq!(serialized.len(), MatchEscrow::SPACE);
    }
}
