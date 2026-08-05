# Story File — WKH-326: el tope de 32 del índice deja de crecer para siempre

> Fase: F2.5 (NexusAgil QUALITY) · Architect · 2026-08-05
> Gate previo: `SPEC_APPROVED — 2026-08-05 by Claude (delegado por Fernando)`
> Repo: `/home/ferdev/.openclaw/workspace/solana-programs`
> Programa: `escrow` — `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` (devnet)
> Branch: `feat/326-cap-del-indice-liberado-en-close`

**Este documento es lo único que vas a leer.** No hace falta abrir el SDD ni el work-item: todo lo
que necesitás está acá adentro. Si algo NO está acá, **parás y escalás** (ver "Escalation" al final).
No inventás.

---

## 0. Bloque de arranque — corré esto ANTES de tocar nada

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/ferdev/.openclaw/workspace/solana-programs

# 0.1 rama
git checkout -b feat/326-cap-del-indice-liberado-en-close

# 0.2 deps
npm ci

# 0.3 build (SIEMPRE antes de la suite — ver CD-11)
anchor build

# 0.4 baseline
anchor test --skip-build --skip-deploy --skip-local-validator
```

### Contra qué comparás

| Cosa | Valor de hoy | Cómo lo verificás |
|---|---|---|
| Suite completa | **43 passing, 0 failing** | la salida de 0.4 |
| `tests/escrow.ts` | 10 tests | `grep -c 'it("' tests/escrow.ts` |
| `tests/escrow-index.ts` | 13 tests | idem |
| `tests/escrow-window.ts` | 20 tests | idem |
| sha256 canónico del IDL | `fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071` | es el que pinnean los dos consumidores hoy |
| md5 de `target/deploy/escrow.so` | `f4be35f7ee11bdb48c0a576a43b4972f` | `md5sum target/deploy/escrow.so` |
| md5 de `target/idl/escrow.json` | `037c5c5ffd80a21e0a758896acc805a3` | `md5sum target/idl/escrow.json` |
| md5 de `programs/escrow/src/lib.rs` | `286226f7f787ca648595dbde42f7c7aa` | `md5sum programs/escrow/src/lib.rs` |

**Si 0.4 no da 43 passing, PARÁ y reportá.** No implementes sobre una suite que ya está en rojo.
Guardate los tres md5 de arriba en un archivo aparte: los vas a necesitar en W4.

---

## 1. Qué se construye y por qué

`EscrowIndex` es una PDA sembrada `["escrow-index", sender]` que guarda hasta 32 ids de 16 bytes
(`MAX_ENTRIES = 32`, `programs/escrow/src/lib.rs:400`). Hoy `register_escrow` **agrega** entradas
(`lib.rs:353-355`) y lo único que las **saca** es un `deregister_escrow` explícito (`lib.rs:368`),
que nadie llama automáticamente. `release`, `refund` y `close` ni siquiera declaran la cuenta.

Resultado: el cap no acota escrows abiertos, acota **ids registrados en toda la vida del sender**.
El `register_escrow` número 33 revierte con `EscrowIndexFull` (6005) aunque los 32 anteriores estén
cerrados hace meses.

**El arreglo:** `close` pasa a declarar la cuenta `escrow_index` como **opcional** y, cuando se la
pasan, saca del índice el id del escrow que está cerrando. `close` es la única instrucción que ya
tiene juntos el firmante correcto (`sender: Signer`, `lib.rs:648`), el momento correcto
(`constraint = escrow_state.status.is_terminal()`, `lib.rs:662`) y el id a borrar (`close(ctx,
remittance_id)`, `lib.rs:298`) — y es la única de las tres terminales que **ningún consumidor
construye hoy**, así que el cambio de interfaz es una restricción hacia adelante, no un corte en vivo.

**Se entrega: rama + suite verde + `target/idl/escrow.json` regenerado. NADA MÁS.**

---

## 2. Las seis cosas que no podés ignorar

### 2.1 W0 PRIMERO Y EN ROJO — es lo único que distingue "arreglé el bug" de "escribí un test que pasa"

El test del ciclo de 33 (AC-3) **se escribe antes de tocar `lib.rs`**, se corre contra el binario de
hoy, y su salida roja literal — con el código `EscrowIndexFull` / 6005 — queda registrada como
evidencia (**CD-10**). Lo mismo el test de la fuga básica (AC-1), que va a fallar por aserción
(`entries` queda `[A,B]` en vez de `[B]`).

No es un bullet más: si W0 no se ve rojo, no hay prueba de que el fix haga algo. Este repo ya se
comió dos veces el caso de correr la suite contra un binario que no correspondía al fuente
(`doc/mutation-run.md:9-15`).

**Guardá la salida cruda** (`... | tee doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/w0-red.txt`).

### 2.2 `escrowIndex: null` EXPLÍCITO, siempre — omitir la clave NO omite la cuenta

**Esto está MEDIDO en F2, no es teoría.** El IDL declara las seeds de la PDA, así que el resolvedor
de `@coral-xyz/anchor` 0.30.1 **la calcula y la manda** cuando la clave no está en el objeto:

```
--- close con escrowIndex: null ---
  [6] DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x     <== PROGRAM_ID (cuenta OMITIDA, correcto)

--- close con escrowIndex AUSENTE del objeto ---
  [6] Ci5akmx3PvX1w1xvZ19eoeEVscWV1YASGy2eWpbzLhtm     <== la PDA del índice (!!)  NO omitió nada
```

Si esa PDA no existe en cadena, la tx revienta con `AccountNotInitialized` (**3012**), un error que
**no menciona la palabra "opcional"** y te va a mandar a buscar donde no es.

**Regla (CD-14):** en TODO test y TODO ejemplo de esta HU, "sin índice" se escribe
`escrowIndex: null`, explícito. Un `.accountsPartial({...})` que simplemente no menciona
`escrowIndex` **está pasando la PDA**.

Corolario: un test de AC-2 escrito omitiendo la clave probaría **lo contrario** de lo que dice probar.

### 2.3 Los 7 tests que se ponen rojos, identificados por nombre

Con el fix puesto y **sin** tocar los helpers, la suite queda en **36 passing, 7 failing**. Los 7,
medidos en F2:

| # | Archivo | Test | Falla con |
|---|---|---|---|
| 1 | `tests/escrow.ts:499` | `7. close while Deposited reverts (EscrowNotTerminal) — AC-8` | `AccountNotInitialized` (3012) |
| 2 | `tests/escrow.ts:521` | `8. close after release returns rent + vault to sender ... (anti-revival)` | `AccountNotInitialized` (3012) |
| 3 | `tests/escrow-window.ts:646` | `D1. dust donated to the vault after the release ...` | `AccountNotInitialized` (3012) |
| 4 | `tests/escrow-window.ts:677` | `D1b. the same holds after a refund ...` | `AccountNotInitialized` (3012) |
| 5 | `tests/escrow-window.ts:704` | `D2. a LIVE escrow cannot be closed ...` | **distinto — ver abajo** |
| 6 | `tests/escrow-window.ts:828` | `E2. an account already sitting on chain as Released is still closable` | `AccountNotInitialized` (3012) |
| 7 | `tests/escrow-window.ts:841` | `E3. an account already sitting on chain as Refunded is still closable too` | `AccountNotInitialized` (3012) |

**Los 7 se arreglan pasando `escrowIndex: null` en el helper. Ninguno es un defecto del diseño.**

**D2 falla DISTINTO, y es esperado:**

```
AssertionError: expected 'AccountNotInitialized' to equal 'EscrowNotTerminal'
   at expectRevert (tests/escrow-window.ts:318:43)
```

D2 seguía reventando, pero **por el motivo equivocado**. Si `expectRevert` de esa suite no pinneara
el código exacto, D2 habría quedado **verde con el guard enmascarado**. Es la convención del repo
atrapando exactamente el caso para el que existe. **No "arregles" D2 relajando su aserción** — se
arregla igual que los otros seis: `escrowIndex: null` en el helper.

### 2.4 `anchor build` ANTES de cada corrida de la suite (CD-11)

`anchor deploy` y bankrun **shippean lo que está en `target/deploy/`, NO compilan**. Restaurar el
fuente sin rebuildear deja un binario mutado corriendo y la suite reporta fallas que no tienen nada
que ver con el código en disco. **Este repo se comió esto dos veces** (`doc/mutation-run.md:9-15`,
`README.md:774-777`).

La secuencia correcta, **cada vez**, en W0, W1, W2, W3, W4 (dos veces por mutante) y W5:

```bash
anchor build && anchor test --skip-build --skip-deploy --skip-local-validator
```

Nunca `anchor test --skip-build` a secas después de editar `lib.rs`.

### 2.5 PROHIBIDO DESPLEGAR (CD-1)

Prohibido: `anchor deploy`, `solana program deploy`, `solana program extend`,
`solana program write-buffer`, `anchor idl init|upgrade|publish`, `scripts/deploy-devnet.sh`, y
**cualquier transacción de escritura contra devnet**.

Permitido: `anchor build`, `anchor test --skip-build --skip-deploy --skip-local-validator` (bankrun,
100% local, no toca ninguna red).

### 2.6 PROHIBIDO escribir en los otros cuatro repos (CD-2)

`chaski-v3/`, `wasiai-facilitator/`, `wasiai-a2a/`, `wasiai-remittance-agents/` se **leen**, no se
tocan. En W3 vas a **correr** dos suites de esos repos en modo lectura. **PROHIBIDO re-pinnear
`ESCROW_IDL_SHA256`** en ninguno de los dos. El rojo del hash ahí es **ESPERADO** y **no se arregla
en esta HU** — se arregla en la HU de deploy, una sola vez, con el hash final.

---

## 3. Acceptance Criteria — los 9, con su forma de refutación

- **AC-1** — WHEN `close` se invoca con la cuenta `escrow_index` del sender que firma, y ese índice
  contiene el `remittance_id` del escrow que se cierra, the system SHALL quitar **exactamente** esa
  entrada y SHALL dejar las demás en su orden original.
  *Refuta:* registrar A y B (en ese orden), releasear A, cerrar A pasando el índice. `entries` tiene
  que quedar **exactamente `[B]`**. Si queda `[A,B]`, `[]` o `[B,A]`, falla.

- **AC-2** — IF el sender que firma nunca creó su PDA `EscrowIndex`, THEN `close` SHALL completarse
  con éxito y SHALL NOT crear esa cuenta.
  *Refuta:* `deposit → release → close(escrowIndex: null)`, **sin llamar nunca a `register_escrow`**.
  La tx confirma y `banksClient.getAccount(indexPda(sender))` devuelve `null` después. Si revierte
  con 3012, falla. Si la cuenta existe después, también falla (habría cobrado 4.774.560 lamports de
  rent por una cuenta vacía).
  **Es el AC más importante de la lista:** es exactamente el camino que corre en producción hoy
  (`chaski-v3` arma sólo `deposit`). Romperlo rompe lo que funciona.

- **AC-3** — WHEN un mismo sender completa `deposit → register_escrow → release → close`
  repetidamente, the system SHALL aceptar el `register_escrow` número 33 y todos los siguientes.
  *Refuta:* 33 ciclos completos. El 33º `register_escrow` confirma y `entries.length ≤ 1` al final
  de cada ciclo. **Hoy el 33º revierte con `EscrowIndexFull` (6005): este test se escribe y se ve
  ROJO en W0.**

- **AC-4** — IF el llamador pasa una cuenta `escrow_index` cuyas seeds no derivan del sender que
  firma, THEN `close` SHALL revertir con `ConstraintSeeds` y SHALL NOT modificar ningún índice.
  *Refuta:* el atacante cierra un escrow **propio y terminal** pasando la PDA de índice de la
  víctima. Revierte con ese código **exacto** (no "tira algo") y el índice de la víctima queda
  idéntico entrada por entrada.

- **AC-5** — the system SHALL mover exactamente los mismos montos de tokens en `close` después del
  cambio que antes.
  *Refuta:* con N unidades en el vault al momento del `close`, `senderAta` crece exactamente N, el
  balance del beneficiary no se mueve, el vault queda cerrado. D1 y D1b de `escrow-window.ts` siguen
  verdes **sin que se les toque una aserción**.

- **AC-6** — WHILE `escrow_state.status` es `Deposited`, `close` SHALL revertir con
  `EscrowNotTerminal` (6004) y SHALL NOT quitar ninguna entrada del índice.
  *Refuta:* `deposit → register_escrow → close(con índice)` antes del deadline. **Dos** aserciones:
  código 6004 **y** `entries === [id]` después. Una tx que revierte no escribe nada, pero el AC
  obliga a asertar las dos cosas porque lo que lo garantiza es el **orden** de los constraints, y el
  orden se puede cambiar sin querer.

- **AC-7** — WHEN `close` se invoca con un índice que **no** contiene el `remittance_id`, the system
  SHALL completarse con éxito y SHALL dejar `entries` sin cambios.
  *Refuta:* cerrar un escrow cuyo id no está en el índice, pasando el índice. La tx **confirma**. Si
  revierte, es una regresión respecto de la idempotencia que `retain` ya garantiza (`lib.rs:368`).

- **AC-8** — WHEN el programa se rebuildea, the system SHALL generar un `target/idl/escrow.json` que
  (i) declara exactamente 6 instrucciones, (ii) conserva los 6 discriminadores actuales, y (iii)
  declara `escrow_index` en la lista de cuentas de `close`.
  *Refuta:* aserción contra el **artefacto construido**, no contra el fuente. El discriminador de
  `close` sigue siendo `[98, 165, 201, 177, 108, 65, 206, 96]`. Si aparece una 7ª instrucción, falla.

- **AC-9** — the system SHALL conservar sin cambios la lista de cuentas, los args y el discriminador
  de `deposit`, `release`, `refund`, `register_escrow` y `deregister_escrow`.
  *Refuta:* pin local por posición (test 20) **y** los tests de pin de los consumidores corridos en
  modo lectura (W3).

---

## 4. Constraint Directives — las 17, enumeradas

### PROHIBIDO

| CD | Qué |
|---|---|
| **CD-1** | **DESPLEGAR.** `anchor deploy`, `solana program deploy\|extend\|write-buffer`, `anchor idl init\|upgrade\|publish`, `scripts/deploy-devnet.sh`, y cualquier tx de escritura contra devnet. `anchor build` y bankrun local SÍ. |
| **CD-2** | **Escribir en `chaski-v3/`, `wasiai-facilitator/`, `wasiai-a2a/`, `wasiai-remittance-agents/`.** Se leen y se corren sus tests; no se editan. En particular PROHIBIDO re-pinnear `ESCROW_IDL_SHA256`. |
| **CD-3** | Tocar `MIN_CUSTODY_SECS` (`lib.rs:121`) y `MAX_CUSTODY_SECS` (`lib.rs:129`). |
| **CD-4** | Cambiar orden o cantidad de variantes de `EscrowStatus` (`lib.rs:433-445`). Insertar variantes de `ErrorCode` fuera del final (`lib.rs:463-490`): **los códigos son posicionales desde 6000**, insertar en el medio renumera todo lo que sigue. |
| **CD-5** | Cambiar cuentas, args o discriminadores de `deposit`, `release`, `refund`, `register_escrow`, `deregister_escrow`. **SÓLO `close` cambia.** |
| **CD-7** | Subir `MAX_ENTRIES` (`lib.rs:400`). Se queda en 32. |
| **CD-9** | Abrir `chaski-v3/m5-keys/`. Imprimir secretos. Git destructivo (`reset --hard`, `push --force`, `clean -fd`). |
| **CD-12** | `cargo fmt`. El árbol no pasa `--check` hoy a propósito (`README.md:872-877`) y un reformateo entierra el diff que hay que revisar. |
| **CD-13** | Agregar `init` o `init_if_needed` a la cuenta `escrow_index` de `Close`. Le cobraría al sender 4.774.560 lamports para devolverle 4.002.000, y dejaría una cuenta vacía cuyo rent no se recupera. **Es el error que un `AccountNotInitialized` en un test invita a cometer.** Detección en AR: `grep -n "init" ` en el bloque de `Close` → BLOQUEANTE. |
| **CD-14** | Omitir el índice dejando la clave afuera del objeto. "Sin índice" se escribe `escrowIndex: null`, explícito, siempre. Detección: cualquier `.close(` cuyo objeto de cuentas no contenga la clave `escrowIndex`. |
| **CD-16** | Tocar el `retain` de `deregister_escrow` (`lib.rs:368`) y su Context. **Y prohibido unificar los dos `retain` en un helper compartido.** La duplicación es deliberada: la simetría entre los dos es lo que hace que un mutante que rompe uno no toque al otro, y por lo tanto lo que hace que el plan de mutación de la sección 8 signifique algo. |
| **CD-17** | Afirmar el sha256 nuevo del IDL en cualquier archivo que no sea la evidencia de esta HU. El del spike de F2 (`cedfddd4…`) **NO es el final**: se midió sin el `///` de la cuenta nueva y sin los comentarios de W5. |

### OBLIGATORIO

| CD | Qué |
|---|---|
| **CD-6** | Todo comentario **nuevo** usa `//`, nunca `///` ni `//!` — los doc comments viajan al IDL y le mueven el sha256. **Excepción única y ya decidida: el `///` de la cuenta `escrow_index` nueva de `Close`.** Todo lo demás (el bloque de `lib.rs:377-396`, el de `:411-412`, cualquier nota en el handler) sigue en `//`, sin excepción. |
| **CD-8** | Agregar a `doc/mutation-run.md` los mutantes M15..M19 y registrar qué test mata a cada uno. **En este repo un guard sin mutante no cuenta como probado.** |
| **CD-10** | El test de AC-3 se ve **ROJO** contra el binario actual **antes** de escribir el fix, y esa salida queda registrada. |
| **CD-11** | `anchor build` antes de **cada** corrida de la suite. |
| **CD-15** | La cuenta `escrow_index` va **ÚLTIMA** en `struct Close`, después de `token_program`. Detección: en `target/idl/escrow.json`, `close.accounts[5].name === "token_program"` y `close.accounts[6].name === "escrow_index"`. |

---

## 5. Files to Modify / Create — la lista exhaustiva

| # | Archivo | Acción | Qué | Wave |
|---|---|---|---|---|
| 1 | `programs/escrow/src/lib.rs:644-687` (`struct Close`) | Modificar | agregar `escrow_index: Option<Account<'info, EscrowIndex>>` al final, con `///` | W1 |
| 2 | `programs/escrow/src/lib.rs:298-336` (handler `close`) | Modificar | agregar el `if let Some(...) { retain }` al final del cuerpo | W1 |
| 3 | `programs/escrow/src/lib.rs:377-396` | Modificar | reescribir el bloque `//` que hoy describe el defecto como abierto (comentarios `//`) | W5 |
| 4 | `programs/escrow/src/lib.rs:411-412` | Modificar | reescribir el comentario del campo `entries` (comentarios `//`) | W5 |
| 5 | `tests/escrow-index.ts` | Modificar | helper `close(...)` nuevo + tests 12..21 | W0, W1, W2, W3 |
| 6 | `tests/escrow.ts:507-514` y `:544-551` | Modificar | agregar `escrowIndex: null,` a los dos `.accountsPartial({...})` de `close` | W1 |
| 7 | `tests/escrow-window.ts:270-287` | Modificar | el helper `close(...)` toma un 4º parámetro opcional, default `null` | W1 |
| 8 | `doc/mutation-run.md` | Modificar | apendizar M15..M19 al final de la tabla + una sección con el resultado | W4 |
| 9 | `README.md:607-623` | Modificar | "Known limitations": el índice ya no se llena para siempre | W5 |
| 10 | `README.md:453-459` (inv. 9), `:468-473` (inv. 11) | Modificar | el índice ahora también lo escribe `close`; la cota deja de ser monótona | W5 |
| 11 | `README.md:285` | Modificar | fila de `close` en la tabla de Instructions | W5 |
| 12 | `README.md:244-276` | Modificar | "Recovering an escrow whose id was lost" | W5 |
| 13 | `README.md:987-1002` | Modificar | "The account list of `close` has no safe deployment order": ahora suma una segunda cuenta | W5 |
| 14 | `doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/` | Crear | evidencia: `w0-red.txt`, hash final, salidas de W3 y W4 | W0..W5 |
| 15 | `target/idl/escrow.json`, `target/types/escrow.ts` | **Regenerados** | los produce `anchor build`. **NO se editan a mano.** | W1 |

**Cualquier archivo fuera de esta tabla: PARÁ y escalá.**

---

## 6. Exemplars verificados — copiás de acá, no inventás

Todos confirmados con `Read` sobre el archivo real el 2026-08-05.

### E1 — Cuenta de índice sembrada + bump leído de la cuenta
**`programs/escrow/src/lib.rs:725-730`** (`struct DeregisterEscrow`)
```rust
#[account(
    mut,
    seeds = [b"escrow-index", sender.key().as_ref()],
    bump = escrow_index.bump
)]
pub escrow_index: Account<'info, EscrowIndex>,
```
Esta es la forma exacta de las seeds y del bump. La única diferencia en `Close` es que el tipo va
envuelto en `Option<...>`.

### E2 — El `retain`
**`programs/escrow/src/lib.rs:368`**
```rust
ctx.accounts.escrow_index.entries.retain(|e| *e != remittance_id);
```
**Misma expresión, sin variantes.** Es idempotente por construcción: no hace panic si el id no está
(eso es AC-7). No escribas una búsqueda nueva: una segunda implementación de la misma operación es
una segunda oportunidad de que difieran.

### E3 — Cuenta nueva de `close` documentada con `///` (precedente de CD-6)
**`programs/escrow/src/lib.rs:674-684`** (`sender_ata`)
```rust
/// Destino del barrido. Cuenta NUEVA en esta instrucción: los consumidores que hoy arman el
/// `close` con la lista vieja tienen que agregarla. No existe orden de despliegue seguro entre
/// programa y cliente para este cambio (ver README, "Deploying"): las dos combinaciones cruzadas
/// fallan. Hoy ningún consumidor construye `close`, así que es una restricción hacia adelante y
/// no un corte en vivo.
#[account(...)]
pub sender_ata: Account<'info, TokenAccount>,
```
Verificado en el IDL construido: ese texto **está** en `close.accounts[4].docs`, y es la **única**
cuenta de `close` con `docs`. Por eso la cuenta nueva también lleva `///`.

### E4 — Helper `close` de una suite (el que hay que extender)
**`tests/escrow-window.ts:270-287`**
```ts
function close(
  remittanceId: Uint8Array,
  escrowState: PublicKey,
  vault: PublicKey
) {
  return program.methods
    .close(Array.from(remittanceId))
    .accountsPartial({
      sender: sender.publicKey,
      mint,
      escrowState,
      vault,
      senderAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([sender])
    .rpc();
}
```

### E5 — Los dos `close` inline sin helper de `escrow.ts`
**`tests/escrow.ts:504-517`** (test 7, dentro de un `expectRevert`) y **`tests/escrow.ts:542-553`**
(test 8). Mismo objeto de 6 cuentas.

### E6 — `expectRevert` que pinnea el código EXACTO
**`tests/escrow-index.ts:328-350`**. Todo test de revert de esta HU usa éste. "Tira algo" no cuenta:
D2 es la prueba viva de que sin el pin del código un guard se enmascara.

### E7 — Derivación de la PDA del índice
**`tests/escrow-index.ts:176-182`**
```ts
function indexPda(owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow-index"), owner.toBuffer()],
    program.programId
  );
  return pda;
}
```

### E8 — Helpers ya disponibles en `tests/escrow-index.ts` (NO los reescribas)
| Helper | Línea | Qué hace |
|---|---|---|
| `deposit(rid, amount, deadline)` | `:194-221` | devuelve `{escrowState, vault}` |
| `register(rid, escrowState, signer?, override?)` | `:240-256` | `register_escrow` |
| `deregister(rid, signer?, override?)` | `:258-271` | `deregister_escrow` |
| `release(rid, escrowState, vault)` | `:289-305` | firma `authority` |
| `refund(rid, escrowState, vault)` | `:273-287` | firma `sender` |
| `expectRevert(promise, code)` | `:328-350` | pinnea el código exacto |
| `indexPda(owner)` | `:176-182` | la PDA del índice |
| `bumpSlot()` | `:309-312` | avanza el slot (bankrun deduplica por firma) |
| `tokenBalance(ata)` | `:156-160` | `-1n` si la cuenta no existe |
| `idsOf(entries)` / `hex(rid)` | `:352-358` | comparar entradas como hex |
| `rid(seed)` | `:184-188` | id16 con `b[0] = seed` — **seed único por escrow, 0..255** |
| `warpTo(unixTs)` | `:314-326` | mueve el reloj |
| `processIxs(ixs, signers)` | `:72-80` | devuelve el `meta` con `computeUnitsConsumed` |
| `registerIx(...)` | `:223-238` | versión `.instruction()` de register |

**`tests/escrow-index.ts` NO tiene helper de `close` hoy** (verificado: `grep -n "\.close(" tests/escrow-index.ts` no devuelve ninguna llamada). Lo creás vos en W0.

### E9 — Aserción contra el IDL **construido**
**`tests/escrow-index.ts:27`** (`import idl from "../target/idl/escrow.json";` — import directo,
**nunca** guardado por `existsSync` + `it.skip`) y el test 4a en **`:521-545`**.

### E10 — Medición de CU y su advertencia
**`tests/escrow-index.ts:724-772`** (T11) y la nota de `:725-731`. Constante ya existente:
`CU_REGRESSION_GUARD = 300_000` en **`:47`**.

### E11 — Formato de la tabla de mutantes y el protocolo
**`doc/mutation-run.md:17-32`** (la tabla M1..M14) y **`:61-73`** ("How to repeat it").

---

## 7. Waves — secuenciales, ninguna se salta

---

### W0 — Los tests en ROJO primero. **No se toca `lib.rs`.**

**Objetivo:** dejar registrada la salida roja del bug contra el binario de HOY (CD-10).

**Archivos:** `tests/escrow-index.ts` únicamente.

**Qué hacés:**

**W0.1 — Creá el helper `close` en `tests/escrow-index.ts`, con las 6 cuentas de HOY.**
Ponelo justo después de `release(...)` (`:305`). Copiá de E4 (`tests/escrow-window.ts:270-287`).

> ⚠️ **En W0 el helper NO lleva `escrowIndex`.** La cuenta todavía no existe en el IDL construido, y
> pasar una clave que el IDL no declara haría fallar los tests por el motivo equivocado — que es
> exactamente lo que W0 existe para evitar. **El parámetro se agrega en W1**, cuando el IDL ya la
> declara. Esta es la **única** ventana en la que un `.close(` sin la clave `escrowIndex` es
> correcto; a partir de W1 rige CD-14 sin excepciones.

**W0.2 — Escribí el test 14 (AC-3): el ciclo de 33.**
```
para i en 0..33:
  id = rid(150 + i)
  { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL)
  await register(id, escrowState)          // <- el nº 33 (i = 32) es el que hoy revienta
  await release(id, escrowState, vault)
  await close(id, escrowState, vault)
  assert: entries.length <= 1              // al final de CADA ciclo
assert: el register nº 33 confirmó
```
Notas de implementación que te ahorran una tarde:
- `rid(seed)` sólo escribe `b[0] = seed`, así que **cada ciclo necesita un seed distinto** y el rango
  útil es 0..255. `150 + i` con `i` hasta 32 da 150..182, sin colisión con ningún otro test del
  archivo. (Igual, `beforeEach` crea un contexto bankrun nuevo por test, así que no hay colisión
  entre tests.)
- El reloj **no** se warpea en este test: los 33 deposits usan `nowTs + FIXTURE_TTL` (2 h), dentro de
  la ventana `[1 h, 24 h]`, y `release` exige `now < deadline`. No agregues `warpTo`.
- Las 33 txs tienen ids distintos ⇒ firmas distintas ⇒ bankrun no las deduplica. Si por algún motivo
  reusás un id, tenés que llamar `bumpSlot()` (E8) o la tx "pasa" sin ejecutarse.
- El índice se crea recién en el primer `register_escrow` (`init_if_needed`), no en el `deposit`.

**W0.3 — Escribí el test 12 (AC-1): la fuga básica.**
```
idA = rid(120); idB = rid(121)
depositar A y B, register A, register B      -> entries === [A, B]
release A
close A (con las 6 cuentas de hoy)
assert: entries === [B]                       <- HOY queda [A, B]
```

**W0.4 — Corré y capturá el rojo:**
```bash
anchor build
anchor test --skip-build --skip-deploy --skip-local-validator 2>&1 \
  | tee doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/w0-red.txt
```

**Sale con:** el archivo `w0-red.txt` conteniendo, literalmente:
- el test 14 fallando con **`EscrowIndexFull`** (código 6005) en el `register_escrow` nº 33;
- el test 12 fallando por aserción, con `entries` = `[A, B]` en vez de `[B]`;
- los otros **43** tests en verde (total esperado: 43 passing, 2 failing).

**Si el test 14 NO falla con `EscrowIndexFull`, PARÁ.** O el test no está haciendo lo que dice, o el
binario en `target/deploy/` no corresponde al fuente. Rebuildeá y volvé a mirar antes de seguir.

---

### W1 — El fix. `struct Close` + handler + los 3 helpers.

**Objetivo:** que los tests de W0 se pongan verdes y que los 7 rojos previstos vuelvan a verde.

**W1.1 — `programs/escrow/src/lib.rs:686` — agregar la cuenta al FINAL de `struct Close`,
después de `pub token_program: Program<'info, Token>,` (CD-15):**

```rust
/// <doc comment nuevo — ver requisitos abajo>
#[account(
    mut,
    seeds = [b"escrow-index", sender.key().as_ref()],
    bump = escrow_index.bump
)]
pub escrow_index: Option<Account<'info, EscrowIndex>>,
```

- `Option<Account<...>>`, **no** `Account<...>` obligatorio: para todo escrow que nunca se registró,
  esa cuenta **no existe**, y una cuenta obligatoria haría revertir `close` con 3012 para exactamente
  el camino que corre hoy en producción (AC-2).
- `bump = escrow_index.bump`, **no** `bump` a secas. Está medido: re-derivar cuesta
  `(255 − bump) × 1.500 − 20` CU de más, hasta **+7.480 CU** en el peor caso observado, y esa
  variación depende de qué sender sea. Además las otras cuatro cuentas sembradas del programa ya usan
  `bump = <acct>.bump` (`:583`, `:620`, `:655`, `:728`): usar `bump` acá sería la única excepción del
  archivo.
- **PROHIBIDO `init` / `init_if_needed`** (CD-13).
- El `///` de esta cuenta es la **única excepción a CD-6**. Ya está decidido: va con `///` porque el
  hash se mueve igual por la cuenta, el precedente `sender_ata` (E3) ya lo hace así, y el lector que
  necesita esta advertencia está del otro lado del IDL (quien escriba WKH-327 leyendo el IDL
  vendoreado). **Contenido obligatorio del doc comment**, en tus palabras:
  1. la cuenta es **opcional**;
  2. se omite pasando **`null` explícito**; dejar la clave afuera del objeto **NO la omite** — el
     cliente deriva la PDA desde las seeds del IDL y la manda igual, y la tx revierte con
     `AccountNotInitialized` (3012);
  3. **omitirla cuando el índice SÍ existe deja la entrada colgada** y el cap vuelve a ser monótono;
  4. la regla para el cliente: pasarla si la PDA `["escrow-index", sender]` existe (un
     `getAccountInfo`), omitirla si no.
  Sin promesas universales; cada frase tiene que ser falsable con un input concreto.

**W1.2 — `programs/escrow/src/lib.rs:333` — agregar al FINAL del cuerpo del handler `close`**,
después de `anchor_spl::token::close_account(cpi_ctx)?;` y del comentario de `:334`, antes de `Ok(())`:

```rust
if let Some(index) = ctx.accounts.escrow_index.as_mut() {
    index.entries.retain(|e| *e != remittance_id);
}
```

- **Al final, no antes.** El orden dentro del cuerpo es indistinto para la atomicidad (una tx que
  revierte no escribe nada), pero ponerlo al final deja el bloque de CPIs existente sin tocar y por
  lo tanto el diff es legible. Los constraints del Context — incluido `is_terminal()` — corren
  **antes** de todo el cuerpo, y eso es lo que hace verdadero AC-6.
- **Misma expresión que E2**, literal. No la "mejores".
- **PROHIBIDO** unificarlo con el `retain` de `deregister_escrow` en un helper (CD-16).
- Comentarios que agregues acá: `//`, no `///` (CD-6).

**W1.3 — `tests/escrow.ts`: agregar `escrowIndex: null,`** a los dos `.accountsPartial({...})` de
`close`, después de `tokenProgram: TOKEN_PROGRAM_ID,`:
- `:507-514` (test 7)
- `:544-551` (test 8)

**W1.4 — `tests/escrow-window.ts:270-287`: el helper `close` toma un 4º parámetro.**
```ts
function close(
  remittanceId: Uint8Array,
  escrowState: PublicKey,
  vault: PublicKey,
  escrowIndex: PublicKey | null = null   // default null: el caso de producción (sender sin índice)
) {
  return program.methods
    .close(Array.from(remittanceId))
    .accountsPartial({
      ...,
      tokenProgram: TOKEN_PROGRAM_ID,
      escrowIndex,                        // SIEMPRE presente la clave (CD-14)
    })
    ...
}
```
Los 5 call sites (`:669`, `:699`, `:715`, `:836`, `:846`) **no se tocan**: heredan el default.

**W1.5 — `tests/escrow-index.ts`: el helper `close` de W0.1 toma el mismo 4º parámetro**, mismo
default `null`. A partir de acá **todo** `.close(` del repo lleva la clave `escrowIndex` (CD-14).

> Nota de tipos: `tsconfig.json` de este repo no tiene `strict`, así que `null` es asignable sin
> ceremonia. Si aun así TypeScript rechaza `escrowIndex: null`, **escalá** — no lo resuelvas
> omitiendo la clave (eso viola CD-14 y desactiva AC-2).

**Verificación de W1:**
```bash
anchor build
anchor test --skip-build --skip-deploy --skip-local-validator
```
**Sale con:** 45 passing, 0 failing (43 baseline + los 2 tests nuevos de W0). Los 7 de la sección 2.3
en verde. Ningún test de `deposit`, `release`, `refund`, `register_escrow` o `deregister_escrow`
movido — ésa es la comprobación de runtime de CD-5.

Verificación adicional de CD-15, sin escribir un test todavía:
```bash
node -e 'const i=require("./target/idl/escrow.json");const c=i.instructions.find(x=>x.name==="close");console.log(c.accounts.map(a=>a.name).join(" | "));console.log("disc:",JSON.stringify(c.discriminator));console.log("n ix:",i.instructions.length)'
```
Esperado exacto:
```
sender | mint | escrow_state | vault | sender_ata | token_program | escrow_index
disc: [98,165,201,177,108,65,206,96]
n ix: 6
```

---

### W2 — Adversariales

**Objetivo:** los caminos de atacante, los estados no terminales, y el footgun de CD-14 ejecutable.

**Archivo:** `tests/escrow-index.ts`. Tests **13, 13b, 15, 16, 17, 18** (ver sección 8).

**Verificación:**
```bash
anchor build && anchor test --skip-build --skip-deploy --skip-local-validator
```
**Sale con:** 51 passing, 0 failing. AC-2, AC-4, AC-5, AC-6, AC-7 cubiertos.

---

### W3 — No-regresión de interfaz

**Objetivo:** pinnear la interfaz localmente y confirmar contra los dos consumidores, **en modo
lectura**.

**W3.1 — Tests 19, 20 y 21 en `tests/escrow-index.ts`** (ver sección 8).

**W3.2 — Correr los tests de pin de los dos consumidores. SE CORREN, NO SE EDITAN (CD-2).**
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npx vitest run contracts/idl/escrow-idl.hash.test.ts 2>&1 | tee /tmp/chaski-pin.txt

cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
npx vitest run src/chains/escrow-idl.hash.test.ts 2>&1 | tee /tmp/facilitator-pin.txt
```

**Resultado esperado, verificado leyendo los dos archivos el 2026-08-05:**

| Repo | Test | Línea | Esperado |
|---|---|---|---|
| `chaski-v3` | `AC-2: canonicalSha256(escrowIdl) == constante pinneada` | `:26-28` | **VERDE** — compara el IDL **vendoreado** (`src/infrastructure/solana/escrow-idl.ts`), que esta HU no toca |
| `chaski-v3` | `AC-3: coincide con solana-programs (sibling)` | `:32-35` | **ROJO** — lee `../solana-programs/target/idl/escrow.json`, o sea el artefacto que acabás de regenerar |
| `chaski-v3` | `AC-R2b-2: el address del IDL sigue siendo DR5G` | `:39-41` | **VERDE** |
| `chaski-v3` | `AC-R2b-3/4: deposit y refund intactos + register_escrow con sus 4 cuentas` | `:45-95` | **VERDE** — ninguna de las tres cambia |
| `wasiai-facilitator` | `AC-2: el IDL vendoreado canonicaliza al hash pinneado` | `:33-35` | **VERDE** — mismo motivo |
| `wasiai-facilitator` | `AC-R2a-2: el address del IDL sigue siendo el program deployado` | `:39-42` | **VERDE** |
| `wasiai-facilitator` | `R2a: 6 instrucciones y los discriminadores de R1` | `:46-79` | **VERDE** — Anchor hashea el **nombre** de la instrucción, no su lista de cuentas, así que el disc de `close` no se mueve |
| `wasiai-facilitator` | `AC-3: coincide con solana-programs (fuente de verdad)` | `:82-85` | **ROJO** |

> **Delta respecto de lo que dice el SDD §4.3.** El SDD escribió "el único `expect` que se pone rojo
> es el de la constante del hash". Leyendo los dos archivos, eso es **impreciso**: el `expect` de la
> constante (AC-2, en los dos repos) compara contra el IDL **vendoreado**, que esta HU no regenera,
> así que **queda VERDE**. El que se pone rojo es el `AC-3` sibling, que lee
> `path.resolve(process.cwd(), "../solana-programs/target/idl/escrow.json")` — y en este workspace
> `solana-programs` **sí** es hermano de los dos repos, así que ese test **corre** (no cae en el
> `it.skip`). Refutable en un comando: `grep -n "canonicalSha256(escrowIdl)" ` en cada archivo
> muestra que el argumento es el import local, no el sibling.
>
> **Total esperado: exactamente 1 test rojo por repo, y es el sibling.** Cualquier otro rojo — en
> particular un rojo en un pin de lista de cuentas o de discriminador — **contradice la medición de
> F2 y es un hallazgo: PARÁ y reportá.**

**PROHIBIDO** re-pinnear `ESCROW_IDL_SHA256`, tocar `CONTRACT-VERSIONS.md`, o regenerar los IDL
vendoreados. Ese rojo es correcto y se resuelve en la HU de deploy.

**Sale con:** 54 passing en `solana-programs`, 0 failing. Las dos salidas de consumidores guardadas
como evidencia. AC-8, AC-9, CD-15.

---

### W4 — Mutación (CD-8)

**Objetivo:** romper el guard nuevo de cinco formas y registrar qué test mata cada una.

**Protocolo completo, por cada mutante. No es negociable.**

```bash
# ANTES DE EMPEZAR: guardá los md5 de referencia
md5sum target/deploy/escrow.so target/idl/escrow.json programs/escrow/src/lib.rs > /tmp/wkh326-md5-ref.txt
cp programs/escrow/src/lib.rs /tmp/wkh326-lib.rs.bak

# --- por cada mutante MNN ---
# 1. romper UN guard en programs/escrow/src/lib.rs
anchor build                                                     # REBUILD, o probás el binario anterior
anchor test --skip-build --skip-deploy --skip-local-validator    # anotá QUÉ tests murieron, por nombre
# 2. restaurar el fuente
cp /tmp/wkh326-lib.rs.bak programs/escrow/src/lib.rs
anchor build                                                     # REBUILD OTRA VEZ, o la próxima corrida te miente
anchor test --skip-build --skip-deploy --skip-local-validator    # TIENE que volver al baseline de W3
```

**Verificación de la restauración — verificar, no asumir** (esto es lo que F2 hizo en su spike y por
eso pudo afirmar que el árbol quedó limpio):
```bash
md5sum target/deploy/escrow.so target/idl/escrow.json programs/escrow/src/lib.rs
diff <(md5sum target/deploy/escrow.so target/idl/escrow.json programs/escrow/src/lib.rs) /tmp/wkh326-md5-ref.txt \
  && echo "RESTAURADO OK" || echo "NO VOLVIÓ — PARAR"
```
Los tres md5 tienen que volver a su valor de referencia (el de después de W3, no el del arranque).
**Si no vuelven, PARÁ.** Un binario mutado que se queda en `target/deploy/` hace que todo lo que
corras después sea mentira. Este repo se comió eso dos veces.

**Los 5 mutantes:**

| # | Mutante | Qué rompe | Test que lo tiene que matar |
|---|---|---|---|
| **M15** | `close`: el `retain` borrado (cuerpo del `if let Some` vacío) | el fix entero: vuelve el bug original | **12** (AC-1: `entries` queda `[A,B]` en vez de `[B]`) **y 14** (AC-3: el 33º vuelve a `EscrowIndexFull`) |
| **M16** | `close`: `retain(\|e\| *e != remittance_id)` → `retain(\|e\| *e == remittance_id)` | **borra la entrada equivocada**: conserva sólo la que había que sacar | **12** (`entries` queda `[A]` en vez de `[B]`) |
| **M17** | `close`: el `retain` → `entries.clear()` | borra TODAS las entradas del sender, no la del escrow que cierra | **12** (`entries` queda `[]`) **y 18** (AC-7: el índice de B se vacía) |
| **M18** | `close`: `if let Some(index) = …` → `let index = ctx.accounts.escrow_index.as_mut().unwrap()` | rompe la opcionalidad: panic cuando la cuenta se omite | **13** (AC-2: `deposit→release→close(null)` deja de confirmar) |
| **M19** | `Close`: se le sacan `seeds` y `bump` a la cuenta `escrow_index` | **mata el guard de ownership**: el atacante puede pasar el índice de cualquiera | **15** (AC-4: deja de revertir `ConstraintSeeds` y el índice de la víctima se modifica) |

**M16 y M19 son los dos que importan de verdad, por motivos opuestos:** M16 es el bug silencioso (la
tx confirma, la contabilidad queda mal) y M19 es el agujero de seguridad (la tx confirma, la
contabilidad de **otro** queda mal). Un test que sólo mire "el close confirmó" no mata a ninguno de
los dos — por eso 12 y 15 asertan el **contenido** de `entries` y no sólo el éxito.

**Si un mutante SOBREVIVE:** hay precedente en el mismo archivo (M12, `doc/mutation-run.md:34-45`).
Tenés que decidir y **escribir el argumento**: ¿es un hueco de cobertura (⇒ falta un test) o es una
expresión equivalente (⇒ ningún input las distingue)? **Registrar un `SURVIVED` sin explicación es
peor que no correrlo, porque parece cobertura.**

**Entregable:** `doc/mutation-run.md` con las filas M15..M19 apendizadas a la tabla (mismo formato de
`:17-32`) y una nota que diga contra qué baseline se corrió y que la restauración se verificó por md5.

---

### W5 — Documentación y hash final

**Objetivo:** que el repo deje de describir el defecto como abierto, y registrar el sha256 nuevo sin
re-pinnear a nadie.

**W5.1 — `programs/escrow/src/lib.rs:377-396`.** Ese bloque `//` describe el bug como no resuelto
("Cómo arreglarlo es una decisión de diseño que NO está tomada"). Reescribilo: `close` ahora saca la
entrada cuando se le pasa el índice; el cap dejó de ser monótono; y lo que sigue en pie es que si el
sender nunca llama `close`, el cupo tampoco se libera, y que `deregister_escrow` sigue siendo la
única salida para entradas cuyo `EscrowState` ya fue cerrado antes de este cambio.
**Comentarios `//`, nunca `///` (CD-6).**

**W5.2 — `programs/escrow/src/lib.rs:411-412`.** El comentario del campo `entries` dice que los ids
"ahí se quedan, terminales o no, hasta un `deregister_escrow` explícito". Ya no es cierto. `//`.

**W5.3 — `programs/escrow/src/lib.rs:397-399`** (el doc comment `///` de `MAX_ENTRIES`): **NO SE
TOCA.** Es uno de los tres doc comments falsos que el README lista, y se corrigen la próxima vez que
se republique el IDL en cadena, o sea en la HU de deploy. Corregirlo acá lo dejaría en un hash
intermedio que nunca se publica: más diff, cero ganancia.

**W5.4 — `README.md`:**
| Línea | Qué |
|---|---|
| `:285` | fila de `close` en la tabla de Instructions: suma "removes the id from the sender's index when the optional account is passed" a Effect, y la cuenta opcional a Guards |
| `:453-459` | invariante 9 ("The index is writable only by its owner"): ahora son **tres** instrucciones las que la escriben, y en las tres el guard sigue siendo las seeds + el `Signer`. Nombrar el test que lo cubre (15) |
| `:468-473` | invariante 11 ("The index is bounded and idempotent"): la cota deja de ser monótona; nombrar el test 14 |
| `:607-623` | "The index fills up with finished escrows": reescribir. Decir qué se resolvió **y qué no** (si el sender no llama `close`, no se libera) |
| `:244-276` | "Recovering an escrow whose id was lost": el párrafo de `:256-263` afirma que "`release`, `refund` and `close` do not touch the index" — ya es falso para `close` |
| `:987-1002` | "The account list of `close` has no safe deployment order": ahora suma una **segunda** cuenta nueva. El grep de consumidores se re-corrió el 2026-08-05 y sigue dando cero builders de `close` |

**Regla de redacción del repo:** prosa falsable. Cada afirmación con el input concreto que la
refutaría. Una frase que promete una propiedad universal hace que nadie vuelva a mirar ahí.

**W5.5 — Registrar el sha256 final:**
```bash
anchor build
python3 -c "
import json,hashlib
d=json.load(open('target/idl/escrow.json'))
print(hashlib.sha256(json.dumps(d,sort_keys=True,separators=(',',':')).encode()).hexdigest())
"
```
> Si esa canonicalización no reproduce `fb64c937…` sobre el IDL **de main** (probalo primero con
> `git stash` o contra una copia), **no es la canonicalización correcta**: usá
> `chaski-v3/contracts/idl/canonical-hash.ts` en modo lectura para calcularlo. **PARÁ y reportá**
> antes de registrar un número que no sabés reproducir.

El hash se escribe **sólo** en la evidencia de esta HU
(`doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/`). **CD-17: PROHIBIDO ponerlo en ningún otro
archivo, y prohibido re-pinnearlo en los consumidores.** El del spike de F2 (`cedfddd4…`) **NO es el
final** — se midió sin el `///` de W1.1 y sin los comentarios de W5.

**Verificación final:**
```bash
anchor build
cargo clippy --all-targets -- -D warnings
anchor test --skip-build --skip-deploy --skip-local-validator
git status --short          # sólo archivos de la tabla de la sección 5
```

---

## 8. Los 13 tests — archivo, numeración y forma de refutación

Todos en `tests/escrow-index.ts` salvo donde diga otra cosa. Numeración a partir del 11 actual.
**Todo test de revert usa `expectRevert` de `:328-350`, que pinnea el código exacto.** "Tira algo" no
cuenta: D2 es la prueba viva de que sin el pin del código un guard se enmascara.

| # | Test | AC | Wave | Qué asserta y **con qué input se pone rojo si el fix está mal** |
|---|---|---|---|---|
| **12** | `close saca exactamente la entrada del escrow que cierra y deja el resto en orden` | AC-1 | **W0** | Registrar A y B en ese orden, releasear A, cerrar A con el índice. `entries` **exactamente `[B]`**. **Rojo si:** queda `[A,B]` (el retain no corrió), `[]` (borró todo), o `[B,A]` (reordenó). |
| **13** | `close sin índice: escrowIndex=null, la tx confirma y NO se crea la cuenta` | AC-2 | W2 | `deposit → release → close(escrowIndex: null)` **sin llamar nunca a `register_escrow`**. Dos aserciones: la tx confirma **y** `banksClient.getAccount(indexPda(sender))` sigue `null`. **Rojo si:** revierte con 3012 (la cuenta quedó obligatoria) **o** la cuenta existe después (alguien puso `init_if_needed` y le cobró 4.774.560 lamports por una cuenta vacía). |
| **13b** | `omitir la clave NO omite la cuenta: el cliente resuelve la PDA y la tx revierte 3012` | AC-2 bis / CD-14 | W2 | Armar `close` **sin** la clave `escrowIndex`, con `.instruction()`. Asertar que `ix.keys[6].pubkey` **es `indexPda(sender)` y NO el `programId`**, y que la tx revierte con `AccountNotInitialized`. **Rojo si:** `keys[6]` es el programId — significaría que el cliente sí omitió, y entonces CD-14 sería innecesaria y hay que revisar la regla. Es el único test que deja el footgun **ejecutable** en vez de en prosa. |
| **14** | `33 ciclos deposit→register→release→close con el MISMO sender` | AC-3 | **W0** | 33 ciclos; el `register_escrow` nº 33 confirma y `entries.length ≤ 1` al final de **cada** ciclo. **Rojo si:** el 33º revierte con `EscrowIndexFull` (6005) — que es exactamente lo que tiene que pasar en W0 contra el binario de hoy. |
| **15** | `close con el índice de la VÍCTIMA revierte ConstraintSeeds y no lo toca` | AC-4 | W2 | El atacante cierra un escrow **propio y terminal** pasando `indexPda(sender)`. Revierte con `ConstraintSeeds` **exacto** y el índice de la víctima queda idéntico entrada por entrada. Espejo de 4c (`:559-573`). **Rojo si:** revierte con otro código (el guard es otro), o si confirma, o si `entries` de la víctima cambió. El atacante está fondeado en `beforeEach` (`:374`) **a propósito**: así una falla es un guard, no falta de lamports. |
| **16** | `close con índice no mueve ni un token de más` | AC-5 bis | W2 | Mismo escenario que 12, midiendo los cuatro balances (vault A, vault B, `senderAta`, `beneficiaryAta`) antes y después con `tokenBalance` (`-1n` = cuenta cerrada). Espejo de lo que ya hace el test 7 para `deregister_escrow` (`:640-654`). **Rojo si:** cualquiera de los cuatro deltas difiere del esperado. |
| **17** | `close en estado Deposited revierte EscrowNotTerminal y el índice queda intacto` | AC-6 | W2 | `deposit → register_escrow → close(con índice)` antes del deadline. **Dos** aserciones obligatorias: código `EscrowNotTerminal` (6004) **y** `entries === [id]` después. **Rojo si:** falta la segunda — es la que detecta que alguien mueva el `retain` a un lugar donde corra antes del constraint. |
| **18** | `close con un índice que no contiene el id confirma y deja entries igual` | AC-7 | W2 | `deposit(A) → deposit(B) → register(B) → release(A) → close(A, con el índice)`. La tx **confirma** (no revierte) y `entries` sigue `[B]`. **Rojo si:** revierte — sería una regresión respecto de la idempotencia que `retain` ya garantiza (`lib.rs:368`). |
| **19** | `el IDL construido declara 6 instrucciones, los 6 discriminadores de siempre, y escrow_index en close` | AC-8 | W3 | Contra `target/idl/escrow.json` importado **directo** (`:27`, nunca con `existsSync`): (i) `instructions.length === 6` y los 6 nombres; (ii) los 6 discriminadores, con `close` en `[98,165,201,177,108,65,206,96]`; (iii) `close.accounts.map(a=>a.name)` **termina en** `token_program, escrow_index` (CD-15) y ese último tiene `optional === true`. **Rojo si:** aparece una 7ª instrucción, o si `escrow_index` no quedó última, o si algún disc se movió. |
| **20** | `las otras 5 instrucciones conservan cuentas, args y discriminador` | AC-9 | W3 | Pin **local** por posición: `deposit` (8 cuentas), `release` (8), `refund` (7), `register_escrow` (4), `deregister_escrow` (2), con sus discriminadores. **Por qué acá y no sólo en los consumidores:** hoy AC-9 depende de correr tests de otros dos repos, y un test que necesita otro repo montado es un test que se salta solo el día que no lo esté. Leé los valores del IDL **construido de main** antes de W1, no de la memoria. |
| **21** | `computeUnitsConsumed de close, con índice y sin índice` | CU | W3 | Arma las dos formas con `.instruction()` y las manda con `processIxs` (`:72-80`), que devuelve el `meta`. Reporta los dos números por consola y asserta `< CU_REGRESSION_GUARD` (`300_000`, la constante de `:47`). **Obligatorio:** el mismo tipo de nota que T11 (`:725-731`) diciendo que **el número NO es constante** — se mueve 1.500 CU por cada paso del bump canónico por debajo de 255. Referencia medida en F2 sobre 16 senders deterministas: peor `close` observado **28.643 CU**, contra el límite por defecto de 200.000 de una tx. |
| **D1 / D1b** | (existentes) `dust ... swept to the sender` | AC-5 | W1 | `tests/escrow-window.ts:646` y `:677`. **En W1 se cambia la lista de cuentas del helper y NADA MÁS.** Si necesitás relajar una aserción de D1 o D1b para que pasen, eso es un **hallazgo**, no un ajuste: PARÁ y reportá. |
| **pins de consumidores** | (existentes, modo LECTURA) | AC-9 | W3 | `chaski-v3/contracts/idl/escrow-idl.hash.test.ts` y `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts`. **Se corren, no se editan (CD-2).** Esperado: exactamente 1 rojo por repo, el `AC-3` sibling. Cualquier otro rojo es un hallazgo. |

**Conteo final esperado de la suite de `solana-programs`: 54 passing, 0 failing**
(43 baseline + 12, 13, 13b, 14, 15, 16, 17, 18, 19, 20, 21 = 11 nuevos).

---

## 9. Cómo se ve que salió bien

Cinco cosas, todas verificables con un comando o una aserción:

1. **El ciclo de 33 en verde.** El test 14 pasa contra el binario final, y su versión roja de W0 está
   guardada en `w0-red.txt` con el `EscrowIndexFull` / 6005 literal.
2. **Los 7 rojos de la sección 2.3 de vuelta en verde**, y **ninguno** por relajación de aserciones:
   el único cambio en `escrow.ts` y `escrow-window.ts` es la lista de cuentas del `close`.
   Verificable: `git diff tests/escrow.ts tests/escrow-window.ts` sólo muestra líneas de cuentas.
3. **La interfaz quedó donde tiene que quedar:**
   ```
   close.accounts[5].name === "token_program"
   close.accounts[6].name === "escrow_index"   &&   close.accounts[6].optional === true
   instructions.length === 6
   close.discriminator === [98,165,201,177,108,65,206,96]
   ```
   y los discriminadores de `deposit`, `release`, `refund`, `register_escrow`, `deregister_escrow`
   **intactos**.
4. **Los 5 mutantes M15..M19 registrados en `doc/mutation-run.md`** con qué test mató a cada uno, y
   los md5 de `target/deploy/escrow.so` y `target/idl/escrow.json` de vuelta en su valor post-W3
   (verificado con `diff`, no asumido).
5. **El sha256 nuevo REGISTRADO en la evidencia de la HU y en ningún otro lado.** Cero re-pins.
   `git status` de `chaski-v3` y de `wasiai-facilitator` **limpio**:
   ```bash
   cd /home/ferdev/.openclaw/workspace/chaski-v3 && git status --short
   cd /home/ferdev/.openclaw/workspace/wasiai-facilitator && git status --short
   ```
   Cualquier archivo modificado ahí es una violación de CD-2.

---

## 10. Qué NO es tu trabajo

| Cosa | Por qué no | Quién |
|---|---|---|
| **Cualquier deploy** | Irreversible; lo autoriza el founder aparte (CD-1) | HU de deploy |
| Republicar el IDL on-chain (cuenta `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC`) | Va con el deploy | HU de deploy |
| **Re-pinnear `ESCROW_IDL_SHA256`** en `chaski-v3` (`contracts/idl/escrow-idl.hash.test.ts:22` + `contracts/CONTRACT-VERSIONS.md`) y en `wasiai-facilitator` (`src/chains/escrow-idl.hash.test.ts:30`) | Se pinnea el hash **final**, una sola vez (CD-2, CD-17). El rojo del sibling es esperado | HU de deploy |
| Regenerar los IDL vendoreados de los consumidores | Idem | HU de deploy |
| **R4** (el cliente que llamaría `register_escrow`) | Otra HU, en `chaski-v3`. Ésta la habilita; R4 **no debe desplegarse antes** que ésta | otra HU |
| **WKH-327** (el cliente que construye `close` y recupera el rent) | Otra HU, en `chaski-v3`. Se construye contra la lista de cuentas **post-326** | otra HU |
| **Los tres doc comments falsos que lista `README.md:32`** (`lib.rs:30-32`, `:514-518`, `:397-399`) | Se corrigen cuando se republique el IDL, o sea en el deploy. Acá quedarían en un hash intermedio que nunca se publica | HU de deploy |
| Una instrucción que cierre el `EscrowIndex` y recupere sus 4.774.560 lamports | No existe (`README.md:625-628`). `close` recupera el rent de `EscrowState` + vault (4.002.000), **no** el del índice | otra HU |
| Subir `MAX_ENTRIES` | Correr la pared no la resuelve, y agranda una cuenta cuyo rent no se recupera (CD-7) | descartado |
| Payout freeze / `PayoutPending` / `begin_payout` / `abort_payout` | Bloqueado por trabajo previo en los dos consumidores (`README.md:499-508`) | otra HU |
| Emisión de eventos | No existe hoy. Su **deploy** se agrupa con el de esta HU | otra HU |
| `cargo fmt` | El árbol no pasa `--check` a propósito (CD-12) | nadie |
| Verificar si hay `EscrowIndex` vivos en devnet | No se puede sin tocar la cadena. Es insumo de la HU de deploy, que corre `scripts/list-live-escrows.py` primero | HU de deploy |
| El drift de `rustc` (el entorno tiene 1.97.1, `rust-toolchain.toml` pinnea 1.89.0) | Ajeno a WKH-326. F2 verificó que el artefacto sale byte-idéntico igual, pero **no se investigó** si el toolchain se está respetando | reportado al humano |

---

## 11. Lo que no se pudo medir en F2 — dicho con esas palabras

1. **El sha256 final del IDL no está medido, y no podía estarlo en F2.** El del spike es
   `cedfddd46bdc77669b4a46fc2636e9c345995fac9bf554b0929bc40b7ad7e1ea`, medido **sin** el `///` de
   W1.1 y sin los comentarios de W5. **Lo mide W5.5.**
2. **El costo marginal exacto del índice dentro de `close` no quedó aislado.** Lo que hay es una cota
   sucia (953…6.970 CU) que compara escrows **distintos**, con bumps distintos. **Lo reporta el test
   21 sobre el binario final.** No es bloqueante: el peor `close` completo observado (30.154 CU) está
   al 15 % del límite por defecto de 200.000.
3. **F2 no corrió las suites de `chaski-v3` ni de `wasiai-facilitator`.** La predicción de la sección
   7/W3.2 sale de **leer** esos tests. **Las corre W3.** Si aparece un rojo que no sea el sibling,
   contradice la medición del IDL y hay que parar.
4. **No hay Auto-Blindaje histórico que heredar.** `doc/sdd/_INDEX.md` lista 001 y 002 pero sus
   carpetas no están en el árbol (`ls doc/sdd/` devuelve sólo `003-…`). Lo más cercano que sí existe
   y sí se aplicó es `doc/mutation-run.md:9-15`: el error que este repo cometió **dos veces** —
   correr la suite contra un binario que no corresponde al fuente. De ahí salen CD-11 y el protocolo
   de md5 de W4.

---

## 12. Escalation Rule

**Si algo no está en este Story File, PARÁS y escalás al Architect. No inventás. No asumís. No
improvisás.**

Escalá inmediatamente si:
- El test 14 de W0 **no** falla con `EscrowIndexFull` contra el binario de hoy.
- TypeScript rechaza `escrowIndex: null` (**no** lo resuelvas omitiendo la clave — eso viola CD-14).
- Aparece un rojo en los consumidores que **no** sea el `AC-3` sibling.
- Necesitás relajar una aserción de D1, D1b, D2, E2 o E3 para que pasen.
- Un mutante sobrevive y no podés argumentar si es equivalente o es un hueco.
- Los md5 no vuelven después de restaurar un mutante.
- Necesitás tocar un archivo que no está en la tabla de la sección 5.
- La canonicalización del hash no reproduce `fb64c937…` sobre el IDL de main.
- Cualquier cosa te empuja a desplegar, a tocar devnet, o a escribir en otro repo.

---

*Story File generado por NexusAgil — F2.5 · Architect · 2026-08-05*
