# SDD #002: Camino de recuperación cuando se pierde el `remittanceId` del escrow

> SPEC_APPROVED: no
> Fecha: 2026-07-27
> Tipo: feature (aditiva, money-path)
> SDD_MODE: full
> HU: **HU-SOL-20** (identificador canónico; ver §2.0 — Jira suspendido, la gestión vive en el repo)
> Branch: `feat/002-escrow-remittance-id-recovery`
> Artefactos: `doc/sdd/002-escrow-remittance-id-recovery/`
> Repos afectados: `solana-programs` (este) + `chaski-v3` + `wasiai-facilitator`

---

## 1. Resumen

El PDA `escrow_state` se deriva de `["escrow", sender, sha256(utf8(remittanceId))[:16]]`. Esos 16
bytes son la **única** llave para direccionar la cuenta, y hoy no se guardan en ningún lado
on-chain: si el `remittanceId` se pierde (hoy vive solo en `window.localStorage`), los fondos
quedan inalcanzables incluso para el `refund` trustless que ya funciona.

Este SDD entrega dos capas complementarias, en este orden:

- **Wave 0 (off-chain, sin cadena)**: cerrar el agujero real de hoy. La fila durable
  server-side **ya se escribe** en `remittance_settlements` antes del depósito
  (`chaski-v3/app/api/payout/prepare/route.ts:296-311`), pero **nadie la lee**: `refundEscrow`
  recibe el `remittanceId` como parámetro y no tiene fallback
  (`chaski-v3/src/infrastructure/solana-wallet.ts:160-180`). Wave 0 agrega la lectura
  sender-scoped + el fallback del refund. Protege desde el día uno, sin tocar el programa.
- **Wave 1+ (on-chain, aditivo)**: una **cuenta nueva** `EscrowIndex` (PDA `["escrow-index", sender]`)
  que lista los `[u8;16]` de los escrows abiertos de ese `sender`, escrita por una **instrucción
  nueva** `register_escrow`. `EscrowState`, `deposit`, `release`, `refund` y `close` **NO se tocan**.
  Con el índice, el `sender` recupera los 16 bytes desde la cadena con **una** llamada RPC
  determinística (`getAccountInfo` de un PDA derivable solo con su address) y ejecuta el `refund`
  que ya está probado on-chain.

Resultado esperado: ningún escrow depositado después de esta HU puede quedar inalcanzable por
pérdida del identificador, y **ningún escrow ya depositado se rompe** (compatibilidad total, por
construcción y no por suerte — §4.1/§4.2).

---

## 2. Work Item

### 2.0 Numeración (resuelve un Missing Input del work-item)

El work-item dejó abierto el `WKH-NN`. **Resuelto**: Jira está suspendido y la gestión pasó al
repo, por lo que el identificador canónico de esta HU es **`HU-SOL-20`**, carpeta
`doc/sdd/002-escrow-remittance-id-recovery/`, fila `002` de `doc/sdd/_INDEX.md`. No se inventa
ningún `WKH-NN`. `_INDEX.md:6` debe actualizarse para reemplazar `WKH-TBD / HU-SOL-20?` por
`HU-SOL-20` (lo hace `nexus-docs` en el cierre; no es trabajo de F2).

| Campo | Valor |
|-------|-------|
| **#** | 002 / HU-SOL-20 |
| **Tipo** | feature aditiva (money-path) |
| **SDD_MODE** | full |
| **Objetivo** | Que el `sender` de un escrow pueda recuperar la llave de direccionamiento de sus escrows abiertos sin depender del `remittanceId` guardado en el browser, y ejercer `refund` con ella. |
| **Reglas de negocio** | Devnet, dinero no real. Custodia trustless: solo el `sender` refundea. Ninguna autoridad nueva sobre fondos. Los escrows viejos siguen operables sin migrar. |
| **Scope IN** | §6 |
| **Scope OUT** | §6 (incluye, con nombre, el escrow `BmHDdjKL…`) |
| **Missing Inputs** | §12 (1 abierto no-bloqueante-para-codear, 1 decisión de founder acotada a W2/W3) |

### 2.1 Acceptance Criteria (EARS) — heredados del work-item

- **AC-1 (W0)**: WHEN un `deposit` es autorizado por el cliente, the system SHALL persistir el
  `remittanceId` de forma durable server-side (no solo `localStorage`), indexado por la address
  del `sender`, ANTES de que el cliente firme/broadcastee el `deposit`.
- **AC-2 (W0)**: WHEN el flujo de `refund` no recibe un `remittanceId` explícito del caller, the
  system SHALL intentar resolverlo desde el store de AC-1 usando la address conectada del
  `sender` como clave, antes de fallar.
- **AC-3 (W1+)**: WHEN un `sender` conectado no posee el `remittanceId` de un escrow propio, the
  system SHALL proveer un mecanismo que permita descubrir la dirección de TODOS los
  `escrow_state` abiertos de ese `sender` sin requerir el `remittanceId` original.
- **AC-4 (W1+)**: WHEN un `escrow_state` es descubierto mediante AC-3 sobre un escrow depositado
  DESPUÉS del upgrade, the system SHALL permitir que su `sender` invoque `refund` sobre esa cuenta
  sin necesitar reconstruir el `remittance_id` de 16 bytes a partir del `remittanceId` original.
- **AC-5**: IF cualquier mecanismo de recuperación permite a la `authority`/árbitro mover o
  redirigir fondos, THEN the system SHALL exigir también la firma del `sender` original.
- **AC-6**: WHILE existan `escrow_state` deployados bajo el esquema actual cuyo `remittanceId` se
  conserve, the system SHALL seguir permitiendo `release`/`refund`/`close` sobre ellos exactamente
  como hoy, sin migración.
- **AC-7**: IF un escrow fue depositado ANTES del upgrade Y su `remittanceId` está
  irrecuperablemente perdido, THEN the system SHALL NO prometer ni implementar un rescate.

### 2.2 Refinamiento explícito de AC-4 (leerlo antes de F2.5 — no es una reinterpretación silenciosa)

AC-4 dice literalmente «sin necesitar reconstruir el `remittance_id` original de 16 bytes **como
argumento de instrucción**». El diseño elegido **sí pasa** los 16 bytes como argumento a `refund`
(la instrucción no se toca), pero **no requiere el secreto perdido**: los 16 bytes se **leen de la
cadena** desde `EscrowIndex`. El espíritu de AC-4 —«el `sender` no depende de ningún dato off-chain
para operar su escrow»— se cumple al 100%; la letra («no como argumento de instrucción») se cumple
solo si se cambiara la firma de `refund`, lo cual:

1. rompería el `release-shape`/`refund` ya validado y probado on-chain,
2. crearía lógica dual permanente (exactamente lo que el founder descartó para el esquema de nonce),
3. no agrega ninguna capacidad: con el id16 en la mano, `refund` ya funciona.

**Decisión**: se cumple AC-4 en su intención, documentado acá. Si QA exige la letra, esto es un
`DRIFT` esperado y ya justificado, no un hallazgo. Marcado también en §12.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos (todos verificados como existentes)

| Archivo | Por qué | Hallazgo / patrón extraído |
|---------|---------|----------------------------|
| `solana-programs/programs/escrow/src/lib.rs` | el programa entero (339 líneas, leído completo) | `declare_id!` en `:5` = `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`. `EscrowState` en `:156-167` **no guarda** `remittance_id` ni su hash. Seeds en `:210,250,287,322`. `payer = sender` para `escrow_state` (`:208`) y `vault` (`:217`) → **el sender ya paga rent hoy**. Constraints declarativos (`has_one`, `constraint = ... @ Err`) en `:252-255,289-290,326`. Patrón `CpiContext::new(ctx.accounts.token_program.key(), ...)` (Pubkey, no AccountInfo — auto-blindaje #001). |
| `solana-programs/tests/escrow.ts` | exemplar de la suite | `startAnchor` + `BankrunProvider` (`:1-31`), helpers `processIxs`/`fundSol`/`createMint6` (`:47-80`), `bumpSlot()` con `context.setClock` (`:190-198`), `context.banksClient.getAccount` (`:134,519`), 9 tests nombrados `1.`…`9.` (`:259-531`). |
| `solana-programs/Anchor.toml` | cluster + globs | `[programs.localnet]` y `[programs.devnet]` ambos con DR5G (`:12,15`); `cluster = "devnet"` (`:18`); `[scripts] test = "npx ts-mocha … tests/**/*.ts"` → **un archivo de test nuevo bajo `tests/` se levanta solo**. |
| `solana-programs/programs/escrow/Cargo.toml` | features de anchor | `anchor-lang = "1.1.2"` **sin features** (`:22`) → `init_if_needed` HOY NO COMPILA (ver DT-4). |
| `solana-programs/target/idl/escrow.json` | 3ª fuente del program id | `"address": "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x"` (`:2`). `target/` está en `.gitignore:3` → es artefacto local, relevante para el golden sibling (§4.9). |
| `solana-programs/.github/workflows/ci.yml` | gate de CI | `anchor build` + `anchor test --skip-build --skip-deploy --skip-local-validator`; toolchain pineado `dtolnay/rust-toolchain@1.89.0`, `SOLANA_VERSION=3.1.10`, `ANCHOR_VERSION=1.1.2`. |
| `solana-programs/scripts/deploy-devnet.sh` | el gate de deploy | 4 líneas: `solana config set --url devnet` + `anchor deploy --provider.cluster devnet`. Upgrade in-place con la keypair única. |
| `chaski-v3/src/infrastructure/solana-wallet.ts` | cliente que deposita y refundea | `remittanceIdToBytes16` en `:61-63` (`@noble/hashes`). `authorizePrincipal` `:67-151`: `feePayer = facilitator` (`:138`), partial-sign, **`.remainingAccounts([reference])`** (`:132`) → la tx de deposit YA lleva una cuenta remaining. `refundEscrow` `:160-228`: recibe `remittanceId` como parámetro (`:160`), **sin ningún fallback** si el caller no lo tiene. |
| `chaski-v3/src/infrastructure/solana-wallet-bridge.ts` | capacidad de firma | solo registra `useWallet().signTransaction` (`:15`); **no expone `signAllTransactions`** → relevante para la variante B2 (DT-6). |
| `chaski-v3/app/api/payout/prepare/route.ts` | ¿cuándo se escribe la fila durable? | `recordOrderPrepared` Solana en `:296-311`, dentro de `prepare`, **antes** de que el cliente pueda construir el deposit (el deposit necesita `beneficiary`/`authority` que esta misma ruta devuelve en `:314-318`). Best-effort en try/catch (`:309-311`) y gated por `getSettlementLedger()`. |
| `chaski-v3/src/infrastructure/persistence/supabase-settlement-ledger.ts` | el store durable | tabla `remittance_settlements` (`:22`), columnas `remittance_id` + `sender_address` (`:25-26`), factory `null` si `SETTLEMENT_LEDGER_ENABLED !== "true"` (`:243`), ownership app-layer por `sender_address` (`:1-8`), `::text` en numerics (CD WKH-196). |
| `chaski-v3/src/application/ports.ts` | el port a extender | `SettlementLedger` en `:378-431`: `recordOrderPrepared` (`:383`), `listStale` (`:415`, global/admin). **No existe** ninguna query por `sender_address` → es lo que falta para AC-2. |
| `chaski-v3/src/infrastructure/address.ts` | clave de matcheo | `canonicalizeAddress(_, "solana")` = round-trip `new PublicKey(x).toBase58()`, **case-sensitive** (`:13-25`) → la clave del store y la address de la wallet matchean sin normalización lossy. |
| `chaski-v3/src/infrastructure/auth/pop-verify-solana.ts` | auth del endpoint nuevo | `verifySolanaPop` (`:19`) + `pop-challenge.ts:133` `verifySolanaPopChallenge` → infra ya existente para probar posesión de la wallet (evita IDOR en la lectura sender-scoped). |
| `wasiai-facilitator/src/methods/solana-sponsor/cr1.ts` | **el hallazgo que define el orden de release** | `:80-82` `if (businessIx.length !== 1) reject('NOT_EXACTLY_ONE_BUSINESS_IX')`; `:144` `keys.length < 8 → reject`; `:170-173` toda cuenta en índice ≥8 debe ser **no-signer y no-writable** (`REMAINING_ACCOUNT_FLAGS_INVALID`); `:180-186` el fee-payer no puede aparecer en NINGUNA ix. |
| `wasiai-facilitator/src/methods/solana-sponsor/deposit-shape.ts` | shape pineado del deposit | `DEPOSIT_POSITIONAL_ACCOUNTS = 8` (`:51`), `DEPOSIT_DISCRIMINATOR` (`:25`), índices `:54-63`. |
| `wasiai-facilitator/src/routes/solana-sponsor.ts` | wiring del money-path | `:150` inyecta `validateDepositForSponsor`; config CU/fee desde `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` / `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` (`:66-68`). |
| `wasiai-facilitator/src/chains/solana-escrow.ts` | lado authority/lectura | `remittanceIdToBytes16` con `node:crypto` (`:95-97`), `deriveEscrowStatePda` (`:103-113`), `readEscrowState` decodifica `EscrowState` con `BorshAccountsCoder` (`:164-165`), `ESCROW_PROGRAM_ID_DEFAULT` (`:43`). |
| `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts` + `chaski-v3/contracts/idl/escrow-idl.hash.test.ts` | el lock que se va a poner rojo | ambos pinean `ESCROW_IDL_SHA256 = aa53c03f…fb71` (`:21` y `:9`) y el test AC-3 compara contra el **sibling** `../solana-programs/target/idl/escrow.json`. |
| `chaski-v3/contracts/CONTRACT-VERSIONS.md` | 3er lugar del hash | el mismo sha256 en `:53`. |
| `~/.cargo/registry/.../anchor-attribute-account-1.1.2/src/lib.rs` | **la pregunta central del layout** | `:247-256` `try_deserialize` (solo chequea `len<8` y compara los 8 bytes), `:258-262` `try_deserialize_unchecked` → `AnchorDeserialize::deserialize` → error `AccountDidNotDeserialize`. Discriminador vía `gen_discriminator("account", Ident)` (`:113-125`). |
| `~/.cargo/registry/.../anchor-syn-1.1.2/src/codegen/program/common.rs` | qué determina el discriminador | `:19-27` `gen_discriminator` = `sighash(namespace, name)` → **depende SOLO del nombre del struct**, no de sus campos. |
| `~/.cargo/registry/.../anchor-lang-error-1.1.2/src/lib.rs` | códigos exactos | `:230-241` `AccountDiscriminatorAlreadySet=3000`, `NotFound=3001`, `Mismatch=3002`, **`AccountDidNotDeserialize=3003`**; `:264-266` `AccountNotInitialized=3012`. |
| `~/.cargo/registry/.../anchor-syn-1.1.2/src/parser/accounts/constraints.rs` | features/gates | `:624-625` `init_if_needed` **exige la feature cargo `init-if-needed`**; `:711-721` `realloc` exige `realloc::payer` + `realloc::zero`. |
| `~/.cargo/registry/.../anchor-derive-space-1.1.2/src/lib.rs` | tamaño del enum | `:80-105` enum ⇒ `INIT_SPACE = 1 + max(variantes)` ⇒ `EscrowStatus` = 1 byte. |
| `solana-programs/doc/sdd/001-escrow-anchor/auto-blindaje.md` | aprender del pasado | 6 entradas; 3 aplican acá (ver CD-11/CD-12/CD-13). |
| `chaski-v3/doc/sdd/032-wkh-227-contratos-idl-golden/auto-blindaje.md` | aprender del pasado (cross-repo) | patrón recurrente: **el Architect asumió un config que no leyó** (glob de vitest) → CD-13. |

### 3.2 Exemplars verificados (paths confirmados)

| Para crear/modificar | Seguir patrón de | Qué se copia |
|---------------------|------------------|--------------|
| `EscrowIndex` (`#[account]` nuevo) | `programs/escrow/src/lib.rs:156-167` (`EscrowState`) | `#[account] #[derive(InitSpace)]`, comentario por campo con su tamaño en bytes, `bump: u8` último. |
| `register_escrow` / `deregister_escrow` (handlers) | `lib.rs:88-124` (`refund`) | orden CHECKS → EFFECTS → INTERACTIONS, `require!(..., ErrorCode::X)`, `let _ = &arg` si el arg solo alimenta las seeds (`:21`). |
| `RegisterEscrow` / `DeregisterEscrow` (`#[derive(Accounts)]`) | `lib.rs:277-310` (`Refund`) | `#[instruction(remittance_id: [u8; 16])]`, `seeds = [...]` + `bump = escrow_state.bump`, `has_one`, `constraint = … @ ErrorCode::…`. |
| errores nuevos | `lib.rs:180-192` | `#[error_code] pub enum ErrorCode` con `#[msg("…")]` en inglés. |
| `tests/escrow-index.ts` (nuevo) | `tests/escrow.ts:1-198` | imports, `startAnchor('.')`, `processIxs`, `fundSol`, `createMint6`, `bumpSlot`, aserciones con `chai`. |
| test de cuenta legacy | `tests/escrow.ts:134,519` (`banksClient.getAccount`) + `solana-bankrun` `setAccount` (verificado en `node_modules/solana-bankrun/dist/index.d.ts:187`) | inyectar bytes crudos de una cuenta pre-upgrade. |

### 3.3 Estado de BD relevante (Wave 0, repo `chaski-v3`)

| Tabla | Existe | Columnas relevantes | Nota |
|-------|--------|---------------------|------|
| `remittance_settlements` | Sí (`supabase-settlement-ledger.ts:22-26`) | `remittance_id`, `sender_address`, `status`, `created_at` | **No requiere columna nueva**. Falta un índice para la query sender-scoped: ver DT-8. Gated por `SETTLEMENT_LEDGER_ENABLED` (`:243`). |

### 3.4 Componentes reutilizables encontrados (no crear nuevos)

- `verifySolanaPop` / `verifySolanaPopChallenge` (`chaski-v3/src/infrastructure/auth/`) → auth del endpoint de lectura.
- `canonicalizeAddress(_, "solana")` (`chaski-v3/src/infrastructure/address.ts:13`) → clave de matcheo.
- `remittanceIdToBytes16` (ya duplicado en los 2 repos) → **no se toca** (DT-2 lo deja intacto).
- `deriveEscrowStatePda` (`wasiai-facilitator/src/chains/solana-escrow.ts:103`) → reusar para el índice.
- `canonicalSha256` (`wasiai-facilitator/src/chains/canonical-hash.ts`) → re-pin del hash del IDL.

---

## 4. Diseño Técnico

### 4.1 El riesgo del layout: qué pasa EXACTAMENTE con una cuenta vieja (con evidencia de código)

Pregunta: si se agrega un campo a `EscrowState`, ¿qué le pasa a las cuentas que ya existen en
devnet con el layout viejo?

**Respuesta, en tres pasos, leídos del código del macro `#[account]` (no de memoria):**

1. **El discriminador NO falla.** `gen_discriminator("account", EscrowState)` =
   `sighash("account", "EscrowState")` = `sha256("account:EscrowState")[..8]`
   (`anchor-syn-1.1.2/src/codegen/program/common.rs:19-27`). Depende **solo del nombre del struct**.
   Agregar, quitar o reordenar campos **no lo cambia**. Por eso el chequeo de
   `try_deserialize` (`anchor-attribute-account-1.1.2/src/lib.rs:247-256`) **pasa**: los 8 primeros
   bytes de la cuenta vieja siguen siendo los correctos. Esto es lo peligroso: no hay un error
   temprano y claro de «versión distinta»; Anchor cree que la cuenta es del tipo correcto.
2. **Falla la deserialización, por longitud.** `try_deserialize_unchecked`
   (`ibid.:258-262`) hace `AnchorDeserialize::deserialize(&mut data)` sobre `&buf[8..]` y mapea
   **cualquier** error a `ErrorCode::AccountDidNotDeserialize` = **3003**
   (`anchor-lang-error-1.1.2/src/lib.rs:238-239`). Borsh lee campo por campo; al llegar al campo
   nuevo se queda sin bytes (`UnexpectedEof`) ⇒ 3003.
   Números exactos: `EscrowState::INIT_SPACE` = 32·4 (`sender`,`beneficiary`,`authority`,`mint`) +
   8 (`amount`) + 8 (`deadline`) + 1 (`status`, enum unit ⇒ `1 + max = 1`,
   `anchor-derive-space-1.1.2/src/lib.rs:80-105`) + 1 (`bump`) = **146**; la cuenta se creó con
   `space = 8 + INIT_SPACE` (`lib.rs:209`) = **154 bytes**. Con un `[u8;16]` extra el struct nuevo
   pide 162 bytes de payload sobre una cuenta que tiene 146 ⇒ 16 bytes faltantes ⇒ 3003.
3. **Anchor SÍ tolera el trailing, pero eso no ayuda acá.** `deserialize` (no `try_from_slice`) no
   exige consumir todo el buffer: una cuenta **más grande** que el struct se lee bien y los bytes
   sobrantes se ignoran. La tolerancia es solo en la dirección «cuenta grande / struct chico». Como
   `space` es exacto (`8 + INIT_SPACE`, sin padding reservado), **no hay ningún colchón** que
   absorba un campo nuevo. Si el diseño original hubiera reservado `_reserved: [u8; 64]`, agregar un
   campo dentro de ese colchón sería gratis. No lo hizo.

**Consecuencia si se agregara el campo a `EscrowState`**: `Account<'info, EscrowState>` aparece en
los Contexts de `release` (`lib.rs:257`), `refund` (`:292`) y `close` (`:329`). Las tres
instrucciones fallarían con 3003 **para toda cuenta pre-upgrade**. Es decir: un fix de «fondos
inalcanzables» que vuelve inalcanzables los fondos legítimos que hoy sí se pueden mover. Sería
peor que el bug que arregla, y violaría AC-6/CD-4.

`realloc` **no** es una salida por sí sola: para reallocar una cuenta hay que cargarla en un
Context, y cargarla como `Account<EscrowState>` ya falla (3003). Una instrucción de migración
tendría que tomarla como `UncheckedAccount` y hacer byte-poking manual, **y además** re-derivar las
seeds, que exigen el `remittance_id` — el dato que justamente puede faltar. Es decir: la migración
sería imposible exactamente en los casos que motivan la HU.

> Verificación empírica exigida (no queda como razonamiento): el test **T1a** (§9) asertea que un
> `deposit` produce una cuenta de **exactamente 154 bytes**. Si alguien agrega un campo a
> `EscrowState`, ese test se pone rojo en el acto. Es el canario permanente de este riesgo.

### 4.2 DT-1 — Estrategia elegida: **NO tocar `EscrowState`**; el índice va en una cuenta nueva

**Decisión**: `EscrowState` queda **byte-idéntico**. La enumerabilidad vive en una cuenta separada
`EscrowIndex`, PDA `["escrow-index", sender]`, escrita por una instrucción **nueva**.

**Por qué (trade-off)**: da compatibilidad total **por construcción**, no por cuidado. El layout de
`EscrowState` no cambia ⇒ no hay ninguna deserialización que pueda fallar ⇒ AC-6/CD-4 se cumplen
sin condiciones, sin migración, sin lógica dual, y sin depender de que nadie se equivoque.
Precio: una cuenta más y su rent (§4.5), y que el índice cubre solo los depósitos que pasen por la
instrucción nueva (los pre-upgrade se cubren por backfill cuando su id se conserva — §4.4).

**Alternativas evaluadas y descartadas:**

| Estrategia | Compatibilidad con cuentas viejas | Por qué NO |
|-----------|-----------------------------------|-----------|
| **A. Campo `remittance_id` al final de `EscrowState`** | **ROTA**: 3003 en `release`/`refund`/`close` para las 154-byte existentes (§4.1) | Deja plata legítima inalcanzable. Descartada por el hallazgo de §4.1, que es evidencia de código y no una precaución teórica. |
| **B. Campo nuevo + versionado del discriminador** (`#[account(discriminator = …)]` distinto para v2) | Las viejas dejan de matchear el nuevo tipo ⇒ 3002, no 3003 | El error es más claro pero el efecto es el mismo: las cuentas viejas ya no se pueden operar. Exige mantener DOS tipos y DOS caminos en cada instrucción — la «complejidad permanente» que el founder descartó explícitamente. |
| **C. Campo nuevo + `realloc` migratorio** | Requiere una ix de migración que necesita el `remittance_id` para derivar seeds | Imposible justo en el caso que motiva la HU (id perdido). Y hasta que se migre cada cuenta, sigue rota. |
| **D. Campo nuevo + reserva/padding retroactivo** | N/A | No existe padding en el layout actual (`space = 8 + INIT_SPACE` exacto, `lib.rs:209`). No se puede reservar espacio en el pasado. |
| **E. `getProgramAccounts` con memcmp sobre `sender`** (sin tocar nada) | Total | Encuentra la dirección pero **no da los 16 bytes** (no están en la cuenta) ⇒ no permite operar. Además la mayoría de RPCs públicos lo limitan, y el cliente usa el público (`solana-wallet.ts:112`). Queda como **fallback de diagnóstico**, no como mecanismo (§4.7). |
| **F. Esquema de contador/nonce en las seeds** | Coexisten pero bajo dos esquemas | Descartado por el founder: cambia la firma de `deposit` y obliga a lógica dual permanente. |
| **G. Instrucción de recuperación con `authority`** | N/A | Viola AC-5/CD-1 si actúa sola; y con co-firma del sender igual necesita primero **encontrar** el PDA ⇒ no resuelve nada por sí sola. |

**Estado degradado (obligación de decirlo)**: con la estrategia elegida **ningún escrow queda
degradado**. Los pre-upgrade siguen soportando `release`/`refund`/`close` idénticamente (mismo
programa, mismo layout, mismas seeds). La única diferencia es que **no aparecen en el índice** hasta
que alguien los registre, lo cual requiere conocer su id16 (§4.4, backfill). Para el escrow cuyo id
está perdido (`BmHDdjKL…`), no aparece nunca y sus fondos no se recuperan: **Scope OUT con nombre**
(§6, CD-2, AC-7).

### 4.3 DT-2 — Cuenta nueva `EscrowIndex`

```
seeds  = [b"escrow-index", sender.key().as_ref()]
```

| Campo | Tipo | Bytes | Para qué |
|-------|------|-------|----------|
| `sender` | `Pubkey` | 32 | redundante con las seeds, pero habilita `getProgramAccounts` con memcmp como fallback y espeja el patrón de `EscrowState:159` |
| `version` | `u8` | 1 | forward-compat del layout del índice (hoy `1`) |
| `bump` | `u8` | 1 | bump canónico (patrón `EscrowState:166`) |
| `entries` | `Vec<[u8; 16]>` con `#[max_len(MAX_ENTRIES)]` | 4 + 16·N | los id16 de los escrows **abiertos** de este sender |

`MAX_ENTRIES = 32`. `INIT_SPACE` = 32 + 1 + 1 + 4 + 512 = **550**; `space = 8 + 550` = **558 bytes**,
**fijo** (se asigna el máximo al crear). **Sin `realloc` en ningún lado** (DT-5).

Decisiones de layout, con su razón:

- **`Vec` con `max_len` y espacio fijo, no `realloc` incremental.** Un `Vec` es *length-prefixed*:
  al leer, borsh consume `4 + 16·len` y **el resto del buffer se ignora** (tolerancia al trailing,
  §4.1 paso 3). Eso hace que subir `MAX_ENTRIES` en el futuro sea **compatible en lectura** con los
  índices ya creados — lo contrario de lo que pasa al agregar un campo fijo a `EscrowState`. El
  precio es rent del máximo desde el primer uso (§4.5) a cambio de cero aritmética de lamports y
  cero `realloc` que auditar.
- **Solo se guarda el id16, no el `remittanceId` (string).** Con 16 bytes ya se puede derivar el PDA
  y ejecutar `refund` — es todo lo que hace falta para no perder plata. La etiqueta de negocio
  (`remittanceId` de TransFi/Chaski) la da el store de Wave 0. Además evita publicar on-chain un
  identificador de negocio correlacionable, y evita un campo de largo variable.
- **NO se usa `has_one = sender` en `EscrowIndex`.** Las seeds `[b"escrow-index", sender]` con
  `sender: Signer` ya son el guard criptográfico de ownership: nadie puede tocar el índice de otro.
  Agregar `has_one` sobre una cuenta con `init_if_needed` mete una dependencia de orden entre el
  init y el chequeo (en la rama de creación el campo vale `Pubkey::default()`), sin ganar
  seguridad. **PROHIBIDO agregarlo** (CD-8).

### 4.4 DT-3 — Instrucción nueva `register_escrow(remittance_id: [u8; 16])`

Firma el **`sender`**. Cuentas (orden a fijar en F2.5, con `system_program` último):

| # | Cuenta | Constraints |
|---|--------|-------------|
| 0 | `sender: Signer` | `mut` (paga rent del índice, patrón `lib.rs:201-202`) |
| 1 | `escrow_state: Account<EscrowState>` | `seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()]`, `bump = escrow_state.bump`, `has_one = sender`, `constraint = escrow_state.status == EscrowStatus::Deposited @ ErrorCode::EscrowNotDeposited`. **NO `mut`**: no se modifica. |
| 2 | `escrow_index: Account<EscrowIndex>` | `init_if_needed`, `payer = sender`, `space = 8 + EscrowIndex::INIT_SPACE`, `seeds = [b"escrow-index", sender.key().as_ref()]`, `bump`, `mut` |
| 3 | `system_program: Program<System>` | requerido por el init |

Handler (CHECKS → EFFECTS, sin INTERACTIONS ni CPI de tokens):

1. `require!(escrow_index.entries.len() < MAX_ENTRIES, ErrorCode::EscrowIndexFull)`.
2. Escrituras **idempotentes** del header: `escrow_index.sender = sender.key()`,
   `escrow_index.version = ESCROW_INDEX_VERSION`, `escrow_index.bump = ctx.bumps.escrow_index`.
   Son idempotentes porque las seeds ya fijan `sender` y `bump`, y `version` es una constante ⇒
   no hay superficie de re-init attack (CD-9 lo prohíbe explícitamente para futuros campos).
3. `if !escrow_index.entries.contains(&remittance_id) { entries.push(remittance_id) }` — **no-op
   idempotente**, no error: un retry no puede tumbar la tx.

Propiedades que dan seguridad y que AR debe poder verificar de un vistazo:

- **No mueve un solo token.** No hay `token::transfer` ni `CpiContext` de SPL. La única
  transferencia es la del `system_program` por el rent del índice, generada por el macro `init`, del
  `sender` a su propia cuenta.
- **Exige que el escrow exista, sea del `sender` y esté `Deposited`.** El `Account<EscrowState>` con
  seeds + `has_one = sender` garantiza que no se puede indexar basura ni el escrow de otro: si la
  cuenta no existe da `AccountNotInitialized` (3012), si es de otro sender las seeds no cierran
  (`ConstraintSeeds`).
- **Sirve de backfill.** Como `EscrowState` no cambió, un `register_escrow` sobre un escrow
  **pre-upgrade** cuyo id16 se conserva (p. ej. reconstruido desde el store de Wave 0) funciona
  igual. Eso convierte las filas de `remittance_settlements` en entradas durables on-chain.
  **No** rescata `BmHDdjKL…` (su id no existe en ningún lado).
- **Requiere `Deposited`** ⇒ el índice solo lista escrows abiertos ⇒ su tamaño está acotado por el
  trabajo en vuelo del sender, no por su historia.

### 4.5 DT-4 — Habilitar la feature cargo `init-if-needed` (cambio de dependencia, explícito)

`programs/escrow/Cargo.toml:22` tiene `anchor-lang = "1.1.2"` **sin features**. `init_if_needed` no
compila así: `anchor-syn-1.1.2/src/parser/accounts/constraints.rs:624-625` emite el error «requires
that anchor-lang be imported with the init-if-needed cargo feature enabled».

**Decisión**: cambiar a `anchor-lang = { version = "1.1.2", features = ["init-if-needed"] }`. No es
una dependencia nueva ni un bump de versión: es una feature del crate ya pineado.

Por qué se acepta el riesgo conocido de `init_if_needed` (re-init attack): el vector clásico es un
handler que **resetea** estado de una cuenta ya existente. Acá (a) el índice no custodia fondos,
(b) las seeds lo atan al `sender` que firma, y (c) todas las escrituras del header son idempotentes
y ninguna resetea `entries` (DT-3 paso 2/3). **CD-9** lo blinda para el futuro.

Alternativa evaluada: una ix separada `init_escrow_index` + `register_escrow` exigiendo el índice ya
creado. Descartada porque obliga al cliente a decidir a-priori si mandar 1 o 2 instrucciones (una
lectura RPC extra y un camino más para equivocarse), y **agrava** el problema de CR-1 (§5), que
cuenta instrucciones.

### 4.6 DT-5 — `MAX_ENTRIES`, rent y el dead-end del cap

- **`MAX_ENTRIES = 32`.** El índice solo lista escrows **abiertos** (DT-3) y el ciclo de vida de un
  escrow es de minutos/horas. 32 abiertos simultáneos por sender es ~16-32x el uso real esperado.
- **Error `EscrowIndexFull`** cuando se llena. Como `register_escrow` va en la **misma tx** que el
  `deposit` (§4.7), un índice lleno **bloquea el depósito**. Ese es el dead-end que hay que evitar,
  y por eso `deregister_escrow` (DT-6) **entra en scope de esta HU**, no en un follow-up.
- **Rent** (fórmula estándar: `(128 + data_len) · 3480 · 2` lamports):
  índice de 558 bytes ⇒ `(128+558)·6960` = **4.775.760 lamports ≈ 0,00477 SOL**, una sola vez por
  sender, pagados por el sender. Contexto: cada `deposit` ya quema ≈0,004 SOL de rent
  (`escrow_state` 154 B + `vault` ATA 165 B, ambos `payer = sender` en `lib.rs:208,217`) y **nunca
  se recupera**, porque `close` no lo invoca nadie (verificado: en `chaski-v3` solo se construyen
  `deposit` (`solana-wallet.ts:126`) y `refund` (`:213`); el facilitator solo `release`). Es decir:
  el índice cuesta ~1,2 depósitos de rent, una sola vez.
  → **Los números de rent son cálculo, no medición**: el test **T10** (§9) los verifica con
  `getMinimumBalanceForRentExemption`. Si difieren, manda el test.
- **Que el `sender` pague el rent es consistente con lo que ya pasa hoy** (`payer = sender` en el
  `deposit`). El «gasless» del diseño actual cubre el **fee** de red (`feePayer = facilitator`,
  `solana-wallet.ts:138`), no el rent. Y **no puede** cubrirlo: CR-1 rechaza cualquier tx donde el
  fee-payer aparezca en una ix (`cr1.ts:180-186`), justamente para no ser drenable.

### 4.7 DT-6 — Instrucción nueva `deregister_escrow(remittance_id: [u8; 16])`

Firma el **`sender`**. Cuentas: `sender: Signer` + `escrow_index` (`mut`, `seeds`, `bump = escrow_index.bump`).
Handler: quitar `remittance_id` de `entries` (swap-remove o `retain`); si no está, **no-op** sin
error (idempotente). **Sin `realloc`** (el espacio queda asignado; se reusa en el próximo register).

**Análisis adversarial explícito (para que AR lo ataque con algo concreto):**

- No mueve fondos: no hay ninguna CPI de tokens ni de lamports.
- Está self-scoped: las seeds `["escrow-index", sender]` + `Signer` implican que solo se puede
  operar sobre el índice propio. No hay `authority` involucrada ⇒ **AC-5/CD-1 no aplica y no puede
  violarse**.
- Peor caso: el `sender` borra su propio breadcrumb. Los fondos siguen siendo refundeables por él
  con el id16 (que además está en el store de Wave 0). Es autolesión reversible: puede volver a
  registrar con `register_escrow` mientras el escrow siga `Deposited`.
- **Deliberadamente NO** se exige que el escrow esté en estado terminal para desregistrar. Exigirlo
  obligaría a cargar `Account<EscrowState>`, que **falla con 3012 si el escrow ya fue cerrado** —
  y entonces esas entradas quedarían imposibles de limpiar (fuga del índice hasta el cap, o sea el
  dead-end de DT-5 por otra puerta). Se prefiere la operación que no puede quedar trabada.

### 4.8 DT-7 — Cómo llega `register_escrow` a la cadena: **el punto donde CR-1 manda**

Este es el hallazgo que convierte «orden de deploy» en diseño. La tx de `deposit` de Chaski **no la
broadcastea el cliente**: la arma y la partial-firma el browser (`solana-wallet.ts:137-144`), la
manda a `chaski-v3/app/api/settle/solana-sponsor/route.ts:38-54`, y de ahí al facilitator
(`wasiai-facilitator/src/routes/solana-sponsor.ts:150`), que la valida con **CR-1**
(`validateDepositForSponsor`), co-firma y broadcastea. CR-1 es el núcleo anti-drain.

Y CR-1, **hoy, rechaza las dos formas posibles de escribir el índice en el depósito**:

| Forma | Qué diría CR-1 hoy | Evidencia |
|-------|--------------------|-----------|
| Agregar `escrow_index` como 9ª cuenta posicional de `deposit` | `REMAINING_ACCOUNT_FLAGS_INVALID`: todo lo que esté en índice ≥ 8 debe ser no-writable, y el índice **tiene** que ser writable | `cr1.ts:170-173` + `deposit-shape.ts:51` (`DEPOSIT_POSITIONAL_ACCOUNTS = 8`) |
| Agregar `register_escrow` como 2ª instrucción de la misma tx | `NOT_EXACTLY_ONE_BUSINESS_IX` | `cr1.ts:80-82` |

(La primera forma, además, está descartada por otro motivo: cambiar el orden de cuentas de `deposit`
la vuelve **breaking** para clientes viejos. Un bundle JS cacheado que manda 8 cuentas + el
`reference` como remaining haría que el programa nuevo lea el `reference` en el slot del índice ⇒
`ConstraintSeeds`. Falla cerrado, pero rompe depósitos. Ese es el motivo por el que `deposit` **no
se toca** — DT-2.)

Dos variantes, **con el mismo diseño on-chain** (por eso W1 es implementable ya, sin esperar esta
decisión):

- **B1 — atómica, recomendada.** `deposit` + `register_escrow` en **una** tx sponsoreada. Exige
  extender CR-1 a un allowlist de **exactamente 2** business-ix: `ix[0]` = `deposit` (todos los
  chequeos actuales intactos) y `ix[1]` = mismo `programId` + discriminador **pineado** de
  `register_escrow` + cuentas con flags fijos (`sender` signer+writable, `escrow_index` writable
  non-signer, `escrow_state` read-only, `system_program` exacto), y CR-1 debe seguir aceptando la
  forma vieja de **1** business-ix (compatibilidad durante la ventana). Check 5 del fee-payer
  (`cr1.ts:180-186`) queda intacto y sigue cubriendo el drain.
  **Ventaja decisiva**: la entrada del índice es atómica con el depósito. Un índice «best-effort»
  que puede fallar en silencio es exactamente la clase de bug que creó esta HU (`localStorage`
  también era best-effort).
  **Costo**: toca el núcleo anti-drain ⇒ AR propio en el repo del facilitator (gate G4, §10).
- **B2 — fallback, sin tocar CR-1.** `register_escrow` en una **segunda tx**, firmada y pagada por
  el `sender` (que ya tiene SOL: paga el rent del deposit), broadcasteada por el cliente después de
  que el depósito confirme. **Cero cambio de seguridad en el facilitator.** Costos reales: (a) no
  es atómica (si falla, el escrow queda sin indexar y depende de Wave 0; es reintentable después),
  y (b) **hoy el bridge de wallet solo expone `signTransaction`**, no `signAllTransactions`
  (`solana-wallet-bridge.ts:15`) ⇒ o se extiende el bridge, o el usuario ve **dos** popups de
  Phantom en un flujo de remesa.

**Recomendación del Architect: B1**, con la extensión de CR-1 especificada byte a byte y su propio
AR. **B2 queda documentada como fallback aceptable** si AR o el founder juzgan que relajar «exactamente
1 business ix» no vale la pena. → `[NEEDS CLARIFICATION — founder/AR]` en §12: **no bloquea W0 ni W1**.

Nota de ops para B1: la ix extra consume CU adicionales (init de una cuenta de 558 B). Revisar
`SOLANA_SPONSOR_MAX_COMPUTE_UNITS` y `SOLANA_SPONSOR_MAX_FEE_LAMPORTS`
(`wasiai-facilitator/src/routes/solana-sponsor.ts:66-68`) antes de encender.

### 4.9 DT-8 — Wave 0: el registro durable off-chain (repo `chaski-v3`)

Estado real, verificado: **la escritura ya existe y ya ocurre antes de firmar.**
`app/api/payout/prepare/route.ts:296-311` llama `recordOrderPrepared({remittanceId, senderAddress,
…, vm:"solana"})` dentro de `prepare`, y el cliente **no puede** construir el `deposit` antes,
porque necesita el `beneficiary`/`authority` que esa misma respuesta devuelve (`:314-318`;
`solana-wallet.ts:75-76` falla con `escrow_params_missing` si faltan). ⇒ **AC-1 está satisfecho
arquitectónicamente**, condicionado a `SETTLEMENT_LEDGER_ENABLED=true` (`supabase-settlement-ledger.ts:243`).

Lo que falta de verdad, y es el trabajo de Wave 0:

1. **Lectura sender-scoped** en el port `SettlementLedger` (`src/application/ports.ts:378-431`):
   un método nuevo tipo `listRemittanceIdsBySender({ senderAddress, vm, limit })` que filtre
   `.eq('sender_address', canonicalizeAddress(sender,'solana'))` (ownership app-layer obligatorio —
   el cliente Supabase bypassea RLS, `supabase-settlement-ledger.ts:1-8`). Devuelve
   `remittance_id` + `status` + `created_at`. **Nunca** PII.
2. **Endpoint** que la exponga, autenticado con **proof-of-possession Solana**
   (`verifySolanaPopChallenge` en `src/infrastructure/auth/pop-challenge.ts:133` +
   `verifySolanaPop` en `pop-verify-solana.ts:19`): el caller debe **probar** que controla la
   wallet cuyos `remittanceId` pide. Sin PoP el endpoint es un enumerador de identificadores de
   remesa por address ⇒ IDOR. **CD-6.**
3. **Fallback en el refund**: `refundEscrow(remittanceId, sender?)`
   (`solana-wallet.ts:160-228`) debe poder resolver el `remittanceId` desde (1) cuando el caller no
   lo tiene, antes de fallar (AC-2). El resto de `refundEscrow` (lectura on-chain autoritativa,
   `feePayer = sender`, CD-10) **no se toca**.
4. **Índice de BD**: la query nueva filtra por `sender_address`; verificar/crear el índice
   correspondiente en la migración de `remittance_settlements` (hoy solo consta el índice parcial
   por status para `listStale`, `supabase-settlement-ledger.ts:28-33`). **[TBD para el story de
   chaski-v3]**: confirmar leyendo la migración real antes de asumir que falta.
5. **Ops**: `SETTLEMENT_LEDGER_ENABLED=true` en devnet (§12).

> El código de Wave 0 **no se escribe en este repo**. Este SDD fija el contrato; el story y la
> implementación salen del pipeline de `chaski-v3`.

### 4.10 DT-9 — IDL, hash golden y quién es la fuente de verdad

Fuente de verdad del IDL: **`solana-programs/target/idl/escrow.json`**, generado por `anchor build`.
La regla vigente sigue en pie: **leer `idl.address`, nunca un literal copiado**
(`solana-wallet.ts:90,173` ya lo hacen). El program id **no cambia** en esta HU (upgrade in-place
del mismo `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`, triple-verificado: `lib.rs:5`,
`target/idl/escrow.json:2`, `Anchor.toml:12,15`, y consistente con `solana-escrow.ts:43` y
`deposit-shape.ts:19`).

Lo que **sí** cambia: el IDL gana 2 instrucciones y 1 account type ⇒ **el hash canónico cambia** ⇒
se ponen rojos, en el momento en que se corra `anchor build`:

| Archivo | Qué hacer |
|---------|-----------|
| `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:21` | re-pinear `ESCROW_IDL_SHA256` |
| `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:9` | re-pinear el mismo valor |
| `chaski-v3/contracts/CONTRACT-VERSIONS.md:53` | actualizar el hash documentado |
| `chaski-v3/src/infrastructure/solana/escrow-idl.ts` | re-vendorear el IDL (lo necesita para construir `register_escrow`) |
| `wasiai-facilitator/src/chains/escrow-idl.ts` | re-vendorear (**no** lo necesita en runtime: solo decodifica `EscrowState`, que no cambió; se re-vendorea para que el hash quede en paridad) |

El valor nuevo se calcula con `canonicalSha256` (`wasiai-facilitator/src/chains/canonical-hash.ts`)
sobre el `escrow.json` recién buildeado. **Ojo con el timing**: el test AC-3 de ambos repos compara
contra el **sibling** `../solana-programs/target/idl/escrow.json`, y `target/` está gitignoreado
(`.gitignore:3`) ⇒ en este workspace el sibling **existe**, así que las suites de los otros dos
repos se ponen rojas apenas se buildee acá, aunque no se haya tocado nada allá. Es esperado, no es
una regresión, y se cierra con el re-pin en la misma ventana (§5).

### 4.11 Flujo principal — recuperación (happy path)

1. El usuario abre Chaski en un teléfono nuevo (o borró datos del navegador) y conecta la misma
   wallet. `localStorage` está vacío (`persistence.ts` `LocalRepo`).
2. **Capa off-chain (W0)**: el cliente pide al endpoint PoP-autenticado los `remittanceId` de su
   address. Con eso ya puede llamar `refundEscrow(remittanceId)` como hoy. **Fin, en el caso normal.**
3. **Capa on-chain (W1+), si (2) no devuelve nada** (ledger apagado, fila nunca escrita, otro
   frontend): el cliente deriva `["escrow-index", sender]` y hace **un** `getAccountInfo` — un PDA
   determinístico, sin `getProgramAccounts`, así que funciona con el RPC público que ya usa
   (`solana-wallet.ts:112`).
4. Decodifica `EscrowIndex.entries` ⇒ lista de id16.
5. Para cada id16: deriva `["escrow", sender, id16]` y lee `EscrowState` (`getMultipleAccounts`).
   Muestra los `Deposited` con su `amount`/`deadline` (autoritativo on-chain, patrón
   `solana-wallet.ts:186-199`).
6. El usuario elige uno; el cliente construye `refund(id16)` **con la instrucción existente, sin
   cambios**, `feePayer = sender`, firma y broadcastea (`solana-wallet.ts:213-227`). Los fondos
   vuelven al `sender_ata`.
7. Opcional: `deregister_escrow(id16)` para limpiar la entrada.

### 4.12 Flujo de error

| Condición | Comportamiento esperado |
|-----------|------------------------|
| No existe `EscrowIndex` para el sender (nunca depositó post-upgrade) | `getAccountInfo` ⇒ `null` ⇒ mensaje «no hay escrows recuperables», **sin excepción cruda** (patrón fail-loud con enum estable, `solana-wallet.ts:188`) |
| `entries` vacío | igual que arriba |
| Una entrada apunta a un `escrow_state` que ya no existe (cerrado) | se omite de la lista; se ofrece `deregister_escrow` para limpiarla |
| `register_escrow` con un escrow que no existe | `AccountNotInitialized` (3012) |
| `register_escrow` sobre un escrow de otro sender | `ConstraintSeeds` (las seeds incluyen el signer) |
| `register_escrow` sobre un escrow no-`Deposited` | `EscrowNotDeposited` (error existente, `lib.rs:186-187`) |
| Índice lleno | `EscrowIndexFull` (nuevo) ⇒ con B1 **falla el depósito entero**; remediación: `deregister_escrow` de entradas viejas (DT-5/DT-7) |
| Ledger de W0 apagado o sin fila | el refund cae al camino on-chain (paso 3); si tampoco hay índice, error explícito. **Nunca** un `refund` a ciegas |
| CR-1 rechaza la tx (facilitator sin actualizar, orden mal aplicado) | `NOT_EXACTLY_ONE_BUSINESS_IX` / `REMAINING_ACCOUNT_FLAGS_INVALID` ⇒ el depósito **no se broadcastea**; fail-closed, sin pérdida de fondos, pero flujo caído ⇒ por eso el orden de §5 es obligatorio |

### 4.13 Archivos a crear/modificar

**`solana-programs` (este repo — lo único que se escribe acá):**

| Archivo | Acción | Qué cambia | Exemplar |
|---------|--------|-----------|----------|
| `programs/escrow/src/lib.rs` | Modificar | + `EscrowIndex` (`#[account]`), + `MAX_ENTRIES`/`ESCROW_INDEX_VERSION`, + `register_escrow`, + `deregister_escrow`, + `EscrowIndexFull`, + Contexts `RegisterEscrow`/`DeregisterEscrow`. **`EscrowState`, `deposit`, `release`, `refund`, `close` intactos.** | `lib.rs:156-167`, `:88-124`, `:277-310`, `:180-192` |
| `programs/escrow/Cargo.toml` | Modificar | `anchor-lang` con `features = ["init-if-needed"]` (DT-4) | `:22` |
| `tests/escrow-index.ts` | Crear | suite nueva (§9). Se levanta con el glob `tests/**/*.ts` de `Anchor.toml:22` / `package.json` | `tests/escrow.ts:1-198` |
| `tests/escrow.ts` | Modificar | **solo** agregar T1a (canario de 154 bytes) a la suite existente | patrón `:519` |
| `doc/sdd/002-…/` | Crear | artefactos del pipeline | — |

**`chaski-v3` (otro pipeline; acá solo se especifica):** `src/application/ports.ts`,
`src/infrastructure/persistence/supabase-settlement-ledger.ts`, endpoint PoP nuevo,
`src/infrastructure/solana-wallet.ts` (fallback + register + lectura del índice),
`src/infrastructure/solana/escrow-idl.ts`, `contracts/idl/escrow-idl.hash.test.ts`,
`contracts/CONTRACT-VERSIONS.md`, y (si B1) nada más; (si B2) `solana-wallet-bridge.ts`.

**`wasiai-facilitator` (otro pipeline):** si B1 — `src/methods/solana-sponsor/cr1.ts`,
`src/methods/solana-sponsor/deposit-shape.ts` (constantes del 2º ix); siempre —
`src/chains/escrow-idl.ts` + `src/chains/escrow-idl.hash.test.ts`.

---

## 5. Orden de release — es diseño, no ops

Regla: **cada paso tiene que ser seguro y reversible por sí solo, y ningún paso puede dejar
depósitos rotos.** El orden inverso rompe cosas en silencio o cierra el money-path.

| # | Paso | Repo | Por qué acá y no antes/después | Reversible |
|---|------|------|-------------------------------|-----------|
| **R0** | Wave 0: lectura sender-scoped + endpoint PoP + fallback del refund. Encender `SETTLEMENT_LEDGER_ENABLED`. | `chaski-v3` | No toca la cadena ni la tx de depósito ⇒ riesgo casi nulo y **es lo que protege hoy**. Primero porque es la red de contención de todos los pasos siguientes. | Sí (flag OFF / revert) |
| **R1** | Upgrade del programa en devnet (`scripts/deploy-devnet.sh`) + `anchor build` ⇒ IDL nuevo. | `solana-programs` | **Puramente aditivo**: `deposit`/`release`/`refund`/`close`/`EscrowState` sin cambios ⇒ **ningún cliente viejo se rompe** (siguen mandando las mismas 8 cuentas y los mismos discriminadores). Tiene que ir **antes** de que cualquier cliente mande `register_escrow`, porque un discriminador desconocido tumba la tx entera. | Sí (redeploy del `.so` anterior) |
| **R2** | Re-pin del hash del IDL + re-vendoreo. | `chaski-v3` + `wasiai-facilitator` | Apenas se buildea en R1, el test AC-3 (sibling) se pone rojo en los dos repos (§4.10). Va inmediatamente después de R1, en la misma ventana. | Sí |
| **R3** | **Solo si B1**: extender CR-1 a 2 business-ix con allowlist estricto, **aceptando también la forma de 1 ix**. Revisar `SOLANA_SPONSOR_MAX_COMPUTE_UNITS`. | `wasiai-facilitator` | Tiene que estar **deployado antes** de que el cliente emita la tx de 2 ix, o CR-1 la rechaza y **el depósito no se broadcastea** (money-path caído). Acepta las dos formas ⇒ no rompe a los clientes viejos. | Sí (revert ⇒ vuelve a 1 ix) |
| **R4** | Cliente: emitir `register_escrow` + UI de recuperación leyendo el índice. | `chaski-v3` | Último: depende de R1 (la ix tiene que existir) **y** de R3 (CR-1 tiene que aceptarla). | Sí |
| **R5** | Backfill opcional: registrar escrows abiertos pre-upgrade cuyo id16 se conserve (desde `remittance_settlements`). | `chaski-v3` | Después de R4. No rescata ids perdidos (AC-7). | Sí |

**Órdenes inversos y qué rompen exactamente** (esto es lo que el AR previo marcó como bloqueante
cuando falta):

- **R4 antes de R1** ⇒ el programa viejo no conoce el discriminador de `register_escrow` ⇒
  `InvalidInstructionData` ⇒ la tx **entera** falla ⇒ **no hay depósito**. Roto y visible.
- **R4 antes de R3** ⇒ CR-1 responde `NOT_EXACTLY_ONE_BUSINESS_IX` ⇒ el facilitator no co-firma ⇒
  **no hay depósito**. Fail-closed, pero money-path caído.
- **R1 con la variante descartada de modificar `deposit`** ⇒ un bundle JS cacheado manda 8 cuentas
  y el programa nuevo lee el `reference` (`solana-wallet.ts:132`) en el slot del índice ⇒
  `ConstraintSeeds`. Error confuso, depósitos rotos: el escenario exacto que justifica DT-2.
- **R2 antes de R1** ⇒ el hash pineado no corresponde a ningún IDL real ⇒ CI rojo en 2 repos sin
  ganancia.
- **R0 último** ⇒ se pierde la única protección disponible durante toda la ventana de deploy.

**Footgun de deploy a verificar en R1** (upgrade in-place, no program nuevo): el `.so` crece al
agregar instrucciones. Si excede el espacio ya asignado a la cuenta del programa, `anchor deploy`
falla y hace falta `solana program extend <program-id> <bytes>` **antes** del deploy. Debe quedar
como paso explícito del runbook de R1, con `solana program show DR5G…` para leer el tamaño actual.
(Antecedente en este repo: el id anterior `BBQ9…` nunca se deployó y se perdió su keypair —
`wasiai-facilitator/src/chains/escrow-idl.ts:9-13`. El deploy de este programa **no** se improvisa.)

---

## 6. Constraint Directives (Anti-Alucinación)

### Heredadas del work-item (íntegras, no se re-litigan)

- **CD-1** — PROHIBIDO que cualquier mecanismo de recuperación permita a la `authority` mover o
  redirigir fondos SIN la firma del `sender` original (AC-5). Violación ⇒ **BLOQUEANTE** en AR.
  *Cómo lo cumple este diseño*: las dos instrucciones nuevas tienen al `sender` como único
  `Signer`, no reciben la `authority` como cuenta, y **no contienen ninguna CPI de tokens**.
- **CD-2** — PROHIBIDO prometer o implementar un rescate para escrows pre-upgrade con id perdido
  (AC-7). Documentado en §4.1/§4.2 con evidencia de código (`EscrowState` nunca guardó el dato ⇒ no
  existe en ningún lado ⇒ nada puede reconstruirlo).
- **CD-3** — OBLIGATORIO documentar el alcance cross-repo y el **orden de despliegue** desde el día 1
  ⇒ §5.
- **CD-4** — OBLIGATORIO que los escrows pre-upgrade sigan operables exactamente como hoy (AC-6).
  PROHIBIDO cualquier diseño que exija migrar o re-depositar. *Cumplido por construcción*: `EscrowState`
  no cambia (DT-1) y hay un canario de tamaño (T1a).
- **CD-5** — PROHIBIDO deployar a mainnet en esta HU. **Devnet only.**
- **CD-6** — OBLIGATORIO AR antes de mergear cualquier cambio al programa Anchor (money-path).

### Nuevas de este SDD

- **CD-7** — **PROHIBIDO tocar `EscrowState`**: ni agregar, quitar, renombrar ni reordenar campos, ni
  cambiar `space`. Cualquier diff en `lib.rs:156-167` o en `:209` es **BLOQUEANTE** (§4.1). El test
  T1a es el guard.
- **CD-8** — **PROHIBIDO tocar las seeds, los argumentos o la lista de cuentas de `deposit`,
  `release`, `refund` y `close`** (`lib.rs:198-339`). Son 4 instrucciones ya probadas on-chain y
  validadas por shape-validators externos (`deposit-shape.ts:51`, `release-shape.ts`). También
  PROHIBIDO agregar `has_one = sender` a `EscrowIndex` (DT-2, última bullet).
- **CD-9** — **PROHIBIDO que el handler de `register_escrow` resetee estado**: solo escrituras
  idempotentes del header (`sender`/`version`/`bump`, todas seed-derivadas o constantes) y `push`
  condicionado por `contains`. Cualquier `entries.clear()`, `= Vec::new()` o campo mutable no
  idempotente reabre la superficie de re-init attack de `init_if_needed` (DT-4).
- **CD-10** — **PROHIBIDO que el facilitator (o cualquier fee-payer) sea `payer` de la cuenta del
  índice**, y PROHIBIDO relajar el Check 5 de CR-1 (`cr1.ts:180-186`). El `payer` es el `sender`,
  igual que hoy (`lib.rs:208,217`).
- **CD-11** — **PROHIBIDO agregar `realloc` en esta HU** (DT-2/DT-7): espacio fijo. Si a futuro sube
  `MAX_ENTRIES`, es otra HU con su propia ruta de migración para los índices ya creados.
- **CD-12** — **OBLIGATORIO** que todo test que reintente una operación de la misma forma varíe el
  ix-data o avance el slot (`bumpSlot()`, `tests/escrow.ts:190-198`): bankrun **deduplica** txs con
  firma idéntica y el test pasa/falla por el motivo equivocado.
  *Referencia: auto-blindaje #001, entrada «W4 — tests flaky: bankrun dedup».*
- **CD-13** — **OBLIGATORIO** leer el config real antes de asumir comportamiento del toolchain o del
  runner: el toolchain lo fija `rust-toolchain.toml` (**1.89.0**, no `stable`), el glob de tests lo
  fija `Anchor.toml:22`, y las features de anchor `programs/escrow/Cargo.toml:22`. Al agregar
  `tests/escrow-index.ts`, verificar que el **conteo de test-files subió**, no solo que «pasó».
  *Referencia: auto-blindaje #001 («toolchain real es 1.89.0, no 1.97.1 del SDD») + auto-blindaje
  WKH-227 («el Architect asumió el glob de vitest sin leer el config real») — patrón recurrente en
  2 HUs, por eso es CD y no una nota.*
- **CD-14** — **OBLIGATORIO** usar `CpiContext::new(ctx.accounts.<program>.key(), …)` (Pubkey, no
  `AccountInfo`) si aparece cualquier CPI. *Referencia: auto-blindaje #001, `E0308` en anchor 1.1.2.*
- **CD-15** — **PROHIBIDO** hardcodear el program id en código nuevo: se lee de `declare_id!`
  (Rust) o de `idl.address` (TS), nunca un literal copiado (regla vigente de WKH-227;
  `solana-wallet.ts:90,173` es el patrón).
- **CD-16** — **OBLIGATORIO** que el endpoint de lectura sender-scoped de Wave 0 exija proof-of-possession
  Solana y filtre por `sender_address` en la query (app-layer, el service key bypassea RLS). Un
  endpoint que devuelva `remittanceId` de una address sin probar posesión es un IDOR ⇒ **BLOQUEANTE**.
- **CD-17** — **PROHIBIDO** que el `remittanceId` (string de negocio) se guarde on-chain. Solo los 16
  bytes (DT-2).
- **CD-18** — **PROHIBIDO** que este repo escriba en `chaski-v3`, `chaski-v2`,
  `wasiai-remittance-agents` o `wasiai-a2a`. Lectura sí, escritura no. **PROHIBIDO** abrir
  `chaski-v3/m5-keys/` (contiene claves).
- **CD-19** — **PROHIBIDO** git destructivo (`reset --hard`, `clean -fd`, `checkout --`, `stash
  drop/clear`, `branch -D`, `push --force`) y PROHIBIDO ejecutar deploys/tx on-chain desde F3. El
  deploy de R1 es un gate humano (§10).

---

## 7. Scope

**IN**

- `solana-programs`: `EscrowIndex` + `register_escrow` + `deregister_escrow` + `EscrowIndexFull` +
  la feature cargo `init-if-needed` + tests (§9) + el canario T1a.
- Diseño y contrato cross-repo de Wave 0 (implementación en el pipeline de `chaski-v3`).
- Especificación de la extensión de CR-1 (implementación en el pipeline de `wasiai-facilitator`).
- Orden de release (§5) y su runbook de deploy devnet.
- Re-pin coordinado del hash del IDL (§4.10).

**OUT**

- **Rescate de los fondos ya atrapados, incluido el escrow `BmHDdjKL…` (10 USDC de prueba en
  devnet).** Imposible: `EscrowState` nunca guardó el `remittance_id` ni su hash (`lib.rs:156-167`)
  y las 4 instrucciones lo exigen como argumento para re-derivar seeds (`:210,250,287,322`). Ese
  dato **no existe** en ningún lado, on-chain ni off-chain. **Nadie debe esperar esa plata de vuelta.**
- Deploy a mainnet (gate = auditoría externa).
- Migración de la upgrade authority a multisig/timelock (HU-SOL-19).
- Cambio de la derivación del PDA / esquema de nonce (descartado por el founder).
- Cambio de firma de `deposit`/`release`/`refund`/`close` (CD-8).
- `realloc` / cap dinámico del índice (CD-11).
- Dispute/arbiter genérico; gasless/relayer (HU-SOL-14) más allá de la extensión de CR-1 de R3.
- UI/UX de «recuperar mi remesa» más allá de lo necesario para ejercer el mecanismo.
- `close` automático del vault/escrow (hoy nadie lo llama; sigue así).

---

## 8. Waves de Implementación

### Wave 0 (serial, **fuera de este repo** — `chaski-v3`) — el registro durable
- W0.1: `listRemittanceIdsBySender` en el port + impl Supabase con `.eq('sender_address', …)`.
- W0.2: endpoint PoP-autenticado que lo exponga (CD-16).
- W0.3: fallback en `refundEscrow` cuando no hay `remittanceId` (AC-2).
- W0.4: verificar/crear el índice de BD por `sender_address`; `SETTLEMENT_LEDGER_ENABLED=true`.
- **Verificación**: tests de `chaski-v3` + evidencia de un refund exitoso sin `localStorage`.

### Wave 1 (serial gate, **este repo**) — contratos y tipos on-chain
- W1.1: `programs/escrow/Cargo.toml` ⇒ feature `init-if-needed` (DT-4). Verificar `anchor build`.
- W1.2: `EscrowIndex` + `MAX_ENTRIES = 32` + `ESCROW_INDEX_VERSION = 1` + `EscrowIndexFull`.
- W1.3: Context `RegisterEscrow` + handler `register_escrow` (DT-3).
- W1.4: Context `DeregisterEscrow` + handler `deregister_escrow` (DT-7).
- **Verificación al completar**: `anchor build` verde + `git diff` de `lib.rs` muestra **cero**
  cambios en `EscrowState` y en los 4 Contexts viejos (CD-7/CD-8) + el IDL nuevo contiene
  `deposit`/`release`/`refund`/`close` con **los mismos discriminadores y las mismas cuentas** que
  `target/idl/escrow.json` de hoy.

### Wave 2 (paralelizable tras W1) — tests
- W2.1: `tests/escrow.ts` ⇒ T1a (canario de 154 bytes).
- W2.2: `tests/escrow-index.ts` ⇒ T1b, T2, T3, T6, T10.
- W2.3: `tests/escrow-index.ts` ⇒ T4, T5, T7, T8, T9 (adversariales).
- **Verificación**: `anchor test --skip-deploy --skip-local-validator` verde y **el conteo de
  test-files/tests subió** (CD-13).

### Wave 3 (final, este repo) — cierre
- W3.1: `README.md` (si documenta instrucciones) + runbook de deploy R1 (incluye
  `solana program show` / `solana program extend`, §5).
- W3.2: `doc/sdd/_INDEX.md` fila 002 ⇒ `HU-SOL-20` (lo hace `nexus-docs`).
- **Sin deploy en F3**: R1 es gate humano (§10).

### Waves fuera de este repo (declaradas, no implementadas acá)
- WF-A (`wasiai-facilitator`): extensión de CR-1 (si B1) + re-pin del hash. **AR propio.**
- WF-B (`chaski-v3`): re-vendoreo del IDL + `register_escrow` en el flujo + UI de recuperación.

### Dependencias

| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.3 | W1.1, W1.2 | `init_if_needed` no compila sin la feature; el Context necesita el tipo |
| W2.* | W1.* | los tests instancian las ix nuevas |
| WF-B | W1 + WF-A | la ix tiene que existir y CR-1 aceptarla (§5, R4) |
| R1 (deploy) | W1+W2 verdes + AR + CR + F4 | money-path, gate humano |

---

## 9. Test Plan (`anchor test`, anchor-bankrun) — por AC

| # | Test | AC / riesgo que cubre | Archivo | Cómo |
|---|------|----------------------|---------|------|
| **T1a** | **Canario de layout**: un `deposit` produce una cuenta `escrow_state` de **exactamente 154 bytes** | **AC-6 / CD-7** — es el guard permanente de §4.1 | `tests/escrow.ts` (extender) | `banksClient.getAccount(escrowState)` ⇒ `data.length === 154` (patrón `:134`) |
| **T1b** | **Cuenta legacy sintética**: inyectar con `context.setAccount` un `escrow_state` de 154 bytes (discriminador + campos borsh a mano) + su vault ATA con saldo, y ejecutar `refund` pasado el deadline ⇒ **éxito**, fondos al `sender_ata` | **AC-6** — prueba empírica de que el programa nuevo SÍ deserializa el layout viejo | `tests/escrow-index.ts` | `setAccount` (`solana-bankrun/dist/index.d.ts:187`) + `bumpSlot`/`setClock` (`tests/escrow.ts:190-198`) |
| **T2** | `deposit` + `register_escrow` ⇒ `EscrowIndex` existe en `["escrow-index", sender]`, `entries.length === 1`, `entries[0]` == el id16 usado, `sender`/`version`/`bump` correctos. Segundo deposit+register ⇒ `entries.length === 2` | **AC-3** | `tests/escrow-index.ts` | derivar el PDA solo con el `sender`; decodificar con el coder del programa |
| **T3** | **Recuperación e2e con el id «perdido»**: el test descarta la variable del `remittanceId` string, lee el índice, toma `entries[0]`, deriva `["escrow", sender, entries[0]]`, llama `refund` ⇒ los USDC vuelven al `sender_ata` | **AC-4** (y su refinamiento §2.2) | `tests/escrow-index.ts` | asegurar que ninguna aserción usa el string original |
| **T4** | **Anti-custodia**: (a) la `authority` sola no puede invocar nada nuevo — assert sobre el IDL de que el set de instrucciones es exactamente `{deposit, release, refund, close, register_escrow, deregister_escrow}` y que ninguna nueva incluye `authority` entre sus cuentas; (b) un atacante llamando `register_escrow` con el `escrow_state` de la víctima ⇒ revierte; (c) `deregister_escrow` sobre el índice de la víctima ⇒ revierte | **AC-5 / CD-1** | `tests/escrow-index.ts` | leer `target/idl/escrow.json` (patrón `tests/escrow.ts:25`) |
| **T5** | Registrar `MAX_ENTRIES` ids y el siguiente ⇒ `EscrowIndexFull` | DT-5 (dead-end del cap) | `tests/escrow-index.ts` | 32 escrows con ids distintos (o registrar ids sintéticos si se relaja el `Deposited`; si no, 33 deposits) — **si el costo de setup es alto, documentarlo y testear con `MAX_ENTRIES` chico vía constante, no bajando el guard** |
| **T6** | `register_escrow` dos veces con el mismo id16 ⇒ **no duplica** y **no revierte** | idempotencia (DT-3) | `tests/escrow-index.ts` | **CD-12**: variar ix-data o `bumpSlot()` entre los dos intentos |
| **T7** | `deregister_escrow` quita la entrada correcta, deja las otras intactas, **no mueve tokens** (vault y ATAs con el mismo saldo antes/después) y es idempotente si el id no está | DT-7 | `tests/escrow-index.ts` | comparar saldos con `AccountLayout` (patrón `tests/escrow.ts:134`) |
| **T8** | `register_escrow` con (a) un `escrow_state` inexistente ⇒ `AccountNotInitialized` (3012); (b) un escrow ya `Released` ⇒ `EscrowNotDeposited` | flujo de error §4.12 | `tests/escrow-index.ts` | reusar el helper de release de la suite existente |
| **T9** | Las 4 instrucciones viejas siguen funcionando igual: re-correr los 9 tests de `tests/escrow.ts` **sin modificarlos** (salvo el agregado de T1a) | **AC-6 / CD-8** | `tests/escrow.ts` | 9/9 verdes; cualquier cambio necesario en un test viejo es señal de que se rompió el contrato |
| **T10** | Rent real del índice vía `getMinimumBalanceForRentExemption(558)` y del `escrow_state` (154) ⇒ registrar los valores medidos y compararlos con §4.6 | verificar el cálculo, no confiar en él | `tests/escrow-index.ts` | `provider.connection.getMinimumBalanceForRentExemption` (patrón `tests/escrow.ts:74-76`) |

**Tests cross-repo (declarados; se ejecutan en sus pipelines):**

| Test | AC | Repo |
|------|-----|------|
| `refundEscrow` sin `remittanceId` resuelve desde el store server-side | **AC-2** | `chaski-v3` |
| el endpoint sender-scoped rechaza sin PoP y con PoP de otra wallet (IDOR) | CD-16 | `chaski-v3` |
| CR-1 acepta la forma de 2 ix **solo** con el discriminador y flags pineados; sigue aceptando la de 1 ix; rechaza 2º ix de otro programa / con el fee-payer referenciado | R3 / CD-10 | `wasiai-facilitator` |
| hash del IDL re-pineado en los 3 lugares y AC-3 sibling verde | §4.10 | ambos |

---

## 10. Gates que dispara esta HU (declarados)

| Gate | Qué es | Quién | Estado |
|------|--------|-------|--------|
| **G1 — Reemplazo del programa on-chain** | Upgrade **in-place** del program id vivo `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` (verificado leyendo `declare_id!` en `lib.rs:5`, `target/idl/escrow.json:2` y `Anchor.toml:12,15`; **ningún literal de doc**) vía `scripts/deploy-devnet.sh`, con la **keypair única** de upgrade authority. Incluye el chequeo previo de tamaño (`solana program show` / `solana program extend`). | **founder / humano**. PROHIBIDO que F3 lo ejecute (CD-19) | pendiente, paso R1 |
| **G2 — Auditoría externa antes de mainnet** | Política ya fijada (HU-SOL-12/CD-5). En **devnet** el gate es **AR + tests verdes**. Recomendación: secuenciar esta HU **antes** de HU-SOL-19 para auditar el programa ya con el mecanismo de recuperación incluido, no dos veces. | founder | mainnet bloqueado |
| **G3 — AR obligatorio (money-path)** | Antes de mergear cualquier cambio a `lib.rs` (CD-6). | `nexus-adversary` | pendiente |
| **G4 — AR propio de la extensión de CR-1** | Solo si B1. Toca el **núcleo anti-drain** del facilitator ⇒ no se cuela como cambio menor de otro repo. | `nexus-adversary` en `wasiai-facilitator` | pendiente, decisión §12 |
| **G5 — Re-pin coordinado del IDL** | 5 archivos en 2 repos (§4.10) en la misma ventana que R1. | pipelines de `chaski-v3` / `wasiai-facilitator` | pendiente |
| **Entorno** | **Devnet, dinero no real** (CD-5). Código de producción, no de hackathon: sin `unwrap` en paths nuevos, sin datos simulados, sin hardcodes (CD-15). | — | — |

---

## 11. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|-----------|
| Alguien agrega un campo a `EscrowState` en esta HU o en una futura ⇒ 3003 en todos los escrows viejos | B | **Crítico** | CD-7 + **T1a** (canario de 154 bytes) + §4.1 documentado con evidencia |
| El cliente emite la tx nueva antes de que CR-1 la acepte ⇒ money-path caído | M | Alto | Orden R3 antes de R4 (§5) + CR-1 acepta **ambas** formas |
| El `.so` no entra en el espacio asignado del programa ⇒ `anchor deploy` falla a mitad de la ventana | M | Alto | Paso explícito de `solana program show` + `solana program extend` en el runbook de R1 |
| Relajar «exactamente 1 business ix» en CR-1 amplía la superficie de drain | M | **Crítico** | Allowlist estricto (programId + discriminador pineado + flags por posición), Check 5 intacto (CD-10), AR propio (G4), y **B2 como fallback** que no toca CR-1 |
| `init_if_needed` mal usado ⇒ re-init de estado | B | Medio | CD-9 (escrituras idempotentes, sin reset) + T6 |
| El índice se llena y bloquea el depósito | B | Alto | `deregister_escrow` **en scope** (DT-7) + T5 + `MAX_ENTRIES` con 16-32x de holgura |
| Wave 0 no aporta porque `SETTLEMENT_LEDGER_ENABLED` está OFF en devnet | **A** | Alto | §12: verificación de ops **antes** de dar AC-1/AC-2 por PASS. Es la mitigación de hoy: si está OFF, hoy **no hay ninguna** |
| El endpoint de lectura filtra `remittanceId` de otras wallets (IDOR) | M | Alto | CD-16 (PoP obligatorio + filtro `sender_address`) + test cross-repo |
| Los 3 IDL divergen y el hash queda desincronizado ⇒ CI rojo en 2 repos | **A** (es esperado tras R1) | Bajo | R2 inmediatamente después de R1 (§4.10/§5) |
| `getProgramAccounts` como plan B falla en RPC público | M | Bajo | El diseño **no lo usa**: el índice es un PDA determinístico ⇒ un solo `getAccountInfo` (§4.11 paso 3) |
| Subir `MAX_ENTRIES` a futuro sobre índices ya creados | B | Medio | `version: u8` reservado; documentado en DT-2 que la lectura es compatible pero la escritura >32 requeriría migración ⇒ otra HU (CD-11) |

---

## 12. Missing Inputs / Uncertainty Markers

| Marker | Sección | Descripción | ¿Bloqueante? |
|--------|---------|-------------|-------------|
| **[NEEDS CLARIFICATION — founder/AR]** | §4.8 (DT-7) | **B1 (atómica, extiende CR-1) vs B2 (2ª tx, no toca CR-1)**. Recomendación: **B1**. La decisión afecta **solo** R3/R4 en los otros dos repos; el diseño on-chain es idéntico en ambas. | **NO bloquea W0 ni W1** (este repo). **SÍ bloquea** WF-A/WF-B (R3/R4). Debe resolverse antes de F2.5 del story de `chaski-v3`. |
| **[NEEDS CLARIFICATION — ops/founder]** | §4.9 (DT-8) | Estado real de `SETTLEMENT_LEDGER_ENABLED` en devnet y de los envs Supabase. No es leíble desde este alcance (no hay `.env` de devnet ni acceso a Vercel; **no se abrió** ninguna credencial). Si está OFF, la fila de AC-1 **no se escribe** y Wave 0 no protege nada. | **NO bloquea codear** W0 (el código es correcto con el flag en cualquier estado). **SÍ bloquea** dar AC-1/AC-2 por PASS en F4. |
| **[TBD — story de `chaski-v3`]** | §4.9 punto 4 | ¿Existe ya un índice de BD por `sender_address` en `remittance_settlements`? Verificar leyendo la migración real (CD-13), no asumir. | No |
| **[DRIFT esperado, ya justificado]** | §2.2 | AC-4 se cumple en intención (los 16 bytes se leen de la cadena) pero **sí** se pasan como argumento a `refund`. No es un hallazgo de QA. | No |
| **RESUELTO** | §2.0 | `WKH-NN`: no aplica (Jira suspendido). Identificador canónico **HU-SOL-20** / carpeta 002. | — |
| **RESUELTO** | §4.2 | Preferencia UX entre índice y nonce ⇒ **índice**, decisión del founder; la derivación del PDA **no** se toca. | — |
| **RESUELTO** | §4.9 | ¿Wave 0 en `chaski-v3` o en el facilitator? ⇒ **`chaski-v3`**, decisión del founder (la tabla y el flujo de depósito ya viven ahí). | — |
| **RESUELTO** | §4.9 | ¿En qué momento se escribe la fila respecto al `deposit`? ⇒ en `prepare`, **antes** de que el cliente pueda construir la tx (`app/api/payout/prepare/route.ts:296-311` + `:314-318`). | — |

> Gate: el primer `[NEEDS CLARIFICATION]` no bloquea `SPEC_APPROVED` de este repo (W0/W1 son
> implementables sin él), pero **sí** debe estar decidido antes de arrancar los stories de
> `wasiai-facilitator` y `chaski-v3`.

---

## 13. Readiness Check

```
READINESS CHECK — SDD #002 / HU-SOL-20
[x] Cada AC tiene al menos 1 archivo asociado (§4.13) y al menos 1 test (§9)
    AC-1→W0.1-W0.4 · AC-2→W0.3+test cross-repo · AC-3→T2 · AC-4→T3 · AC-5→T4
    AC-6→T1a/T1b/T9 · AC-7→§6 CD-2 (imposibilidad documentada, no implementable)
[x] Cada archivo de §4.13 tiene un Exemplar verificado (§3.2 — todos con archivo:línea)
[x] Todos los paths citados existen (verificados uno por uno con test -f: 27/27 OK)
[x] Program id verificado en 3 fuentes independientes, ningún literal de doc (§4.10/G1)
[x] El riesgo de layout está resuelto con evidencia de código, no de memoria
    (§4.1: macro #[account] :247-262, gen_discriminator :19-27, error 3003 :238-239,
     InitSpace de enum :80-105) + estrategia elegida + 6 alternativas descartadas (§4.2)
[x] La estrategia "no tocar EscrowState / índice en cuenta aparte" fue evaluada
    explícitamente contra la alternativa de modificar EscrowState, y ELEGIDA (§4.2, DT-1)
[x] Estado degradado de los escrows viejos declarado: NINGUNO (§4.2, último párrafo)
[x] Orden de release definido con los 3 repos, paso por paso, con qué rompe cada
    orden inverso (§5) — y el hallazgo que lo hace obligatorio (CR-1, cr1.ts:80-82,170-173)
[x] Alcance multi-repo mapeado con archivo:línea (§3.1, §4.13)
[x] Golden tests del IDL: 5 archivos identificados, fuente de verdad declarada
    (target/idl/escrow.json + idl.address, nunca literal) (§4.10)
[x] Gates declarados: G1 reemplazo on-chain · G2 auditoría externa pre-mainnet ·
    G3 AR · G4 AR de CR-1 · G5 re-pin IDL. Devnet, dinero no real
[x] Constraint Directives: 6 heredadas + 13 nuevas; 11 son PROHIBIDO (mínimo 3)
[x] Auto-Blindaje histórico leído y convertido en CD: #001 (bankrun dedup→CD-12,
    toolchain asumido→CD-13, CpiContext→CD-14) + WKH-227 (config asumido→CD-13).
    Patrón recurrente en ≥2 HUs: "el Architect asumió un config que no leyó" → CD-13
[x] Context Map: 24 archivos leídos (≥2)
[x] Scope IN/OUT explícitos; el escrow BmHDdjKL… está en OUT **con nombre** (§7)
[x] Happy path completo (§4.11, 7 pasos) y flujo de error con 9 casos (§4.12)
[x] Waves ordenadas: W0 = registro durable off-chain (protege ya), W1 = contratos
    on-chain, W2 = tests, W3 = cierre (§8)
[x] Test plan por AC con archivo destino y método (§9, 10 tests + 4 cross-repo)
[x] Números de rent marcados como CÁLCULO y con test que los mide (T10)
[ ] [NEEDS CLARIFICATION] pendientes: 2 — ninguno bloquea W0/W1 de este repo;
    el de B1/B2 bloquea los stories de facilitator y chaski (§12)
```

**Veredicto**: **LISTO para `SPEC_APPROVED`** en el alcance de este repo (Wave 0 + Wave 1 + tests).
Los dos `[NEEDS CLARIFICATION]` están acotados y declarados: el de B1/B2 no afecta una sola línea
del programa Anchor (por eso W1 puede arrancar), y el del flag de devnet no afecta el código de
Wave 0 (solo su verificación en F4).

---

*SDD generado por NexusAgil — FULL · F2 · nexus-architect*
