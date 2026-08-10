//! Non-custodial escrow for the in-flight moment of a remittance.
//!
//! # What it custodies
//!
//! One SPL token account (the `vault`) per remittance. Its authority is the
//! `escrow_state` PDA, derived from `["escrow", sender, remittance_id]`, so no
//! human and no operator holds a key that can move it. `EscrowState` records the
//! `sender`, the `beneficiary`, the `authority` (operator), the `mint`, the
//! `amount` and the `deadline`, all written once at `deposit` and never mutated
//! afterwards except `status`.
//!
//! # Who can take the money out, and when
//!
//! The `deadline` chosen at deposit cuts time into two windows that never overlap:
//!
//! | Instruction | Who signs | When it is legal | Where the tokens go |
//! |---|---|---|---|
//! | `release` | `authority` (the operator) | `now <  deadline` | the `beneficiary` fixed at deposit |
//! | `refund`  | `sender` | `now >= deadline` | back to the `sender` |
//!
//! `deposit` requires the beneficiary's associated token account for the escrow's mint to already
//! exist, and it never creates it. That is the same account `release` will require, so a deposit
//! that could not be settled for that reason is rejected before any token moves. It bounds the
//! case "the account never existed"; it does not cover a beneficiary that closes the account after
//! the deposit, which stays possible and leaves the refund path as the only exit.
//!
//! Both also require `status == Deposited` and both write a terminal status
//! *before* the transfer, so neither can run twice. Because the two windows are
//! disjoint, at most one of them is legal at any instant: the operator cannot
//! outrun a sender who is refunding, and the sender cannot claw back a payment
//! the operator already made. That is the single invariant worth attacking.
//!
//! No instruction can send tokens to an address that was not written into
//! `EscrowState` at deposit time, and no key can move the vault anywhere else.
//! The beneficiary written at deposit time is additionally required, at that same moment, to hold
//! an associated token account for the mint being escrowed.
//!
//! `deadline` is clamped at deposit to `[now + MIN_CUSTODY_SECS, now +
//! MAX_CUSTODY_SECS]` (1 h to 24 h), so the sender's worst case wait before the
//! refund path opens is bounded by the program and not by the operator.
//!
// ⚠️ CORRECCION 2026-08-04, y va en `//` a proposito (los `//!` viajan al IDL):
// la palabra "clamped" de arriba es FALSA. `deposit` NO clampea en silencio: RECHAZA
// con `DeadlineTooSoon` / `DeadlineTooLate` (los `require!` de este mismo archivo, en
// el cuerpo de `deposit`). El efecto para el remitente es el mismo techo y el mismo
// piso, pero un cliente que asuma clamping va a mandar un deadline fuera de rango y
// recibir un error en vez de un valor ajustado.
// NO se corrige el `//!` porque Anchor copia los doc comments al IDL: cambiar esa
// linea mueve el sha256 canonico, que esta publicado en cadena y pinneado por los dos
// consumidores. Medido: al cambiarla, el hash pasa de fb64c937... a otro y el test
// AC-3 del facilitator se pone rojo. Se corrige cuando se republique el IDL.
//! # What it deliberately does not do
//!
//! No fees, no partial release, no dispute resolution, and no admin instruction
//! that can touch a live escrow. `close` runs only from a terminal state and only
//! returns rent, plus any tokens a stranger sent to the vault, to the sender.
//!
//! # What still requires trust
//!
//! The program is deployed under the upgradeable loader and its upgrade authority
//! is a single key: whoever holds it can replace all of the above. See
//! `SECURITY.md` and the README for the current authority and for the two known
//! custody limitations (a mint's freeze authority can freeze the vault, and the
//! vault's associated token account can be front-created to block a deposit).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x");

// On-chain contact card, readable straight off the deployed binary with
// `solana-verify get-security-txt` or the Neodyme parser, so a finder does not
// have to guess who to tell. Compiled out under `no-entrypoint` (the feature used
// when this crate is pulled in as a CPI dependency) so it ships only in the
// program itself. Every field name here is validated by the crate's parser, which
// rejects unknown keys; `contacts` entries must be `type:value`.
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "WasiAI escrow",
    project_url: "https://github.com/ferrosasfp/solana-programs",
    contacts: "email:fernando@wasiai.io",
    policy: "https://github.com/ferrosasfp/solana-programs/blob/main/SECURITY.md",
    preferred_languages: "es,en",
    source_code: "https://github.com/ferrosasfp/solana-programs",
    // Stated because "no audit" is itself information a reviewer needs, and an
    // absent field would read as an oversight rather than as the answer.
    auditors: "None"
}

// ---------------------------------------------------------------------------
// Los rieles de la ventana de custodia
// ---------------------------------------------------------------------------
//
// Estas dos constantes son los RIELES EXTERIORES del plazo de custodia: acotan qué deadline puede
// entrar. El valor OPERATIVO de todos los días (el que elige el cliente al depositar) lo fijan los
// consumidores adentro de estos rieles; acá sólo está el límite duro que un redespliegue puede
// mover y nada más.
//
// ⚠️ LOS DOS NÚMEROS SON PROVISORIOS. Decisión del founder del 2026-07-31, tomada SIN la medición
// que debería fijarlos. Lo que los cambiaría es UNA cosa concreta y sólo una: **la medición del
// tiempo real que tarda la pata fiat del proveedor cuando esté conectado de verdad**, extremo a
// extremo, desde que se despacha la orden hasta que se puede confirmar el desembolso. Hoy ese
// número no existe: no está medido, está supuesto.
//
// Y hay un resultado de esa medición que NO se resuelve tocando una constante: **si el peor tiempo
// medido del proveedor supera MAX_CUSTODY_SECS (24 h), subir el techo es la respuesta equivocada.**
// Eso sería un hallazgo de producto, no de configuración, y significa que el producto le está
// pidiendo a una persona que le mandó plata a su familia que espere más de un día hábil sin poder
// recuperarla ni saber si llegó. La decisión ahí es de producto (cambiar de proveedor, partir el
// flujo, o declarar el plazo por adelantado), y hay que tomarla antes de tocar este archivo.

/// Piso de la ventana de custodia: 1 hora.
///
/// Por qué existe: un deadline demasiado corto reabre exactamente la carrera que este programa
/// viene a matar. Debajo de una hora el operador no llega a completar la pata fiat, así que el
/// release le queda estructuralmente fuera de alcance y el sender termina refundeando remesas que
/// sí se estaban pagando. PROVISORIO: ver la nota de arriba.
///
/// LA OTRA MITAD DE ESTE NÚMERO, que hay que leer junto con la de arriba: el piso es también el
/// tiempo MÍNIMO durante el cual el sender NO puede recuperar su plata. `refund` exige
/// `now >= deadline` y el deadline no puede entrar por debajo de este piso, así que un depósito
/// hecho por error queda inmovilizado por lo menos una hora. Con el TTL de 10 minutos que usa hoy
/// el cliente ese piso multiplica por seis la espera del sender. Subir el piso mejora el margen del
/// operador y empeora exactamente esto, en la misma proporción y sin compensación.
pub const MIN_CUSTODY_SECS: i64 = 3_600;

/// Techo de la ventana de custodia: 24 horas.
///
/// Por qué existe: es la exposición MÁXIMA del sender si el operador desaparece justo después del
/// depósito. 24 h es el estándar de día hábil siguiente en remesas: cubre un release manual y un
/// proveedor que liquida por lotes, y sigue siendo lo que una persona tolera. PROVISORIO: ver la
/// nota de arriba, incluido el caso en que la medición lo supere.
pub const MAX_CUSTODY_SECS: i64 = 86_400;

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
        // La ventana de custodia se acota por los DOS lados. Los dos lados de cada comparación son
        // independientes: el `deadline` viene en los args de la ix y el `now` sale del Clock del
        // validador, que ningún cliente puede escribir. `saturating_add` porque el perfil release
        // tiene `overflow-checks = true`: sin él, un `now` cerca de i64::MAX haría panic en vez de
        // devolver el error, y un panic no es un rechazo legible.
        let now = Clock::get()?.unix_timestamp;
        require!(
            deadline >= now.saturating_add(MIN_CUSTODY_SECS),
            ErrorCode::DeadlineTooSoon
        );
        require!(
            deadline <= now.saturating_add(MAX_CUSTODY_SECS),
            ErrorCode::DeadlineTooFar
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

        // 3. INTERACTIONS: transfer-in, sender firma DIRECTO (no PDA). sender_ata -> vault.
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
    ///
    /// LA INVARIANTE, que es lo único que hay que atacar para tumbar este programa: para toda
    /// cuenta y todo instante, a lo sumo UNA de `release` y `refund` puede entrar.
    ///
    /// Que `release` y `refund` exijan exactamente el mismo estado (`Deposited`) no los vuelve
    /// intercambiables: lo que los separa es el RELOJ, no el estado. `release` sólo entra con
    /// `now < deadline` y `refund` sólo con `now >= deadline`, así que para todo instante a lo sumo
    /// uno de los dos es legal.
    pub fn release(ctx: Context<Release>, remittance_id: [u8; 16]) -> Result<()> {
        // 1. CHECKS
        require!(
            ctx.accounts.escrow_state.status == EscrowStatus::Deposited,
            ErrorCode::EscrowNotDeposited
        );
        // LA guarda que faltaba. Sin esto, "pasado el plazo recuperás tu plata" es falso: el
        // release seguía siendo legal para siempre, así que el sender que va a refundear no ejerce
        // un derecho, entra en una carrera contra alguien que puede reintentar indefinidamente.
        // El orden importa: el chequeo de estado va PRIMERO para que un segundo release sobre un
        // escrow ya terminal siga reportando EscrowNotDeposited y no la ventana.
        require!(
            Clock::get()?.unix_timestamp < ctx.accounts.escrow_state.deadline,
            ErrorCode::ReleaseWindowClosed
        );

        // 2. EFFECTS (ANTES de la CPI: CEI / AC-2)
        ctx.accounts.escrow_state.status = EscrowStatus::Released;

        // 3. INTERACTIONS: CPI firmada por el PDA, vault -> beneficiary_ata, por escrow_state.amount
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
        // Igualdad contra la ÚNICA variante no terminal, no una negación ni un predicado de
        // conjunto: desde un estado terminal el vault ya se vació, pero cualquiera puede volver a
        // fondearlo (es una ATA de dirección derivable), y con el vault lleno el que rechaza tiene
        // que ser esta línea y no SPL. Cubierto por escrow-window.ts C1..C4, que refondean el vault
        // a propósito antes de intentarlo.
        require!(
            ctx.accounts.escrow_state.status == EscrowStatus::Deposited,
            ErrorCode::EscrowNotDeposited
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.escrow_state.deadline,
            ErrorCode::DeadlineNotReached
        );

        // 2. EFFECTS (ANTES de la CPI: CEI / AC-2)
        ctx.accounts.escrow_state.status = EscrowStatus::Refunded;

        // 3. INTERACTIONS: CPI firmada por el PDA, vault -> sender_ata, por escrow_state.amount
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

    /// La lista blanca de estados terminales (AC-8) va en el Context. Acá barremos el vault y lo
    /// cerramos.
    ///
    /// EL BARRIDO, y decir exactamente qué barre: `CloseAccount` de SPL exige saldo CERO. Como el
    /// vault es una ATA con dirección derivable, cualquiera puede mandarle 1 unidad atómica después
    /// del release y trabar el cierre para siempre, dejando muerto el rent de dos cuentas. Esta
    /// instrucción manda al `sender_ata` **todo `vault.amount`, sin cota superior**, y recién ahí
    /// cierra. No es "el polvo": si un tercero deposita mil tokens en el vault de un escrow ya
    /// terminal, los mil se los lleva el sender. Es inofensivo (el principal ya se pagó y quien
    /// dona un token a una cuenta ajena lo está regalando), pero quien lea "polvo" dimensiona mal
    /// la instrucción, así que queda escrito el caso concreto que lo refutaría.
    ///
    /// Por qué el remanente va al SENDER y no al beneficiary: llegado este punto el escrow ya está
    /// en un estado terminal, o sea que el monto custodiado ya se pagó completo a quien
    /// correspondía. Lo que quede acá no es parte del principal, y el sender es quien pagó el rent
    /// de las dos cuentas que se están cerrando.
    pub fn close(ctx: Context<Close>, remittance_id: [u8; 16]) -> Result<()> {
        let sender_key = ctx.accounts.sender.key();
        let bump = ctx.accounts.escrow_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            sender_key.as_ref(),
            remittance_id.as_ref(),
            &[bump],
        ]];

        let remaining = ctx.accounts.vault.amount;
        if remaining > 0 {
            let sweep_accounts = anchor_spl::token::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.sender_ata.to_account_info(),
                authority: ctx.accounts.escrow_state.to_account_info(),
            };
            let sweep_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                sweep_accounts,
                signer_seeds,
            );
            anchor_spl::token::transfer(sweep_ctx, remaining)?;
        }

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

        // El índice es OPCIONAL: si el caller mandó `null` no hay nada que limpiar (ese es el caso
        // de un sender que nunca llamó `register_escrow`). Va al final del cuerpo sólo para dejar
        // el bloque de CPIs de arriba sin tocar: los constraints del Context — incluido
        // `is_terminal()` — corren antes que todo esto, así que un `close` rechazado no llega acá.
        // Misma expresión que `deregister_escrow`, a propósito duplicada y no factorizada.
        if let Some(index) = ctx.accounts.escrow_index.as_mut() {
            index.entries.retain(|e| *e != remittance_id);
        }
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

        // 2. EFFECTS: escrituras IDEMPOTENTES del header (CD-9), `sender` y `bump` están fijados
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

// ⚠️ CORRECCION 2026-08-05, y va en `//` a proposito (los `///` viajan al IDL y le mueven el
// sha256 canónico publicado en cadena; mismo patrón que el bloque del Context `Deposit`, y la
// fila "On-chain IDL" del README):
// el doc comment de abajo dice que "el índice solo lista escrows en estado Deposited" y DIMENSIONA
// MAX_ENTRIES sobre esa premisa. La premisa sigue siendo falsa: `register_escrow` exige Deposited
// UNA SOLA VEZ, en el instante del registro (constraint de RegisterEscrow, más abajo en este
// archivo), y después el estado del escrow puede cambiar sin que la entrada se entere.
//
// QUÉ CAMBIÓ (WKH-326): `close` ahora declara la cuenta `escrow_index` como OPCIONAL y, cuando se
// la pasan, saca del índice el id del escrow que está cerrando (ver el `if let Some` al final del
// handler `close`). `release` y `refund` siguen sin tocar el índice — se puede comprobar leyendo
// sus dos Contexts, ninguno declara la cuenta.
// CONSECUENCIA MEDIBLE: el cap dejó de ser monótono. Un sender que hace
// `deposit → register_escrow → release → close` pasándole el índice al `close` puede repetir el
// ciclo indefinidamente; el `register_escrow` número 33 entra (test 14 de tests/escrow-index.ts
// corre exactamente 33 ciclos y antes de este cambio moría con EscrowIndexFull / 6005).
//
// QUÉ SIGUE EN PIE, y es refutable con un input concreto:
// 1. Si el sender nunca llama `close`, el cupo no se libera: `close` es opt-in y hoy ningún
//    consumidor la construye. 32 escrows registrados y jamás cerrados siguen dando 6005 en el 33º.
// 2. Si el sender llama `close` SIN pasar el índice (`escrowIndex: null`), la entrada queda
//    colgada igual que antes. Omitir la cuenta no es un error: es el camino de quien nunca
//    registró nada.
// 3. Para las entradas cuyo `EscrowState` ya se cerró antes de este cambio, `close` no sirve
//    (ya no existe la cuenta que cierra), y `deregister_escrow` sigue siendo la única salida.
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
    // id16 de los escrows REGISTRADOS del sender: estaban Deposited cuando se registraron. Salen
    // por dos caminos y sólo por esos dos: un `deregister_escrow` explícito, o un `close` al que
    // se le pasa esta cuenta. Un `close` con `escrowIndex: null`, o un escrow que nadie cierra,
    // dejan la entrada acá indefinidamente (ver el bloque de MAX_ENTRIES).
    pub entries: Vec<[u8; 16]>, //  4 + 16·32 = 516
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
    Deposited, // 0 — el único estado NO terminal
    Released,  // 1 — terminal
    Refunded,  // 2 — terminal
    // EXACTAMENTE TRES VARIANTES, y el número es parte del contrato con los consumidores: el IDL
    // que pinnean chaski-v3 y el facilitator declara estas tres, así que un byte de status 4º haría
    // que su `BorshAccountsCoder` tire `TypeError` al decodificar la cuenta. Una variante nueva
    // (por ejemplo el `PayoutPending` de la fase 2, ver README) se apendiza al FINAL (los
    // discriminantes 0, 1 y 2 están escritos en cuentas VIVAS y moverlos le cambia el significado a
    // bytes que ya existen) y NO se despliega hasta que los dos consumidores publiquen el IDL nuevo
    // y traten el estado nuevo. El test E1b de escrow-window.ts es el alambre de ese contrato.
}

impl EscrowStatus {
    /// Estados TERMINALES: la plata ya salió del vault y la cuenta se puede cerrar.
    ///
    /// Lista blanca a propósito y no `!= Deposited`, aunque HOY las dos expresiones den lo mismo
    /// (el enum tiene una sola variante no terminal). La diferencia aparece el día que se agregue
    /// otra variante no terminal: la negación dejaría cerrar esa cuenta con el vault lleno y la
    /// lista blanca no. Escribirlo así es lo que hace que agregar un estado no abra un agujero.
    pub fn is_terminal(&self) -> bool {
        matches!(self, EscrowStatus::Released | EscrowStatus::Refunded)
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("Deposit amount must be greater than zero")]
    ZeroAmount,
    /// Ya no la tira nadie: el piso de la ventana de custodia (`DeadlineTooSoon`) es estrictamente
    /// más fuerte que "el deadline está en el futuro". Se conserva la VARIANTE, no su uso, porque
    /// los códigos de Anchor son posicionales desde 6000 y borrarla renumeraría todo lo que sigue.
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
    // Apendizados al FINAL por el mismo motivo que EscrowIndexFull: 6006, 6007 y 6008 en ese orden.
    #[msg("Deadline is below the minimum custody window")]
    DeadlineTooSoon,
    #[msg("Deadline is above the maximum custody window")]
    DeadlineTooFar,
    #[msg("The release window is closed: the deadline has been reached")]
    ReleaseWindowClosed,
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
// `beneficiary` se agrega acá (WKH-343) para que las constraints de `beneficiary_ata`, al final de
// esta struct, puedan derivar la ATA canónica del destinatario. Es el MISMO arg que el handler graba
// en `escrow.beneficiary`, así que la cuenta validada y el beneficiario grabado no pueden diferir.
// Los 5 args de la instrucción NO cambian (CD-12): esto sólo los pone en scope en `try_accounts`,
// igual que ya se hacía con `remittance_id` para las seeds del PDA.
#[instruction(remittance_id: [u8; 16], beneficiary: Pubkey)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    // ⚠️ CORRECCION 2026-08-04, ACTUALIZADA POR WKH-343 (2026-08-10).
    // Lo que decía esta nota: que el `///` de abajo justificaba no clavar el mint citando un
    // co-firmante off-chain que "se niega a firmar un depósito con un mint inesperado", que ese
    // control NO EXISTE (CR-1 del facilitator nunca compara el mint contra `SOLANA_USDC_MINT`,
    // aunque sí lo hace en las otras dos rutas del mismo servicio), y que el `///` NO se corregía
    // porque Anchor lo copia al IDL y eso movería el sha256 canónico publicado en cadena.
    // QUÉ CAMBIÓ: WKH-343 agrega la cuenta `beneficiary_ata` a esta struct, así que el hash del IDL
    // se mueve POR CONSTRUCCIÓN y la ventana para corregir el `///` quedó abierta. Se usó, y el
    // párrafo falso ya no está: el `///` de abajo describe el control que SÍ existe.
    // QUÉ SIGUE EN PIE, y es refutable con un input concreto: el programa sigue aceptando CUALQUIER
    // mint y nadie lo filtra aguas arriba. Validar el mint vive en `wasiai-facilitator` y sigue sin
    // hacerse. El guard que agrega WKH-343 NO es un validador de mint (ver el párrafo de abajo).
    /// Acepta CUALQUIER mint, y es una decisión, no un olvido. El programa es infraestructura de
    /// escrow genérica; "qué token vale un dólar" es política de producto y vive aguas arriba, en
    /// el componente que arma el depósito. Clavarlo acá obligaría a dos builds, dos IDL, dos hashes
    /// pinneados y un redespliegue para rotarlo.
    ///
    /// ⚠️ NO hay hoy ningún control que rechace un mint inesperado. El co-firmante off-chain que
    /// esta decisión daba por sentado no compara el mint contra nada. Es una ausencia conocida y
    /// declarada, no un supuesto: el que decide qué mint es aceptable es quien construye la
    /// transacción, y hoy nadie lo verifica.
    ///
    /// LO QUE ESTA STRUCT SÍ EXIGE, y es distinto de clavar el mint: que el mint sea CONSISTENTE
    /// con un beneficiario capaz de recibirlo (ver `beneficiary_ata`, al final de esta struct). Es
    /// un invariante RELACIONAL entre el mint y el destinatario, y por eso una constante global no
    /// lo expresa: clavar el mint no habría prevenido el incidente de WKH-343 (los 4 depósitos
    /// trabados estaban sobre el mint que el producto quiere usar) y además rechazaría ese mismo
    /// token. Lo que se violó no fue `mint == X`.
    ///
    /// LA CONDICIÓN QUE DA VUELTA ESTA DECISIÓN, escrita para que se pueda comprobar: el día que
    /// exista un barrido que descubra depósitos on-chain y los tome por buenos SIN co-firma,
    /// el mint tiene que clavarse acá, porque ahí un depósito auto-fondeado con el mint de un
    /// atacante entraría a un camino de producto. Los enumeradores de hoy (EscrowIndex y el
    /// resolver de ids) sólo alimentan el refund, que es inofensivo.
    ///
    /// LO QUE ESTA DECISIÓN SE LLEVA PUESTO, y es el único atrapamiento permanente que conocemos:
    /// el vault es una token account SPL común de este mint. Si el mint tiene FREEZE AUTHORITY (el
    /// USDC real la tiene), esa authority puede congelar el vault, y una token account congelada
    /// rechaza toda transferencia: ni `release` ni `refund` pueden mover un token, sin importar el
    /// deadline, la firma ni el estado. Elegir el mint es elegir a qué freeze authority te exponés.
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = sender,
        space = 8 + EscrowState::INIT_SPACE,
        seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// `init` y no `init_if_needed`, y eso tiene un costo conocido: la dirección de esta ATA es
    /// derivable antes del depósito, así que cualquiera que vea o adivine los 16 bytes del
    /// `remittance_id` puede crearla primero por ~0.002 SOL y dejar ese par (sender, remittance_id)
    /// sin poder depositar nunca. No hay fondos en riesgo y la salida es usar otro id. Es
    /// PRE-EXISTENTE, no lo introduce la ventana de custodia, y está escrito en el README.
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

    // WKH-343. AL FINAL DE LA LISTA A PROPOSITO, despues de system_program, rompiendo la convencion
    // de "los programas van ultimos". El motivo es el ORDEN DE DESPLIEGUE: Anchor solo falla por
    // cuentas de MENOS (anchor-syn 1.1.2 codegen/accounts/try_accounts.rs:48,64) y las de sobra van a
    // remaining_accounts (anchor-lang 1.1.2 src/context.rs:68), asi que una cuenta agregada AL FINAL
    // la ignora el binario viejo y un cliente actualizado puede desplegarse ANTES que el programa,
    // sin ventana en la que los depositos fallen. Insertarla en el medio rompe eso: el binario viejo
    // leeria esta cuenta como su `token_program`. El test 14 de tests/escrow.ts ejerce el mecanismo.
    // OJO: eso vale para el orden CLIENTE-PRIMERO. El orden inverso (programa nuevo, cliente viejo)
    // SI tiene ventana de falla, y su sintoma es engañoso: el programa nuevo lee como
    // `beneficiary_ata` la ultima cuenta que mande el cliente viejo y falla nombrando ESTA cuenta,
    // cuando la causa real es que el cliente no se actualizo.
    //
    // Que valida, y que NO: valida que en el instante del DEPOSITO exista la ATA canonica del
    // beneficiario para este mint, que es exactamente la cuenta que `release` va a exigir (ver
    // Release.beneficiary_ata en este mismo archivo, con las MISMAS dos constraints). Por eso un
    // deposito que entra no puede quedar sin camino de entrega POR ESTA CAUSA.
    // NO garantiza que siga existiendo en el instante del release: el beneficiario puede cerrarla
    // despues (SPL CloseAccount, la firma su dueño, nadie se lo puede impedir). O sea que ACOTA el
    // caso "nunca existio" y deja ABIERTO "existia y se cerro". El test 15 de tests/escrow.ts ejerce
    // ese caso a proposito, para que el limite quede ejecutable y no sea una nota de prosa.
    //
    // `associated_token::` y no `token::`, y no es intercambiable: `token::` aceptaria cualquier
    // token account del beneficiario con este mint, incluida una que NO es la ATA canonica, y
    // `release` exige la canonica. El guard tiene que exigir exactamente lo mismo que el que va a
    // cobrar, o no predice nada.
    // SIN `mut`: en `deposit` no se le transfiere nada a esta cuenta, solo se comprueba que exista.
    // Menos privilegio, y obliga a que alguien agregue el `mut` a mano el dia que quiera mandarle
    // tokens desde aca.
    // SIN `init` ni `init_if_needed`, y es una decision, no un olvido: crear la ATA aca completaria
    // un pago del activo equivocado de forma irreversible, y ademas le habria sacado la salida a los
    // 4 depositos trabados del incidente (habrian quedado `Released`, que es terminal, y los 4
    // refunds del 2026-08-10 habrian revertido con EscrowNotDeposited).
    #[account(
        associated_token::mint = mint,
        associated_token::authority = beneficiary
    )]
    pub beneficiary_ata: Account<'info, TokenAccount>,
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
        // LISTA BLANCA, no `!= Deposited`, aunque hoy den lo mismo. Ver `is_terminal`: la
        // diferencia aparece el día que exista otra variante no terminal, donde la negación
        // dejaría cerrar esa cuenta con el vault LLENO y el único que frenaría sería SPL, y sólo
        // mientras el vault no esté vacío.
        constraint = escrow_state.status.is_terminal() @ ErrorCode::EscrowNotTerminal,
        close = sender
    )]
    pub escrow_state: Account<'info, EscrowState>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow_state
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Destino del barrido. Cuenta NUEVA en esta instrucción: los consumidores que hoy arman el
    /// `close` con la lista vieja tienen que agregarla. No existe orden de despliegue seguro entre
    /// programa y cliente para este cambio (ver README, "Deploying"): las dos combinaciones cruzadas
    /// fallan. Hoy ningún consumidor construye `close`, así que es una restricción hacia adelante y
    /// no un corte en vivo.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender
    )]
    pub sender_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// Índice del sender, cuenta OPCIONAL. Si se la pasa, `close` saca de `entries` el
    /// `remittance_id` que está cerrando; si se la omite, `close` no la lee ni la crea (un sender
    /// que nunca llamó `register_escrow` no tiene esta PDA y su `close` tiene que funcionar igual).
    ///
    /// Omitirla se escribe `escrowIndex: null` EXPLÍCITO. Dejar la clave afuera del objeto de
    /// cuentas NO la omite: el cliente deriva la PDA `["escrow-index", sender]` a partir de las
    /// seeds que declara este IDL y la manda igual, y si esa cuenta no existe la tx revierte con
    /// `AccountNotInitialized` (3012), un error que no nombra la palabra "opcional" y manda a
    /// buscar donde no es.
    ///
    /// Omitirla cuando el índice SÍ existe y SÍ contiene el id no revierte: deja la entrada
    /// colgada, ocupando uno de los 32 lugares hasta que alguien llame `deregister_escrow` con ese
    /// id. O sea que la omisión reintroduce, para ese id, el cap monótono que esta cuenta existe
    /// para evitar.
    ///
    /// Regla para el cliente: un `getAccountInfo` sobre `["escrow-index", sender]` antes de armar
    /// la tx. Si devuelve una cuenta, pasarla; si devuelve null, `null` explícito.
    #[account(
        mut,
        seeds = [b"escrow-index", sender.key().as_ref()],
        bump = escrow_index.bump
    )]
    pub escrow_index: Option<Account<'info, EscrowIndex>>,
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
