use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x");

#[program]
pub mod escrow {
    use super::*;

    pub fn deposit(
        ctx: Context<Deposit>,
        remittance_id: [u8; 16],
        beneficiary: Pubkey,
        authority: Pubkey,
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        // `remittance_id` lo consume el `#[instruction(remittance_id)]` del Context (seeds del PDA);
        // el cuerpo no lo usa. Referencia no-op para silenciar el warning sin romper las seeds.
        let _ = &remittance_id;

        // 1. CHECKS
        require!(amount > 0, ErrorCode::ZeroAmount);
        require!(
            deadline > Clock::get()?.unix_timestamp,
            ErrorCode::InvalidDeadline
        );

        // 2. EFFECTS
        let escrow = &mut ctx.accounts.escrow_state;
        escrow.sender = ctx.accounts.sender.key();
        escrow.beneficiary = beneficiary;
        escrow.authority = authority;
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.deadline = deadline;
        escrow.status = EscrowStatus::Deposited;
        escrow.bump = ctx.bumps.escrow_state;

        // 3. INTERACTIONS — transfer-in: sender firma DIRECTO (no PDA). sender_ata -> vault.
        let cpi_accounts = anchor_spl::token::Transfer {
            from: ctx.accounts.sender_ata.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
        anchor_spl::token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    /// Autorización (AC-6) y destino fijo (AC-1) son DECLARATIVOS vía `has_one` en el Context,
    /// no `require!` imperativos. `has_one = authority` -> ConstraintHasOne (2001) si firma otro.
    pub fn release(ctx: Context<Release>, remittance_id: [u8; 16]) -> Result<()> {
        // 1. CHECKS
        require!(
            ctx.accounts.escrow_state.status == EscrowStatus::Deposited,
            ErrorCode::EscrowNotDeposited
        );

        // 2. EFFECTS (ANTES de la CPI — CEI / AC-2)
        ctx.accounts.escrow_state.status = EscrowStatus::Released;

        // 3. INTERACTIONS — CPI firmada por el PDA: vault -> beneficiary_ata, por escrow_state.amount
        let sender_key = ctx.accounts.sender.key();
        let bump = ctx.accounts.escrow_state.bump;
        let amount = ctx.accounts.escrow_state.amount;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            sender_key.as_ref(),
            remittance_id.as_ref(),
            &[bump],
        ]];
        let cpi_accounts = anchor_spl::token::Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.beneficiary_ata.to_account_info(),
            authority: ctx.accounts.escrow_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        anchor_spl::token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>, remittance_id: [u8; 16]) -> Result<()> {
        // 1. CHECKS
        require!(
            ctx.accounts.escrow_state.status == EscrowStatus::Deposited,
            ErrorCode::EscrowNotDeposited
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.escrow_state.deadline,
            ErrorCode::DeadlineNotReached
        );

        // 2. EFFECTS (ANTES — CEI / AC-2)
        ctx.accounts.escrow_state.status = EscrowStatus::Refunded;

        // 3. INTERACTIONS — CPI firmada por el PDA: vault -> sender_ata, por escrow_state.amount
        let sender_key = ctx.accounts.sender.key();
        let bump = ctx.accounts.escrow_state.bump;
        let amount = ctx.accounts.escrow_state.amount;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            sender_key.as_ref(),
            remittance_id.as_ref(),
            &[bump],
        ]];
        let cpi_accounts = anchor_spl::token::Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.sender_ata.to_account_info(),
            authority: ctx.accounts.escrow_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        anchor_spl::token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    /// `constraint status != Deposited` (AC-8) va en el Context. Aquí solo cerramos el vault.
    pub fn close(ctx: Context<Close>, remittance_id: [u8; 16]) -> Result<()> {
        let sender_key = ctx.accounts.sender.key();
        let bump = ctx.accounts.escrow_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            sender_key.as_ref(),
            remittance_id.as_ref(),
            &[bump],
        ]];
        let cpi_accounts = anchor_spl::token::CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.sender.to_account_info(),
            authority: ctx.accounts.escrow_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        anchor_spl::token::close_account(cpi_ctx)?;
        // escrow_state se cierra automáticamente por el constraint `close = sender` del Context.
        Ok(())
    }

    /// HU-SOL-20/AC-3: registra el id16 de un escrow ABIERTO del sender en su EscrowIndex, para que
    /// pueda redescubrirlo on-chain sin conocer el remittanceId original. NO mueve ni un token: no
    /// hay ninguna CPI de SPL acá; la única transferencia es el rent del índice que el macro `init`
    /// genera del sender hacia su propia cuenta.
    pub fn register_escrow(ctx: Context<RegisterEscrow>, remittance_id: [u8; 16]) -> Result<()> {
        // 1. CHECKS
        let index = &mut ctx.accounts.escrow_index;
        require!(index.entries.len() < MAX_ENTRIES, ErrorCode::EscrowIndexFull);

        // 2. EFFECTS — escrituras IDEMPOTENTES del header (CD-9): `sender` y `bump` están fijados
        // por las seeds y `version` es una constante ⇒ re-ejecutar esto no puede resetear nada.
        index.sender = ctx.accounts.sender.key();
        index.version = ESCROW_INDEX_VERSION;
        index.bump = ctx.bumps.escrow_index;
        // Idempotente por diseño: un retry NO tumba la tx ni duplica la entrada.
        if !index.entries.contains(&remittance_id) {
            index.entries.push(remittance_id);
        }
        Ok(())
    }

    /// HU-SOL-20: quita un id16 del índice del propio sender. Idempotente (no-op si no está), no
    /// mueve fondos, y NO exige que el escrow esté en estado terminal — a propósito: exigirlo
    /// obligaría a cargar Account<EscrowState>, que falla con AccountNotInitialized (3012) si el
    /// escrow ya fue cerrado, y entonces esas entradas quedarían imposibles de limpiar (fuga del
    /// índice hasta el cap). Se prefiere la operación que no puede quedar trabada.
    pub fn deregister_escrow(
        ctx: Context<DeregisterEscrow>,
        remittance_id: [u8; 16],
    ) -> Result<()> {
        ctx.accounts.escrow_index.entries.retain(|e| *e != remittance_id);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Índice enumerable por sender (HU-SOL-20)
// ---------------------------------------------------------------------------

/// Máximo de escrows ABIERTOS indexables por sender. El índice solo lista escrows en estado
/// Deposited (ver RegisterEscrow), y el ciclo de vida de un escrow es de minutos/horas ⇒ 32 es
/// ~16-32x el uso real esperado. Subirlo a futuro es OTRA HU (CD-11).
pub const MAX_ENTRIES: usize = 32;
/// Versión del layout de EscrowIndex (forward-compat). Hoy 1.
pub const ESCROW_INDEX_VERSION: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct EscrowIndex {
    pub sender: Pubkey,         // 32 — redundante con las seeds; habilita memcmp como fallback
    pub version: u8,            //  1 — forward-compat del layout del índice
    pub bump: u8,               //  1 — bump canónico del PDA
    #[max_len(MAX_ENTRIES)]
    pub entries: Vec<[u8; 16]>, //  4 + 16·32 = 516 — id16 de los escrows ABIERTOS del sender
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct EscrowState {
    pub sender: Pubkey,       // 32 — depositor/payer; único que firma refund (AC-4)
    pub beneficiary: Pubkey,  // 32 — owner de la ATA destino; fijado en deposit, inmutable (CR-4/CD-3)
    pub authority: Pubkey,    // 32 — facilitator/operator; único que invoca release (AC-6)
    pub mint: Pubkey,         // 32 — mint de USDC (env-driven; §10.3)
    pub amount: u64,          //  8 — monto custodiado
    pub deadline: i64,        //  8 — unix ts; comparado contra Clock (AC-4/AC-5)
    pub status: EscrowStatus, //  1 — Deposited | Released | Refunded
    pub bump: u8,             //  1 — bump canónico del PDA (para invoke_signed)
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Deposited, // 0
    Released,  // 1 — terminal
    Refunded,  // 2 — terminal
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("Deposit amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deadline must be in the future")]
    InvalidDeadline,
    #[msg("Escrow is not in the Deposited state")]
    EscrowNotDeposited,
    #[msg("Deadline has not been reached yet")]
    DeadlineNotReached,
    #[msg("Escrow must be in a terminal state to close")]
    EscrowNotTerminal,
    // Al FINAL a propósito: los códigos de error de Anchor son posicionales desde 6000. Insertarlo
    // en el medio renumeraría EscrowNotDeposited/DeadlineNotReached/EscrowNotTerminal y rompería a
    // cualquier cliente que mapee códigos. Debe quedar 6005.
    #[msg("Escrow index is full for this sender")]
    EscrowIndexFull,
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(remittance_id: [u8; 16])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = sender,
        space = 8 + EscrowState::INIT_SPACE,
        seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        init,
        payer = sender,
        associated_token::mint = mint,
        associated_token::authority = escrow_state
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = sender
    )]
    pub sender_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(remittance_id: [u8; 16])]
pub struct Release<'info> {
    pub authority: Signer<'info>,

    /// CHECK: solo aporta su key a las seeds del PDA; validado por has_one = sender. NO firma.
    pub sender: SystemAccount<'info>,

    /// validado por has_one = beneficiary; owner de la ATA destino (CR-4)
    pub beneficiary: SystemAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()],
        bump = escrow_state.bump,
        has_one = authority,
        has_one = beneficiary,
        has_one = sender,
        has_one = mint
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow_state
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = beneficiary
    )]
    pub beneficiary_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(remittance_id: [u8; 16])]
pub struct Refund<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()],
        bump = escrow_state.bump,
        has_one = sender,
        has_one = mint
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow_state
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender
    )]
    pub sender_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(remittance_id: [u8; 16])]
pub struct Close<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()],
        bump = escrow_state.bump,
        has_one = sender,
        has_one = mint,
        constraint = escrow_state.status != EscrowStatus::Deposited @ ErrorCode::EscrowNotTerminal,
        close = sender
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow_state
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(remittance_id: [u8; 16])]
pub struct RegisterEscrow<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    // NO `mut`: register_escrow no modifica el escrow. Las seeds (que incluyen al signer) son el
    // guard REAL de ownership; `has_one` es defensa en profundidad, espejo de Refund.
    #[account(
        seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()],
        bump = escrow_state.bump,
        has_one = sender,
        constraint = escrow_state.status == EscrowStatus::Deposited @ ErrorCode::EscrowNotDeposited
    )]
    pub escrow_state: Account<'info, EscrowState>,

    // Sin `mut` (el macro `init_if_needed` ya lo implica; agregarlo NO compila) y sin
    // `has_one = sender` (CD-8: en la rama de creación el campo todavía vale Pubkey::default()).
    // Las seeds ["escrow-index", sender] + Signer ya son el guard criptográfico.
    #[account(
        init_if_needed,
        payer = sender,
        space = 8 + EscrowIndex::INIT_SPACE,
        seeds = [b"escrow-index", sender.key().as_ref()],
        bump
    )]
    pub escrow_index: Account<'info, EscrowIndex>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeregisterEscrow<'info> {
    // SIN `mut`: no paga rent y no se le transfiere nada. Menos privilegio que en RegisterEscrow.
    pub sender: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow-index", sender.key().as_ref()],
        bump = escrow_index.bump
    )]
    pub escrow_index: Account<'info, EscrowIndex>,
}
