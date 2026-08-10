# WKH-343 — el sha256 canónico del IDL nuevo, y por qué vive sólo acá

> Medido el 2026-08-10 sobre el árbol base `8fca47294f6cd8e7ecefd330e278e63078957e26` con el cambio de
> W2 aplicado. `lib.rs` md5 `4904ecc950795662d8c4e7cca262247c`, `target/idl/escrow.json` md5
> `26b2685ce861b04e22322b6d52430836`.
>
> ⛔ **Este archivo es el ÚNICO lugar del repo donde va este valor** (CD-4). No se copia al README, ni a
> `doc/publish-idl-onchain.md`, ni se re-pinnea en ningún consumidor. El re-pin de un consumidor es una
> decisión de ese repo, con su propio SDD, y **no se hace desde acá** (CD-7).

---

## 1. El control, que va ANTES del dato

Un canonicalizador que no reproduce un valor conocido no mide nada, y su salida sobre el IDL nuevo no
vale nada. Así que primero se verificó contra el IDL **sin tocar**:

| Paso | IDL | md5 del archivo | sha256 canónico | Resultado |
|---|---|---|---|---|
| Control | sin tocar (`main`) | `c8e10be9a38bd96b4f0e2ebb422c0c28` | `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922` | **reproduce el valor esperado** |
| Medición | con el cambio de W2 | `26b2685ce861b04e22322b6d52430836` | `fbf2214b0766b7edbb193849460a19b852ef5370b6ced04bb59e14d348ce518e` | dato nuevo |

El algoritmo es el de `chaski-v3/contracts/idl/canonical-hash.ts`, **leído** y reimplementado en el
scratchpad: JSON canónico con claves ordenadas recursivamente + sha256 del UTF-8. No se importó, no se
copió al repo y no se escribió en ese repo (CD-7).

Se corrió en **Node**, no en Python, a propósito: el auto-blindaje de WKH-326 registra que un snippet
de Python devolvía `447a05a7…` en vez de `fb64c937…` porque `json.dumps` escapa lo no-ASCII con
`ensure_ascii=True`, y los `docs` de este IDL tienen acentos y un `⚠️`. Usar el mismo runtime que el
consumidor saca esa clase de error del tablero.

---

## 2. El hash se mueve POR CONSTRUCCIÓN, y no hay forma de evitarlo

`deposit` pasa de 8 a 9 cuentas. Las cuentas nuevas **sí** aparecen en el IDL (los `constraint =` no,
pero los nombres de cuenta y los bloques `pda` sí), así que este cambio **no puede** hacerse sin mover
el hash. No es un efecto colateral a discutir: es la definición del cambio.

**Consecuencia esperada y correcta:** `chaski-v3` y `wasiai-facilitator` pinnean `bfbdfe5a…`, así que
sus tests de hash **van a quedar rojos**. Eso es el resultado esperado, **no un pendiente de esta HU**,
y es el mismo patrón que WKH-326.

### 2.1 Qué NO se movió — y es lo que hace que el re-pin sea compatible

Medido sobre el IDL nuevo:

| Invariante | Valor | ¿Se movió? |
|---|---|---|
| discriminador de `deposit` | `[242, 35, 198, 137, 82, 225, 242, 182]` | **NO** |
| args de `deposit` | los 5: `remittance_id`, `beneficiary`, `authority`, `amount`, `deadline` | **NO** (CD-12) |
| las 8 cuentas previas de `deposit` | mismos nombres, **mismos índices 0..7** | **NO** |
| discriminadores de las otras 5 instrucciones | `close`, `refund`, `register_escrow`, `release`, `deregister_escrow` | **NO** |
| cuentas y args de las otras 5 | idénticos | **NO** |
| discriminadores de cuenta | `EscrowState [19,90,148,111,55,130,229,108]`, `EscrowIndex [55,105,102,30,12,158,174,239]` | **NO** |
| códigos de error | siguen siendo 9, de 6000 a 6008, el último `ReleaseWindowClosed` | **NO** (CD-13: la forma A no agrega ninguno) |
| `EscrowStatus` | sigue con 3 variantes | **NO** |

La **única** diferencia es que `deposit` suma una novena cuenta, `beneficiary_ata`, **al final**,
después de `system_program`. Ningún índice existente se corrió.

Que el discriminador de `deposit` no se mueva importa: una tx armada con el discriminador viejo sigue
llegando al mismo handler. Lo que cambia es cuántas cuentas ese handler exige.

---

## 3. El bloque `pda` que Anchor emite, y por qué es el dato más útil de este archivo

```json
"beneficiary_ata": {
  "pda": {
    "seeds": [
      { "kind": "arg",     "path": "beneficiary" },
      { "kind": "const",   "value": [6, 221, 246, ..., 169] },
      { "kind": "account", "path": "mint" }
    ],
    "program": { "kind": "const", "value": [140, 151, 37, ..., 89] }
  }
}
```

La primera seed es un **argumento de la instrucción**, no otra cuenta. Las otras dos son el SPL Token
program (constante) y la cuenta `mint`, que todo cliente ya manda. O sea: **toda la información para
derivar esta cuenta ya está en una transacción de hoy.**

---

## 4. W2.3 — el resultado, registrado textualmente porque decide el trabajo de otro repo

**La pregunta:** al agregar la cuenta, ¿hay que pasarle `beneficiaryAta` a los cuatro builders de
`deposit` de los tests, o el cliente la deriva solo?

**La respuesta medida: NO hubo que tocar ninguno de los cuatro builders.**

Los cuatro siguen **byte a byte** como estaban:

| Archivo | Línea | Qué es | ¿Se tocó? |
|---|---|---|---|
| `tests/escrow.ts` | helper `deposit(...)` | el helper de este archivo | **NO** (se le agregó un parámetro `opts` opcional al final, pero **no** nombra `beneficiaryAta` en el camino normal) |
| `tests/escrow-index.ts` | helper `deposit(...)` | helper | **NO** |
| `tests/escrow-index.ts` | builder inline del test 11 | el que mide compute | **NO** |
| `tests/escrow-window.ts` | helper `deposit(...)` | helper | **NO** |

⇒ **`[features] resolution = true` (`Anchor.toml:7`) más el bloque `pda` de arriba alcanzan para que
el cliente derive `beneficiary_ata` por su cuenta.** Ningún builder la nombra y los 61 tests pasan.

### 4.1 Lo que eso implica para `chaski-v3` — y lo que NO implica

**Implica** que el camino más probable para `chaski-v3` es **re-pinnear el IDL y nada más**, sin cambio
de código en el armado del depósito: su cliente ya manda los 5 args (incluido `beneficiary`) y la
cuenta `mint`, que es todo lo que la derivación necesita.

⚠️ **NO implica que alcance con re-pinnear.** Lo medido acá es que **el cliente de los tests de este
repo** la deriva sola, y ese cliente usa `.accountsPartial(...)` de `@coral-xyz/anchor` con
`resolution` activa. Dos cosas quedan **NO VERIFICADAS** de este lado, y las dos viven en el otro repo:

1. **`chaski-v3` pinnea las cuentas de `deposit` POR POSICIÓN, y ese pin va a quedar rojo.** Medido
   leyendo `chaski-v3/contracts/idl/escrow-idl.hash.test.ts` (sólo lectura): el test
   `AC-R2b-3/4` hace `expect(accountsOf("deposit")).toEqual([...8 nombres...])`. O sea que en ese repo
   van a quedar rojos **al menos dos** tests, no uno: el del hash canónico **y** este pin posicional.
   El Story File anticipaba "1 test rojo por consumidor"; medido, en `chaski-v3` son dos.
2. **El `reference` se corre del índice 8 al 9.** El cliente real agrega un pubkey de referencia estilo
   Solana Pay en `remainingAccounts`, así que hoy la última cuenta de la tx **no** es `system_program`.
   Si algo lo lee **por posición fija** en vez de barrer `accountKeys`, el arreglo le rompe el camino
   de pago en silencio. **NO está verificado.** Detalle en `runbook-deploy.md`.

---

## 5. Lo que este archivo NO autoriza

- ⛔ No re-pinnea nada. `bfbdfe5a…` sigue siendo el valor pinneado en los dos consumidores, y seguirá
  siéndolo hasta que cada repo lo cambie con su propio SDD.
- ⛔ No declara que el IDL nuevo esté publicado en cadena. **No lo está**: el deploy es W6 y **no se
  ejecutó**. La cuenta del IDL on-chain sigue sirviendo el IDL del binario vigente.
- ⛔ No dice que el binario desplegado tenga esta cuenta. El árbol **diverge a propósito** de la cadena
  entre W2 y el deploy.
