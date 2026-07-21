# SDD #001: Programa escrow on-chain (Rust/Anchor) + workspace

> SPEC_APPROVED: no
> Fecha: 2026-07-21
> Tipo: feature
> SDD_MODE: full
> Branch: feat/001-escrow-anchor
> Artefactos: doc/sdd/001-escrow-anchor/
> WKH: WKH-215 / HU-SOL-12
> Modo: QUALITY (AR obligatorio — custodia de fondos USDC, ruta crítica Sprint 1)

---

## 1. Resumen

Se construye un programa Anchor **greenfield** (`solana-programs/`, workspace nuevo) que
implementa un escrow trustless de USDC en Solana. Reemplaza la custodia off-chain del flujo
de remesas Chaski/TransFi: el `sender` deposita USDC en un vault (ATA cuya authority es el
PDA `escrow_state`), y los fondos solo pueden salir por dos caminos terminales y mutuamente
excluyentes: `release` (invocado por la `authority`/facilitator, paga SIEMPRE al
`beneficiary` grabado en el `deposit`) o `refund` (invocado por el `sender` una vez pasado el
`deadline`, sin ninguna dependencia del facilitator). El programa espeja las propiedades de
seguridad del EVM `WasiAIEscrow.sol` (máquina de estados terminal, destino fijo, CEI) pero
con el modelo nativo de Solana (PDA / vault ATA / CPI firmada con `invoke_signed`).

Resultado esperado: workspace que compila (`anchor build` verde), suite `anchor test` con los
6 escenarios de AC-12 en verde, CI que corre build+test, y script de deploy a **devnet**
(mainnet gateado por auditoría externa — HU-SOL-19, fuera de scope). Este SDD va a auditoría
externa antes de mainnet, por lo que el nivel de detalle es de producción.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 001 (WKH-215 / HU-SOL-12) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Escrow Anchor no-custodial de USDC con release-a-destino-fijo y refund operador-independiente |
| **Reglas de negocio** | `release` paga solo al `beneficiary` de `deposit`; `refund` solo `sender`+`deadline`; transición terminal única; devnet only |
| **Scope IN** | Workspace Anchor completo, instrucciones `deposit`/`release`/`refund`/`close`, PDA `escrow_state`, vault ATA, tests (6 escenarios), CI, script deploy devnet |
| **Scope OUT** | Integración chaski (HU-SOL-13), gasless/relayer (HU-SOL-14), verificación facilitator (HU-SOL-6), auditoría + upgrade authority final (HU-SOL-19), mainnet, dispute/arbiter |
| **Missing Inputs** | Los 2 [NEEDS CLARIFICATION] del work-item — **RESUELTOS en §10 de este SDD** |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1 (CR-4)**: WHEN `release` la invoca la `authority`, THE system SHALL transferir el balance del vault ÚNICAMENTE a la ATA del `beneficiary` grabado en `deposit`, sin importar qué cuenta se pase.
- **AC-2 (CR-3/CR-7)**: WHEN `status == Deposited` AND `release`/`refund` tiene éxito, THE system SHALL setear `status` a `Released`/`Refunded` (terminal irreversible).
- **AC-3 (CR-3/CR-7)**: IF `release`/`refund` se invoca WHILE `status != Deposited`, THEN THE system SHALL revertir (`EscrowNotDeposited`) sin mover fondos.
- **AC-4**: WHEN `refund` se invoca, THE system SHALL exigir `signer == sender` AND `Clock::now >= deadline`, sin requerir firma/disponibilidad de la `authority`.
- **AC-5**: IF `refund` se invoca WHILE `Clock::now < deadline`, THEN THE system SHALL revertir (`DeadlineNotReached`).
- **AC-6**: IF `release` la invoca `signer != authority`, THEN THE system SHALL revertir (`has_one = authority`).
- **AC-7 (ME-1)**: WHEN `deposit` se invoca, THE system SHALL crear `escrow_state` con `init` (NUNCA `init_if_needed`); re-`deposit` con las mismas seeds falla "account already in use".
- **AC-8 (ME-1)**: WHEN `close` se invoca, THE system SHALL exigir `status != Deposited` AND cerrar con `close = depositor`; las seeds solo reusables vía `init` nuevo.
- **AC-9 (ME-1)**: THE system SHALL fijar la authority del vault como el PDA `escrow_state` AND ejecutar todo transfer de `release`/`refund` vía CPI firmada con las seeds del PDA (`invoke_signed`).
- **AC-10 (ME-1)**: THE system SHALL compilar con `overflow-checks = true` (`[profile.release]` y `[profile.test]`) AND usar `checked_add`/`checked_sub` para cómputo sobre `amount`.
- **AC-11 (ME-1)**: THE system SHALL declarar `token_program: Program<'info, Token>` (SPL clásico, NO Token-2022) en todo `Context` que toque el vault.
- **AC-12**: WHEN `anchor test`, THE system SHALL correr y pasar 6 escenarios (ver §8).

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `solana-programs/doc/sdd/001-escrow-anchor/work-item.md` | Input autoritativo (F1 aprobado) | 12 ACs EARS, DT-1..5 (layout `EscrowState`, enum), CD-1..7, Scope IN/OUT, 2 clarifications |
| `wasiai-a2a/contracts/src/WasiAIEscrow.sol` | Referencia conceptual EVM (WKH-191) | Máquina de estados terminal, CEI (effects antes de interactions), destino-fijo grabado en deposit, no-custodia por clave única de operador, `checked`/SafeERC20, riesgo externo USDC pausable aceptado |

### Verificación de toolchain (ejecutada)

| Herramienta | Versión requerida | Verificado |
|-------------|-------------------|------------|
| anchor-cli | 1.1.2 | SÍ (`anchor --version` → `anchor-cli 1.1.2`) |
| solana-cli | 3.1.10 | SÍ (`solana --version` → `3.1.10 (Agave)`) |
| rustc | 1.97.1 | SÍ (`rustc --version` → `1.97.1`) |

### Estado del repo objetivo

| Path | Existe | Nota |
|------|--------|------|
| `solana-programs/` | Solo `doc/` | Greenfield. `anchor init` lo corre F3/Dev (W0), NO este SDD. |
| `solana-programs/doc/sdd/_INDEX.md` | SÍ | Fila 001 `in progress`. Sin HUs DONE previas → sin `auto-blindaje.md` que heredar (paso Auto-Blindaje salteado: proyecto nuevo). |

### Exemplars

| Para crear | Seguir patrón de | Razón |
|-----------|------------------|-------|
| `programs/escrow/src/lib.rs` (máquina de estados, CEI, destino-fijo) | `wasiai-a2a/contracts/src/WasiAIEscrow.sol` (conceptual, NO port 1:1) | Propiedades de seguridad; adaptadas al modelo PDA/vault/CPI de Solana |
| Estructura del workspace (`Anchor.toml`, `Cargo.toml`, `programs/*/Cargo.toml`, `tests/*.ts`) | Scaffold canónico de `anchor init` (anchor-cli 1.1.2) | Layout estándar Anchor; se genera en W0 y se edita |

> **Nota anti-alucinación**: NO existe otro programa Anchor en el ecosistema `wasiai-*` del
> cual copiar. El único exemplar de lógica es el EVM (conceptual). Todo detalle Anchor de este
> SDD (tipos, constraints, CPI) sale del modelo estándar de anchor-spl 1.1.2 verificado, no de
> un archivo copiable — por eso el diseño va explícito campo por campo abajo.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Wave |
|---------|--------|-------------|------|
| `Anchor.toml` | Crear (init+editar) | `[toolchain] anchor_version="1.1.2"`; `[programs.devnet]` con program id; `[provider] cluster="devnet"`; `[scripts] test` | W0 |
| `Cargo.toml` (workspace root) | Crear (init+editar) | `[workspace] members=["programs/*"]`; **`[profile.release] overflow-checks=true`** y **`[profile.test] overflow-checks=true`** (CD-1/AC-10) | W0 |
| `programs/escrow/Cargo.toml` | Crear (init+editar) | deps `anchor-lang`, `anchor-spl` (ambos `=1.1.2`... o la versión que resuelva anchor init, ver §4.10); features `init-if-needed` **NO** habilitada (CD-2) | W0 |
| `programs/escrow/src/lib.rs` | Crear | `declare_id!`, `#[program]` con `deposit`/`release`/`refund`/`close`; `EscrowState`, `EscrowStatus`, `#[error_code] ErrorCode`, los 4 `#[derive(Accounts)]` | W1-W3 |
| `tests/escrow.ts` | Crear | Suite TS con `anchor-bankrun` (solana-bankrun) — 6 escenarios AC-12 con control determinístico del `Clock` | W4 |
| `package.json` / `tsconfig.json` / `yarn.lock` | Crear (init+editar) | Deps de test: `@coral-xyz/anchor`, `solana-bankrun`, `anchor-bankrun`, `@solana/spl-token`, `chai`, `ts-mocha` | W0/W4 |
| `.github/workflows/ci.yml` | Crear | CI: instala rust/solana/anchor (avm), corre `anchor build` + `anchor test` | W4 |
| `scripts/deploy-devnet.sh` | Crear | `solana config set --url devnet` + `anchor deploy --provider.cluster devnet`; comentario CD-7 (upgrade authority) | W4 |
| `README.md` | Crear (editar el de init) | Doc CD-6 (orden TransFi post-release-finalized) + CD-7 (upgrade authority) + mint devnet env-driven | W4 |

### 4.2 Estado on-chain — `EscrowState`

Layout exacto (DT-2 del work-item, tal cual):

```rust
#[account]
#[derive(InitSpace)]
pub struct EscrowState {
    pub sender: Pubkey,       // 32 — depositor/payer; único autorizado a firmar refund (AC-4)
    pub beneficiary: Pubkey,  // 32 — owner de la ATA destino; fijado en deposit, inmutable (CR-4/CD-3)
    pub authority: Pubkey,    // 32 — facilitator/operator; único autorizado a release (AC-6)
    pub mint: Pubkey,         // 32 — mint de USDC (env-driven, ver §10.3)
    pub amount: u64,          //  8 — monto custodiado
    pub deadline: i64,        //  8 — unix ts; comparado contra Clock (AC-4/AC-5)
    pub status: EscrowStatus, //  1 — Deposited | Released | Refunded
    pub bump: u8,             //  1 — bump canónico del PDA (para invoke_signed)
}
```

**Cálculo de `space` (EXACTO):**

| Componente | Bytes |
|------------|-------|
| Anchor discriminator | 8 |
| `sender` + `beneficiary` + `authority` + `mint` (4 × Pubkey) | 128 |
| `amount` (u64) | 8 |
| `deadline` (i64) | 8 |
| `status` (enum, discriminante u8 borsh; variantes unit → 0 payload) | 1 |
| `bump` (u8) | 1 |
| **`EscrowState::INIT_SPACE`** (sin discriminator: 128+8+8+1+1) | **146** |
| **`space` total** (`8 + EscrowState::INIT_SPACE`) | **154** |

> **Directiva**: en el constraint `init` usar `space = 8 + EscrowState::INIT_SPACE` (deriva
> `InitSpace` calcula 146; el `8` es el discriminator). NO hardcodear `154` — que el compilador
> lo derive. `EscrowStatus` DEBE derivar `InitSpace` para que el enum aporte su 1 byte.

### 4.3 Enum de estado — `EscrowStatus` (DT-5)

```rust
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Deposited,  // 0 — estado inicial post-deposit
    Released,   // 1 — terminal: fondos al beneficiary
    Refunded,   // 2 — terminal: fondos al sender
}
```

> `InitSpace` agregado a DT-5 (el work-item lista el derive base; para el cálculo de space del
> §4.2 el enum debe reportar su tamaño). 1 byte (discriminante borsh, variantes sin payload).

### 4.4 Errores — `#[error_code] ErrorCode`

| Variante | Cuándo | AC |
|----------|--------|-----|
| `ZeroAmount` | `deposit` con `amount == 0` | hardening |
| `InvalidDeadline` | `deposit` con `deadline <= Clock::now` (evita refund inmediato) | AC-5 (indirecto) |
| `EscrowNotDeposited` | `release`/`refund` con `status != Deposited` | AC-3 |
| `DeadlineNotReached` | `refund` con `Clock::now < deadline` | AC-5 |
| `EscrowNotTerminal` | `close` con `status == Deposited` | AC-8 |
| `Overflow` | fallo de `checked_add`/`checked_sub` sobre `amount` | AC-10 |

> **AC-6 (release no autorizado)** y **AC-1 destino-fijo** NO necesitan variante propia: los
> cubre el constraint `has_one` de Anchor (emite `ConstraintHasOne`, código 2001). Documentar en
> el `///` que la autorización es declarativa vía `has_one`, no un `require!` imperativo.

### 4.5 Contexts — los 4 `#[derive(Accounts)]`

Convención de seeds del PDA (DT-1, con clarification §10.1 aplicado):
`seeds = [b"escrow", <depositor>.key().as_ref(), remittance_id.as_ref()]`, con
`remittance_id: [u8; 16]`. Longitud de seeds: 6 + 32 + 16 = 54 bytes (cada seed ≤ 32 → OK;
3 seeds ≤ 16 máx → OK).

#### 4.5.1 `Deposit`

Firma de instrucción: `deposit(ctx, remittance_id: [u8;16], beneficiary: Pubkey, authority: Pubkey, amount: u64, deadline: i64)`.

| Account | Tipo | Constraints |
|---------|------|-------------|
| `sender` | `Signer<'info>` (mut) | payer del `init`; source de los fondos |
| `mint` | `Account<'info, Mint>` | el mint USDC (env-driven; §10.3) |
| `escrow_state` | `Account<'info, EscrowState>` | **`init`** (NO `init_if_needed` — AC-7/CD-2), `payer = sender`, `space = 8 + EscrowState::INIT_SPACE`, `seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()]`, `bump` |
| `vault` | `Account<'info, TokenAccount>` | **`init`**, `payer = sender`, `associated_token::mint = mint`, `associated_token::authority = escrow_state` (AC-9: authority del vault = PDA) |
| `sender_ata` | `Account<'info, TokenAccount>` (mut) | `token::mint = mint`, `token::authority = sender` — source del transfer-in |
| `token_program` | `Program<'info, Token>` | pin SPL clásico (AC-11) |
| `associated_token_program` | `Program<'info, AssociatedToken>` | derive canónico del vault |
| `system_program` | `Program<'info, System>` | rent/creación de cuentas |

Lógica `deposit`:
1. Checks: `require!(amount > 0, ZeroAmount)`; `require!(deadline > Clock::get()?.unix_timestamp, InvalidDeadline)`.
2. Effects: setear `escrow_state.{sender, beneficiary, authority, mint, amount, deadline}`, `status = Deposited`, `bump = ctx.bumps.escrow_state`.
3. Interactions: CPI `token::transfer` (source `sender_ata` → `vault`, authority `sender` que firma) por `amount`. (Transfer-in desde fondos propios del sender; el sender firma directamente, sin PDA.)

> **CEI en deposit**: los effects (escritura de `escrow_state`) van antes de la CPI. La CPI de
> transfer-in usa la firma directa del `sender` (no del PDA) — es un `token::transfer` normal.

#### 4.5.2 `Release`

Firma: `release(ctx, remittance_id: [u8;16])`.

| Account | Tipo | Constraints |
|---------|------|-------------|
| `authority` | `Signer<'info>` | el facilitator (AC-6: `has_one = authority` valida que sea el grabado) |
| `sender` | `SystemAccount<'info>` | usado en las seeds; validado por `has_one = sender`. NO firma. (CHECK doc: solo aporta su key a las seeds) |
| `beneficiary` | `SystemAccount<'info>` | validado por `has_one = beneficiary`; owner de la ATA destino (CR-4) |
| `mint` | `Account<'info, Mint>` | `has_one = mint` (== `escrow_state.mint`) |
| `escrow_state` | `Account<'info, EscrowState>` (mut) | `seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()]`, `bump = escrow_state.bump`, `has_one = authority`, `has_one = beneficiary`, `has_one = sender`, `has_one = mint` |
| `vault` | `Account<'info, TokenAccount>` (mut) | `associated_token::mint = mint`, `associated_token::authority = escrow_state` |
| `beneficiary_ata` | `Account<'info, TokenAccount>` (mut) | `associated_token::mint = mint`, `associated_token::authority = beneficiary` — destino FIJO (AC-1/CD-3). **Debe existir** (NO se crea con `init_if_needed`; ver §4.9 nota) |
| `token_program` | `Program<'info, Token>` | pin SPL clásico (AC-11) |
| `associated_token_program` | `Program<'info, AssociatedToken>` | derive de las ATAs |

Lógica `release`:
1. Checks: `require!(escrow_state.status == EscrowStatus::Deposited, EscrowNotDeposited)` (AC-3). Autorización y destino: declarativos vía `has_one` (AC-6, AC-1).
2. **Effects (ANTES de la CPI — CEI/AC-2)**: `escrow_state.status = EscrowStatus::Released`.
3. Interactions: CPI `token::transfer` firmada por el PDA (`vault` → `beneficiary_ata`) por `escrow_state.amount`, con `CpiContext::new_with_signer` y signer seeds `&[b"escrow", sender.key().as_ref(), remittance_id.as_ref(), &[escrow_state.bump]]` (AC-9).

#### 4.5.3 `Refund`

Firma: `refund(ctx, remittance_id: [u8;16])`.

| Account | Tipo | Constraints |
|---------|------|-------------|
| `sender` | `Signer<'info>` (mut) | **firma** el refund (AC-4); `has_one = sender` valida que sea el depositante; recibe los fondos |
| `mint` | `Account<'info, Mint>` | `has_one = mint` |
| `escrow_state` | `Account<'info, EscrowState>` (mut) | `seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()]`, `bump = escrow_state.bump`, `has_one = sender`, `has_one = mint`. **NO** referencia `authority` (CD-4/AC-4: refund independiente del operador) |
| `vault` | `Account<'info, TokenAccount>` (mut) | `associated_token::mint = mint`, `associated_token::authority = escrow_state` |
| `sender_ata` | `Account<'info, TokenAccount>` (mut) | `associated_token::mint = mint`, `associated_token::authority = sender` — destino del refund |
| `token_program` | `Program<'info, Token>` | pin SPL clásico (AC-11) |
| `associated_token_program` | `Program<'info, AssociatedToken>` | derive de la ATA |

Lógica `refund`:
1. Checks: `require!(escrow_state.status == EscrowStatus::Deposited, EscrowNotDeposited)` (AC-3); `require!(Clock::get()?.unix_timestamp >= escrow_state.deadline, DeadlineNotReached)` (AC-4/AC-5). NINGUNA dependencia de `authority` (CD-4).
2. **Effects (ANTES — CEI/AC-2)**: `escrow_state.status = EscrowStatus::Refunded`.
3. Interactions: CPI `token::transfer` firmada por el PDA (`vault` → `sender_ata`) por `escrow_state.amount`, signer seeds igual que release (AC-9).

#### 4.5.4 `Close`

Firma: `close(ctx, remittance_id: [u8;16])`.

| Account | Tipo | Constraints |
|---------|------|-------------|
| `sender` | `Signer<'info>` (mut) | recibe el rent; `has_one = sender` |
| `mint` | `Account<'info, Mint>` | `has_one = mint` (para cerrar el vault) |
| `escrow_state` | `Account<'info, EscrowState>` (mut) | `seeds = [...]`, `bump = escrow_state.bump`, `has_one = sender`, `has_one = mint`, **`constraint = escrow_state.status != EscrowStatus::Deposited @ ErrorCode::EscrowNotTerminal`** (AC-8: solo terminal), **`close = sender`** (rent al depositor) |
| `vault` | `Account<'info, TokenAccount>` (mut) | `associated_token::mint = mint`, `associated_token::authority = escrow_state`; se cierra vía CPI `token::close_account` firmada por el PDA (reclama el rent del vault → `sender`) |
| `token_program` | `Program<'info, Token>` | pin SPL clásico (AC-11) |

Lógica `close`:
1. Check: `status != Deposited` (declarativo vía `constraint`, AC-8). Tras release/refund el vault tiene balance 0.
2. CPI `token::close_account` firmada por el PDA (`vault` → destino `sender`), reclamando el rent del vault ATA.
3. Anchor cierra `escrow_state` automáticamente por el constraint `close = sender` (zeroing + rent a `sender`). Las seeds solo vuelven a ser usables vía `init` nuevo (AC-8: sin revival).

> **Anti-revival (AC-8)**: como `deposit` usa `init` (no `init_if_needed`), tras el `close` un
> nuevo `deposit` con las mismas seeds hace un `init` limpio (cuenta ya no existe) — nunca pisa
> estado terminal residual. El escenario 6 de AC-12 valida que **re-deposit sobre seeds vivas**
> (sin close) revierte; un deposit-tras-close es un flujo legítimo nuevo.

### 4.6 Patrón CPI firmada (`invoke_signed` vía `CpiContext::new_with_signer`)

Para `release`/`refund`, la authority del vault es el PDA `escrow_state`, así que el transfer
DEBE firmarse con las seeds del PDA (AC-9). Patrón (descriptivo, NO código de producción):

```
seeds del signer = [ b"escrow", sender.key().as_ref(), remittance_id.as_ref(), &[escrow_state.bump] ]
signer_seeds     = &[ &seeds[..] ]
cpi_accounts     = token::Transfer { from: vault, to: <destino>, authority: escrow_state }
cpi_ctx          = CpiContext::new_with_signer(token_program, cpi_accounts, signer_seeds)
token::transfer(cpi_ctx, escrow_state.amount)?   // amount leído del estado, no de un arg variable
```

- El `bump` proviene de `escrow_state.bump` (grabado en deposit con `ctx.bumps.escrow_state`) — bump canónico, determinístico.
- `remittance_id` viene como **arg de la instrucción** (no se almacena en `EscrowState`); se usa tanto en el constraint `seeds` como en las signer seeds → consistencia garantizada por Anchor (si el arg no matchea el PDA pasado, la validación del `escrow_state` falla antes de ejecutar).
- El destino es un account **validado por constraint** (`beneficiary_ata` / `sender_ata`), nunca un `AccountInfo` crudo variable (CD-3).

### 4.7 CEI (Checks-Effects-Interactions)

En release/refund: `status` se muta a terminal **antes** de la CPI de transfer. Refuerzo:
Solana es atómico (si la CPI falla, revierte todo), pero el orden CEI + el pin de
`token_program` (AC-11, bloquea CPI a un programa malicioso) elimina cualquier vector de
reentrada. AC-3 (`EscrowNotDeposited`) garantiza que un segundo release/refund sobre estado
terminal revierte sin mover fondos.

### 4.8 Aritmética checked + overflow-checks (AC-10/CD-1)

- `deposit` no computa sobre `amount` (solo lo almacena) → sin arithmetic riesgosa; aun así,
  cualquier cómputo futuro DEBE usar `checked_add`/`checked_sub` mapeando el `None` a
  `ErrorCode::Overflow` (nunca `+`/`-` crudos).
- **`overflow-checks = true`** explícito en `[profile.release]` **y** `[profile.test]` del
  `Cargo.toml` del workspace (CD-1 no negociable). El binario BPF que corre en el validador se
  compila en release; los tests Rust (si los hubiera) en test.

### 4.9 Flujo principal y de error

**Happy path (deposit→release):**
1. La capa de negocio (HU-SOL-13) resuelve `beneficiary: Pubkey`, `authority: Pubkey`, `amount`, `deadline`, `remittance_id: [u8;16]`, y crea/asegura la `beneficiary_ata`.
2. `sender` invoca `deposit` → se crea `escrow_state` (`init`) + `vault` (ATA authority=PDA), se transfieren `amount` USDC al vault, `status = Deposited`.
3. Cumplido el off-chain, la `authority` invoca `release` → `status = Released`, CPI firmada vault→`beneficiary_ata`.
4. (Opcional) `sender` invoca `close` → rent de `escrow_state` + `vault` de vuelta al `sender`.

**Flujo de error:**
- release por no-authority → `ConstraintHasOne` (AC-6).
- release/refund con estado terminal → `EscrowNotDeposited` (AC-3).
- refund pre-deadline → `DeadlineNotReached` (AC-5).
- re-deposit sobre seeds vivas → "account already in use" del runtime (AC-7).
- close con `status == Deposited` → `EscrowNotTerminal` (AC-8).

> **Nota `beneficiary_ata` (destino de release)**: NO se crea con `init_if_needed` (CD-2 lo
> prohíbe en TODA instrucción). Se asume creada por la capa de negocio (HU-SOL-13) antes del
> release, y se valida vía `associated_token::authority = beneficiary`. Documentar este
> pre-requisito en el README (§CD-6). Si en integración se necesitara crearla, se hará en una
> instrucción/paso separado, no vía `init_if_needed` dentro de `release`.

### 4.10 Versiones de dependencias (pin)

`anchor init` con anchor-cli 1.1.2 genera `anchor-lang`/`anchor-spl` alineados a esa CLI. W0
DEBE **verificar** con `anchor build` verde que las versiones de crate resuelven contra rustc
1.97.1 y solana 3.1.10. Si `anchor init` fija un `anchor-lang` distinto de `1.1.2`, se pinnea
al que la CLI 1.1.2 espera (evitar drift CLI↔crate). NO inventar versiones: usar exactamente
lo que `anchor init` escribe, y solo ajustar si el build falla por mismatch.

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-1**: `overflow-checks = true` en `[profile.release]` **y** `[profile.test]` del `Cargo.toml` del workspace (AC-10). No negociable.
- **CD-3**: `release` transfiere exclusivamente a la ATA del `beneficiary` grabado en `deposit`; destino validado por constraint (`associated_token::authority = beneficiary` + `has_one = beneficiary`), NUNCA un `AccountInfo` variable.
- **CD-4**: `refund` sin ninguna dependencia de `authority`/facilitator — solo `sender` (Signer) + `Clock` (AC-4). El `Context` de `Refund` NO incluye `authority`.
- Todo transfer de release/refund vía CPI firmada con seeds del PDA (`CpiContext::new_with_signer`) — AC-9.
- CEI: mutar `status` a terminal ANTES de cualquier CPI de transfer (AC-2).
- `amount` de la CPI se lee de `escrow_state.amount`, no de un arg de instrucción.
- Usar `space = 8 + EscrowState::INIT_SPACE` (derivado), no un literal.

### PROHIBIDO

- **CD-2**: usar `init_if_needed` en CUALQUIER instrucción (NO habilitar el feature `init-if-needed` en `programs/escrow/Cargo.toml`). Solo `init` explícito (AC-7).
- **CD-5**: deployar a mainnet en esta HU — **devnet only**. Mainnet gateado por HU-SOL-19.
- Hardcodear el mint USDC en `lib.rs` (§10.3: env-driven; el mint entra como account/arg y se graba en `escrow_state.mint`).
- Usar Token-2022 o `InterfaceAccount` para el vault — pin `Program<'info, Token>` clásico (AC-11).
- Operadores aritméticos crudos (`+`/`-`) sobre `amount` — solo `checked_*` (AC-10).
- Modificar archivos fuera de `solana-programs/` o agregar dispute/arbiter (Scope OUT).
- Almacenar `remittance_id` en `EscrowState` (no está en DT-2; entra como arg de instrucción).

### DOCUMENTADO (no implementado en esta HU)

- **CD-6** (front-run mitigation): la orden de cashout en TransFi se crea SOLO después de que la tx de `release` esté **finalized** on-chain. Guard a nivel de flujo de negocio → **se implementa en HU-SOL-13**. En esta HU: documentar en `README.md`.
- **CD-7** (upgrade authority): la upgrade authority del programa deployado DEBE migrar a multisig/timelock o deployarse `--final` post-auditoría → **HU-SOL-19**. En esta HU: documentar en `README.md` + comentario en `scripts/deploy-devnet.sh`. NO implementar.

---

## 6. Scope

**IN:** workspace Anchor (`Anchor.toml`, `Cargo.toml`, `programs/escrow/*`), instrucciones
`deposit`/`release`/`refund`/`close`, `EscrowState` PDA, vault ATA (authority=PDA), suite de 6
tests (AC-12), CI (build+test), script deploy devnet, README con CD-6/CD-7 documentados.

**OUT:** integración chaski (HU-SOL-13), gasless/relayer (HU-SOL-14), verificación facilitator
(HU-SOL-6), auditoría externa + upgrade authority final (HU-SOL-19), deploy mainnet,
dispute/arbiter, mapeo fiat(TransFi depositAddress)→wallet Solana (HU-SOL-13).

---

## 7. Waves de Implementación

> Cada wave termina con **`anchor build` verde** como gate de verificación incremental.

### Wave 0 (Serial Gate — scaffold que compila)
- [ ] W0.1: `anchor init escrow` en `solana-programs/` (genera workspace + `programs/escrow` + `tests/`).
- [ ] W0.2: Editar `Cargo.toml` workspace → agregar `[profile.release] overflow-checks=true` y `[profile.test] overflow-checks=true` (CD-1).
- [ ] W0.3: Verificar que `programs/escrow/Cargo.toml` NO tiene el feature `init-if-needed` (CD-2).
- [ ] W0.4: Editar `Anchor.toml` → `cluster = "devnet"`, `[toolchain] anchor_version = "1.1.2"`.
- [ ] W0.5: Esqueleto de tipos que compile vacío. **Gate: `anchor build` verde.**

### Wave 1 (tipos + deposit)
- [ ] W1.1: `EscrowState` (+ `#[derive(InitSpace)]`), `EscrowStatus` (+ `InitSpace`), `#[error_code] ErrorCode`.
- [ ] W1.2: `Deposit` context (§4.5.1) con `init` (NO init_if_needed) + vault ATA authority=PDA + `space = 8 + EscrowState::INIT_SPACE`.
- [ ] W1.3: Handler `deposit` (checks `ZeroAmount`/`InvalidDeadline`, effects, CPI transfer-in firma directa del sender). **Gate: `anchor build` verde.**

### Wave 2 (release — CPI firmada + CEI)
- [ ] W2.1: `Release` context (§4.5.2): `has_one = authority/beneficiary/sender/mint`, `beneficiary_ata` con `associated_token::authority = beneficiary`.
- [ ] W2.2: Handler `release`: check `EscrowNotDeposited`, effect `status = Released` ANTES de CPI, CPI `token::transfer` firmada por PDA vault→`beneficiary_ata` por `escrow_state.amount`. **Gate: `anchor build` verde.**

### Wave 3 (refund + close)
- [ ] W3.1: `Refund` context (§4.5.3): `sender: Signer`, sin `authority` (CD-4), `has_one = sender/mint`.
- [ ] W3.2: Handler `refund`: checks `EscrowNotDeposited` + `DeadlineNotReached`, effect `status = Refunded` ANTES de CPI, CPI firmada vault→`sender_ata`.
- [ ] W3.3: `Close` context + handler (§4.5.4): `constraint status != Deposited` (`EscrowNotTerminal`), `close = sender`, CPI `close_account` del vault. **Gate: `anchor build` verde.**

### Wave 4 (tests + CI + deploy)
- [ ] W4.1: Suite `tests/escrow.ts` con `anchor-bankrun` — 6 escenarios de §8.
- [ ] W4.2: `.github/workflows/ci.yml` (avm + `anchor build` + `anchor test`).
- [ ] W4.3: `scripts/deploy-devnet.sh` (devnet only, comentario CD-7) + `README.md` (CD-6/CD-7 + mint env-driven).
- [ ] W4.4: **Gate: `anchor test` verde (6/6).**

---

## 8. Test Plan (`anchor test` — AC-12)

**Framework**: `anchor-bankrun` (solana-bankrun) para control **determinístico del `Clock`**
(warp de tiempo sin depender de un validador real ni `sleep`). Setup común:
- 2 keypairs: `sender` (depositor) y `authority` (facilitator); un tercero `attacker` para el negativo.
- Mint SPL **local** de 6 decimales creado con `@solana/spl-token` (los tests NO usan la Circle USDC devnet — no se puede mintear en bankrun; ver §10.3). La address env-driven aplica al **deploy/integración devnet**, no al mint sintético de los unit tests.
- ATAs de sender y beneficiary creadas explícitamente (nunca `init_if_needed` en el programa).
- `remittance_id` = `Uint8Array(16)` fijo por caso.
- Control de deadline: `context.setClock(new Clock(...))` de `solana-bankrun` para avanzar el `unix_timestamp` más allá del `deadline` en el caso de refund-post-deadline.

| # | Escenario | AC | Setup / aserción |
|---|-----------|-----|------------------|
| 1 | **Happy path deposit→release** | AC-1, AC-2, AC-9 | deposit (amount N, deadline futuro) → vault balance N; release por `authority` → `beneficiary_ata` recibe N, vault 0, `status == Released` |
| 2 | **Release por signer ≠ authority revierte** | AC-6 | deposit; release firmado por `attacker` → error `ConstraintHasOne` (2001); vault intacto |
| 3 | **Refund pre-deadline revierte** | AC-5 | deposit (deadline futuro); refund por `sender` con clock < deadline → error `DeadlineNotReached`; vault intacto |
| 4 | **Refund post-deadline funciona (sin authority)** | AC-4 | deposit; `context.setClock` avanza a `>= deadline`; refund por `sender` (authority NUNCA firma) → `sender_ata` recibe N, `status == Refunded` |
| 5 | **Doble transición revierte** | AC-3, AC-2 | deposit→release OK; segundo release → `EscrowNotDeposited`. Variante: deposit→refund OK; luego release → `EscrowNotDeposited` |
| 6 | **Re-deposit sobre mismas seeds revierte** | AC-7 | deposit OK; segundo deposit con las mismas `[sender, remittance_id]` → error del runtime "account already in use" (init sobre cuenta viva) |

Cobertura adicional recomendada (no exigida por AC-12 pero suma a auditoría):
- `close` con `status == Deposited` → `EscrowNotTerminal` (AC-8).
- `close` tras release → rent de `escrow_state` + vault de vuelta al `sender`; luego deposit nuevo con las mismas seeds → OK (anti-revival correcto: init limpio post-close).
- `deposit` con `amount == 0` → `ZeroAmount`.

> **Nota tiempo/deadline**: bankrun permite setear el sysvar `Clock` arbitrariamente, evitando
> tests flaky basados en tiempo real. Es el método idiomático para AC-4/AC-5. Si por alguna
> restricción de entorno `anchor-bankrun` no estuviera disponible en CI, el fallback es
> `solana-program-test`/litesvm (Rust) — pero la vía primaria es `anchor-bankrun` en TS.

---

## 9. Cobertura DT / CD / requisitos de auditoría

| Requisito | Cerrado por | Sección |
|-----------|-------------|---------|
| DT-1 (seeds PDA) | `[b"escrow", sender.key().as_ref(), remittance_id.as_ref()]` + bump; `remittance_id: [u8;16]` | §4.5, §10.1 |
| DT-2 (layout `EscrowState`) | struct exacto + space 154 derivado | §4.2 |
| DT-3 (vault = ATA authority=PDA) | `associated_token::authority = escrow_state` | §4.5.1, AC-9 |
| DT-4 (SPL clásico) | `Program<'info, Token>` + `Account<TokenAccount>` | §4.5, AC-11 |
| DT-5 (enum status) | `EscrowStatus` + `InitSpace` | §4.3 |
| CD-1 (overflow-checks) | `[profile.release]` + `[profile.test]` | §4.8, W0.2 |
| CD-2 (no init_if_needed) | `init` explícito; feature no habilitado | §4.5.1, W0.3 |
| CD-3 (release destino-fijo) | `has_one = beneficiary` + `associated_token::authority = beneficiary` | §4.5.2 |
| CD-4 (refund sin operador) | `Refund` context sin `authority` | §4.5.3 |
| CD-5 (devnet only) | `Anchor.toml cluster="devnet"` + `deploy-devnet.sh` | W0.4, W4.3 |
| CD-6 (front-run doc) | README: orden TransFi post-release-finalized | W4.3, DOCUMENTADO |
| CD-7 (upgrade authority doc) | README + comentario deploy script | W4.3, DOCUMENTADO |
| **CR-4** (release a destino fijo) | AC-1 → CD-3 (constraints declarativos) | §4.5.2 |
| **CR-3/CR-7** (terminal / no double-spend) | AC-2/AC-3 → enum `status` + guard `EscrowNotDeposited` + CEI | §4.5.2/3, §4.7 |
| **ME-1** (hardening) | AC-7 (`init`), AC-8 (`close` terminal), AC-9 (vault authority=PDA + CPI firmada), AC-10 (overflow-checks + checked), AC-11 (token_program pin) | §4.5, §4.8 |

---

## 10. Uncertainty Markers — RESUELTOS

Los 2 `[NEEDS CLARIFICATION]` del work-item quedan **cerrados** en F2 (decisiones del
orquestador, incorporadas):

### 10.1 `remittance_id` encoding (era bloqueante para DT-1) — RESUELTO
`remittance_id: [u8; 16]` (16 bytes fijos). Acomoda un UUID (16 bytes) o un idempotency-key
truncado/hasheado a 16 bytes. Es el parámetro `remittance_id: [u8;16]` de `deposit`/`release`/
`refund`/`close`. HU-SOL-13 mapea su `remittanceId` de negocio a esos 16 bytes. **No bloqueante.**

### 10.2 `beneficiary` = `Pubkey` resuelto — RESUELTO
`beneficiary` es un `Pubkey` de Solana **ya resuelto** provisto por la capa de negocio al
invocar `deposit`. El mapeo fiat (`depositAddress` de TransFi) → wallet Solana vive en HU-SOL-13
(Scope OUT). El escrow solo graba el `Pubkey` en `escrow_state.beneficiary` y lo honra en
`release` (destino fijo). **No bloqueante.**

### 10.3 Mint USDC devnet — RESUELTO (env-driven)
El mint **NO** se hardcodea en `lib.rs`: entra como account (`mint`) en cada Context y se graba
en `escrow_state.mint`. Para tests/deploy devnet, el valor canónico de referencia es la Circle
USDC devnet **`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`**, pasado por config/env
(script de deploy, variable de entorno de la capa de integración), **nunca literal en el
programa**. Los unit tests (`anchor-bankrun`) usan un mint SPL local sintético de 6 decimales
(no se puede mintear Circle USDC en bankrun). **No bloqueante.**

| Marker | Estado | Bloqueante? |
|--------|--------|-------------|
| `remittance_id` encoding | RESUELTO (§10.1: `[u8;16]`) | No |
| `beneficiary` resolución | RESUELTO (§10.2: `Pubkey` ya resuelto) | No |
| Mint USDC devnet | RESUELTO (§10.3: env-driven, ref Circle devnet) | No |

---

## 11. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Drift versión CLI↔crate (anchor 1.1.2) rompe `anchor build` | M | M | W0 usa exactamente lo que `anchor init` escribe; ajustar solo si el build falla (§4.10) |
| `beneficiary_ata` no existe al momento del `release` (no se auto-crea por CD-2) | M | M | Pre-requisito documentado (README/CD-6); HU-SOL-13 asegura la ATA antes del release |
| `anchor-bankrun` no disponible en CI | B | M | Fallback `solana-program-test`/litesvm (Rust) documentado (§8) |
| USDC (Circle) puede pausar/blocklist el vault | B | A | Riesgo externo aceptado (igual que el EVM WKH-191); inherente a custodiar USDC, no mitigable on-chain |
| Upgrade authority del deploy devnet queda en EOA del deployer | M | A (si se confundiera con prod) | Devnet only (CD-5); CD-7 documenta la migración a multisig/`--final` en HU-SOL-19 pre-mainnet |

## 12. Dependencias

- Toolchain (anchor 1.1.2 / solana 3.1.10 / rustc 1.97.1) — **verificado** (§3).
- `anchor init` (W0) genera el scaffold — es el primer paso de F3/Dev, no de este SDD.
- HU-SOL-13 y HU-SOL-14 **dependen** de este programa deployado en devnet + IDL (ruta crítica Sprint 1).

---

## 13. Readiness Check

```
READINESS CHECK:
[x] Cada AC (1..12) tiene archivo asociado (lib.rs / Cargo.toml / tests/escrow.ts) — §4.1, §9
[x] Cada archivo tiene exemplar/base verificado (scaffold anchor init 1.1.2 + WasiAIEscrow.sol conceptual) — §3
[x] No hay [NEEDS CLARIFICATION] pendientes — los 3 RESUELTOS en §10
[x] Constraint Directives incluyen >3 PROHIBIDO — §5 (7 PROHIBIDO)
[x] Context Map tiene >2 entradas (work-item + WasiAIEscrow.sol + toolchain verificado) — §3
[x] Scope IN/OUT explícitos y no ambiguos — §6
[x] Estado on-chain (EscrowState) verificado: space 154 derivado exacto — §4.2
[x] Happy path completo (deposit→release→close) — §4.9
[x] Flujo de error definido (5+ casos con su ErrorCode) — §4.4, §4.9
[x] Toolchain verificado con anchor/solana/rustc --version — §3
[x] overflow-checks + checked arithmetic mapeados a Cargo.toml (CD-1/AC-10) — §4.8
[x] CPI firmada (invoke_signed) especificada con seeds+bump exactos (AC-9) — §4.6
[x] Test plan: 6 escenarios AC-12 con setup y aserción por caso — §8
```

**No blockers.** Los 2 `[NEEDS CLARIFICATION]` del work-item quedaron cerrados (§10.1/§10.2) +
el mint resuelto env-driven (§10.3). SDD listo para SPEC_APPROVED.

---

*SDD generado por NexusAgil — FULL — nexus-architect F2 (WKH-215 / HU-SOL-12)*
