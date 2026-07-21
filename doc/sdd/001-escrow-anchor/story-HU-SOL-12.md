# Story File — #001: Programa escrow on-chain (Rust/Anchor) + workspace

> SDD: doc/sdd/001-escrow-anchor/sdd.md
> Work Item: doc/sdd/001-escrow-anchor/work-item.md
> Fecha: 2026-07-21
> WKH: WKH-215 / HU-SOL-12
> Branch: feat/001-escrow-anchor
> Repo objetivo: `/home/ferdev/.openclaw/workspace/solana-programs/` (greenfield — NO existe todavía)

---

## Goal

Construir un programa **Anchor greenfield** (`solana-programs/`, workspace nuevo) que implementa
un escrow trustless de USDC en Solana. El `sender` deposita USDC en un vault (ATA cuya authority
es el PDA `escrow_state`); los fondos salen SOLO por dos caminos terminales mutuamente excluyentes:
`release` (la `authority`/facilitator paga SIEMPRE al `beneficiary` grabado en `deposit`) o
`refund` (el `sender` recupera los fondos una vez pasado el `deadline`, sin depender del
facilitator). Espeja las propiedades de seguridad del EVM `WasiAIEscrow.sol` (máquina de estados
terminal, destino fijo, CEI) con el modelo nativo Solana (PDA / vault ATA / CPI firmada). Es la
ruta crítica de Sprint 1: HU-SOL-13 y HU-SOL-14 dependen de este programa deployado en devnet.

**Dev lee SOLO este Story File. Si algo no está aquí → PARÁ y escalá al Architect. No inventes constraints Anchor.**

---

## ⚠️ Anti-Hallucination Header (leer antes de tocar nada)

### PATH obligatorio (exportar en CADA shell antes de `anchor`/`solana`/`cargo build-sbf`)

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# Verificar (deben responder exactamente):
anchor --version   # anchor-cli 1.1.2
solana --version   # solana-cli 3.1.10 (Agave)
rustc --version    # rustc 1.97.1
```

### Comando de arranque W0 (scaffold)

```bash
cd /home/ferdev/.openclaw/workspace/solana-programs
anchor init escrow      # genera Anchor.toml, Cargo.toml, programs/escrow/, tests/, package.json...
```

> `anchor init escrow` crea el scaffold DENTRO de `solana-programs/` (el `doc/` ya existente
> convive). Si `anchor init` se queja de directorio no vacío, ejecutalo y luego integrá el `doc/`
> existente — NO borres `doc/`.

### Directivas anti-alucinación (NO negociable)

1. **NO inventar versiones de crates.** Usá EXACTAMENTE lo que `anchor init` escribe en
   `programs/escrow/Cargo.toml` (`anchor-lang`, `anchor-spl`). Solo ajustar si `anchor build`
   falla por mismatch CLI↔crate — en ese caso pinnear a lo que la CLI 1.1.2 espera (SDD §4.10).
2. **NO habilitar el feature `init-if-needed`** en `programs/escrow/Cargo.toml` (CD-2). Solo `init`
   explícito. Si ves `features = ["init-if-needed"]` en el `anchor-lang` dep → quitalo.
3. **NO hardcodear el mint USDC** en `lib.rs`. El mint entra como account (`mint`) en cada Context
   y se graba en `escrow_state.mint` (SDD §10.3).
4. **NO hardcodear `154`** como space. Usar `space = 8 + EscrowState::INIT_SPACE` (derivado).
5. **NO almacenar `remittance_id`** en `EscrowState` — entra como ARG de instrucción `[u8; 16]`.
6. **Gate de cada wave = `anchor build` verde.** W4 = `anchor test` 6/6 verde.

### Program Instruction ABI (firmas fijas — NO re-decidir)

```
deposit(ctx, remittance_id: [u8;16], beneficiary: Pubkey, authority: Pubkey, amount: u64, deadline: i64)
release(ctx, remittance_id: [u8;16])
refund(ctx,  remittance_id: [u8;16])
close(ctx,   remittance_id: [u8;16])
```

---

## Acceptance Criteria (EARS) — copiados del SDD aprobado (QA valida en F4)

- **AC-1 (CR-4)**: WHEN `release` la invoca la `authority`, THE system SHALL transferir el balance del vault ÚNICAMENTE a la ATA del `beneficiary` grabado en `deposit`, sin importar qué cuenta se pase.
- **AC-2 (CR-3/CR-7)**: WHEN `status == Deposited` AND `release`/`refund` tiene éxito, THE system SHALL setear `status` a `Released`/`Refunded` (terminal irreversible).
- **AC-3 (CR-3/CR-7)**: IF `release`/`refund` se invoca WHILE `status != Deposited`, THEN THE system SHALL revertir (`EscrowNotDeposited`) sin mover fondos.
- **AC-4**: WHEN `refund` se invoca, THE system SHALL exigir `signer == sender` AND `Clock::now >= deadline`, sin requerir firma/disponibilidad de la `authority`.
- **AC-5**: IF `refund` se invoca WHILE `Clock::now < deadline`, THEN THE system SHALL revertir (`DeadlineNotReached`).
- **AC-6**: IF `release` la invoca `signer != authority`, THEN THE system SHALL revertir (`has_one = authority` → `ConstraintHasOne`).
- **AC-7 (ME-1)**: WHEN `deposit` se invoca, THE system SHALL crear `escrow_state` con `init` (NUNCA `init_if_needed`); re-`deposit` con las mismas seeds falla "account already in use".
- **AC-8 (ME-1)**: WHEN `close` se invoca, THE system SHALL exigir `status != Deposited` AND cerrar con `close = sender`; las seeds solo reusables vía `init` nuevo.
- **AC-9 (ME-1)**: THE system SHALL fijar la authority del vault como el PDA `escrow_state` AND ejecutar todo transfer de `release`/`refund` vía CPI firmada con las seeds del PDA (`invoke_signed`).
- **AC-10 (ME-1)**: THE system SHALL compilar con `overflow-checks = true` (`[profile.release]` y `[profile.test]`) AND usar `checked_add`/`checked_sub` para cómputo sobre `amount`.
- **AC-11 (ME-1)**: THE system SHALL declarar `token_program: Program<'info, Token>` (SPL clásico, NO Token-2022) en todo `Context` que toque el vault.
- **AC-12**: WHEN `anchor test`, THE system SHALL correr y pasar 6 escenarios (ver Test Expectations).

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Wave |
|---|---------|--------|-----------|------|
| 1 | `Cargo.toml` (workspace root) | Crear (init+editar) | agregar `[profile.release] overflow-checks=true` y `[profile.test] overflow-checks=true` (CD-1) | W0 |
| 2 | `programs/escrow/Cargo.toml` | Crear (init+editar) | verificar deps `anchor-lang`/`anchor-spl` de init; **NO** feature `init-if-needed` (CD-2) | W0 |
| 3 | `Anchor.toml` | Crear (init+editar) | `[provider] cluster="devnet"`; `[toolchain] anchor_version="1.1.2"` | W0 |
| 4 | `programs/escrow/src/lib.rs` | Crear/editar | `declare_id!`, `#[program]`, `EscrowState`, `EscrowStatus`, `#[error_code] ErrorCode`, 4 Contexts, 4 handlers | W0-W3 |
| 5 | `tests/escrow.ts` | Crear | Suite `anchor-bankrun` — 6 escenarios AC-12 + cobertura extra | W4 |
| 6 | `package.json` / `tsconfig.json` | Crear (init+editar) | deps de test: `solana-bankrun`, `anchor-bankrun`, `@solana/spl-token`, `chai`, `ts-mocha` | W0/W4 |
| 7 | `.github/workflows/ci.yml` | Crear | CI: avm/rust/solana + `anchor build` + `anchor test` | W4 |
| 8 | `scripts/deploy-devnet.sh` | Crear | `solana config set --url devnet` + `anchor deploy --provider.cluster devnet`; comentario CD-7 | W4 |
| 9 | `README.md` | Crear (editar el de init) | CD-6 (orden TransFi post-release-finalized) + CD-7 (upgrade authority) + mint devnet env-driven | W4 |

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — verificar antes de tocar código)

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor --version   # exige: anchor-cli 1.1.2
solana --version   # exige: 3.1.10 (Agave)
rustc --version    # exige: 1.97.1
cd /home/ferdev/.openclaw/workspace/solana-programs && ls doc   # doc/ debe existir; el resto NO todavía
```

**Si algo falla en Wave -1: PARAR y reportar al orquestador.** No implementar sobre entorno roto.

---

### Wave 0 (Serial Gate — scaffold que compila)

- [ ] **W0.1**: `anchor init escrow` en `solana-programs/` (genera workspace + `programs/escrow` + `tests/` + `package.json`).
- [ ] **W0.2**: Editar `Cargo.toml` (workspace root) → agregar los dos profiles (CD-1/AC-10):
  ```toml
  [profile.release]
  overflow-checks = true

  [profile.test]
  overflow-checks = true
  ```
  > Si `anchor init` ya generó un `[profile.release]` con `overflow-checks = true`, dejalo y agregá el `[profile.test]`. AMBOS deben quedar presentes.
- [ ] **W0.3**: Abrir `programs/escrow/Cargo.toml`. Verificar que el dep `anchor-lang` NO tiene `features = ["init-if-needed"]` (CD-2). Si lo tiene → quitarlo. Confirmar que `anchor-spl` está en deps (lo necesita el vault ATA / token).
  ```toml
  [dependencies]
  anchor-lang = "<lo que init escriba>"
  anchor-spl  = "<lo que init escriba>"
  ```
- [ ] **W0.4**: Editar `Anchor.toml` → `[provider] cluster = "devnet"`; `[toolchain] anchor_version = "1.1.2"`. Mantener `[programs.devnet]` con el program id que init genera.
- [ ] **W0.5**: Esqueleto de `lib.rs` que compile vacío (los 4 handlers con `Ok(())` y los 4 Contexts vacíos o mínimos, o dejar el default de init). **Gate: `anchor build` verde.**

**PROHIBIDO en W0**: escribir lógica de handlers, hardcodear versiones de crates distintas a las de init, habilitar `init-if-needed`, hardcodear `154`.

---

### Wave 1 (tipos + `deposit`)

Editar `programs/escrow/src/lib.rs`.

- [ ] **W1.1**: Definir estado, enum y errores.

**`EscrowState`** (layout EXACTO — DT-2; NO agregar/quitar campos, NO agregar `remittance_id`):
```rust
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
```
> `space` en `init` = `8 + EscrowState::INIT_SPACE` (INIT_SPACE deriva 146; +8 discriminator = 154). NO hardcodear.

**`EscrowStatus`** (DT-5 + `InitSpace` obligatorio para el byte del enum):
```rust
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Deposited,  // 0
    Released,   // 1 — terminal
    Refunded,   // 2 — terminal
}
```

**`ErrorCode`** (todas las variantes, exactas):
```rust
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
    #[msg("Arithmetic overflow")]
    Overflow,
}
```
> AC-6 (release no autorizado) y AC-1 (destino fijo) NO llevan variante propia: los cubre `has_one` (emite `ConstraintHasOne`, código 2001). Documentar en el `///` del handler `release`.

- [ ] **W1.2**: `Deposit` context (SDD §4.5.1) — copiar constraints LITERALES (ver sección "Contexts literales" abajo).
- [ ] **W1.3**: Handler `deposit` (checks → effects → CPI transfer-in con firma directa del sender). **Gate: `anchor build` verde.**

**Handler `deposit` (orden CEI):**
```rust
pub fn deposit(
    ctx: Context<Deposit>,
    remittance_id: [u8; 16],
    beneficiary: Pubkey,
    authority: Pubkey,
    amount: u64,
    deadline: i64,
) -> Result<()> {
    // 1. CHECKS
    require!(amount > 0, ErrorCode::ZeroAmount);
    require!(deadline > Clock::get()?.unix_timestamp, ErrorCode::InvalidDeadline);

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
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    anchor_spl::token::transfer(cpi_ctx, amount)?;
    Ok(())
}
```
> `remittance_id` es arg de instrucción (se usa en el constraint `seeds` del Context, NO se almacena). Anchor lo pasa a `#[instruction(remittance_id: [u8;16], ...)]`.

**PROHIBIDO en W1**: `init_if_needed`, hardcodear space, almacenar `remittance_id`, operadores crudos `+`/`-`, poner la CPI antes de los effects.

---

### Wave 2 (`release` — CPI firmada + CEI)

- [ ] **W2.1**: `Release` context (SDD §4.5.2) — constraints literales abajo.
- [ ] **W2.2**: Handler `release`. **Gate: `anchor build` verde.**

**Handler `release` (CEI — `status` a terminal ANTES de la CPI):**
```rust
/// Autorización (AC-6) y destino fijo (AC-1) son DECLARATIVOS vía `has_one` en el Context,
/// no `require!` imperativos. `has_one = authority` → ConstraintHasOne si firma otro.
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
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    anchor_spl::token::transfer(cpi_ctx, amount)?;
    Ok(())
}
```
> `amount` se lee de `escrow_state.amount`, NUNCA de un arg (CD). El destino es `beneficiary_ata` (validado por constraint), NUNCA un `AccountInfo` variable (CD-3).

**PROHIBIDO en W2**: leer amount de un arg, transferir a un account no validado, mutar `status` después de la CPI, usar `init_if_needed` para crear `beneficiary_ata` (se asume creada por la capa de negocio — HU-SOL-13).

---

### Wave 3 (`refund` + `close`)

- [ ] **W3.1**: `Refund` context (SDD §4.5.3) — SIN `authority` (CD-4).
- [ ] **W3.2**: Handler `refund`.
- [ ] **W3.3**: `Close` context + handler (SDD §4.5.4). **Gate: `anchor build` verde.**

**Handler `refund` (CEI; sin dependencia de `authority` — AC-4/CD-4):**
```rust
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
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    anchor_spl::token::transfer(cpi_ctx, amount)?;
    Ok(())
}
```

**Handler `close` (solo terminal; cierra vault vía CPI firmada; `escrow_state` lo cierra Anchor por `close = sender`):**
```rust
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
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    anchor_spl::token::close_account(cpi_ctx)?;
    // escrow_state se cierra automáticamente por el constraint `close = sender` del Context.
    Ok(())
}
```

**PROHIBIDO en W3**: incluir `authority` en el `Refund` context, permitir `close` con `status == Deposited`, cerrar el vault con authority distinta al PDA.

---

### Wave 4 (tests + CI + deploy + README)

- [ ] **W4.1**: `tests/escrow.ts` con `anchor-bankrun` — 6 escenarios (ver Test Expectations) + cobertura extra.
- [ ] **W4.2**: `.github/workflows/ci.yml` (instala rust/solana/anchor vía avm + `anchor build` + `anchor test`).
- [ ] **W4.3**: `scripts/deploy-devnet.sh` (devnet only, comentario CD-7) + `README.md` (CD-6/CD-7 + mint env-driven).
- [ ] **W4.4**: **Gate: `anchor test` verde (6/6).**

---

## Contexts literales (copiar constraints EXACTOS — el Dev NO re-decide)

> Cada Context usa `#[instruction(remittance_id: [u8; 16], ...)]` con los args que preceden a
> los usados en las seeds. Anchor requiere que `#[instruction(...)]` liste los args EN ORDEN
> hasta el último usado en un constraint.

### `Deposit` (SDD §4.5.1)
```rust
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
```

### `Release` (SDD §4.5.2)
```rust
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
```

### `Refund` (SDD §4.5.3) — SIN `authority` (CD-4)
```rust
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
```

### `Close` (SDD §4.5.4)
```rust
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
```

> **Imports necesarios** (top de `lib.rs`): `use anchor_lang::prelude::*;` +
> `use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, CloseAccount};` +
> `use anchor_spl::associated_token::AssociatedToken;`. Ajustar a los paths reales de `anchor-spl`
> 1.1.2 si el build reporta un path distinto (escalá si diverge — NO inventes).

---

## CPI firmada — patrón de referencia (AC-9)

Para `release`/`refund`/`close`, la authority del vault es el PDA `escrow_state`. El transfer DEBE
firmarse con las seeds del PDA:

```
signer_seeds = &[&[ b"escrow", sender.key().as_ref(), remittance_id.as_ref(), &[escrow_state.bump] ]]
cpi_accounts = token::Transfer { from: vault, to: <beneficiary_ata|sender_ata>, authority: escrow_state }
cpi_ctx      = CpiContext::new_with_signer(token_program, cpi_accounts, signer_seeds)
token::transfer(cpi_ctx, escrow_state.amount)?
```

- `bump` viene de `escrow_state.bump` (grabado en deposit con `ctx.bumps.escrow_state`) — canónico.
- `remittance_id` viene como ARG (no se almacena); consistencia garantizada por Anchor (si el arg no
  matchea el PDA pasado, la validación de `escrow_state` falla antes de ejecutar).
- **CEI**: mutar `status` a terminal ANTES de la CPI (release/refund). Ya reflejado en los handlers.

---

## Constraint Directives

### OBLIGATORIO
- `overflow-checks = true` en `[profile.release]` **y** `[profile.test]` del `Cargo.toml` workspace (CD-1/AC-10).
- `release` transfiere exclusivamente a la ATA del `beneficiary` grabado (destino validado por constraint: `has_one = beneficiary` + `associated_token::authority = beneficiary`) — CD-3.
- `refund` sin ninguna dependencia de `authority` — solo `sender` (Signer) + `Clock` (CD-4). El `Refund` context NO incluye `authority`.
- Todo transfer de release/refund/close vía CPI firmada con seeds del PDA (`CpiContext::new_with_signer`) — AC-9.
- CEI: mutar `status` a terminal ANTES de cualquier CPI de transfer (AC-2).
- `amount` de la CPI se lee de `escrow_state.amount`, nunca de un arg.
- `space = 8 + EscrowState::INIT_SPACE` (derivado), no literal `154`.
- `token_program: Program<'info, Token>` (SPL clásico) en todo Context que toque el vault (AC-11).
- Cualquier cómputo futuro sobre `amount` con `checked_add`/`checked_sub` mapeando `None → ErrorCode::Overflow` (AC-10).

### PROHIBIDO
- **CD-2**: usar `init_if_needed` en CUALQUIER instrucción (ni habilitar el feature en `Cargo.toml`). Solo `init` explícito.
- **CD-5**: deployar a mainnet — **devnet only**. Mainnet gateado por HU-SOL-19.
- Hardcodear el mint USDC en `lib.rs` (entra como account, se graba en `escrow_state.mint`).
- Usar Token-2022 o `InterfaceAccount` para el vault — pin `Program<'info, Token>` clásico.
- Operadores aritméticos crudos (`+`/`-`) sobre `amount`.
- Almacenar `remittance_id` en `EscrowState` (entra como arg de instrucción).
- Agregar dispute/arbiter, o modificar archivos fuera de `solana-programs/`.
- Agregar dependencias de crate no generadas por `anchor init` (salvo las de test listadas en Files #6).

---

## Test Expectations (W4 — AC-12)

**Framework**: `anchor-bankrun` (`solana-bankrun`) — control DETERMINÍSTICO del `Clock` (warp de
tiempo sin validador real ni `sleep`).

**Setup común** (`tests/escrow.ts`):
- Keypairs: `sender` (depositor), `authority` (facilitator), `attacker` (para el negativo AC-6). `beneficiary` como keypair/Pubkey.
- **Mint SPL local sintético de 6 decimales** creado con `@solana/spl-token` (los unit tests NO usan la Circle USDC devnet — no se puede mintear en bankrun; SDD §10.3).
- ATAs de `sender` y `beneficiary` creadas EXPLÍCITAMENTE (nunca `init_if_needed` en el programa).
- `remittance_id` = `Uint8Array(16)` fijo por caso.
- Deadline: `context.setClock(new Clock(...))` de `solana-bankrun` para avanzar `unix_timestamp` más allá del `deadline` (caso refund-post-deadline).

| Test | Escenario | ACs | Setup / aserción |
|------|-----------|-----|------------------|
| 1 | Happy path deposit→release | AC-1, AC-2, AC-9 | deposit (amount N, deadline futuro) → vault balance N; release por `authority` → `beneficiary_ata` recibe N, vault 0, `status == Released` |
| 2 | Release por signer ≠ authority revierte | AC-6 | deposit; release firmado por `attacker` → error `ConstraintHasOne` (2001); vault intacto |
| 3 | Refund pre-deadline revierte | AC-5 | deposit (deadline futuro); refund por `sender` con clock < deadline → `DeadlineNotReached`; vault intacto |
| 4 | Refund post-deadline funciona (sin authority) | AC-4 | deposit; `context.setClock` avanza a `>= deadline`; refund por `sender` (authority NUNCA firma) → `sender_ata` recibe N, `status == Refunded` |
| 5 | Doble transición revierte | AC-3, AC-2 | deposit→release OK; segundo release → `EscrowNotDeposited`. Variante: deposit→refund OK; luego release → `EscrowNotDeposited` |
| 6 | Re-deposit sobre mismas seeds revierte | AC-7 | deposit OK; segundo deposit con las mismas `[sender, remittance_id]` → error runtime "account already in use" |

**Cobertura adicional recomendada** (no exigida por AC-12, suma a auditoría — incluirla):
- `close` con `status == Deposited` → `EscrowNotTerminal` (AC-8).
- `close` tras release → rent de `escrow_state` + vault de vuelta al `sender`; luego deposit nuevo con las mismas seeds → OK (anti-revival correcto: init limpio post-close).
- `deposit` con `amount == 0` → `ZeroAmount`.

> Si `anchor-bankrun` no estuviera disponible en CI, fallback documentado: `solana-program-test`/litesvm (Rust). Vía primaria = `anchor-bankrun` en TS.

### Criterio Test-First
| Tipo de cambio | Test-first? |
|----------------|-------------|
| Lógica on-chain (handlers/constraints) | Sí — escribir/ajustar el escenario junto con el handler cuando sea posible; en la práctica los 6 escenarios se implementan en W4 tras `anchor build` verde de W3 |

---

## CI, deploy y README (W4)

### `.github/workflows/ci.yml`
- Instala rust (1.97.1), solana (3.1.10), anchor (avm 1.1.2).
- Corre `anchor build` y `anchor test`.
- NO deploya (CI solo build+test).

### `scripts/deploy-devnet.sh` (devnet ONLY — CD-5)
```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# CD-7: la upgrade authority del deploy queda en la EOA del deployer. ANTES de mainnet debe
# migrar a multisig/timelock o deployarse `solana program deploy --final` post-auditoría (HU-SOL-19).
# Este script es SOLO para devnet — NUNCA usar para mainnet en esta HU.
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

### `README.md` (documentar, NO implementar)
- **CD-6** (front-run mitigation): la orden de cashout en TransFi se crea SOLO después de que la tx de `release` esté **finalized** on-chain. El guard de flujo se implementa en HU-SOL-13; acá solo se documenta.
- **CD-7** (upgrade authority): migrar a multisig/timelock o `--final` post-auditoría (HU-SOL-19). No implementar.
- **Mint USDC devnet env-driven**: valor canónico de referencia `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle USDC devnet), pasado por config/env al deploy/integración — **NUNCA literal en `lib.rs`**. Los unit tests usan un mint SPL local sintético.

---

## Definition of Done

- [ ] `anchor build` verde (workspace compila con rustc 1.97.1 / solana 3.1.10 / anchor 1.1.2).
- [ ] `anchor test` 6/6 verde (los 6 escenarios de AC-12 + cobertura extra pasan).
- [ ] `overflow-checks = true` presente en `[profile.release]` **y** `[profile.test]` del `Cargo.toml` workspace.
- [ ] Feature `init-if-needed` AUSENTE de `programs/escrow/Cargo.toml`; solo `init` explícito en `deposit`.
- [ ] `space = 8 + EscrowState::INIT_SPACE` (no literal `154`); `EscrowStatus` deriva `InitSpace`.
- [ ] Los 4 Contexts con los constraints literales de este Story File (has_one, seeds/bump, associated_token::authority, constraint terminal, close=sender).
- [ ] `Refund` context SIN `authority` (CD-4).
- [ ] CPI de release/refund/close firmada por el PDA (`CpiContext::new_with_signer`), amount leído de `escrow_state.amount`.
- [ ] `status` mutado a terminal ANTES de la CPI en release/refund (CEI).
- [ ] `token_program: Program<'info, Token>` (SPL clásico) en todo Context con vault.
- [ ] Mint NO hardcodeado en `lib.rs` (env-driven).
- [ ] CI configurado (`ci.yml` corre build+test).
- [ ] README documenta CD-6 y CD-7 + mint devnet env-driven.
- [ ] `scripts/deploy-devnet.sh` devnet-only con comentario CD-7. Sin deploy a mainnet.
- [ ] Nada modificado fuera de `solana-programs/`.

---

## Out of Scope (Dev NO toca)

- Integración chaski (HU-SOL-13), gasless/relayer (HU-SOL-14), verificación facilitator (HU-SOL-6).
- Auditoría externa + upgrade authority final (HU-SOL-19), deploy mainnet, dispute/arbiter.
- Mapeo fiat (TransFi `depositAddress`) → wallet Solana (HU-SOL-13).
- Crear `beneficiary_ata` dentro de `release` (se asume creada por la capa de negocio; NUNCA vía `init_if_needed`).
- Cualquier archivo fuera de `solana-programs/`.
- NO "mejorar" código adyacente ni agregar funcionalidad no listada.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala al Architect. No inventar, no asumir.**

Situaciones de escalation:
- `anchor init` genera un layout distinto al esperado por este Story File.
- Un path de import de `anchor-spl` 1.1.2 difiere del listado (`token::Transfer`, `CloseAccount`, `AssociatedToken`) — escalá antes de inventar.
- `anchor build` falla por mismatch de versión CLI↔crate irresoluble con lo que init escribe.
- `anchor-bankrun` no instala/corre en el entorno.
- Ambigüedad en un AC o un constraint que este documento no cubre.

---

*Story File generado por NexusAgil — F2.5 — nexus-architect (WKH-215 / HU-SOL-12)*
