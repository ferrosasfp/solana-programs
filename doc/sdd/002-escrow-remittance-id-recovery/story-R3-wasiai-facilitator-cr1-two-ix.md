# Story File — R3 · CR-1 acepta la tx atómica de 2 business-ix (`deposit` + `register_escrow`)

> **REPO: `wasiai-facilitator`** (`/home/ferdev/.openclaw/workspace/wasiai-facilitator`)
> SDD: `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` (§4.8 DT-7 variante **B1**, §5 paso R3, gate **G4**)
> HU: **HU-SOL-20** · Fecha: 2026-07-28 · Wave de release: **R3**
> Branch sugerida: `feat/hu-sol-20-r3-cr1-two-business-ix`

---

## ⚠️ 0. Este story toca el núcleo anti-drenaje. Leelo entero antes de escribir una línea.

`validateDepositForSponsor` (CR-1) es **lo único** que impide que el fee-payer del facilitator firme
un blob opaco y se vacíe la wallet. Su propio archivo lo dice en `src/methods/solana-sponsor/cr1.ts:10-13`:

> «⚠️ VECTOR ESTRELLA: a fee-payer that signs an opaque blob drains its own wallet. Every check here
> is fail-closed (CD-3): any deviation, and any thrown exception, returns `{ ok:false }` WITHOUT
> signing. When in doubt, reject.»

Por eso este story:
- va **aislado**, sin ninguna otra tarea mezclada;
- tiene su **propio Adversarial Review** (gate **G4** del SDD §10), separado del AR del programa;
- es **el único story de la HU que puede tocar `cr1.ts`**;
- deja el camino de **1 business-ix byte-idéntico**, con todos sus checks intactos.

Si te encontrás relajando, moviendo o "simplificando" un check existente ⇒ **STOP y escalá.** La
extensión es **aditiva**: una rama nueva para el caso de 2 ix, con un allowlist estricto.

---

## 1. Prerequisitos y orden

### Qué tiene que estar mergeado ANTES

1. **R1** (`solana-programs`) — para tener el **discriminador real** de `register_escrow` y el orden
   real de sus 4 cuentas. Sin eso pinearías un valor inventado.
2. **R2a** (este repo) — el escritor de este repo va en serie; R2a re-vendorea el IDL y re-pinea el
   hash. R3 se despacha después.
3. **R0** (`chaski-v3`) — orden del release.

También necesitás, del reporte de R1: el **CU medido** (test T11) de una tx con `deposit` +
`register_escrow` en una sola transacción.

### Daño concreto si se hace al revés (copiado del SDD §5)

- **R4 antes de R3** (el cliente emitiendo la tx de 2 ix antes de que CR-1 la acepte) ⇒ CR-1 responde
  **`NOT_EXACTLY_ONE_BUSINESS_IX`** ⇒ el facilitator **no co-firma** ⇒ **no hay depósito**.
  Fail-closed (no se pierde plata) **pero el money-path queda caído**: ninguna remesa Solana puede
  entrar en custodia mientras dure el desfase.
- **R3 sin aceptar también la forma de 1 ix** ⇒ **rompés a todos los clientes viejos**: cualquier
  bundle JS cacheado que mande la tx de 1 ix es rechazado ⇒ mismo efecto, money-path caído. Por eso
  CR-1 debe aceptar **1 o 2**, nunca "solo 2".
- **R3 antes de R1** ⇒ pinearías un discriminador que no corresponde a ninguna instrucción
  deployada: CR-1 aceptaría una tx que la cadena rechaza, o rechazaría la legítima. Fail-closed, pero
  inútil.

### Qué habilita

**R4** (`chaski-v3`): emitir la tx atómica. R4 **no puede** mergearse antes de que R3 esté
**deployado** (no solo mergeado) en el facilitator.

---

## 2. Goal y por qué B1 y no B2 (decisión del founder, ya tomada — no se re-litiga)

La tx de `deposit` de Chaski **no la broadcastea el cliente**: la arma y la partial-firma el browser
(`chaski-v3/src/infrastructure/solana-wallet.ts:135-144`), la manda a
`chaski-v3/app/api/settle/solana-sponsor/route.ts:57-69`, y de ahí al facilitator
(`src/routes/solana-sponsor.ts:148-152`), que la valida con CR-1, **co-firma y broadcastea**. El
`feePayer` es el facilitator: el usuario **no paga gas**.

Para que el índice del escrow se escriba, `register_escrow` tiene que viajar en esa misma tx. Y CR-1,
hoy, la rechaza: `cr1.ts:80-82` exige **exactamente una** instrucción de negocio.

**Se eligió B1 (una tx atómica) y se descartó B2 (una segunda tx firmada y pagada por el sender), por
dos razones:**

1. **B2 exige que el usuario tenga SOL, y toda la premisa del diseño es que NO lo tiene.** Por eso el
   facilitator es el fee-payer (sponsor gasless). B2 no es "menos elegante": **no funciona para el
   flujo principal**.
2. Un índice best-effort repite el error del `localStorage`: si la segunda escritura falla, la llave se
   vuelve a perder. El bug que esta HU arregla nació exactamente así.

Costo aceptado: tocar el núcleo anti-drenaje ⇒ este story aislado + AR propio (G4).

---

## 3. Acceptance Criteria

- **AC-R3-1**: CR-1 acepta una tx con **exactamente 2** business-ix cuando `ix[0]` es el `deposit`
  válido de siempre **y** `ix[1]` es `register_escrow` del **mismo** programa, con el discriminador
  pineado, exactamente 4 cuentas con los flags exactos, y **atado** al `deposit` (mismo `sender`,
  mismo `escrow_state`, mismo `remittance_id`).
- **AC-R3-2**: CR-1 **sigue aceptando** la forma de **1** business-ix, byte-idéntica (compatibilidad
  con clientes viejos durante toda la ventana).
- **AC-R3-3**: CR-1 rechaza, sin firmar, cualquier 2ª ix que no sea **exactamente** ese
  `register_escrow`: otro programa, otro discriminador, cuentas de más/de menos, flags distintos,
  `system_program` distinto, o no atada al `deposit`.
- **AC-R3-4** (**CD-10, intocable**): el Check 5 (`cr1.ts:175-186`, el fee-payer no puede aparecer en
  NINGUNA instrucción) queda **sin modificar** y sigue cubriendo también la 2ª ix.
- **AC-R3-5**: 0 o ≥3 business-ix siguen rechazando con el **mismo** enum
  `NOT_EXACTLY_ONE_BUSINESS_IX` (los tests T4a/T4b existentes no se editan).

---

## 4. Scope IN — archivos exactos (verificados contra disco el 2026-07-28)

| # | Archivo | Acción | Qué hacer |
|---|---------|--------|-----------|
| 1 | `src/methods/solana-sponsor/deposit-shape.ts` (63 líneas) | Modificar | **Solo agregar** constantes nuevas al final (§5.1). Las existentes (`DEPOSIT_DISCRIMINATOR` `:25`, `DEPOSIT_POSITIONAL_ACCOUNTS = 8` `:51`, `DEPOSIT_ACCOUNT_INDEX` `:54-63`, los 4 program ids) **no se tocan**. |
| 2 | `src/methods/solana-sponsor/cr1.ts` (201 líneas) | Modificar | Dos cambios quirúrgicos: (a) línea **80** ⇒ aceptar 1 **o** 2; (b) **Check 4b nuevo** entre el final del Check 4 (`:173`) y el Check 5 (`:175`). Nada más. |
| 3 | `src/__tests__/unit/solana-sponsor.cr1.test.ts` (303 líneas) | Modificar | Agregar los vectores T-R3-* (§6). **Los 16 `it` existentes no se editan.** |

### Fuera de scope (PROHIBIDO)

- **`src/infra/env.ts`**: **NO** cambiar `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` (`:212`, default 300000)
  ni `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` (`:216`, default 100000). Se **compara** contra el CU medido en
  R1/T11 y se **reporta** (§7). Cambiar un cap de dinero es una decisión de ops del founder, no un
  efecto colateral de un story de validación.
- `src/routes/solana-sponsor.ts` — el wiring de `:148-152` ya es correcto y no requiere cambio.
- `src/methods/solana-sponsor/broadcast.ts` — verificado: `parseSponsorTx` (`:96-118`) no impone
  límite de instrucciones ni de tamaño; solo rechaza tx **versionadas** (`:113-115`). Sin cambios.
- `src/chains/escrow-idl.ts` y su hash test ⇒ eso fue **R2a**.
- Cualquier archivo de `chaski-v3` o `solana-programs`. **Lectura sí, escritura no.**
- `chaski-v3/m5-keys/` ⇒ **no se abre**.

---

## 5. Especificación exacta del cambio

### 5.1 Constantes nuevas en `deposit-shape.ts` (append, con el mismo estilo de comentarios)

```ts
/**
 * HU-SOL-20 / R3 — shape pineado de la 2ª instrucción de negocio permitida:
 * `register_escrow` del MISMO programa escrow. Pineado desde el IDL generado por
 * `anchor build` en solana-programs (HU-SOL-20/R1), NUNCA de un literal de doc.
 */
export const REGISTER_ESCROW_DISCRIMINATOR: readonly number[] = [/* ← §5.2 */];

/** `register_escrow` lleva EXACTAMENTE estas 4 cuentas, en este orden, y NINGUNA remaining. */
export const REGISTER_ESCROW_POSITIONAL_ACCOUNTS = 4;
export const REGISTER_ESCROW_ACCOUNT_INDEX = {
  SENDER: 0,         // signer + writable (paga el rent del índice)
  ESCROW_STATE: 1,   // read-only (register_escrow NO lo modifica)
  ESCROW_INDEX: 2,   // writable, non-signer (PDA ["escrow-index", sender])
  SYSTEM_PROGRAM: 3, // === SYSTEM_PROGRAM_ID
} as const;

/** Layout del ix-data: 8 bytes de discriminador + [u8;16] remittance_id = 24 bytes EXACTOS. */
export const REMITTANCE_ID_OFFSET = 8;
export const REMITTANCE_ID_LEN = 16;
export const REGISTER_ESCROW_DATA_LEN = REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN; // 24
```

### 5.2 El discriminador: de dónde sale (CD-15)

Valor **esperado** (calculado como `sha256("global:register_escrow")[..8]`; método validado porque
reproduce exacto el `DEPOSIT_DISCRIMINATOR` ya pineado en `:25`):

```
[200, 17, 194, 170, 224, 144, 127, 166]
```

**No lo copies de este documento como fuente.** Leelo del IDL ya vendoreado en este repo por R2a:

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
node --input-type=module -e "
import { escrowIdl } from './dist/chains/escrow-idl.js';
" 2>/dev/null || \
grep -n -A3 "name: 'register_escrow'" src/chains/escrow-idl.ts | head -8
```
o directamente del artefacto fuente:
```bash
node -e "const d=require('../solana-programs/target/idl/escrow.json');
const i=d.instructions.find(x=>x.name==='register_escrow');
console.log(JSON.stringify(i.discriminator), i.accounts.map(a=>a.name));"
```
Si el valor leído difiere del esperado, **manda el leído** y avisá en el reporte. Si el orden de
cuentas difiere de `[sender, escrow_state, escrow_index, system_program]`, **PARÁ**: CR-1 valida por
posición y R1 habría cambiado el contrato.

### 5.3 Cambio (a) — línea 80 de `cr1.ts`

```ts
// ANTES (:80-82)
    if (businessIx.length !== 1) {
      return reject('NOT_EXACTLY_ONE_BUSINESS_IX');
    }

// DESPUÉS — HU-SOL-20/R3: se permite 1 (forma legacy, byte-idéntica) o 2 (deposit + register_escrow,
// atómico). 0 o >=3 siguen rechazando con el MISMO enum (los vectores T4a/T4b no cambian).
    if (businessIx.length !== 1 && businessIx.length !== 2) {
      return reject('NOT_EXACTLY_ONE_BUSINESS_IX');
    }
```
`const deposit = businessIx[0]` (`:83`) y el `undefined`-guard (`:84-86`) quedan igual: la **posición
0 sigue siendo obligatoriamente el `deposit`**. Si un cliente manda `register_escrow` primero, el
Check 4 falla con `BAD_DISCRIMINATOR`. Determinístico y fail-closed: **no** implementes búsqueda por
discriminador.

### 5.4 Cambio (b) — Check 4b, entre `:173` y `:175`

Insertar **después** del bloque de remaining accounts del deposit (`:169-173`) y **antes** del
comentario del Check 5 (`:175`). Todo lo nuevo vive dentro de `if (businessIx.length === 2) { … }`,
así que **el camino de 1 ix no ejecuta ni una línea nueva** (eso es lo que hace AC-R3-2 verificable).

```ts
    // ── Check 4b: si hay una 2ª ix de negocio, DEBE ser EXACTAMENTE `register_escrow`
    // del mismo programa, atada a este mismo deposit (HU-SOL-20/R3). Allowlist estricto:
    // programId + discriminador pineado + largo de data exacto + 4 cuentas con flags fijos
    // + binding sender/escrow_state/remittance_id. Cualquier desvío ⇒ reject SIN firmar.
    if (businessIx.length === 2) {
      const reg = businessIx[1];
      if (reg === undefined) return reject('SECOND_IX_ACCOUNTS_INVALID');
      // b1 — mismo programa escrow (nunca otro programId, ni ComputeBudget, ni SPL).
      if (!reg.programId.equals(escrowPk)) return reject('SECOND_IX_PROGRAM_NOT_WHITELISTED');
      // b2 — largo EXACTO (8 + 16). Ni un byte más: cierra el "arg extra" silencioso.
      if (reg.data.length !== REGISTER_ESCROW_DATA_LEN) return reject('SECOND_IX_BAD_DATA_LEN');
      // b3 — discriminador pineado, comparado por bytes (CD-12: sin anchor, sin confiar en el IDL en runtime).
      const regDisc = Buffer.from(reg.data.subarray(0, REGISTER_ESCROW_DISCRIMINATOR.length));
      if (!regDisc.equals(Buffer.from([...REGISTER_ESCROW_DISCRIMINATOR]))) {
        return reject('SECOND_IX_BAD_DISCRIMINATOR');
      }
      // b4 — EXACTAMENTE 4 cuentas: ninguna remaining, ninguna de más.
      if (reg.keys.length !== REGISTER_ESCROW_POSITIONAL_ACCOUNTS) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      const [regSender, regEscrowState, regEscrowIndex, regSystemProgram] = reg.keys;
      if (
        regSender === undefined || regEscrowState === undefined ||
        regEscrowIndex === undefined || regSystemProgram === undefined
      ) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      // b5 — flags EXACTOS por posición. Un writable de más es una cuenta que la tx puede mutar.
      if (!regSender.isSigner || !regSender.isWritable) return reject('SECOND_IX_ACCOUNTS_INVALID');
      if (regEscrowState.isSigner || regEscrowState.isWritable) return reject('SECOND_IX_ACCOUNTS_INVALID');
      if (regEscrowIndex.isSigner || !regEscrowIndex.isWritable) return reject('SECOND_IX_ACCOUNTS_INVALID');
      if (regSystemProgram.isSigner || regSystemProgram.isWritable) return reject('SECOND_IX_ACCOUNTS_INVALID');
      if (!regSystemProgram.pubkey.equals(new PublicKey(SYSTEM_PROGRAM_ID))) {
        return reject('SECOND_IX_ACCOUNTS_INVALID');
      }
      // b6 — BINDING con el deposit: mismo sender, mismo escrow_state y mismo remittance_id.
      // Sin esto, un atacante podría aparear un deposit legítimo con el register de otra cosa.
      // El largo del deposit se chequea SOLO acá: el camino de 1 ix queda byte-idéntico.
      if (data.length < REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN) {
        return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      }
      const depEscrowState = keys[DEPOSIT_ACCOUNT_INDEX.ESCROW_STATE];
      if (depEscrowState === undefined) return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      const depRid = Buffer.from(data.subarray(REMITTANCE_ID_OFFSET, REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN));
      const regRid = Buffer.from(reg.data.subarray(REMITTANCE_ID_OFFSET, REMITTANCE_ID_OFFSET + REMITTANCE_ID_LEN));
      if (
        !regSender.pubkey.equals(sender.pubkey) ||
        !regEscrowState.pubkey.equals(depEscrowState.pubkey) ||
        !regRid.equals(depRid)
      ) {
        return reject('SECOND_IX_NOT_BOUND_TO_DEPOSIT');
      }
    }
```

**Por qué b6 puede atar el `remittance_id` sin conocerlo**: el ix-data del `deposit` es
`disc(8) + remittance_id(16) + beneficiary(32) + authority(32) + amount(8) + deadline(8)` = 104 bytes
(confirmado por el propio fixture del test: `depositData()` en
`src/__tests__/unit/solana-sponsor.cr1.test.ts:45-47` construye `8 + (16+32+32+8+8)`). Así que
`data.subarray(8,24)` **es** el `remittance_id` del depósito, y comparar los dos buffers ata la 2ª ix
al mismo escrow con fuerza criptográfica, sin que CR-1 tenga que saber nada del negocio.

### 5.5 Enums nuevos de rechazo (estables, sin PII, sin eco de la tx)

`SECOND_IX_PROGRAM_NOT_WHITELISTED` · `SECOND_IX_BAD_DATA_LEN` · `SECOND_IX_BAD_DISCRIMINATOR` ·
`SECOND_IX_ACCOUNTS_INVALID` · `SECOND_IX_NOT_BOUND_TO_DEPOSIT`

El `reason` sale por `reply` como `SPONSOR_REJECTED` (`broadcast.ts:157-159`) y el cliente lo mapea a
un 422 opaco (`chaski-v3/app/api/settle/solana-sponsor/route.ts:71-89`), así que **no filtra nada**.

### 5.6 Lo que NO se toca (y hay que poder demostrarlo con `git diff`)

- Check 1 (`:68-72`), Check 3 completo (`:98-131`), Check 4 del deposit (`:133-173`),
  **Check 5 (`:175-186`)**, el cálculo del fee upper bound (`:188-194`) y el `catch` final (`:197-200`).
- `DEPOSIT_POSITIONAL_ACCOUNTS = 8` y `DEPOSIT_ACCOUNT_INDEX`.
- La firma pública `validateDepositForSponsor(tx, feePayerPubkey, cfg)` y el tipo `Cr1Result`.

---

## 6. Tests — los vectores nuevos, con criterio de MUTACIÓN

Framework: **vitest** (`npm run test`). Los fixtures se construyen con `@solana/web3.js` en el propio
archivo (sin anchor, sin spl-token): patrón `buildDepositIx` (`:59-82`) / `buildDepositTx` (`:92-107`).
Extendé ese builder con un `buildRegisterEscrowIx(o)` paralelo y overrides para cada desvío.

| # | Test | AC | Debe dar |
|---|------|----|----------|
| **T-R3-1** | ★ happy 2 ix: deposit válido + register bien formado y atado | AC-R3-1 | `ok: true` con `feeUpperBoundLamports > 0n` |
| **T-R3-2** | happy 2 ix **con ComputeBudget** en rango (SetCULimit + SetCUPrice) | AC-R3-1 | `ok: true` |
| **T-R3-3** | ★ **1 ix legacy** (el fixture de T1 tal cual) | **AC-R3-2** | `ok: true` — sin este verde, R3 rompe a todos los clientes viejos |
| **T-R3-4** | 2ª ix de **otro programId** | AC-R3-3 | `SECOND_IX_PROGRAM_NOT_WHITELISTED` |
| **T-R3-5** | 2ª ix con discriminador de `deregister_escrow` (o cualquier otro) | AC-R3-3 | `SECOND_IX_BAD_DISCRIMINATOR` |
| **T-R3-6** | 2ª ix con `data.length` 25 y con 23 | AC-R3-3 | `SECOND_IX_BAD_DATA_LEN` en los dos |
| **T-R3-7** | 2ª ix con **5 cuentas** (una remaining inyectada) y con **3** | AC-R3-3 | `SECOND_IX_ACCOUNTS_INVALID` en los dos |
| **T-R3-8** | ★ `escrow_state` de la 2ª ix marcado **writable** | AC-R3-3 | `SECOND_IX_ACCOUNTS_INVALID` |
| **T-R3-9** | ★ `escrow_index` marcado **signer** | AC-R3-3 | `SECOND_IX_ACCOUNTS_INVALID` |
| **T-R3-10** | ★ `system_program` reemplazado por otra pubkey | AC-R3-3 | `SECOND_IX_ACCOUNTS_INVALID` |
| **T-R3-11** | ★ **binding roto**: `regSender` ≠ sender del deposit | AC-R3-3 | `SECOND_IX_NOT_BOUND_TO_DEPOSIT` |
| **T-R3-12** | ★ **binding roto**: `regEscrowState` ≠ `escrow_state` del deposit | AC-R3-3 | `SECOND_IX_NOT_BOUND_TO_DEPOSIT` |
| **T-R3-13** | ★ **binding roto**: `remittance_id` de la 2ª ix ≠ el del deposit | AC-R3-3 | `SECOND_IX_NOT_BOUND_TO_DEPOSIT` |
| **T-R3-14** | ★★ **DRAIN**: `regSender` = **feePayer** (2 ix bien formadas por lo demás) | **AC-R3-4** | `ok: false` — y el reason debe ser `FEE_PAYER_REFERENCED_IN_INSTRUCTION` **o** un `SECOND_IX_*`: lo que importa es que **NO firma** |
| **T-R3-15** | ★★ **DRAIN**: `escrow_index` = **feePayer** | **AC-R3-4** | `ok: false`, no firma |
| **T-R3-16** | ★★ **DRAIN**: 2 ix legítimas **+ una 3ª** `SystemProgram.transfer({from: feePayer})` | AC-R3-5 / CD-10 | `NOT_EXACTLY_ONE_BUSINESS_IX` (son 3 business-ix) |
| **T-R3-17** | orden invertido: `register_escrow` en posición 0 y `deposit` en 1 | AC-R3-3 | `BAD_DISCRIMINATOR` (el Check 4 corre sobre `businessIx[0]`) |
| **T-R3-18** | 2ª ix **duplicando el `deposit`** (dos deposits) | AC-R3-3 | `SECOND_IX_BAD_DISCRIMINATOR` |
| **T-R3-19** | 3 business-ix (deposit + register + register) | AC-R3-5 | `NOT_EXACTLY_ONE_BUSINESS_IX` |
| **T-R3-20** | 0 business-ix y solo-ComputeBudget | AC-R3-5 | `NOT_EXACTLY_ONE_BUSINESS_IX` (**es T4a/T4b: no los edites**, tienen que seguir verdes tal cual) |

### 6.1 ⚠️ Un test cuyo doble ignora los argumentos es un test vacuo

Acá **no hay doble**: `validateDepositForSponsor` es pura y se la llama directo con una `Transaction`
real. El riesgo equivalente en este archivo es **el fixture que aprueba desde arriba**:

- **Asertar solo `r.ok === false` en un vector nuevo es insuficiente.** Los vectores existentes lo
  hacen (T2/T5/T6) porque el rechazo es lo único que importa ahí, pero en los nuevos, un `ok:false`
  puede venir de **otro** check y el vector no probaría nada de lo que dice probar. **Todos los
  T-R3-4..T-R3-13 y T-R3-16..T-R3-19 asertean el `reason` exacto.** Excepción deliberada: T-R3-14 y
  T-R3-15 (los drain vectors), donde el requisito es "no firma", venga por donde venga.
- **El builder tiene que construir el desvío de verdad.** Si `buildRegisterEscrowIx({ escrowStateWritable: true })`
  se te olvida de propagar el flag, el test pasa porque validó una ix **bien formada**. Verificación
  de honestidad, obligatoria: para cada override nuevo, agregá una aserción sobre el **fixture**, no
  solo sobre el resultado:
  ```ts
  const ix = buildRegisterEscrowIx({ escrowStateWritable: true });
  expect(ix.keys[1]?.isWritable).toBe(true);   // el fixture REALMENTE tiene el desvío
  ```
  Esta semana cazamos un caso donde **3669 tests pasaban con un guard de seguridad borrado** porque el
  doble aprobaba sin mirar los argumentos. La versión de ese bug acá es un fixture que no aplica el
  override.
- **Un `for` sobre variantes que comparte el `expect` puede enmascarar una.** Si agrupás desvíos en un
  loop (patrón `:202-206`), poné el nombre de la variante en el mensaje de la aserción para saber
  cuál falló.

### 6.2 Mutaciones obligatorias (ejecutar, ver el rojo, revertir)

| Mutación | Qué mutar en `cr1.ts` | Test que DEBE ponerse rojo |
|---|---|---|
| **M1** | Borrar el bloque **b6** completo (binding) | T-R3-11, T-R3-12, T-R3-13 |
| **M2** | Borrar el chequeo de flags de `regEscrowState` (**b5**, 2ª línea) | T-R3-8 |
| **M3** | Borrar el chequeo de flags de `regEscrowIndex` (**b5**, 3ª línea) | T-R3-9 |
| **M4** | Cambiar `reg.keys.length !== 4` por `reg.keys.length < 4` (**b4**) | T-R3-7 (la variante de 5 cuentas) |
| **M5** | Cambiar `reg.data.length !== 24` por `>= 24` (**b2**) | T-R3-6 (la variante de 25) |
| **M6** | Borrar el chequeo del discriminador (**b3**) | T-R3-5 y T-R3-18 |
| **M7** | **Borrar el Check 5 entero (`:175-186`)** | T-R3-14 y/o T-R3-15 **y** los existentes T5/T6/T7/CR-MNR-4 |
| **M8** | Cambiar `!== 1 && !== 2` por `<= 3` (línea 80) | T-R3-19 y T-R3-16 |
| **M9** | Cambiar la comparación de `regSystemProgram.pubkey` por `true` | T-R3-10 |

**M7 es la mutación más importante del story**: si borrar el Check 5 no pone rojo nada, la extensión
abrió un agujero de drenaje. **Si M7 no pone rojo, PARÁ y escalá antes de seguir.**

Procedimiento por mutación: mutar → `npm run test -- solana-sponsor.cr1` → anotar test + mensaje →
revertir → confirmar con `sha256sum src/methods/solana-sponsor/cr1.ts` que volvió al original.

> ⚠️ **`git diff` no ve archivos sin trackear.** Los 3 archivos de este story ya existen y están
> trackeados, así que `git diff` sirve. Pero si en algún momento probás en una copia nueva del archivo
> (por ejemplo `cr1.mutant.ts`), esa copia **no** aparece en el diff: no la uses como evidencia. El
> criterio válido es `sha256sum` del archivo real.

---

## 7. Ops — el CU, que se reporta y no se cambia

La ix extra consume CU adicionales: `register_escrow` hace `init_if_needed` de una cuenta de **558
bytes** (`8 + EscrowIndex::INIT_SPACE`). Datos verificados de la config:

| Env | Default | Dónde |
|---|---|---|
| `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` | **300000** | `src/infra/env.ts:212` |
| `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS` | 50000 | `:213` |
| `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` | 100000 | `:216` |

Tarea: tomar el **CU medido** en el test T11 de R1 (tx real con las 2 ix, medido con
`banksClient.processTransaction(...).computeUnitsConsumed`) y compararlo con 300000.

- Si el medido queda **cómodamente por debajo** (< 60% del cap): no se cambia nada, se reporta.
- Si queda cerca o por encima: **NO cambies el default en código.** Reportá al orquestador con el
  número y la recomendación, y que el founder decida el valor de la env. Un cap de dinero no se sube
  como efecto colateral de un story de validación.

Nota sobre el fee: la 2ª ix **no agrega firmantes** (el `sender` ya firma la 1ª), así que
`BASE_FEE_LAMPORTS_PER_SIG * numSigners` (`cr1.ts:189-191`) no cambia. Y CR-1 ya es conservador
cuando el cliente no manda `SetComputeUnitLimit`: asume el cap máximo (`:102-104`).

---

## 8. Constraint Directives

### OBLIGATORIO
- **Fail-closed en cada rama nueva**: cualquier desvío ⇒ `reject(...)`, jamás un `throw` propagado ni
  un `ok:true` optimista. El `catch` final (`:197-200`) es la red, no la primera línea.
- **CD-12 del facilitator**: sin `@coral-xyz/anchor` en runtime, sin confiar en un IDL en runtime. El
  discriminador y los program ids se comparan **por bytes/pubkey exactos**. La nueva constante se
  pinea en `deposit-shape.ts`, igual que las existentes.
- **CD-10 (heredado del SDD)**: el **`payer` del índice es el `sender`**, nunca el fee-payer, y
  **PROHIBIDO relajar el Check 5** (`cr1.ts:175-186`).
- El camino de **1 business-ix** queda **byte-idéntico**: todo lo nuevo vive dentro de
  `if (businessIx.length === 2)`.
- Los enums de `reason` son estables, sin PII y sin eco de la tx (`:60`).
- `npm run qa` verde (typecheck + lint `--max-warnings 0` + format:check + test).

### PROHIBIDO
- **NO** modificar, mover ni reordenar los Checks 1, 3, 4 y 5 existentes.
- **NO** editar ninguno de los 16 `it` existentes de `solana-sponsor.cr1.test.ts`. Si uno se pone
  rojo, **la extensión está mal** ⇒ PARAR y escalar (es un cambio de comportamiento en el camino
  legacy).
- **NO** cambiar la firma pública de `validateDepositForSponsor` ni el tipo `Cr1Result`.
- **NO** aceptar una 3ª ix de negocio "porque es inocua". El allowlist es de **2**, exactamente.
- **NO** permitir cuentas remaining en la 2ª ix (`keys.length === 4`, exacto).
- **NO** tocar `env.ts` (§7), ni `routes/solana-sponsor.ts`, ni `broadcast.ts`.
- **NO** agregar dependencias.
- **NO** git destructivo. **NO** abrir `chaski-v3/m5-keys/`. Si te cruzás algo que parece credencial,
  reportá `archivo:línea` **sin el valor** (recordá que `SOLANA_FEE_PAYER_PRIVATE_KEY` es un secreto
  real, `env.ts:194-198`: no lo loguees ni lo imprimas nunca, ni en un test).

---

## 9. Waves

### Wave -1 — Environment Gate
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
npm run qa 2>&1 | tail -8       # baseline VERDE (R2a ya mergeado) — ANOTAR el conteo de tests
npx vitest run solana-sponsor.cr1 2>&1 | tail -5   # los 16 vectores verdes
node -e "const d=require('../solana-programs/target/idl/escrow.json');
const i=d.instructions.find(x=>x.name==='register_escrow');
console.log(JSON.stringify(i.discriminator), i.accounts.map(a=>a.name));"
sha256sum src/methods/solana-sponsor/cr1.ts
```
Si el IDL no tiene `register_escrow`, o el orden de cuentas no es
`[sender, escrow_state, escrow_index, system_program]` ⇒ **PARAR**.

### Wave 0 (serial)
- [ ] W0.1 `deposit-shape.ts`: constantes nuevas con el discriminador **leído del IDL** (§5.1/§5.2).
- [ ] **Verificación**: `npm run typecheck` verde; `git diff` sobre `deposit-shape.ts` muestra **solo
      líneas agregadas** (cero modificadas).

### Wave 1 (serial — el core)
- [ ] W1.1 `cr1.ts` línea 80: aceptar 1 o 2 (§5.3).
- [ ] W1.2 `cr1.ts`: Check 4b completo (§5.4).
- [ ] **Verificación**: `npm run qa` verde **con los 16 vectores existentes intactos**.

### Wave 2 (tests)
- [ ] W2.1 `buildRegisterEscrowIx` + overrides + T-R3-1..T-R3-3.
- [ ] W2.2 T-R3-4..T-R3-13 (allowlist y binding).
- [ ] W2.3 T-R3-14..T-R3-20 (drain vectors y conteo de ix).
- [ ] W2.4 Aserciones de honestidad del fixture (§6.1) para **cada** override.
- [ ] **Verificación**: `npm run qa` verde y conteo de tests ≥ baseline + 20.

### Wave 3 (mutación — el gate real)
- [ ] W3.1 Correr **M1..M9** (§6.2). **M7 primero**: si no pone rojo, PARAR y escalar.
- [ ] W3.2 Anotar por cada mutación: test rojo + mensaje.

### Wave 4 (cierre)
- [ ] W4.1 `git diff --stat` ⇒ exactamente 3 archivos.
- [ ] W4.2 Reportar: discriminador **leído**, CU medido vs cap (§7), resultado de M1..M9, y el
      recordatorio explícito de que **R4 no se mergea hasta que esto esté DEPLOYADO** (no solo
      mergeado).
- [ ] W4.3 Marcar el story para **AR propio (G4)** con el foco en: ¿el camino de 1 ix cambió?, ¿puede
      la 2ª ix referenciar el fee-payer?, ¿puede colar una cuenta writable extra?, ¿puede desatarse
      del deposit?

---

## 10. Definition of Done

1. `npm run qa` verde. Los **16 vectores existentes intactos y verdes** (`git diff` lo prueba).
2. Los 20 vectores nuevos verdes, cada uno asertando el `reason` exacto (salvo los 2 drain vectors).
3. **M1..M9 ejecutadas, cada una poniendo rojo lo declarado.** M7 (borrar el Check 5) pone rojo al
   menos un test nuevo **y** los existentes T5/T6/T7/CR-MNR-4.
4. El camino de 1 business-ix es byte-idéntico (todo lo nuevo dentro del `if (length === 2)`).
5. El discriminador pineado fue **leído del IDL**, no copiado de este doc.
6. Diff limitado a 3 archivos. `env.ts`, `broadcast.ts` y `routes/solana-sponsor.ts` intactos.
7. CU medido reportado contra el cap de 300000, **sin cambiar la env**.
8. Story marcado para **AR propio (G4)**.

---

## 11. Escalation Rule

Si algo no está acá → **PARÁS y preguntás al Architect**. En este story, además, escalá **antes de
insistir** si:

- **M7 no pone rojo ningún test** ⇒ posible agujero de drenaje. Es lo más grave que puede pasar acá.
- Un vector existente se pone rojo ⇒ cambiaste el camino legacy.
- El discriminador leído del IDL ≠ el esperado, o el orden de cuentas de `register_escrow` no es el
  de §5.2 ⇒ el contrato de R1 cambió.
- Aparece la necesidad de aceptar una 3ª ix, o de permitir remaining accounts en la 2ª, o de subir un
  cap de `env.ts` para que "entre" ⇒ eso es una decisión de riesgo del founder, no del dev.
- El CU medido supera el cap ⇒ reportá, no lo subas.

---

*Story File generado por NexusAgil — F2.5 · nexus-architect · HU-SOL-20 · R3/7 · **requiere AR propio (G4)***
