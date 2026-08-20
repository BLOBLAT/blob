use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::ID as LEGACY_TOKEN_PROGRAM_ID,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("11111111111111111111111111111111");

const BASIS_POINTS: u64 = 10_000;
const PLATFORM_FEE_BPS: u16 = 500;
pub const DEFAULT_PAYOUT_BPS: [u16; 3] = [6_000, 3_000, 1_000];
const REBUY_AMOUNT_BASE_UNITS: u64 = 500_000;
const NATIVE_USDC_DECIMALS: u8 = 6;
const MAX_PLAYERS: u16 = 32;
const WINNER_COUNT: usize = 3;
const ROUND_DURATION_SECONDS: i64 = 10 * 60;
const REBUY_WINDOW_SECONDS: i64 = 30;
const REBUY_CUTOFF_SECONDS: i64 = 60;

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
        validate_platform_roles(match_controller, result_authority, treasury)?;
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
        validate_platform_roles(match_controller, result_authority, treasury)?;
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
        revive_enabled: bool,
        revive_amount: u64,
        payout_bps: [u16; 3],
        minimum_players: u16,
        maximum_players: u16,
        round_duration_seconds: i64,
        revive_window_seconds: i64,
        revive_cutoff_seconds: i64,
    ) -> Result<()> {
        validate_native_usdc_decimals(ctx.accounts.native_usdc_mint.decimals)?;
        validate_match_configuration(
            entry_amount,
            revive_enabled,
            revive_amount,
            payout_bps,
            minimum_players,
            maximum_players,
            round_duration_seconds,
            revive_window_seconds,
            revive_cutoff_seconds,
        )?;
        require!(
            match_id_hash != [0; 32] && round_id_hash != [0; 32] && rules_hash != [0; 32],
            EscrowError::InvalidIdentifierHash
        );
        let escrow = &mut ctx.accounts.match_escrow;
        escrow.version = 1;
        escrow.lifecycle = MatchLifecycle::Funding;
        escrow.match_id_hash = match_id_hash;
        escrow.round_id_hash = round_id_hash;
        escrow.rules_hash = rules_hash;
        escrow.final_result_hash = [0; 32];
        escrow.mint = ctx.accounts.native_usdc_mint.key();
        escrow.controller = ctx.accounts.controller.key();
        escrow.result_authority = ctx.accounts.platform_config.result_authority;
        escrow.treasury = ctx.accounts.platform_config.treasury;
        escrow.entry_amount = entry_amount;
        escrow.revive_enabled = revive_enabled;
        escrow.revive_amount = revive_amount;
        escrow.platform_fee_bps = PLATFORM_FEE_BPS;
        escrow.payout_bps = payout_bps;
        escrow.minimum_players = minimum_players;
        escrow.maximum_players = maximum_players;
        escrow.round_duration_seconds = round_duration_seconds;
        escrow.revive_window_seconds = revive_window_seconds;
        escrow.revive_cutoff_seconds = revive_cutoff_seconds;
        escrow.round_ends_at = 0;
        escrow.participant_count = 0;
        escrow.confirmed_revives = 0;
        escrow.total_contributions = 0;
        escrow.total_refunded = 0;
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
            escrow.platform_fee_bps,
            escrow.payout_bps,
        )?;
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"match", escrow.match_id_hash.as_ref(), &[escrow.bump]]];

        transfer_from_escrow(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.treasury_token_account.to_account_info(),
            escrow.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            settlement.platform_fee,
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
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(address = match_escrow.mint @ EscrowError::IncorrectMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = match_escrow,
        associated_token::token_program = token_program
    )]
    pub escrow_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_token_account.owner == match_escrow.treasury @ EscrowError::InvalidTreasuryTokenAccount,
        constraint = treasury_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        seeds = [b"entry", match_escrow.key().as_ref(), winner_one.player.as_ref()],
        bump = winner_one.bump,
        constraint = winner_one.match_escrow == match_escrow.key() @ EscrowError::InvalidWinner,
        constraint = !winner_one.refunded @ EscrowError::InvalidWinner
    )]
    pub winner_one: Account<'info, MatchEntry>,
    #[account(
        mut,
        constraint = winner_one_token_account.owner == winner_one.player @ EscrowError::InvalidWinnerTokenAccount,
        constraint = winner_one_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub winner_one_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        seeds = [b"entry", match_escrow.key().as_ref(), winner_two.player.as_ref()],
        bump = winner_two.bump,
        constraint = winner_two.match_escrow == match_escrow.key() @ EscrowError::InvalidWinner,
        constraint = !winner_two.refunded @ EscrowError::InvalidWinner
    )]
    pub winner_two: Account<'info, MatchEntry>,
    #[account(
        mut,
        constraint = winner_two_token_account.owner == winner_two.player @ EscrowError::InvalidWinnerTokenAccount,
        constraint = winner_two_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub winner_two_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        seeds = [b"entry", match_escrow.key().as_ref(), winner_three.player.as_ref()],
        bump = winner_three.bump,
        constraint = winner_three.match_escrow == match_escrow.key() @ EscrowError::InvalidWinner,
        constraint = !winner_three.refunded @ EscrowError::InvalidWinner
    )]
    pub winner_three: Account<'info, MatchEntry>,
    #[account(
        mut,
        constraint = winner_three_token_account.owner == winner_three.player @ EscrowError::InvalidWinnerTokenAccount,
        constraint = winner_three_token_account.mint == match_escrow.mint @ EscrowError::IncorrectMint
    )]
    pub winner_three_token_account: InterfaceAccount<'info, TokenAccount>,
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

#[account]
pub struct MatchEscrow {
    pub version: u8,
    pub lifecycle: MatchLifecycle,
    pub match_id_hash: [u8; 32],
    pub round_id_hash: [u8; 32],
    pub rules_hash: [u8; 32],
    pub final_result_hash: [u8; 32],
    pub mint: Pubkey,
    pub controller: Pubkey,
    pub result_authority: Pubkey,
    pub treasury: Pubkey,
    pub entry_amount: u64,
    pub revive_enabled: bool,
    pub revive_amount: u64,
    pub platform_fee_bps: u16,
    pub payout_bps: [u16; 3],
    pub minimum_players: u16,
    pub maximum_players: u16,
    pub round_duration_seconds: i64,
    pub revive_window_seconds: i64,
    pub revive_cutoff_seconds: i64,
    pub round_ends_at: i64,
    pub participant_count: u16,
    pub confirmed_revives: u16,
    pub total_contributions: u64,
    pub total_refunded: u64,
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
    pub const SPACE: usize = 8 + 340;
}

#[account]
pub struct MatchEntry {
    pub match_escrow: Pubkey,
    pub player: Pubkey,
    pub contributed_amount: u64,
    pub revive_count: u8,
    pub refunded: bool,
    pub bump: u8,
}

impl MatchEntry {
    pub const SPACE: usize = 8 + 75;
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
    payouts: [u64; WINNER_COUNT],
}

fn validate_match_configuration(
    entry_amount: u64,
    revive_enabled: bool,
    revive_amount: u64,
    payout_bps: [u16; 3],
    minimum_players: u16,
    maximum_players: u16,
    round_duration_seconds: i64,
    revive_window_seconds: i64,
    revive_cutoff_seconds: i64,
) -> Result<()> {
    require!(entry_amount > 0, EscrowError::InvalidConfiguration);
    require!(
        minimum_players >= WINNER_COUNT as u16,
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

fn validate_platform_roles(
    match_controller: Pubkey,
    result_authority: Pubkey,
    treasury: Pubkey,
) -> Result<()> {
    require!(
        match_controller != Pubkey::default()
            && result_authority != Pubkey::default()
            && treasury != Pubkey::default(),
        EscrowError::InvalidAuthority
    );
    require!(
        match_controller != result_authority,
        EscrowError::AuthoritySeparationRequired
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
    fee_bps: u16,
    payout_bps: [u16; 3],
) -> Result<SettlementAmounts> {
    require!(total_contributions > 0, EscrowError::InvalidSettlement);
    require!(
        fee_bps == PLATFORM_FEE_BPS,
        EscrowError::ImmutableRulesViolation
    );
    validate_payout_bps(payout_bps)?;
    let platform_fee = total_contributions
        .checked_mul(fee_bps as u64)
        .ok_or(EscrowError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    let prize_pool = total_contributions
        .checked_sub(platform_fee)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    let mut payouts = [0u64; WINNER_COUNT];
    let mut distributed = 0u64;
    for (index, payout_bps) in payout_bps.iter().enumerate() {
        let amount = prize_pool
            .checked_mul(*payout_bps as u64)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_div(BASIS_POINTS)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        payouts[index] = amount;
        distributed = distributed
            .checked_add(amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
    }
    let remainder = prize_pool
        .checked_sub(distributed)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    payouts[0] = payouts[0]
        .checked_add(remainder)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    Ok(SettlementAmounts {
        platform_fee,
        payouts,
    })
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
    revive_window_seconds: i64,
    revive_cutoff_seconds: i64,
) -> Result<()> {
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
    #[msg("The immutable match, round, or rules hash is required.")]
    InvalidIdentifierHash,
    #[msg("The match controller and result authority must be distinct.")]
    AuthoritySeparationRequired,
    #[msg("The platform controller, result authority, and treasury must be configured.")]
    InvalidAuthority,
    #[msg("Only legacy SPL native USDC is accepted.")]
    NativeUsdcOnly,
    #[msg("The supplied mint does not match this escrow.")]
    IncorrectMint,
    #[msg("The match is not accepting entries.")]
    MatchNotFunding,
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
        let settlement =
            calculate_settlement(100_000_000, PLATFORM_FEE_BPS, DEFAULT_PAYOUT_BPS).unwrap();
        assert_eq!(settlement.platform_fee, 5_000_000);
        assert_eq!(settlement.payouts, [57_000_000, 28_500_000, 9_500_000]);
        assert_eq!(
            settlement.platform_fee + settlement.payouts.iter().sum::<u64>(),
            100_000_000
        );
    }

    #[test]
    fn adds_a_token_rounding_remainder_to_first_place() {
        let settlement =
            calculate_settlement(1_000_003, PLATFORM_FEE_BPS, DEFAULT_PAYOUT_BPS).unwrap();
        assert_eq!(
            settlement.platform_fee + settlement.payouts.iter().sum::<u64>(),
            1_000_003
        );
        assert!(settlement.payouts[0] >= settlement.payouts[1]);
    }

    #[test]
    fn accepts_immutable_configuration_driven_payouts() {
        let settlement =
            calculate_settlement(100_000_000, PLATFORM_FEE_BPS, [5_000, 3_000, 2_000]).unwrap();
        assert_eq!(settlement.payouts, [47_500_000, 28_500_000, 19_000_000]);
    }

    #[test]
    fn rejects_invalid_fee_or_payout_splits() {
        assert!(calculate_settlement(100, 499, DEFAULT_PAYOUT_BPS).is_err());
        assert!(calculate_settlement(100, PLATFORM_FEE_BPS, [5_000, 3_000, 1_000]).is_err());
        assert!(calculate_settlement(100, PLATFORM_FEE_BPS, [5_000, 5_000, 0]).is_err());
    }

    #[test]
    fn keeps_standard_and_rebuy_rules_separate() {
        assert!(validate_match_configuration(
            1_000_000,
            false,
            0,
            DEFAULT_PAYOUT_BPS,
            3,
            10,
            600,
            0,
            0
        )
        .is_ok());
        assert!(validate_match_configuration(
            1_000_000,
            false,
            500_000,
            DEFAULT_PAYOUT_BPS,
            3,
            10,
            600,
            30,
            60
        )
        .is_err());
        assert!(validate_match_configuration(
            1_000_000,
            true,
            REBUY_AMOUNT_BASE_UNITS,
            DEFAULT_PAYOUT_BPS,
            3,
            10,
            600,
            30,
            60
        )
        .is_ok());
    }

    #[test]
    fn keeps_round_and_rebuy_timers_immutable() {
        assert!(validate_match_configuration(
            1_000_000,
            false,
            0,
            DEFAULT_PAYOUT_BPS,
            3,
            10,
            ROUND_DURATION_SECONDS + 1,
            0,
            0
        )
        .is_err());
        assert!(validate_match_configuration(
            1_000_000,
            true,
            REBUY_AMOUNT_BASE_UNITS,
            DEFAULT_PAYOUT_BPS,
            3,
            10,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS + 1,
            REBUY_CUTOFF_SECONDS
        )
        .is_err());
        assert!(validate_match_configuration(
            1_000_000,
            true,
            REBUY_AMOUNT_BASE_UNITS,
            DEFAULT_PAYOUT_BPS,
            3,
            10,
            ROUND_DURATION_SECONDS,
            REBUY_WINDOW_SECONDS,
            REBUY_CUTOFF_SECONDS - 1
        )
        .is_err());
    }

    #[test]
    fn enforces_authoritative_rebuy_timing() {
        assert!(validate_rebuy_window(130, 100, 600, 30, 60).is_ok());
        assert!(validate_rebuy_window(131, 100, 600, 30, 60).is_err());
        assert!(validate_rebuy_window(540, 530, 600, 30, 60).is_err());
        assert!(validate_rebuy_window(99, 100, 600, 30, 60).is_err());
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
        let controller = Pubkey::new_from_array([1; 32]);
        let result_authority = Pubkey::new_from_array([2; 32]);
        let treasury = Pubkey::new_from_array([3; 32]);
        assert!(validate_platform_roles(controller, result_authority, treasury).is_ok());
        assert!(validate_platform_roles(controller, controller, treasury).is_err());
        assert!(validate_platform_roles(controller, result_authority, Pubkey::default()).is_err());
        assert!(validate_native_usdc_decimals(NATIVE_USDC_DECIMALS).is_ok());
        assert!(validate_native_usdc_decimals(9).is_err());
    }
}
