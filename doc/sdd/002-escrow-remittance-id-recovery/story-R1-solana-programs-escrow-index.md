# Story File — R1 · `EscrowIndex` + `register_escrow` + `deregister_escrow` (programa Anchor)

> **REPO: `solana-programs`** (`/home/ferdev/.openclaw/workspace/solana-programs`)
> SDD: `doc/sdd/002-escrow-remittance-id-recovery/sdd.md` (§4.1-§4.7, §5 paso R1, §8 Wave 1-3, §9)
> HU: **HU-SOL-20** · Fecha: 2026-07-28 · Wave de release: **R1**
> Branch: `feat/002-escrow-remittance-id-recovery`
> Program id (upgrade **in-place**, NO cambia): `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`

---

## 0. Prerequisitos y orden

### Qué tiene que estar mergeado ANTES

- **R0** (`chaski-v3`, story `story-R0-chaski-v3-durable-remittance-id.md`). No es una dependencia
  técnica de compilación: es la red de contención que tiene que estar viva **antes** de abrir la
  ventana de deploy del programa. Si R0 no está, cada escrow depositado durante la ventana R1→R4
  puede volverse irrecuperable.

### Daño concreto si se hace al revés (copiado del SDD §5 — no abras otro archivo)

- **R1 después de R4** (el cliente emitiendo `register_escrow` antes de que exista la instrucción)
  ⇒ el programa viejo no conoce el discriminador ⇒ **`InvalidInstructionData`** ⇒ **la tx ENTERA
  falla** ⇒ **no hay depósito**. Roto y visible.
- **R2 antes de R1** (re-pinear el hash del IDL antes de buildear) ⇒ el hash pineado no corresponde a
  ningún IDL real ⇒ **CI rojo en 2 repos** sin ninguna ganancia.
- **R1 tocando `deposit`** (la variante descartada de agregar el índice como 9ª cuenta posicional)
  ⇒ un bundle JS cacheado sigue mandando 8 cuentas + el `reference` como remaining, y el programa
  nuevo leería el `reference` en el slot del índice ⇒ **`ConstraintSeeds`**. Error confuso,
  **depósitos rotos**. Ese escenario es exactamente el motivo por el que `deposit` NO SE TOCA.
- **R0 último** ⇒ se pierde la única protección disponible durante toda la ventana de deploy.

### Qué habilita

R2a y R2b (re-pin del hash del IDL en los otros dos repos) **dependen del `anchor build` de este
story**. R3 y R4 dependen de que estas dos instrucciones existan on-chain.

---

## 1. Goal

El PDA `escrow_state` se deriva de `["escrow", sender, remittance_id16]` y esos 16 bytes **no se
guardan en ningún lado on-chain** (`EscrowState`, `lib.rs:156-167`, no los tiene). Si el
`remittanceId` se pierde, los fondos quedan inalcanzables incluso para el `refund` trustless que ya
funciona. Hoy hay 10 USDC de prueba atrapados en devnet por exactamente esto.

Este story agrega **una cuenta nueva** `EscrowIndex` (PDA `["escrow-index", sender]`) que lista los
`[u8;16]` de los escrows abiertos de ese `sender`, y **dos instrucciones nuevas** para escribirla y
limpiarla. Con eso, el `sender` recupera los 16 bytes desde la cadena con **un solo**
`getAccountInfo` de un PDA que puede derivar sabiendo solamente su propia address, y ejecuta el
`refund` que ya está probado.

**`EscrowState`, `deposit`, `release`, `refund` y `close` NO SE TOCAN.** Eso no es una precaución:
es la única forma de no romper los escrows que ya tienen plata (ver §4).

---

## 2. Acceptance Criteria (copiados del SDD §2.1)

- **AC-3**: WHEN un `sender` conectado no posee el `remittanceId` de un escrow propio, the system
  SHALL proveer un mecanismo que permita descubrir la dirección de TODOS los `escrow_state` abiertos
  de ese `sender` sin requerir el `remittanceId` original.
- **AC-4**: WHEN un `escrow_state` es descubierto mediante AC-3 sobre un escrow depositado DESPUÉS
  del upgrade, the system SHALL permitir que su `sender` invoque `refund` sobre esa cuenta sin
  necesitar reconstruir el `remittance_id` de 16 bytes a partir del `remittanceId` original.
  *Refinamiento ratificado (SDD §2.2): los 16 bytes **sí** se pasan como argumento a `refund` (la
  instrucción no se toca), pero **se leen de la cadena** desde `EscrowIndex`, no del secreto perdido.
  Es un DRIFT esperado y ya justificado, no un hallazgo de QA.*
- **AC-5**: IF cualquier mecanismo de recuperación permite a la `authority`/árbitro mover o redirigir
  fondos, THEN the system SHALL exigir también la firma del `sender` original.
- **AC-6**: WHILE existan `escrow_state` deployados bajo el esquema actual cuyo `remittanceId` se
  conserve, the system SHALL seguir permitiendo `release`/`refund`/`close` sobre ellos exactamente
  como hoy, **sin migración**.
- **AC-7**: IF un escrow fue depositado ANTES del upgrade Y su `remittanceId` está
  irrecuperablemente perdido, THEN the system SHALL NO prometer ni implementar un rescate.

---

## 3. Scope IN — archivos exactos (verificados contra disco el 2026-07-28)

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `programs/escrow/Cargo.toml` (27 líneas) | Modificar | Línea **23**: `anchor-lang = "1.1.2"` ⇒ `anchor-lang = { version = "1.1.2", features = ["init-if-needed"] }`. **Nada más.** `anchor-spl` (`:24`) y el bloque `[features]` (`:12-20`) quedan intactos. | — |
| 2 | `programs/escrow/src/lib.rs` (340 líneas) | Modificar | Agregar: consts, `EscrowIndex`, error `EscrowIndexFull`, handlers `register_escrow`/`deregister_escrow`, Contexts `RegisterEscrow`/`DeregisterEscrow`. Diff **cero** en `:11-149`, `:156-174`, `:198-339`. | `:156-167` (state), `:88-124` (handler), `:277-310` (Context), `:180-192` (errores) |
| 3 | `tests/escrow.ts` (537 líneas) | Modificar | **Solo** agregar el test T1a (canario de 154 bytes). No tocar los 9 tests existentes ni los helpers. | patrón `:519-522` y `:134-137` |
| 4 | `tests/escrow-index.ts` | **Crear** | Suite nueva: T1b, T2..T8, T10, T11. Se levanta sola con el glob de `Anchor.toml:25`. | `tests/escrow.ts:1-255` (imports + helpers + `beforeEach`) |
| 5 | `README.md` (91 líneas) | Modificar | Corregir `:37` (hoy afirma "`init` (never `init_if_needed`)", que pasa a ser falso a nivel programa) + documentar las 2 instrucciones nuevas en la sección `## Flow` (`:25-38`). | el propio estilo del archivo |
| 6 | `doc/sdd/002-escrow-remittance-id-recovery/runbook-R1-deploy-devnet.md` | **Crear** | Runbook del deploy (§8). **El dev NO deploya**: escribe el runbook, el deploy es gate humano. | `scripts/deploy-devnet.sh` |

### Fuera de scope (PROHIBIDO)

- **Ejecutar `anchor deploy` / `scripts/deploy-devnet.sh` / cualquier tx on-chain.** El deploy es el
  gate **G1** del SDD §10: lo ejecuta el founder. F3 escribe el runbook, no lo corre.
- Tocar `chaski-v3` o `wasiai-facilitator` (otros stories, otros repos). **Lectura sí, escritura no.**
- Re-pinear el hash del IDL (eso es R2a/R2b).
- `realloc` en cualquier lado (CD-11).
- Cambiar la derivación del PDA / esquema de nonce (descartado por el founder).
- Rescatar el escrow `BmHDdjKL…` (Scope OUT **con nombre**, AC-7/CD-2: el dato nunca se guardó).
- `scripts/deploy-devnet.sh` no se modifica.

---

## 4. Por qué `EscrowState` no se toca — y el canario que lo hace cumplir

Leído del código del macro `#[account]` de anchor 1.1.2, no de memoria:

1. **El discriminador NO cambia al agregar un campo.** `gen_discriminator("account", EscrowState)` =
   `sha256("account:EscrowState")[..8]`
   (`anchor-syn-1.1.2/src/codegen/program/common.rs:19-27`): depende **solo del nombre del struct**.
   Por eso el chequeo de `try_deserialize` (`anchor-attribute-account-1.1.2/src/lib.rs:247-256`)
   **pasa**: Anchor cree que la cuenta vieja es del tipo correcto. Eso es lo peligroso: no hay error
   temprano de "versión distinta".
2. **Falla la deserialización, por longitud.** `try_deserialize_unchecked` (`ibid.:258-262`) mapea
   **cualquier** error de borsh a `ErrorCode::AccountDidNotDeserialize` = **3003**
   (`anchor-lang-error-1.1.2/src/lib.rs:238-239`). `EscrowState::INIT_SPACE` = 32·4 + 8 + 8 + 1 + 1 =
   **146**; la cuenta se creó con `space = 8 + INIT_SPACE` (`lib.rs:209`) = **154 bytes exactos, sin
   padding**. Un `[u8;16]` extra pediría 162 de payload sobre 146 disponibles ⇒ `UnexpectedEof` ⇒ 3003.
3. `Account<'info, EscrowState>` aparece en los Contexts de `release` (`:257`), `refund` (`:292`) y
   `close` (`:329`). Las tres instrucciones fallarían con 3003 **para toda cuenta pre-upgrade**: un
   fix de "fondos inalcanzables" que vuelve inalcanzables los fondos que hoy sí se pueden mover.
4. `realloc` no salva: para reallocar hay que cargar la cuenta en un Context, y cargarla como
   `Account<EscrowState>` ya falla con 3003. Una migración tendría que hacer byte-poking con
   `UncheckedAccount` **y** re-derivar las seeds, que exigen el `remittance_id` — el dato que
   justamente puede faltar. La migración sería imposible exactamente en los casos que motivan la HU.

**Canario permanente**: el test **T1a** asertea que un `deposit` produce una cuenta de **exactamente
154 bytes**. Si alguien "mejora" el diseño agregando un campo a `EscrowState`, ese test se pone rojo
en el acto y nadie ladrilla los escrows vivos. **No lo borres, no lo relajes, no lo hagas
tolerante a rangos.**

---

## 5. Especificación del código (esto es el contrato; no improvises la forma)

### 5.1 Constantes y estado

```rust
// ── Constantes del índice (HU-SOL-20). Van arriba de la sección State. ──
/// Máximo de escrows ABIERTOS indexables por sender. El índice solo lista escrows en estado
/// Deposited (ver RegisterEscrow), y el ciclo de vida de un escrow es de minutos/horas ⇒ 32 es
/// ~16-32x el uso real esperado. Subirlo a futuro es OTRA HU (CD-11).
pub const MAX_ENTRIES: usize = 32;
/// Versión del layout de EscrowIndex (forward-compat). Hoy 1.
pub const ESCROW_INDEX_VERSION: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct EscrowIndex {
    pub sender: Pubkey,               // 32 — redundante con las seeds; habilita memcmp como fallback
    pub version: u8,                  //  1 — forward-compat del layout del índice
    pub bump: u8,                     //  1 — bump canónico del PDA
    #[max_len(MAX_ENTRIES)]
    pub entries: Vec<[u8; 16]>,       //  4 + 16·32 = 516 — id16 de los escrows ABIERTOS del sender
}
```

**Verificado leyendo el macro** (`anchor-derive-space-1.1.2/src/lib.rs:212-225`): `max_len` acepta
"integer literals, identifiers, or paths" ⇒ `#[max_len(MAX_ENTRIES)]` compila y expande a
`(MAX_ENTRIES as usize)`. Y para `Vec<T>` (`ibid.:168-178`) el cálculo es `4 + type_len * max_len`
⇒ `4 + 16*32 = 516`. Total `INIT_SPACE` = 32+1+1+516 = **550**; `space = 8 + 550` = **558 bytes**,
**fijo**, asignado al máximo en el init. **Sin `realloc` en ningún lado** (CD-11).

Error nuevo, al final del enum existente (`lib.rs:180-192`, después de `EscrowNotTerminal`):
```rust
    #[msg("Escrow index is full for this sender")]
    EscrowIndexFull,
```
> Va **al final** a propósito: los códigos de error de Anchor son posicionales desde 6000. Insertarlo
> en el medio renumeraría `EscrowNotDeposited`/`DeadlineNotReached`/`EscrowNotTerminal` y rompería a
> cualquiera que mapee códigos. Verificado: hoy son 6000..6004 en `target/idl/escrow.json` ⇒
> `EscrowIndexFull` debe quedar **6005**.

### 5.2 Context `RegisterEscrow` — orden de cuentas FIJADO acá

| # | Cuenta | Flags exactos |
|---|--------|---------------|
| 0 | `sender` | `Signer`, `#[account(mut)]` (paga el rent del índice, igual que hoy en `deposit`, `:201-202`) |
| 1 | `escrow_state` | `Account<EscrowState>`, **NO `mut`** (no se modifica) |
| 2 | `escrow_index` | `Account<EscrowIndex>`, `init_if_needed` |
| 3 | `system_program` | `Program<System>` (requerido por el init) |

```rust
#[derive(Accounts)]
#[instruction(remittance_id: [u8; 16])]
pub struct RegisterEscrow<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    // NO `mut`: register_escrow no modifica el escrow. Las seeds (que incluyen al signer) son el
    // guard REAL de ownership; `has_one` es defensa en profundidad, espejo de Refund (:287-290).
    #[account(
        seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()],
        bump = escrow_state.bump,
        has_one = sender,
        constraint = escrow_state.status == EscrowStatus::Deposited @ ErrorCode::EscrowNotDeposited
    )]
    pub escrow_state: Account<'info, EscrowState>,

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
```

> ⚠️ **TRAMPA VERIFICADA — no agregues `mut` a `escrow_index`.** El SDD §4.4 lista ese account con
> `init_if_needed, payer, space, seeds, bump, mut`, y esa combinación **NO COMPILA**:
> `anchor-syn-1.1.2/src/parser/accounts/constraints.rs:631-637` devuelve
> `"mut cannot be provided with init"`. `init`/`init_if_needed` **ya implica** `mut` (el macro lo
> inyecta solo, `:637-640`). Si copiás la tabla del SDD tal cual, perdés media hora con un error de
> macro. Esta línea del SDD está corregida acá.

> ⚠️ **PROHIBIDO agregar `has_one = sender` a `escrow_index`** (CD-8): en la rama de creación de
> `init_if_needed` el campo todavía vale `Pubkey::default()`, así que metés una dependencia de orden
> init↔chequeo sin ganar nada. Las seeds `["escrow-index", sender]` + `Signer` ya son el guard
> criptográfico: nadie puede tocar el índice de otro.

### 5.3 Handler `register_escrow`

```rust
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
```

Propiedades que AR tiene que poder verificar de un vistazo (no las rompas):
- **No mueve un solo token.** Ninguna `CpiContext`, ningún `anchor_spl::token::*`.
- **Exige que el escrow exista, sea del `sender` y esté `Deposited`**: si no existe ⇒
  `AccountNotInitialized` (**3012**, `anchor-lang-error-1.1.2/src/lib.rs:264-266`); si es de otro
  sender, las seeds no cierran ⇒ `ConstraintSeeds`.
- **Sirve de backfill**: como `EscrowState` no cambió, registrar un escrow **pre-upgrade** cuyo id16
  se conserve funciona igual (eso es R5). **No** rescata `BmHDdjKL…`.
- **`Deposited` obligatorio** ⇒ el índice solo lista escrows abiertos ⇒ su tamaño está acotado por
  el trabajo en vuelo del sender, no por su historia.

### 5.4 Context + handler `deregister_escrow`

```rust
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
```
> Notá que **no** lleva `#[instruction(remittance_id: [u8; 16])]`: las seeds del índice no usan el
> argumento, y Anchor permite handlers con args que el Context no referencia.

```rust
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
```
Peor caso auditado: el `sender` borra su propio breadcrumb. Los fondos siguen siendo refundeables por
él con el id16 (que además está en el store de R0), y puede volver a registrar mientras el escrow
siga `Deposited`. Autolesión reversible. **No hay `authority` involucrada ⇒ AC-5/CD-1 no aplica y no
puede violarse.**

### 5.5 Discriminadores esperados — **verificalos, no los copies a ciegas**

Calculados como `sha256("<ns>:<name>")[..8]` (método validado: da exacto los valores ya pineados de
`deposit` = `[242,35,198,137,82,225,242,182]` en
`wasiai-facilitator/src/methods/solana-sponsor/deposit-shape.ts:25`, y de la cuenta `EscrowState` =
`[19,90,148,111,55,130,229,108]` documentada en `wasiai-facilitator/src/chains/escrow-idl.ts:14-16`):

| Símbolo | Namespace | Discriminador esperado |
|---|---|---|
| `register_escrow` | `global` | `[200, 17, 194, 170, 224, 144, 127, 166]` |
| `deregister_escrow` | `global` | `[226, 232, 192, 96, 102, 196, 211, 162]` |
| `EscrowIndex` (cuenta) | `account` | `[55, 105, 102, 30, 12, 158, 174, 239]` |

**Después de `anchor build`, leelos de `target/idl/escrow.json` y compará.** Si difieren, manda el
IDL, no este documento (CD-15: la fuente de verdad es el artefacto generado, nunca un literal de
doc). R3 va a pinear el de `register_escrow` en el facilitator: reportá el valor **leído**, no el
esperado.

---

## 6. Tests — por AC, con criterio de MUTACIÓN

Framework: `anchor test --skip-deploy --skip-local-validator` (anchor-bankrun, in-process, sin
validador). Timeout ya generoso: `-t 1000000` (`Anchor.toml:25`).

| # | Test | AC / riesgo | Archivo | Cómo |
|---|------|-------------|---------|------|
| **T1a** | **CANARIO**: un `deposit` produce un `escrow_state` de **exactamente 154 bytes** | **AC-6 / CD-7** | `tests/escrow.ts` | `(await context.banksClient.getAccount(escrowState)).data.length === 154` (patrón `:134`, `:519`) |
| **T1b** | Cuenta **legacy sintética**: `context.setAccount` con 154 bytes armados a mano (8 disc + 4 pubkeys + u64 + i64 + status + bump) + su vault ATA con saldo ⇒ `refund` pasado el deadline **funciona** y los tokens vuelven al `sender_ata` | **AC-6 empírico** | `tests/escrow-index.ts` | `setAccount(address, AccountInfoBytes)` (verificado en `node_modules/solana-bankrun/dist/index.d.ts:187`) + `setClock` (patrón `tests/escrow.ts:195-208`) |
| **T2** | `deposit` + `register_escrow` ⇒ el PDA `["escrow-index", sender]` existe, `entries.length===1`, `entries[0]` == el id16 usado, `sender`/`version`(=1)/`bump` correctos. Segundo deposit+register ⇒ `entries.length===2` | **AC-3** | idem | derivar el PDA **solo con el sender**; `program.account.escrowIndex.fetch(...)` |
| **T3** | **Recuperación e2e con el id "perdido"**: descartar la variable del `remittanceId`, leer el índice, tomar `entries[0]`, derivar `["escrow", sender, entries[0]]`, llamar `refund` ⇒ los tokens vuelven | **AC-4** | idem | ninguna aserción puede usar el string/array original — **borralo de scope** (ver §6.1) |
| **T4a** | Sobre el IDL buildeado: el set de instrucciones es **exactamente** `{close, deposit, refund, release, register_escrow, deregister_escrow}` **y** ninguna de las 2 nuevas tiene una cuenta llamada `authority` | **AC-5 / CD-1** | idem | `import idl from "../target/idl/escrow.json"` (patrón `tests/escrow.ts:24`). **PROHIBIDO `it.skip` condicional** |
| **T4b** | Un atacante llama `register_escrow` con el `escrow_state` de la víctima ⇒ revierte | **AC-5** | idem | firma `attacker`, pasa el `escrowState` de `sender` ⇒ `ConstraintSeeds` |
| **T4c** | Un atacante llama `deregister_escrow` apuntando al `escrow_index` de la víctima ⇒ revierte | **AC-5** | idem | `ConstraintSeeds` |
| **T5** | Registrar `MAX_ENTRIES` (32) ids y el 33º ⇒ revierte con el código **`EscrowIndexFull`** | DT-5 (dead-end del cap) | idem | 33 deposit+register en un loop. Presupuesto verificado: sender arranca con 100 SOL (`tests/escrow.ts:247`) y 1000 tokens (`:252`); 33 depósitos ≈ 0,13 SOL de rent y 33 tokens ⇒ alcanza. `rid(seed)` (`:148-152`) da 256 ids distintos ⇒ alcanza |
| **T6** | `register_escrow` dos veces con el mismo id16 ⇒ **no duplica** y **no revierte** | idempotencia / CD-9 | idem | **CD-12**: entre los dos intentos, `bumpSlot()` o variar el ix-data. Bankrun **deduplica** txs de firma idéntica y el test pasaría por el motivo equivocado |
| **T7** | `deregister_escrow` quita la entrada correcta, deja las otras intactas, **no mueve tokens** (vault y ATAs con el mismo saldo antes/después) y es no-op si el id no está | DT-7 | idem | comparar saldos con `AccountLayout` (patrón `:133-137`) |
| **T8a** | `register_escrow` con un `escrow_state` inexistente ⇒ `AccountNotInitialized` | flujo de error | idem | usar un id16 nunca depositado |
| **T8b** | `register_escrow` sobre un escrow ya `Released` ⇒ **`EscrowNotDeposited`** | flujo de error | idem | reusar el helper de release del exemplar (`tests/escrow.ts:267-281`) |
| **T9** | Los 9 tests de `tests/escrow.ts` siguen verdes **sin modificarlos** (salvo el agregado de T1a) | **AC-6 / CD-8** | `tests/escrow.ts` | 9/9. Cualquier cambio necesario en un test viejo es señal de que se rompió el contrato ⇒ PARAR |
| **T10** | Rent real: `getMinimumBalanceForRentExemption(558)` y `(154)`; registrar los valores medidos y compararlos con el cálculo del SDD (`(128+558)·6960` = **4.775.760 lamports** ≈ 0,00477 SOL) | verificar el cálculo, no confiarle | idem | `provider.connection.getMinimumBalanceForRentExemption` (patrón `:74-76`). **Si difiere, manda el test** y se reporta el número real |
| **T11** | **CU de la tx atómica B1**: una sola tx con `deposit` + `register_escrow` ⇒ registrar `computeUnitsConsumed` | insumo directo de **R3** | idem | `const meta = await context.banksClient.processTransaction(tx)` ⇒ `meta.computeUnitsConsumed` (verificado en `dist/index.d.ts:14-23`). Asertar `< 300000` (el default de `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` en `wasiai-facilitator/src/infra/env.ts:212`) y **reportar el número exacto** |

> T11 no está en el test plan del SDD §9: lo agrego porque el SDD §4.8 deja "revisar
> `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` antes de encender" como nota de ops sin medición. Medirlo acá,
> gratis y determinístico, evita que R3 se decida a ojo. El número medido va en el reporte de F3.

### 6.1 Un test cuyo doble ignora los argumentos es un test vacuo — la versión de este repo

Acá no hay dobles (los tests corren contra el programa real en bankrun), pero hay dos formas
equivalentes de escribir un test que aprueba desde arriba:

1. **T3 tramposo**: si el test tiene el `remittanceId`/id16 original en una variable y lo usa en
   *cualquier* aserción o en la construcción del `refund`, no probó nada: probó el camino que ya
   funcionaba. Forma obligatoria: derivar todo desde `entries[0]` leído de la cuenta, y **no dejar la
   variable original en scope** (usá un bloque `{ ... }` para el setup, o reasignala a `null` con un
   comentario). Verificación: renombrar la variable original ⇒ el test debe **seguir compilando y
   pasando**; si deja de compilar, la estaba usando.
2. **T4a con `it.skip` silencioso**: los tests de hash de los otros dos repos usan
   `(existsSync(SIBLING) ? it : it.skip)` (`wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:29`).
   Ese patrón, acá, sería un test que **desaparece** en vez de fallar. **PROHIBIDO**: importá el IDL
   directamente (`import idl from "../target/idl/escrow.json"`), que es lo que ya hace
   `tests/escrow.ts:24`. Si el IDL no está, el test tiene que **explotar**, no saltarse.
3. **T5/T8 asertando "revierte"**: `expectRevert` (`tests/escrow.ts:211-232`) exige un **código**. No
   uses una aserción genérica de "throws": asertá `EscrowIndexFull`, `EscrowNotDeposited`,
   `AccountNotInitialized`, `ConstraintSeeds` por nombre. Ver §6.2 M3 para entender por qué es
   crítico en T5.

### 6.2 Mutaciones obligatorias (ejecutar, ver el rojo, revertir)

| Mutación | Qué mutar | Test que DEBE ponerse rojo | Por qué esta mutación y no otra |
|---|---|---|---|
| **M1** | Agregar `pub _pad: u8,` al final de `EscrowState` (`lib.rs:167`) | **T1a** (y también T1b y varios de T9) | Es *el* riesgo crítico del SDD §11: reproduce exactamente el bug que ladrillaría todos los escrows vivos |
| **M2** | Borrar `constraint = escrow_state.status == EscrowStatus::Deposited @ …` de `RegisterEscrow` | **T8b** | Sin él, el índice se llena de escrows cerrados y el cap se agota con basura |
| **M3** | Borrar `require!(index.entries.len() < MAX_ENTRIES, ErrorCode::EscrowIndexFull)` | **T5** | Sin el guard, el 33º push desborda el `space` fijo y la ix falla igual, pero con `AccountDidNotSerialize` (**3004**) en vez de `EscrowIndexFull`. Si T5 solo asertea "revierte", **la mutación sobrevive**. Por eso T5 tiene que asertar el código exacto |
| **M4** | Cambiar `if !contains { push }` por un `push` incondicional | **T6** | Duplicados ⇒ el cap se agota con la misma entrada repetida |
| **M5** | Agregar `/// CHECK: x` + `pub authority: UncheckedAccount<'info>,` a `RegisterEscrow` | **T4a** | Es el guard de AC-5/CD-1: ninguna instrucción nueva puede referenciar a la `authority` |
| **M6** | Cambiar el seed literal `b"escrow-index"` por `b"escrow-idx"` en **uno solo** de los dos Contexts | **T2 o T7** (uno de los dos) | Prueba que los tests derivan el PDA de verdad y no usan el que devuelve el programa |

Después de cada mutación: `anchor build && anchor test --skip-build --skip-deploy --skip-local-validator`.
**Anotá qué test falló y con qué mensaje.** Si una mutación pasa en verde ⇒ el test es vacuo ⇒
arreglá el test **antes** de revertir la mutación.

> ⚠️ **`git diff` no ve archivos sin trackear.** `tests/escrow-index.ts` y el runbook son **nuevos**:
> si mutás uno antes de `git add`, `git diff` sale **vacío** y parece que la mutación no se aplicó.
> Verificá con `sha256sum tests/escrow-index.ts` antes y después, y de nuevo al revertir. Nos costó
> tiempo real esta semana.

> ⚠️ **`anchor build` es obligatorio entre mutación y test.** Con `--skip-build` estarías testeando el
> `.so` anterior y verías "verde" con la mutación puesta. Es la misma clase de error: un test que
> aprueba desde arriba.

---

## 7. Constraint Directives

### OBLIGATORIO
- **CD-3** — el alcance cross-repo y el orden de despliegue están en §0. No lo re-litigues.
- **CD-4/AC-6** — los escrows pre-upgrade siguen operables **exactamente** como hoy. Cumplido por
  construcción (`EscrowState` no cambia) + T1a + T1b + T9.
- **CD-9** — el handler de `register_escrow` **solo** hace escrituras idempotentes del header
  (`sender`/`version`/`bump`, todas seed-derivadas o constantes) y un `push` condicionado por
  `contains`.
- **CD-12** — todo test que reintente una operación de la misma forma **varía el ix-data o avanza el
  slot** (`bumpSlot()`, `tests/escrow.ts:190-193`). Bankrun deduplica txs con firma idéntica.
  *(Auto-blindaje #001, entrada "W4 — tests flaky: bankrun dedup".)*
- **CD-13** — leer el config real, no asumirlo. Ya verificado y fijado acá: toolchain **1.89.0**
  (`rust-toolchain.toml:2`, **no** `stable`), glob de tests `tests/**/*.ts` (`Anchor.toml:25` — **no**
  la línea 22 que dice el SDD), features de anchor en `programs/escrow/Cargo.toml:23`.
  Al agregar `tests/escrow-index.ts`, **verificá que el conteo de test-files y de tests subió**, no
  solo que "pasó". *(Patrón recurrente en 2 HUs: #001 "toolchain asumido" + WKH-227 "glob de vitest
  asumido".)*
- **CD-14** — si aparece cualquier CPI: `CpiContext::new(ctx.accounts.<program>.key(), …)` (Pubkey,
  **no** `AccountInfo`). *(Auto-blindaje #001: `E0308` en anchor 1.1.2.)* En este story **no debería
  aparecer ninguna CPI**; si escribís una, PARÁ y escalá.
- **CD-15** — nada de program ids hardcodeados en código nuevo: `declare_id!` en Rust, `idl.address`
  en TS.
- `#[msg(...)]` de los errores nuevos **en inglés**, como los 5 existentes (`:180-192`).

### PROHIBIDO
- **CD-7 — PROHIBIDO tocar `EscrowState`**: ni agregar, quitar, renombrar ni reordenar campos, ni
  cambiar `space`. Cualquier diff en `lib.rs:156-167` o en `:209` es **BLOQUEANTE**.
- **CD-8 — PROHIBIDO tocar seeds, argumentos o lista de cuentas de `deposit`, `release`, `refund` y
  `close`** (`lib.rs:198-339`). Son 4 instrucciones probadas on-chain y validadas por un
  shape-validator externo (`wasiai-facilitator/src/methods/solana-sponsor/deposit-shape.ts:51-63`).
  *(Nota: el SDD menciona un `release-shape.ts`; verificado que **no existe** — el único
  shape-validator pineado es el de `deposit`. No cambia la prohibición.)*
  También PROHIBIDO agregar `has_one = sender` a `EscrowIndex` (§5.2).
- **CD-11 — PROHIBIDO agregar `realloc`.** Espacio fijo. Subir `MAX_ENTRIES` es otra HU con su propia
  ruta de migración.
- **CD-5 — PROHIBIDO deployar a mainnet.** Devnet only.
- **CD-19 — PROHIBIDO ejecutar deploys o transacciones on-chain desde F3**, y PROHIBIDO git
  destructivo (`reset --hard`, `clean -fd`, `checkout --`, `stash drop/clear`, `branch -D`,
  `push --force`).
- **CD-17 — PROHIBIDO** que el `remittanceId` (string de negocio) se guarde on-chain. Solo los 16
  bytes.
- **CD-18 — PROHIBIDO** que este repo escriba en `chaski-v3`, `chaski-v2`,
  `wasiai-remittance-agents` o `wasiai-a2a`. Lectura sí, escritura no. **PROHIBIDO abrir
  `chaski-v3/m5-keys/`** (contiene claves). Si te cruzás algo que parece credencial, reportá
  `archivo:línea` **sin el valor**.
- **NO** agregar dependencias nuevas. `init-if-needed` es una **feature** de un crate ya pineado, no
  una dep nueva ni un bump de versión.
- **NO** modificar `scripts/deploy-devnet.sh`, `.github/workflows/ci.yml`, `Anchor.toml`,
  `Cargo.toml` (raíz) ni `rust-toolchain.toml`.

### Sobre el riesgo conocido de `init_if_needed`
El vector clásico (re-init attack) es un handler que **resetea** estado de una cuenta existente. Acá:
(a) el índice no custodia fondos, (b) las seeds lo atan al `sender` que firma, y (c) todas las
escrituras del header son idempotentes y **ninguna** resetea `entries`. Cualquier `entries.clear()`,
`= Vec::new()` o campo mutable no idempotente **reabre** el vector ⇒ **BLOQUEANTE** (CD-9).

---

## 8. Runbook de deploy R1 (lo ESCRIBÍS, no lo corrés)

Archivo #6. Contenido mínimo, en este orden:

1. **Pre-check de tamaño del programa** (footgun real: el `.so` crece al agregar 2 instrucciones y
   una cuenta; si excede el espacio ya asignado, `anchor deploy` **falla a mitad de la ventana**):
   ```bash
   export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
   solana config set --url devnet
   solana program show DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x   # leer el tamaño actual
   ls -l target/deploy/escrow.so                                       # tamaño del nuevo
   # si el nuevo > el asignado:
   # solana program extend DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x <bytes>
   ```
   Antecedente del repo: el id anterior `BBQ9…79WA` **nunca se deployó y su keypair se perdió**
   (`README.md:18-23`). **El deploy de este programa no se improvisa.**
2. **Deploy** (upgrade **in-place**, mismo program id, keypair única de upgrade authority):
   `./scripts/deploy-devnet.sh`.
3. **Post-check**: `solana program show <id>` (sigue `executable`, misma upgrade authority) +
   confirmar que `target/idl/escrow.json` contiene las 6 instrucciones y que
   `deposit`/`release`/`refund`/`close` **conservan los mismos discriminadores y las mismas cuentas**
   que antes del upgrade.
4. **Rollback**: redeploy del `.so` anterior (guardar una copia de `target/deploy/escrow.so` **antes**
   del upgrade, con su `sha256sum`, y anotarlo en el runbook).
5. **Gate**: el paso 2 lo ejecuta el **founder** (G1 del SDD §10). El runbook dice explícitamente
   "F3 no ejecuta esto".

---

## 9. Waves

### Wave -1 — Environment Gate
```bash
cd /home/ferdev/.openclaw/workspace/solana-programs
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
rustc --version            # debe ser 1.89.0 (rust-toolchain.toml:2)
anchor --version           # 1.1.2
solana --version           # 3.1.10
anchor build               # baseline VERDE antes de tocar nada
anchor test --skip-build --skip-deploy --skip-local-validator   # baseline 9/9 — ANOTAR el conteo
sha256sum target/idl/escrow.json target/deploy/escrow.so        # ANOTAR (para comparar después)
```
Si algo falla acá: **PARAR** y reportar. No se implementa sobre un baseline rojo.

### Wave 0 (serial gate) — que compile con la feature
- [ ] W0.1 `programs/escrow/Cargo.toml:23` ⇒ feature `init-if-needed`.
- [ ] **Verificación**: `anchor build` verde **sin ningún otro cambio**. Esto aísla el riesgo de la
      dependencia. (Verificado que la feature existe:
      `anchor-lang-1.1.2/Cargo.toml:58` → `init-if-needed = ["anchor-derive-accounts/init-if-needed"]`.)

### Wave 1 (serial) — contratos on-chain
- [ ] W1.1 consts `MAX_ENTRIES` / `ESCROW_INDEX_VERSION` + `EscrowIndex` + `EscrowIndexFull` (§5.1).
- [ ] W1.2 Context `RegisterEscrow` + handler `register_escrow` (§5.2, §5.3).
- [ ] W1.3 Context `DeregisterEscrow` + handler `deregister_escrow` (§5.4).
- [ ] **Verificación al completar W1** (esto es un gate, no una formalidad):
  ```bash
  anchor build
  git diff programs/escrow/src/lib.rs        # revisar A MANO: cero cambios en EscrowState (:156-167),
                                            # en `space` (:209) y en los 4 Contexts viejos (:198-339)
  python3 - <<'EOF'
  import json; d=json.load(open('target/idl/escrow.json'))
  print(sorted(i['name'] for i in d['instructions']))
  print({i['name']: i['discriminator'] for i in d['instructions']})
  print([a['name'] for a in d['accounts']], [(e['code'],e['name']) for e in d['errors']])
  EOF
  ```
  Debe dar: 6 instrucciones; `deposit`=`[242,35,198,137,82,225,242,182]`,
  `release`=`[253,249,15,206,28,127,193,241]`, `refund`=`[2,96,183,251,63,208,46,46]`,
  `close`=`[98,165,201,177,108,65,206,96]` (**idénticos a hoy**); `EscrowIndexFull` = **6005**;
  cuentas `[EscrowState, EscrowIndex]`.

### Wave 2 (paralelizable tras W1) — tests
- [ ] W2.1 `tests/escrow.ts` ⇒ **T1a** únicamente.
- [ ] W2.2 `tests/escrow-index.ts` ⇒ T1b, T2, T3, T6, T10, T11.
- [ ] W2.3 `tests/escrow-index.ts` ⇒ T4a/T4b/T4c, T5, T7, T8a/T8b (adversariales).
- [ ] **Verificación**: `anchor test --skip-deploy --skip-local-validator` verde **y el conteo de
      test-files y de tests SUBIÓ** respecto al baseline de Wave -1 (CD-13). T9 = los 9 originales
      siguen verdes sin editarlos.

### Wave 3 (mutación)
- [ ] W3.1 Correr **M1..M6** (§6.2), una por una: mutar → `anchor build` → `anchor test` → anotar el
      test rojo y el mensaje → revertir → verificar con `sha256sum` que el archivo volvió al estado
      original.

### Wave 4 (cierre documental)
- [ ] W4.1 `README.md`: corregir `:37` y documentar `register_escrow`/`deregister_escrow` en `## Flow`.
- [ ] W4.2 Escribir el runbook (§8). **Sin ejecutarlo.**
- [ ] W4.3 Reportar al orquestador: (a) los **discriminadores leídos del IDL** para
      `register_escrow`/`deregister_escrow`/`EscrowIndex`, (b) el **nuevo sha256 canónico del IDL**
      calculado con node (ver el aviso de abajo), (c) el **CU medido** en T11, (d) el rent medido en
      T10, (e) el resultado de M1..M6.

> ⚠️ **Cómo NO calcular el hash del IDL.** Los dos repos hermanos usan `canonicalSha256` =
> SHA-256 sobre JSON canónico con **claves ordenadas** y `JSON.stringify` de Node
> (`chaski-v3/contracts/idl/canonical-hash.ts:7-25`). Verificado en vivo: `sha256sum` sobre el
> archivo **NO** sirve (el orden de claves y el formato importan), y un script en Python **tampoco**
> (Python escapa los no-ASCII como `\uXXXX` y el IDL tiene docs con acentos ⇒ da un hash distinto).
> Usá node con exactamente ese algoritmo. Hoy, pre-cambio, ese cálculo devuelve
> `aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71`, que es el valor pineado en los
> 3 lugares ⇒ el punto de partida está en verde y **se pone rojo apenas buildees**. Eso es esperado
> (R2a/R2b lo cierran), no es una regresión.

---

## 10. Definition of Done

1. `anchor build` verde y `anchor test --skip-deploy --skip-local-validator` verde, con el conteo de
   tests **mayor** que el baseline.
2. `git diff programs/escrow/src/lib.rs` muestra **cero** cambios en `EscrowState`, en `space = 8 +
   EscrowState::INIT_SPACE` y en los 4 Contexts viejos.
3. El IDL nuevo conserva **los mismos 4 discriminadores y las mismas cuentas** para
   `deposit`/`release`/`refund`/`close`. `EscrowIndexFull` = 6005.
4. **T1a existe y falla si se agrega un campo a `EscrowState`** (probado con M1).
5. Las 6 mutaciones se ejecutaron y cada una puso rojo el test declarado, con evidencia.
6. Runbook escrito. **Cero** deploys, cero txs on-chain, cero commits no pedidos.
7. Reportados: discriminadores leídos, hash nuevo del IDL, CU de T11, rent de T10.

---

## 11. Escalation Rule

Si algo no está en este Story File → **PARÁS y preguntás al Architect**. No inventes, no asumas.

Escalá especialmente si:
- `anchor build` falla por la feature `init-if-needed` de una forma que no es la trampa documentada
  en §5.2.
- Un test de `tests/escrow.ts` (los 9 originales) necesita cambiar para pasar ⇒ **eso es señal de que
  se rompió el contrato**, no de que el test estaba mal.
- El `.so` nuevo no entra en el espacio asignado del programa (dato para el runbook, no para
  improvisar un `extend`).
- Aparece la tentación de agregar un campo a `EscrowState`, un `realloc`, o de tocar `deposit` ⇒
  **STOP**, eso está prohibido y hay 6 alternativas ya evaluadas y descartadas en el SDD §4.2.
- Necesitás tocar algo en `chaski-v3` o `wasiai-facilitator` ⇒ **eso es otro story, otro repo.**

---

*Story File generado por NexusAgil — F2.5 · nexus-architect · HU-SOL-20 · R1/7*
