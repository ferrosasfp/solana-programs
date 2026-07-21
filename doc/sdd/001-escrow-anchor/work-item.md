# Work Item — [WKH-215 / HU-SOL-12] Programa escrow on-chain (Rust/Anchor) + workspace

## Resumen
Escrow trustless en Solana (Anchor) que custodia USDC en un vault hasta el `release`,
para reemplazar la custodia off-chain del flujo de remesas Chaski/TransFi. Es la ruta
crítica de Sprint 1: HU-SOL-13 (integración chaski) y HU-SOL-14 (gasless) dependen de
este programa. Repo nuevo `solana-programs/` (greenfield — no existía antes de esta HU).

## Grounding (F0)
- **Repo objetivo**: `/home/ferdev/.openclaw/workspace/solana-programs/` — NO EXISTE
  todavía (`Glob` de todo el árbol devolvió 0 resultados). F3/Dev corre `anchor init`
  desde cero. Toolchain ya verificado por el orquestador: anchor-cli 1.1.2, solana-cli
  3.1.10, rustc 1.97.1.
- **Referencia conceptual (EVM, WKH-191)**: leídos
  `wasiai-a2a/contracts/src/WasiAIEscrow.sol` +
  `wasiai-a2a/contracts/src/interfaces/IWasiAIEscrow.sol`. Propiedades a espejar
  (NO portar 1:1 — Solana tiene su propio modelo PDA/vault/CPI):
  - Máquina de estados con transición terminal única (`Deposited → Released XOR
    Refunded`), sin reentrancia posible tras el estado terminal.
  - `deposit` fija un destino/autorización que las funciones de settlement NO pueden
    alterar (en el EVM, `_depositor[keyId]` fijado en el primer deposit; acá,
    `beneficiary` fijado en `deposit`).
  - CEI (checks-effects-interactions): mutar estado ANTES de transferir tokens.
  - Nada de custodia por una sola clave de operador que pueda desviar fondos —
    en el EVM eso lo cubre la firma EIP-712 del depositante; en Solana lo cubre
    que `release` transfiera SIEMPRE al `beneficiary` grabado, nunca a un
    account variable pasado por la authority.

## Sizing
- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/001-escrow-anchor`
- Modo: **QUALITY** — AR (Adversarial Review) OBLIGATORIO por manejar custodia de
  fondos (USDC) y ser la ruta crítica del Sprint 1.

## Acceptance Criteria (EARS)

- **AC-1 (CR-4 — release a destino fijo)**: WHEN `release` es invocada por la
  `authority`, the system SHALL transferir el balance del vault ÚNICAMENTE a la
  token account del `beneficiary` grabado en `escrow_state` durante `deposit`,
  sin importar qué cuenta se pase como destino en la instrucción (Anchor
  `has_one = beneficiary` o constraint equivalente sobre la ATA derivada).

- **AC-2 (CR-3/CR-7 — transición terminal)**: WHEN `escrow_state.status ==
  Deposited` AND `release` o `refund` se ejecuta con éxito, the system SHALL
  actualizar `escrow_state.status` a `Released` o `Refunded` respectivamente,
  dejándolo en un estado terminal irreversible.

- **AC-3 (CR-3/CR-7 — doble transición revierte)**: IF `release` o `refund` es
  invocada WHILE `escrow_state.status != Deposited`, THEN the system SHALL
  revertir la transacción (error `EscrowNotDeposited` o equivalente), sin mover
  fondos por segunda vez.

- **AC-4 (refund independiente del operador)**: WHEN `refund` es invocada, the
  system SHALL exigir `signer == escrow_state.sender` (el depositante) AND
  `Clock::get()?.unix_timestamp >= escrow_state.deadline`, ejecutando la
  devolución exitosamente sin requerir firma, disponibilidad ni acción alguna
  de la `authority`/facilitator (funciona aunque el facilitator esté caído).

- **AC-5 (refund pre-deadline revierte)**: IF `refund` es invocada WHILE
  `Clock::get()?.unix_timestamp < escrow_state.deadline`, THEN the system SHALL
  revertir con error `DeadlineNotReached`.

- **AC-6 (release no autorizado revierte)**: IF `release` es invocada por un
  `signer != escrow_state.authority`, THEN the system SHALL revertir la
  transacción (constraint `has_one = authority` en el `Context`).

- **AC-7 (ME-1 — init, no init_if_needed / anti re-init)**: WHEN `deposit`
  (instrucción de inicialización) es invocada, the system SHALL crear
  `escrow_state` usando el constraint Anchor `init` (NUNCA `init_if_needed`),
  de forma que reinvocar `deposit` con las mismas seeds falle con
  "account already in use" antes de que exista ningún estado mutable que
  pisar.

- **AC-8 (ME-1 — close terminal + anti-revival + rent reclaim)**: WHEN `close`
  es invocada, the system SHALL exigir `escrow_state.status != Deposited`
  (solo estado terminal) AND SHALL cerrar la cuenta con constraint
  `close = depositor`, devolviendo el rent al depositante; las seeds
  `[b"escrow", depositor, remittance_id]` solo vuelven a ser usables mediante
  un `init` nuevo (AC-7), nunca por revival del estado cerrado.

- **AC-9 (ME-1 — vault authority = PDA)**: the system SHALL configurar la
  authority de la token account del vault como el PDA `escrow_state` (o un PDA
  derivado exclusivamente para ese propósito), y SHALL ejecutar toda
  transferencia SPL-Token de `release`/`refund` vía CPI firmada con las seeds
  del PDA (`invoke_signed`), nunca con una cuenta controlada por un usuario.

- **AC-10 (ME-1 — overflow-checks + checked arithmetic)**: the system SHALL
  compilar con `overflow-checks = true` explícito en `Cargo.toml` (perfiles
  `release` y `test` del workspace) AND SHALL usar aritmética `checked_add`/
  `checked_sub` (nunca operadores crudos `+`/`-`) para cualquier cómputo sobre
  `amount`.

- **AC-11 (ME-1 — token_program pin)**: the system SHALL declarar
  `token_program: Program<'info, Token>` (SPL Token clásico, NO Token-2022) en
  todo `Context` que toque el vault, de forma que Anchor rechace cualquier
  cuenta cuyo owner de programa no coincida (anti CPI/program-id confusion).

- **AC-12 (cobertura de tests — `anchor test`)**: WHEN se ejecuta
  `anchor test`, the system SHALL correr y pasar como mínimo estos 6
  escenarios: (1) happy-path deposit→release, (2) release por signer distinto
  de `authority` revierte, (3) refund antes del deadline revierte, (4) refund
  después del deadline funciona, (5) doble release (o release tras refund)
  revierte, (6) re-`deposit` (init) sobre las mismas seeds tras `close`
  revierte.

## Scope IN
- Workspace Anchor completo: `Anchor.toml`, `Cargo.toml` (workspace, con
  `overflow-checks = true` en `[profile.release]` y `[profile.test]`),
  `programs/escrow/Cargo.toml`, `programs/escrow/src/lib.rs`.
- Instrucciones: `deposit` (init de `escrow_state` + vault ATA + transferencia
  inicial), `release`, `refund`, `close`.
- Cuenta `escrow_state` (PDA, seeds `[b"escrow", depositor, remittance_id]` +
  bump) con campos sender/beneficiary/authority/amount/mint/deadline/status.
- Vault: Associated Token Account con authority = PDA `escrow_state`.
- Suite de tests (`tests/escrow.ts` o `.rs`) cubriendo los 6 escenarios de AC-12.
- Config y script de deploy a **devnet** (no mainnet).
- CI (GitHub Actions o equivalente) que corra `anchor build` + `anchor test`.

## Scope OUT
- Integración con chaski / creación de la orden TransFi (**HU-SOL-13**).
- Relayer/gasless (fee payer patrocinado) — **HU-SOL-14**.
- Verificación del facilitator / firma off-chain de autorización — **HU-SOL-6**.
- Auditoría externa formal + fijar upgrade authority a multisig/timelock o
  `--final` — **HU-SOL-19**. Esta HU documenta el constraint (CD-7) pero NO lo
  implementa.
- Deploy a mainnet (gate = auditoría externa, fuera de esta HU).
- Dispute/arbiter (la referencia EVM WKH-191f tiene `lockForDispute`/
  `resolveDispute`; NO está en el alcance de HU-SOL-12 — el humano no lo pidió
  para esta HU, se marca fuera de scope explícitamente).

## Decisiones técnicas (DT-N)

- **DT-1**: seeds del PDA `escrow_state` = `[b"escrow", depositor.key().as_ref(),
  remittance_id.as_ref()]` + bump. `remittance_id` propuesto como `[u8; 16]`
  (bytes de un UUID) por ser el tipo más natural para un idempotency key
  fixed-size en seeds de Anchor. **[NEEDS CLARIFICATION]** ver Missing Inputs.

- **DT-2**: layout de `escrow_state`:
  ```rust
  #[account]
  pub struct EscrowState {
      pub sender: Pubkey,       // depositor/payer — firma refund
      pub beneficiary: Pubkey,  // owner de la ATA destino, fijado en deposit (CR-4)
      pub authority: Pubkey,    // facilitator/operator autorizado a invocar release
      pub mint: Pubkey,         // mint de USDC
      pub amount: u64,
      pub deadline: i64,        // unix timestamp, comparado contra Clock
      pub status: EscrowStatus, // Deposited | Released | Refunded
      pub bump: u8,
  }
  ```

- **DT-3**: vault = Associated Token Account (ATA) canónica cuya `authority` es
  el PDA `escrow_state` (no una PDA de vault separada) — minimiza superficie de
  seeds y aprovecha el derive determinístico estándar de SPL.

- **DT-4**: `token_program` = `anchor_spl::token::Token` (SPL Token clásico),
  NO Token-2022. Consistente con el mint USDC usado hoy en devnet/mainnet por
  el resto del ecosistema (evidencia: WKH-191/WKH-196 en `wasiai-a2a`, EVM,
  pero el mint SPL de referencia en Solana devnet de Circle es SPL clásico).

- **DT-5**: `EscrowStatus` como enum Anchor-serializable:
  ```rust
  #[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
  pub enum EscrowStatus { Deposited, Released, Refunded }
  ```

## Constraint Directives (CD-N)

- **CD-1**: OBLIGATORIO `overflow-checks = true` en `Cargo.toml` (`[profile.release]`
  y `[profile.test]`) — no negociable, cierra ME-1 aritmética.
- **CD-2**: PROHIBIDO usar `init_if_needed` en cualquier instrucción del
  programa — solo `init` explícito (AC-7).
- **CD-3**: OBLIGATORIO que `release` transfiera exclusivamente al
  `beneficiary` grabado en `deposit`; PROHIBIDO que `beneficiary` (o su ATA)
  sea un parámetro variable/no validado en la instrucción `release`.
- **CD-4**: OBLIGATORIO que `refund` funcione sin ninguna dependencia de la
  `authority`/facilitator — solo `depositor` + `Clock` (AC-4).
- **CD-5**: PROHIBIDO deployar a mainnet en esta HU — devnet only. Mainnet
  queda gateado por auditoría externa (HU-SOL-19).
- **CD-6**: OBLIGATORIO documentar (no implementar) el contrato con
  chaski/facilitator: la orden de cashout en TransFi se crea SOLO después de
  que la transacción de `release` esté finalized on-chain. Esto mitiga el
  front-running del release/refund a nivel de flujo de negocio; la
  implementación de ese guard vive en HU-SOL-13.
- **CD-7**: OBLIGATORIO documentar (no implementar) que la upgrade authority
  del programa deployado debe migrar a multisig/timelock, o el programa debe
  deployarse con `solana program deploy --final` post-auditoría externa — esto
  se cierra en HU-SOL-19, NO en esta HU (AL-10).

## Missing Inputs

- **[NEEDS CLARIFICATION — bloqueante para DT-1]**: encoding exacto de
  `remittance_id` como seed del PDA. ¿Es el UUID/idempotency key que genera
  chaski, o el que devuelve TransFi al crear la orden de cashout? ¿String,
  u64, o bytes de 16/32? Afecta el tipo del parámetro de `deposit` y el
  tamaño de las seeds. El Architect debe resolverlo en F2 con quien posea el
  contrato de datos de chaski/TransFi (probablemente HU-SOL-13 lo define,
  pero HU-SOL-12 necesita el tipo concreto para compilar `lib.rs`).

- **[NEEDS CLARIFICATION]**: ¿`beneficiary` es directamente un `Pubkey` de
  Solana (owner de una ATA) provisto por la capa de negocio en el momento del
  `deposit`, o existe un paso intermedio off-chain (chaski) que resuelve el
  `depositAddress` fiat de TransFi a una wallet Solana antes de llamar a
  `deposit`? Esta HU asume que el `Pubkey` ya viene resuelto al momento de
  invocar `deposit` (Scope IN no incluye ese mapeo — eso es HU-SOL-13).

- **[resuelto en F2]**: address exacta del mint USDC en devnet — el Architect
  lo fija en el SDD citando la referencia devnet oficial de Circle, no
  hardcodeado en esta fase.

## Análisis de paralelismo

- Este work-item es **independiente**: repo nuevo (`solana-programs/`), sin
  overlap de archivos con `wasiai-a2a`. No bloquea trabajo en curso de otros
  repos.
- **Bloquea** (ruta crítica de Sprint 1): HU-SOL-13 (integración
  chaski↔escrow) y HU-SOL-14 (gasless/relayer) necesitan el programa
  deployado en devnet con su IDL antes de poder arrancar su propia
  implementación.
- **Puede correr en paralelo** con HU-SOL-6 (verificación del facilitator, si
  vive en `wasiai-a2a` u otro repo) — sin dependencia de código compartido.
- **HU-SOL-19** (auditoría externa + upgrade authority final) depende de que
  esta HU esté DONE (necesita el programa deployado en devnet + tests verdes
  como input de la auditoría).
