# WKH-343 — el sha256 canónico del IDL nuevo, y por qué vive sólo acá

> Medido el 2026-08-10 sobre el árbol base `8fca47294f6cd8e7ecefd330e278e63078957e26` con el cambio de
> W2 aplicado. `lib.rs` md5 `4904ecc950795662d8c4e7cca262247c`, `target/idl/escrow.json` md5
> `26b2685ce861b04e22322b6d52430836`.
>
> **⚠️ EL HASH SE MOVIÓ OTRA VEZ EN LA SEGUNDA RONDA DEL FIX PACK, y el valor de más abajo es el
> viejo.** El valor vigente para este árbol es:
>
> | | |
> |---|---|
> | sha256 canónico del IDL **de este árbol** | `d295b7c74ff9a2ac758e24cc9e7d32d3c09d5943e1b137ef67f4f2692993c70e` |
> | `target/idl/escrow.json` md5 | `25b498214df3f6f87a936b3e536b290b` |
> | `target/deploy/escrow.so` md5 | `1588018c0cc754db49462f93054455c9` (276 800 bytes, sin cambio de tamaño) |
> | `programs/escrow/src/lib.rs` md5 | `15c8d5ecea1babd3f029b8bcce0798ed` |
>
> **Por qué se movió:** la segunda ronda corrigió un `///` de `Deposit.mint` que decía *"NO hay hoy
> ningún control que rechace un mint inesperado"*, y eso era **falso** desde el 2026-08-04
> (`wasiai-facilitator/.../cr1.ts:281-282` responde `MINT_MISMATCH`, commit `e14383f`). Anchor copia
> los `///` al IDL, así que la frase falsa estaba **dentro del IDL construido** — se extrajo de ahí,
> no es hipotético. Corregirla mueve el hash y **eso es correcto**: la ventana está abierta porque
> WKH-343 ya lo movía por construcción y **el IDL nuevo no se publicó** (las dos mitades del gate de W6
> siguen sin cumplirse, `runbook-deploy.md:21-24`). Publicarlo con la frase adentro la habría
> inmortalizado en cadena, y ahí corregirla costaría un upgrade de IDL: el costo es **asimétrico**.
>
> **Lo que NO se movió, medido sobre el IDL nuevo:** el discriminador de `deposit`
> (`[242,35,198,137,82,225,242,182]`), sus 5 args, sus 9 cuentas en el mismo orden, las 6
> instrucciones, y los 9 códigos de error `6000..6008` con `ReleaseWindowClosed` al final. El único
> cambio es texto de `docs`.
>
> **Control del canonicalizador, antes del dato:** reprodujo `fbf2214b…` sobre una copia del IDL
> anterior tomada antes del rebuild. Si no reprodujera un valor conocido, su salida sobre el IDL nuevo
> no valdría nada.
>
> Historial de esta rama, para que se pueda auditar el movimiento:
> `bfbdfe5a…` (lo que está en cadena y lo que pinnean los consumidores) → `fbf2214b…` (W2, la cuenta
> nueva) → **`d295b7c7…`** (fix pack ronda 2, la corrección del `///`).
>
> La ronda 1 del fix pack agregó 19 líneas a `lib.rs`, **todas `//`**, y ahí el IDL **no** se movió
> (`26b2685c…`, byte por byte idéntico): `//` no llega al IDL, `///` y `//!` sí. Esa asimetría es
> justamente lo que hace que la corrección de esta ronda cueste un rebuild.
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
| Medición | con el cambio de W2 | `26b2685ce861b04e22322b6d52430836` | `fbf2214b0766b7edbb193849460a19b852ef5370b6ced04bb59e14d348ce518e` | ⚠️ **SUPERADO** por el fix pack ronda 2 — no pinnear este valor |
| Medición 2 | W2 + la corrección del `///` de `Deposit.mint` (fix pack ronda 2) | `25b498214df3f6f87a936b3e536b290b` | **`d295b7c74ff9a2ac758e24cc9e7d32d3c09d5943e1b137ef67f4f2692993c70e`** | **el valor vigente de este árbol** |

⚠️ El control se volvió a correr en la ronda 2 **antes** de medir: el canonicalizador reprodujo
`fbf2214b…` sobre una copia del IDL de la fila anterior, tomada antes del rebuild. Dos filas de
"Medición" son dos hashes en el archivo que promete tener uno solo, y por eso la fila superada dice que
lo está: lo que CD-4 pide es que exista **un único lugar** donde vive el valor, no que ese lugar borre
su historial. Quien vaya a pinnear usa la última fila.

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
   `AC-R2b-3/4` (`:55`, la aserción en `:74`) hace
   `expect(accountsOf("deposit")).toEqual([...8 nombres...])`. Sumado al del hash canónico (`:36`),
   son **dos** tests rojos en ese archivo.

   ⚠️ **Y no son los únicos: son al menos CUATRO, en DOS archivos.** Este párrafo decía "en
   `chaski-v3` son dos" y esa sección existe para dimensionar el trabajo del otro repo, así que
   quedarse corto es el error que importa. El segundo archivo es
   `chaski-v3/src/infrastructure/solana-wallet.test.ts`, donde `:218` y `:553` hacen los dos
   `expect(ix.keys).toHaveLength(9)` — el comentario de `:553` dice literalmente
   `// 8 del IDL + reference`. Esos dos **no** se rompen por re-pinnear el IDL: se rompen cuando el
   cliente empiece a mandar `beneficiary_ata`, que es la mitad (i) del gate de W6 y por lo tanto
   condición para desplegar. O sea que el trabajo del otro repo es: 2 tests por el IDL + 2 por el
   armado de la instrucción, y el conteo de `ix.keys` pasa de 9 a 10.

   Medido con un barrido de `toHaveLength(|accountsOf(|toEqual([` sobre los dos archivos, no leyendo
   uno solo. **Lo que NO está medido:** que no haya más rojos fuera de esos dos archivos. Es un piso
   ("al menos cuatro"), no un total.
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
