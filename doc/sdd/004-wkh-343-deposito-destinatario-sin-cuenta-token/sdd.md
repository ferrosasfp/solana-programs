# SDD — WKH-343 — El depósito acepta un destinatario que no puede recibir el token, y el repo habla de la cadena en presente

> SPEC_APPROVED: no
> Fecha: 2026-08-10
> Tipo: bugfix de money-path + corrección de prosa verificable + upgrade a devnet
> SDD_MODE: full
> Branch: `feat/004-wkh-343-deposito-destinatario-sin-cuenta-token`
> Worktree: `/home/ferdev/.openclaw/workspace/wt-wkh343`
> Árbol base: `main` @ `8fca47294f6cd8e7ecefd330e278e63078957e26`
> Artefactos: `doc/sdd/004-wkh-343-deposito-destinatario-sin-cuenta-token/`
> Input: `work-item.md` de esta misma carpeta (6 ACs, 2 `[NEEDS CLARIFICATION]` bloqueantes)

---

## 0. Cómo leer este documento

Los dos bloqueantes del work-item (mediciones 1 y 3) están **resueltos y medidos** — §2. Esa medición
no confirma la hipótesis del work-item: la **reencuadra**, y de paso descarta una opción que el
work-item consideraba viable. Si vas a leer una sola sección, leé §2 y §3.

### 0.1 Dos cosas cambiaron mientras se escribía este SDD, y las dos están medidas

| Cambio | Medido | Efecto en el SDD |
|---|---|---|
| **El upgrade a devnet está AUTORIZADO** por el founder. Sigue prohibido mainnet | Precondiciones medidas en §2.9 | CD-1 reescrito; **W6 nueva** (§6, §4.8). El upgrade se planifica acá, con un gate que **no** es opcional (§4.8.5) |
| **Los 4 escrows trabados se refundearon** desde la DApp, mientras esta sesión corría | §2.8, slots `482579398`..`482580179`; el enumerador da **0 en `Deposited`** al slot `482583139` | El defecto **no cambia**: el camino que los trabó está intacto. Lo que cambia es el **argumento**, no el alcance (§2.8.3). Y hace *más* fuerte el caso contra (b) (§3.1) |

⚠️ Consecuencia de la segunda: **en ningún lugar de este documento el arreglo "destraba" ni "recupera"
fondos.** Nunca lo hizo — previene depósitos futuros — y desde el slot `482579398` no hay nada que
recuperar. Un upgrade tampoco recupera nada ya depositado. Si encontrás una frase que sugiera lo
contrario, es un bug de este documento.

### 0.2 Convenciones, y son las que lo hacen auditable

1. **Todo número medido lleva el slot (o el commit) en la misma línea.** Sin slot no es un dato, es
   un recuerdo. §12 tiene el comando exacto que reproduce cada uno.
2. **Ninguna frase dice "elimina" o "ya no puede pasar" sin nombrar el mutante de UNA línea que
   restauraría el comportamiento viejo.** La lista está en §9, y el cuerpo apunta ahí.
3. **Lo derivado se marca DERIVADO y lo medido MEDIDO.** Hay dos afirmaciones centrales que son
   derivadas y están marcadas, aunque suenen obvias.
4. Cuando corrijo un dato del work-item, del brief o **mío**, lo digo con el número viejo al lado.
   Hay cinco correcciones así: §2.6.
5. Los `archivo:línea` son contra `8fca472`. Se desplazan si el Dev edita antes de leerlos: por eso
   cada cita lleva además **el texto que hay que encontrar**.

---

## 1. Context Map — qué leí y qué saqué de cada cosa

Todos los paths de esta tabla fueron abiertos con Read en esta sesión. Ninguno se cita de memoria.

| Archivo | Por qué lo leí | Qué saqué |
|---|---|---|
| `doc/sdd/004-.../work-item.md` (138 líneas) | Es el input | 6 ACs, 5 CDs, los 2 bloqueantes, y el error de desglose de §2.6 |
| `.nexus/project-context.md` | Fuente de verdad del stack | rustc 1.89.0 / anchor-cli 1.1.2 / Agave 3.1.10 / `@coral-xyz/anchor` 0.30.1 / bankrun; las 9 trampas del repo; "los consumidores se leen, no se escriben" |
| `programs/escrow/src/lib.rs` (772 líneas, md5 `e21a3f5e7d06ed83869d6a780c6bbe20`) | Es el archivo a cambiar | `Deposit` no tiene ninguna cuenta del beneficiario (`:514-581`); `Release.beneficiary_ata` es `associated_token::` **sin `init`** (`:614-619`); el bloque `//` del mint (`:518-529`); códigos posicionales (`:494-506`) |
| `tests/escrow.ts` (579 líneas) | Es donde van los tests nuevos | `beforeEach` con UN solo mint (`:243-262`); `createAta`/`mintTo`/`pdas` **cerrados sobre el `mint` de módulo**; `expectRevert` que pinnea el código exacto (`:218-239`); el canario de 154 bytes (`:283-290`) |
| `tests/escrow-index.ts` (1278 líneas) | Exemplar del suite más adversarial | `ataOf(owner)` parametrizado (`:198-200`); `expectRevert` idéntico (`:370-391`); `bumpSlot()` por el dedup de bankrun (`:350-353`) |
| `tests/escrow-window.ts` (854 líneas) | Convención de constantes | re-declara las constantes del programa como literales propios, a propósito |
| `scripts/list-live-escrows.py` (217 líneas, md5 `8c7c7452…`) | AC-3 | El docstring (`:5-17`) y el cierre (`:198-211`) están escritos para el instante previo al upgrade de WKH-326, que ya pasó |
| `scripts/deploy-devnet.sh` (123 líneas) | W6: el upgrade | Exige el keypair **como argumento** y aborta si no coincide con la authority que lee de la cadena (`:46-90`); corre el preflight de tamaño antes de mandar un byte (`:103-107`) |
| `scripts/onchain-hash.py`, `scripts/programdata-capacity.py` | Precondiciones del upgrade | Los dos controles que ya existen y que W6 **reusa** en vez de inventar (§2.9) |
| `README.md` (1095 líneas, md5 `25aecd01…`) | AC-4, AC-5, W6 | 7 sitios de prosa sobre la cadena; 3 con el literal `55`; la tabla Toolchain (`:805-827`); el runbook de deploy (`:966-1000`) |
| `SECURITY.md` (md5 `630ae317…`) | Barrido del 5º caso (el work-item lo dejó abierto) | `:91-92` afirma que el mint es uno que controlamos — falso para el 100% del saldo custodiado |
| `doc/publish-idl-onchain.md` (200 líneas, md5 `122d5414…`) | AC-4, W6.4 | `:43-51` es una tabla "Current state, as read from devnet" que dice `Exists? **No.**`; `:135-146` es el orden de los 4 pasos del ciclo de publicación |
| `doc/mutation-run.md` | Guard sin mutante no cuenta | Protocolo de md5 antes/después; las 3 baselines (43/54/55); M1..M19 |
| `doc/sdd/003-.../auto-blindaje.md` | Paso obligatorio de aprendizaje histórico | 6 entradas; 5 aplican acá — §10 |
| `target/idl/escrow.json` (md5 `c8e10be9…`) | Medir qué mueve el hash del IDL y qué no | §4.6: los `constraint =` **no** aparecen en el IDL; las cuentas nuevas y los `address =` **sí** |
| `Anchor.toml`, `Cargo.toml`, `rust-toolchain.toml` | Precondiciones del Dev y del deploy | `[features] resolution = true`; `solana = "3.1.10"` es lo que elige el compilador que emite los bytes |
| `anchor-syn` 1.1.2 `codegen/accounts/constraints.rs:1269-1324` | Verificar qué genera `associated_token::` | 3 chequeos: dueño del token account, dirección canónica, programa de token. Usa `#wallet_address.key()` |
| `anchor-lang` 1.1.2 `src/lib.rs:541-545` | Si un arg `Pubkey` sirve como `authority` | `impl Key for Pubkey` existe ⇒ `.key()` sobre un arg compila |
| `anchor-syn` 1.1.2 `codegen/accounts/try_accounts.rs:48-87` | Si Anchor tolera cuentas de sobra, y si etiqueta el 3012 | Sólo hay error por cuentas **de menos**; cada campo envuelve su error con `.with_account_name(...)` (`:87`) |
| `anchor-lang` 1.1.2 `src/accounts/account.rs:313-318` | De dónde sale el 3012 | `Account::try_from` devuelve `AccountNotInitialized` si `owner == system_program && lamports == 0` |
| `node_modules/@coral-xyz/anchor/dist/cjs/error.js:113,132-139` | Forma exacta del dato del cliente | `origin` es un **string** con el nombre de la cuenta, no un objeto |
| `chaski-v3/src/infrastructure/solana-wallet.ts` (**sólo lectura**: `:290-336`, `:382-430`, `:761-800`) | Medir el radio de impacto | Usa `.accounts({5 cuentas})` + **`.remainingAccounts([reference])`** (`:410-417`) — hallazgo que cambia §4.7. Ya tiene un docblock sobre la ambigüedad del 3012 (`:793-800`). Declara 120.000 CU (`:427-428`) |

### 1.1 Exemplars verificados (paths confirmados, no inventados)

| Para escribir | Seguir el patrón de | Qué copiar exactamente |
|---|---|---|
| La cuenta nueva de `Deposit` | `programs/escrow/src/lib.rs:614-619` (`Release.beneficiary_ata`) | `associated_token::mint` + `associated_token::authority`, **sin `init`**. Es la misma cuenta que `release` va a exigir: si `deposit` valida otra cosa, el guard no predice nada |
| Cómo se comenta un cambio que mueve el IDL | `programs/escrow/src/lib.rs:386-410` (bloque `//` de `MAX_ENTRIES`) | `//` cuando no querés mover el hash; `///` cuando ya se mueve. §4.6 dice cuál aplica acá |
| Los tests de revert nuevos | `tests/escrow.ts:326-351` (test 2) + `:218-239` (`expectRevert`) | Pinnear el nombre exacto del código de Anchor y asertar además que el vault quedó intacto |
| El fixture de un segundo mint | `tests/escrow.ts:79-104` (`createMint6`) y `tests/escrow-index.ts:198-200` (`ataOf`) | `createMint6` ya recibe la authority por parámetro: se llama dos veces sin tocarla |
| Un test que exhibe un ciclo largo sin que un assert por iteración lo tape | `tests/escrow-index.ts` test 14 + `auto-blindaje.md` entrada 1 | Medir por iteración, asertar **después** del loop |
| La tabla de mutantes | `doc/mutation-run.md:16-38` (M1..M19) | Una línea por mutante, y los tests que murieron **por nombre** |
| El artefacto de hash que vive sólo en la carpeta de la HU hasta el deploy | `doc/sdd/003-.../idl-hash.md` | Y su sección de cierre, que es el modelo de qué se escribe **después** del deploy |
| El runbook del upgrade | `README.md:966-1000` + `scripts/deploy-devnet.sh` | El preflight corre antes de mandar un byte; la decisión no mecánica se escribe, no se asume |

### 1.2 Precondición del árbol, medida (trampa 1 del project-context)

`anchor deploy` y bankrun **shippean lo que hay en `target/`, no compilan**. Medido hoy en el árbol
principal (`/home/ferdev/.openclaw/workspace/solana-programs`, `main` @ `8fca472`):

| Artefacto | md5 medido | Referencia de `doc/mutation-run.md:60-61` | ¿Coincide? |
|---|---|---|---|
| `target/deploy/escrow.so` | `d4b736cf6b9e15421e7cb1d75f3d8e0d` | `d4b736cf6b9e15421e7cb1d75f3d8e0d` | sí |
| `target/idl/escrow.json` | `c8e10be9a38bd96b4f0e2ebb422c0c28` | `c8e10be9a38bd96b4f0e2ebb422c0c28` | sí |
| `programs/escrow/src/lib.rs` | `e21a3f5e7d06ed83869d6a780c6bbe20` | `e21a3f5e7d06ed83869d6a780c6bbe20` | sí |

El `target/` del árbol principal **no está contaminado** y corresponde a `main`. Eso no es una
propiedad del worktree nuevo, que no tiene `target/` en absoluto: el Dev arranca con `anchor build` y
registra los tres md5 antes de tocar nada (W0.1).

⚠️ El worktree nuevo tampoco tiene `target/deploy/escrow-keypair.json`. `anchor build` **genera uno
nuevo** si falta. No rompe los tests (el program id sale de `declare_id!` en `lib.rs:62`, y
`Anchor.toml:15,18` lo pinnea) pero es un archivo que se parece mucho a la llave del programa y no lo
es. CD-9, y es especialmente peligroso ahora que el deploy está autorizado.

---

## 2. Las mediciones que gobiernan el diseño

Todas hechas hoy, 2026-08-10, contra devnet, **sólo lectura**: `getSlot`, `getProgramAccounts`,
`getAccountInfo`, `getTokenAccountsByOwner`, `getSignaturesForAddress`, `getTransaction`. Ninguna
firma, ninguna transacción, ningún keypair. §12 tiene los comandos.

### 2.1 Los 10 `EscrowState` vivos, partidos exactamente en dos — slot `482578481`

MEDIDO con `python3 scripts/list-live-escrows.py --url devnet`, slot `482578481`
(2026-08-10 07:06:58Z). 10 cuentas, no 8 como dice `README.md:723`.

| # | escrow | status **al slot 482578481** | monto (raw) | mint | sender |
|---|---|---|---|---|---|
| 1 | `2eWYonV4PjznByNkLu7u8YLvbZcSh37d4QzreqeTVG14` | Refunded | 500.000 | `8yRX3fZ2…` | `8tJVcM2Jeh…` |
| 2 | `4YRtEL1RGuu5zkSYwMUrkEJajbFLbJFKsojMNEoHxVPo` | Refunded | 1.000.000 | `8yRX3fZ2…` | `8tJVcM2Jeh…` |
| 3 | `BmHDdjKLCJXcdzd8CqbHaeRWY9utbviZduXhbnH5Jm9F` | Refunded | 10.000.000 | `8yRX3fZ2…` | `8tJVcM2Jeh…` |
| 4 | `93ZUG1zdVrUTHv4zuup1wDCPdYrXa8QegU42D4rfzuJL` | **Released** | 500.000 | `8yRX3fZ2…` | `8tJVcM2Jeh…` |
| 5 | `DHc1DYrSm2QeWe6txAs5NnDSzKYeXcCC1WUwviHk11oj` | **Released** | 2.000.000 | `8yRX3fZ2…` | `8tJVcM2Jeh…` |
| 6 | `GXY2todK6pJPdT8h1EcRNZgFX7cZXEnDN7L3XSHCHY2J` | **Released** | 10.000.000 | `8yRX3fZ2…` | `8tJVcM2Jeh…` |
| 7 | `Crqz6hQoChPaP3TVPU4H7kbXo4FPUXz3NzriG3JYmWdw` | Deposited | 20.000.000 | `4zMMC9srt…` | `4AvAjtPg1…` |
| 8 | `HnzegD1fxPNpp7DadNWpStS2a5siSVXVXWV2dykJx3uS` | Deposited | 10.000.000 | `4zMMC9srt…` | `4AvAjtPg1…` |
| 9 | `BSj3YUJUc98w89ckWb96shfRv4sakJuu4BjfKuhmvgdq` | Deposited | 5.000.000 | `4zMMC9srt…` | `4AvAjtPg1…` |
| 10 | `2zWkoznm86cqX6bWExsR3Wvw5njffDpxuCJCXTsT7LWb` | Deposited | 5.000.000 | `4zMMC9srt…` | `4AvAjtPg1…` |

Las filas 7-10 **cambiaron a `Refunded` durante esta sesión**: ver §2.8. La tabla se conserva como
foto del slot `482578481` porque es la que gobernó el diseño, y porque el status con fecha es la única
forma honesta de escribirla.

**Las 10 comparten el mismo beneficiario `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` y la misma
authority `9rphjeRUekSbVpDZhzN9roQQmn6yndodRVfiBvyEAGAV`.** Los 4 `Deposited` sumaban **40.000.000
raw = 40,000000 unidades** (6 decimales, medido en §2.2). Los 4 tenían el deadline pasado.

Esto contesta el bloqueante 1 del work-item: **sí, los 4 comparten destinatario, y además lo comparten
con los 6 terminales.** El beneficiario es la única variable **constante** del conjunto, así que no
puede explicar por qué a 3 les fue bien y a 4 les fue mal. Explicar un resultado con una constante es
el error que esta medición evita.

### 2.2 El beneficiario NO es inválido: tiene una cuenta y le entraron 12.500.000 raw — slot `482578601`

MEDIDO con `getTokenAccountsByOwner(Dr37oH97…, {mint})`, slot `482578601` (2026-08-10):

| mint | ¿token accounts del beneficiario? | saldo | decimales | freeze authority |
|---|---|---|---|---|
| `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` (nuestro) | **1** — `BQC6fXinyR4KnESJso1oY8nnbQjXjbFAJb221V7UkiVe` | **12.500.000 raw** | 6 | `null` |
| `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle) | **0** | — | 6 | `CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT` |

Los dos mints corren sobre el token program clásico `Tokenkeg…` (ninguno es Token-2022, que sería
otro modo de falla).

**Y 12.500.000 = 500.000 + 2.000.000 + 10.000.000, que son exactamente los 3 `Released` de §2.1.**
Cada unidad que este programa liberó en su vida está en esa cuenta y sigue ahí. El beneficiario
recibió tres veces. **La hipótesis "destinatario inválido" queda descartada por dato, no por
argumento.**

### 2.3 La correlación es perfecta, y la variable no es la que parece

De §2.1 y §2.2: **3 de 3 releases ocurrieron sobre el mint nuestro. 0 de 4 depósitos sobre el mint de
Circle llegaron a `Released`.** Y el beneficiario tiene ATA para el primero y no para el segundo.

⚠️ **Honestidad sobre esta correlación, porque es débil en un punto concreto:** el mint y el
**sender** co-varían perfectamente (filas 1-6 son sender `8tJVcM2Jeh…`, filas 7-10 son
`4AvAjtPg1…`). Con n=10 y esa confusión, los datos **no distinguen** "es el mint" de "es qué build de
cliente hizo el depósito". Lo que sí distinguen, y es lo que gobierna el diseño, es §2.2: el
beneficiario es byte a byte el mismo en las 10 filas, incluidas las 3 que cobraron.

### 2.4 Nadie intentó liberarlos, y esa es la observación que faltaba — slot `482579152`

MEDIDO con `getSignaturesForAddress` + `getTransaction` sobre los 4 `Deposited`, slot `482579152`
(o sea: **antes** de los refunds de §2.8):

| escrow | txs aterrizadas | slot | instrucción |
|---|---|---|---|
| `Crqz6hQ…` | 1 | 481455889 | `Deposit` (ok) |
| `HnzegD1f…` | 1 | 481983586 | `Deposit` (ok) |
| `BSj3YUJ…` | 1 | 482045575 | `Deposit` (ok) |
| `2zWkoznm…` | 1 | 482396033 | `Deposit` (ok) |

**Exactamente una transacción cada uno. Nunca aterrizó un intento de `release`.**

Dos consecuencias, dichas con precisión:

1. La afirmación del work-item de que "el `release` explota después con `AccountNotInitialized
   (3012)`" **es DERIVADA, no observada**. Sale de leer `lib.rs:614-619` (la cuenta se exige y no se
   crea) + `anchor-lang/src/accounts/account.rs:313-316` (una cuenta inexistente da 3012) + §2.2 (la
   cuenta no existe). Es una cadena sólida y aun así no hay una tx en cadena que la muestre. **W1 la
   vuelve MEDIDA en bankrun** (test T15).
2. Un `release` rechazado en el *preflight* del cliente no aterriza y no deja rastro. Así que "no
   aterrizó ninguno" **no** es "nadie lo intentó". La forma correcta: *el programa nunca rechazó un
   release de estos 4, porque nunca le llegó uno*.

Y el ritmo importa: 4 depósitos en 5 días (slots 481455889 → 482396033), el último el 2026-08-09. No
es un incidente histórico que dejó de ocurrir; es una tasa.

### 2.5 El `refund` sobre el mint de Circle ya se había ejercido antes, y funcionó — slot `482578944`

MEDIDO. `README.md:615-622` y `:722-741` nombran 4 direcciones como vivas. Las 4 están **ausentes**
al slot `482578944`, y ninguna estaba mal transcripta: las 4 tienen 3 firmas cada una.

Historia completa de `4VopXGzBLyy1LtCm8ms881Vpo45ByApjFoUiZATquLiE`:

| slot | instrucción | resultado |
|---|---|---|
| 481178461 | `Deposit` | ok |
| 481455632 | `Refund` | ok |
| 482045751 | `Close` | ok |

Ídem `4YpeqyZXahcBpSzyh2eaTc3dRxbarFgHfUR2QoV7JXJx` (última tx en slot 482045737). O sea: **el
2026-08-08 alguien ya refundeó y cerró dos escrows del mint de Circle, con este mismo beneficiario.**
Nótese que el `Close` del slot 482045751 corrió **después** del deploy de WKH-326 (slot `481495859`),
así que la instrucción con el índice opcional funciona en cadena.

Complemento, slot `482578725`: el sender `4AvAjtPg1…` **tiene** ATA para el mint de Circle
(`9ucjbsTJ52mL1fihTMm6VW7E255y5yQy56Ktc39cn4a4`), que es la cuenta que `Refund` exige
(`lib.rs:649-654`). Los 4 vaults existían, `initialized` (no congelados), con 40.000.000 raw en total.

### 2.6 Cinco correcciones a datos que me llegaron, que están escritos, o que escribí yo

| Dónde | Decía | Medido |
|---|---|---|
| Tareas previas (según el brief) | 45 USDC trabados | **40,000000** — 4 escrows, slot `482578481`. El work-item dice 45 en `:91`, `:107` y `:126`; gana el 40 |
| `work-item.md:68` (AC-4) | el caso está en `README.md:27` | Es **`README.md:26`** ("Money at risk"). `:27` es "Upgrade authority", que hoy es verdadera. Un `archivo:línea` corrido por uno es "la evidencia que se auto-confirma": apunta a un renglón que igual se lee plausible |
| `work-item.md:35-45` (medición 3) | "es un problema de mint" (derivado) | Es **medible y está medido** (§2.1-2.3), y el resultado **no** es el que la hipótesis esperaba: descarta al beneficiario, y deja al mint y al build del cliente indistinguibles (§2.3) |
| Cualquier frase que diga "40 USDC trabados **hoy**" | — | Falsa desde el slot `482579398` (§2.8). Los 4 están `Refunded`, y **0** escrows en `Deposited` al slot `482583139` |
| Un borrador mío de §2.9.3 | "el rustc de este host (1.97.1) no coincide con el pin" | Falso: **dentro del checkout es 1.89.0**. Lo medí desde el directorio equivocado (§2.9.3) |

### 2.7 El work-item dejó abierto el barrido del 5º caso de prosa. Encontré tres más

MEDIDO por lectura del árbol `8fca472`, sobre los rangos que el analyst declaró no haber revisado:

| # | Sitio | Qué afirma | Por qué es falso o insuficiente hoy |
|---|---|---|---|
| 5 | `README.md:978` | "Either the authority releases it (**still possible until the upgrade lands**)" | Ese upgrade aterrizó el 2026-08-05 en el slot `481495859` (`README.md:25`). Sobre un escrow vencido `release` ya revierte. Es el **mismo defecto operativo** que `list-live-escrows.py:206-207`, y está en el runbook de deploy — el documento que W6 va a seguir |
| 6 | `README.md:540-546` | "As of 2026-08-05 the only **two** escrows… **15 units**" | Eran 4 y 40 (slot `482578481`) y ahora son 0 (slot `482583139`). **Tiene fecha y envejeció igual**: la fecha no salva a una oración escrita como propiedad vigente. Es el caso que define cómo hay que redactar el AC-4 |
| 7 | `SECURITY.md:91-92` | "The mint used in testing is one **we control**" | El 100% del saldo custodiado estuvo en el mint de Circle, cuya mint authority y freeze authority no son nuestras (slot `482578725`). `README.md:26` y `:540-546` ya corrigieron esto; `SECURITY.md` nunca se enteró. Y es el archivo que abre primero quien reporta una vulnerabilidad |

Además: `doc/publish-idl-onchain.md:48` dice `Exists? **No.**` bajo el título "Current state, as read
from devnet". MEDIDO al slot `482579471`: la cuenta `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC`
**existe**, owner `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, 5292 bytes. Y `:51` publica
`fb64c937…` como "canonical sha256 of that IDL" cuando el vigente es `bfbdfe5a…` (`README.md:31`).

### 2.8 Los 4 refunds ocurrieron durante esta sesión, y esto es lo que cambian

#### 2.8.1 Medido, tx por tx — slot `482583313`

El founder ejecutó los 4 refunds desde la DApp desplegada mientras esta sesión corría. MEDIDO con
`getSignaturesForAddress` + `getTransaction`, todos `err: None`:

| escrow | monto devuelto (raw) | slot del `Refund` | CU consumidos | ix de la tx |
|---|---|---|---|---|
| `2zWkoznm…` | 5.000.000 | **482579398** | 14.863 | ComputeBudget ×2 + `DR5GoMT7…` |
| `BSj3YUJU…` | 5.000.000 | **482579872** | 14.863 | ComputeBudget ×2 + `DR5GoMT7…` |
| `HnzegD1f…` | 10.000.000 | **482579957** | 13.363 | ComputeBudget ×2 + `DR5GoMT7…` |
| `Crqz6hQo…` | 20.000.000 | **482580179** | 14.863 | ComputeBudget ×2 + `DR5GoMT7…` |

Fee payer y único firmante de las 4: `4AvAjtPg1aPwJQRvjnY1U9BHbC46rwVc5BY6FuhqUA7P`, el propio
sender. No hubo patrocinador.

Verificación independiente del resultado, slot `482583245`: los 4 `EscrowState` tienen `status_byte =
2` (`Refunded`), los 4 vaults quedaron en `amount = 0`, y la ATA del sender pasó de 10.000.000 a
**50.000.000 raw** — exactamente +40.000.000. Y al slot `482583139` el enumerador imprime *No escrow
is Deposited with an expired deadline*: **0 escrows en `Deposited`**.

#### 2.8.2 El `refund` no cierra nada: quedaron 0,016008 SOL de alquiler inmovilizado

MEDIDO al slot `482583245`. Las 8 cuentas siguen existiendo:

| Cuenta | ×4 | lamports cada una | total |
|---|---|---|---|
| `EscrowState` (154 bytes) | 4 | 1.962.720 | 7.850.880 |
| vault (ATA, `amount = 0`, `initialized`) | 4 | 2.039.280 | 8.157.120 |
| | | **4.002.000 por escrow** | **16.008.000 lamports = 0,016008 SOL** |

Los 4.002.000 por escrow coinciden con lo que `chaski-v3/src/infrastructure/solana-wallet.ts:769`
declara que `close` recupera — dos fuentes independientes, el mismo número.

**Decisión de alcance: es residuo declarado, no trabajo de esta HU.** Motivos: (i) `close` ya existe y
funciona en cadena (§2.5, slot 482045751), así que no hay nada que arreglar; (ii) recuperar ese
alquiler es **mover fondos** — cuatro txs firmadas por el sender — y esta HU no las manda; (iii) es
exactamente el alcance de **WKH-327** (el camino de cliente para recuperar el alquiler), que
`doc/sdd/_INDEX.md` ya tiene registrada como bloqueada por WKH-326. Queda escrito en el report para
que nadie lo descubra de nuevo, y con el número medido para que no haya que remedirlo.

⚠️ Y hay un detalle de secuencia que W6 tiene que respetar: **si el upgrade cambia el layout de
`EscrowState`, esas 4 cuentas dejan de deserializar y su alquiler queda inmovilizado para siempre.**
No es el caso de esta HU (CD-12 prohíbe tocar el layout, y el canario de `tests/escrow.ts:283-290` lo
vigila), pero es la razón por la que ese CD no es una formalidad.

#### 2.8.3 Qué cambia en la HU y qué no

| | |
|---|---|
| **El defecto** | **Intacto.** `deposit` sigue aceptando un beneficiario que no puede recibir, y nada valida el mint. Se limpió la consecuencia, no la causa |
| **El alcance** | Sin cambios. Los 6 ACs siguen igual: ninguno hablaba de los 40 USDC (el AC-1 es sobre depósitos futuros) |
| **El argumento** | **Cambia.** Este SDD no puede justificarse con "hay 40 USDC trabados ahora mismo": es falso desde el slot `482579398`. Se justifica con que **el camino que los trabó está intacto y se recorrió cuatro veces contra el programa desplegado**, la última el 2026-08-09 |
| **El caso contra (b)** | **Se fortalece.** Ver §3.1 |
| **Lo que el arreglo hace** | Previene. **No recupera, y nunca recuperó.** Un upgrade tampoco recupera nada ya depositado |

#### 2.8.4 Un dato colateral que confirma un mecanismo, no una anécdota

Las 8 transacciones (4 depósitos + 4 refunds) llevan **dos instrucciones propias de ComputeBudget**.
Eso confirma en firmas reales lo que `chaski-v3/src/infrastructure/solana-wallet.ts:419-430` describe:
el cliente declara **su** presupuesto en vez de dejar que la billetera inyecte el suyo.

Y el CU medido dice algo más útil que un rango, que es justo lo que exige el CD-18:

| Instrucción | CU medidos en cadena | Congruencia |
|---|---|---|
| `deposit` | 32.475 / 33.975 / 35.475 / 38.475 | **los 4 ≡ 975 (mod 1500)** |
| `refund` | 13.363 / 13.363 (×3 en 14.863) | **los 4 ≡ 1363 (mod 1500)** |

Los pasos de 1.500 son iteraciones de búsqueda de bump canónico — el mismo mecanismo que
`.nexus/project-context.md:88-91` documenta desde los tests (52.826..79.826 CU en 28 corridas, pasos
de 1.500). **Es la primera vez que ese mecanismo queda medido en transacciones de producción y no en
bankrun.** Consecuencia práctica: el delta de CU que introduzca la cuenta nueva se reporta como un
cambio en el **residuo módulo 1500**, no como un `min..max` de N corridas (CD-18). Y el presupuesto
que declara el cliente (120.000 CU, `solana-wallet.ts:427-428`) tiene margen de sobra contra el peor
depósito real medido (38.475).

### 2.9 Precondiciones del upgrade, medidas — 2026-08-10

El upgrade está autorizado (§0.1). Estas son sus cuatro precondiciones, y **tres están cumplidas y
una es operativa**.

#### 2.9.1 ¿Quién firma? — la authority está en cadena; **el path del keypair no está en el repo**

MEDIDO con `python3 scripts/onchain-hash.py --program-id DR5GoMT7… --url devnet`:

| | |
|---|---|
| programdata account | `UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR` |
| último deploy | slot **481495859** (el de WKH-326, que sí se ejecutó) |
| **upgrade authority** | **`4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`** |
| bytes desplegados | 412.568 reservados / 274.785 sin relleno |
| artifact-sha256 | `59ec1098cd64d04cab1063fd837e84a70c7962741a3c14932d249cab28b328ef` |
| verify-hash | `455e4e36fa7c63be568d470a89f7eded9aff5806b198340936a578810be09291` |

Los dos hashes coinciden con los que publica el README y `.github/workflows/verified-build.yml`. Ese
es el control que W6 reusa: **el binario del upgrade anterior se verificó byte a byte contra la
cadena**, y `onchain-hash.py` acepta `--expect-artifact-sha256` y `--expect-verify-hash` para hacerlo
otra vez sin escribir nada nuevo.

**Dónde está el keypair de `4wPhH4dC…`: no lo dice el repo, y eso es correcto.** MEDIDO por barrido
sobre `*.md`, `*.sh`, `*.py`, `*.toml`, `*.yml` del árbol: las 4 menciones son **placeholders** —
`README.md:930-931`, `scripts/deploy-devnet.sh:62-63`, `doc/publish-idl-onchain.md:64,171`, todas
`<path to the upgrade authority keypair>`. Y MEDIDO: `~/.config/solana/id.json` **no existe** (el
directorio tiene sólo `cli/` e `install/`), que es exactamente el footgun de
`.nexus/project-context.md:95-101` y de `deploy-devnet.sh:26-28`.

⇒ **Precondición operativa, no mecánica: el path del keypair de la upgrade authority es un input que
tiene que dar el founder.** El SDD no lo busca, no lo adivina y no lo referencia. `m5-keys/` no se
abre, no se lista y no se menciona como candidata (CD-2): si la conclusión de alguien es que la llave
sólo puede venir de ahí, eso se escribe como pregunta al founder y se sigue.

Nótese que `scripts/deploy-devnet.sh:59-89` ya convierte esto en un error legible: sin keypair aborta
antes de mandar un byte y **imprime la pubkey que la cadena espera**. No hay que agregar nada.

#### 2.9.2 ¿Alcanza el `programdata`? — **sí, con 137.768 bytes de margen. No hace falta más rent**

MEDIDO con `python3 scripts/programdata-capacity.py --program-id DR5GoMT7… --artifact
target/deploy/escrow.so --url devnet`:

```
programdata bytes      412613
loader header          45
usable for the binary  412568
local artifact         274800 bytes
headroom               137768 bytes
OK the binary fits in the space already reserved on chain
```

El número a no superar es **412.568 bytes**. El artefacto actual usa 274.800. Esta HU agrega **una
cuenta a un contexto**: el crecimiento esperado es de cientos a pocos miles de bytes, tres órdenes de
magnitud por debajo del margen.

⇒ **DERIVADO (no medido, porque el binario nuevo todavía no existe): el upgrade no va a necesitar más
rent.** Se vuelve MEDIDO en W6.1, que corre el mismo preflight contra el artefacto nuevo. Si por
algún motivo no entrara, **el upgrade no se ejecuta**: se reporta el faltante en bytes y el rent que
costaría ampliar. Referencia de costo, de la ampliación anterior: +150.000 bytes ⇒ 1,044 SOL,
irreversible. CD-21.

#### 2.9.3 ¿Este host produce el binario desplegable? — sí, y el pin que importa no es el que parece

MEDIDO en el worktree, 2026-08-10:

| Herramienta | Pin declarado | Medido acá | ¿Emite los bytes del `.so`? |
|---|---|---|---|
| rustc (host) | 1.89.0, `rust-toolchain.toml` | **1.89.0** dentro del checkout | **No** (`README.md:809`). Corre clippy y los tests del host |
| solana-cli / Agave | 3.1.10, `Cargo.toml:20` | **3.1.10** | **Elige al que sí**: `cargo-build-sbf` usa el rustc de platform-tools de Agave (`README.md:810-811`) |
| anchor-cli | 1.1.2, `Anchor.toml:4` | **1.1.2** | No. Maneja el build |

Corrección de una premisa que ya costó una ronda, dicha con la precisión que le faltaba: **lo que no
compila el binario es el pin de rustc del host, no `anchor build`.** `anchor build` **sí** produce el
artefacto desplegable, y es reproducible — `README.md:815-818` lo midió el 2026-08-06 corriendo el
build con `channel = "1.89.0"` y con `channel = "stable"` (1.97.1) y las dos veces salió `verify-hash
455e4e36…`, el valor que devnet tiene. Lo que **sí** movería los bytes es cambiar
`[workspace.metadata.cli] solana` (`README.md:824-827`).

⇒ Las tres versiones de este host coinciden con los tres pines. Un `anchor build` acá es
deploy-grade. Y aun así el veredicto no se apoya en eso: W6.3 lo verifica **contra la cadena** con
`onchain-hash.py` **después** del deploy, que es el único momento en que el dato existe.

⚠️ Sobre el rustc del host: fuera del checkout esta máquina tiene 1.97.1, y adentro rustup respeta
`rust-toolchain.toml` y da 1.89.0. La primera lectura que hice fue afuera y por un momento anoté que
había un desajuste. No lo hay. Queda escrito porque es la clase de dato que se mide desde el
directorio equivocado.

#### 2.9.4 La cuarta precondición, y es la que puede romper producción

`chaski-v3` tiene que mandar la cuenta nueva **antes** de que el programa la exija. Está desarrollada
en §4.7 y §4.8.5. No es negociable y no depende de ninguna medición pendiente: es una consecuencia
del orden en que Anchor lee las cuentas.

---

## 3. La decisión: (a) en este repo + (c) como handoff. Y por qué (b) es la peor de las cuatro

El work-item deja abiertas cuatro opciones. Las respondo contra el dato de §2, no contra opiniones.

### 3.1 (b) `init_if_needed` sobre `beneficiary_ata` — **RECHAZADA**. Y los refunds de §2.8 la vuelven indefendible

Cuatro razones, en orden de fuerza. La primera y la segunda son nuevas desde §2.8.

1. **(b) habría hecho ILEGAL el remedio que el founder ejecutó hoy.** Con (b), los 4 depósitos de
   §2.4 se habrían liberado en su momento; el estado habría pasado a `Released`, que es terminal
   (`lib.rs:451-453`). Y `refund` exige `status == Deposited` (`lib.rs:246-249`). Así que los 4
   refunds de los slots `482579398`..`482580179` **habrían revertido con `EscrowNotDeposited`
   (6002)**. (b) no arregla el defecto: le saca la salida.
2. **Convierte un estancamiento reversible en una transferencia irreversible del activo equivocado.**
   Con (b), esas 40 unidades del USDC de Circle habrían llegado a una ATA recién creada de un
   beneficiario que no tiene provisioning para ese token. Volverían sólo si **él** firma. Lo que pasó
   en cambio: volvieron con una firma del sender, la que ya tenía (§2.8.1).
3. **No habría desbloqueado a ninguno de los 4.** Los 4 tenían el deadline vencido (§2.1) y desde el
   deploy de WKH-326 (slot `481495859`) `release` sobre un escrow vencido revierte con
   `ReleaseWindowClosed` / 6008 (`lib.rs:207-210`). (b) opera sobre una cuenta que la instrucción ni
   llega a mirar.
4. **Cuesta lo mismo que (a) en acoplamiento y más en superficie.** `init_if_needed` sobre una ATA
   necesita `payer` y `system_program`, y `Release` (`lib.rs:585-623`) **no tiene** `system_program`
   ni un signer con `mut`. Habría que poner `mut` en `authority` (el operador paga ~0,002 SOL por
   release), agregar `system_program`, y habilitar la feature `init-if-needed` de Anchor. Cambio de
   IDL, de cliente y de modelo de costos, para un resultado peor.

### 3.2 (c) fijar/validar el mint — **es aguas arriba y sí es causal, y aun así NO alcanza**. Va como handoff

El brief lo señala como el defecto raíz. Es cierto que es causalmente anterior, y es cierto que el
control compensatorio que `lib.rs:530-534` invoca **no existe** (lo dice el propio bloque `//` de
`:518-529`). Pero (c) se cae por dos lados, y el segundo es decisivo:

1. **No es implementable en este repo.** El co-firmante off-chain es `wasiai-facilitator`, otro repo,
   fuera de scope (work-item `:93-94`). La versión on-chain de (c) es `#[account(address = <const>)]`
   sobre `mint`, y eso: (i) mueve el sha256 canónico del IDL — MEDIDO: en `target/idl/escrow.json`
   las cuentas con dirección conocida llevan un campo `address` (`token_program` →
   `"address":"Tokenkeg…"`), así que agregar `address =` al `mint` lo agrega al IDL; (ii) obliga a dos
   builds, dos IDL y dos hashes para devnet y mainnet, que es exactamente el costo que
   `README.md:704-708` describe para no hacerlo; (iii) **contradice la condición de reversa que el
   propio repo escribió**: `lib.rs:536-540` dice que el mint se clava el día que exista un barrido que
   tome depósitos por buenos sin la co-firma. Ese barrido no existe (los enumeradores de hoy sólo
   alimentan el refund).
2. **Y esto es lo decisivo: (c) sola no habría prevenido el incidente, en ninguna de sus dos
   configuraciones posibles.** Los 4 depósitos estaban **sobre el mint de Circle** (§2.1).
   - Si el mint de producción pretendido es el de Circle → clavarlo habría **aceptado los 4 sin
     cambiar nada**. Poder preventivo: cero.
   - Si el mint pretendido es el nuestro → clavarlo habría rechazado los 4, y también habría
     rechazado el token que el producto quiere usar.

   O sea que (c) **o no previene, o rompe el producto**. El invariante que se violó no es
   "mint == X": es **"el mint es consistente con un beneficiario que puede recibirlo"**. Es un
   invariante *relacional*, y una constante global no lo expresa. (a) sí.

⇒ (c) sale de esta HU como handoff explícito a `wasiai-facilitator` (§8, R5). No se implementa acá y
no se pretende que esta HU lo cubra.

### 3.3 (a) rechazar el depósito si el beneficiario no puede recibir — **ELEGIDA**

Forma: `Deposit` pasa a declarar la **misma** cuenta que `Release` va a exigir —
`beneficiary_ata`, `associated_token::mint = mint`, `associated_token::authority = beneficiary`, **sin
`init`** — y por lo tanto rechaza el depósito cuando esa cuenta no existe, no es la ATA canónica, no
es del mint del escrow, o no es del beneficiario.

Por qué la misma cuenta y no una más laxa: `Release.beneficiary_ata` usa `associated_token::`
(`lib.rs:614-619`), o sea que el destino del release **tiene** que ser la ATA canónica. Si `deposit`
validara con `token::` (cualquier token account del beneficiario con ese mint, que es lo que hace
`sender_ata` en `:571-575`), aceptaría depósitos que `release` después rechazaría, y el guard no
cumpliría el AC-1. El mutante de una línea que abre ese agujero está en §9 (M23).

**Qué garantiza, con precisión:** que en el instante del `deposit`, la ATA canónica del beneficiario
para ese mint existe y es válida. Y como los dos chequeos son literalmente el mismo, si el `deposit`
entró, el `release` no puede fallar *por esta causa*.

**Qué NO garantiza, y esto es la mitad que hace falsable la frase de arriba:** que siga existiendo en
el instante del `release`. Una token account se puede cerrar (SPL `CloseAccount`, la firma su dueño),
y el beneficiario podría cerrar la suya entre el depósito y el release. `deposit` no puede impedirlo.
Así que (a) **no elimina** el estado "el release no se puede construir": lo mueve del caso "nunca
existió" (que es el 100% de lo medido en §2.2) al caso "existía y se cerró". T15 en §7 fija ese
límite en un test, para que quede ejecutable y no sólo escrito.

### 3.4 El costo de (a), y es alto: hay que decirlo entero

**(a) hace fallar el 100% de los depósitos, hasta que alguien cree una cuenta.**

MEDIDO (§2.2, slot `482578601`): el beneficiario `Dr37oH97…` tiene **0** token accounts para el mint
de Circle. Si el programa se actualizara con (a) y el producto siguiera depositando sobre el mint de
Circle, **cada depósito revertiría**. Ese es exactamente el riesgo que la recomendación previa
(citada en el brief) intentaba proteger, y **es real**. Con el upgrade ahora autorizado, deja de ser
una nota teórica y pasa a ser un gate del deploy (§4.8.5).

La razón por la que igual se elige (a), y es una comparación entre dos males concretos:

| | Sin (a) — lo que pasó | Con (a) |
|---|---|---|
| ¿Se movió plata? | Sí, 40.000.000 raw entraron a 4 vaults | No, la tx revierte antes de la CPI de transferencia |
| ¿Quién tiene que actuar? | El **sender**: 4 firmas de `refund` (hechas, slots `482579398`..`482580179`) y 4 de `close` (pendientes, 0,016008 SOL, §2.8.2) | El **usuario**, reintentando después de que exista la ATA |
| ¿Se ve? | No: 4 depósitos "ok" durante 5 días, sin ningún error en cadena (§2.4) | Sí: la tx falla con un error que nombra la cuenta |
| ¿Cuánto cuesta destaparlo? | Una investigación (esta) | Un mensaje de error |
| ¿Cuánto cuesta arreglarlo? | 8 transacciones que mueven plata | **1** transacción permisionada de ~0,002 SOL: crear la ATA. La puede pagar cualquiera |

Fallar antes de mover plata, ruidosamente, con un remedio de una transacción que no requiere al
founder, es estrictamente mejor que entrar en silencio a un estado que sí lo requiere.

### 3.5 Corrección explícita de una premisa previa, porque la clase de error importa

En una tarea anterior yo escribí que **rechazar el depósito podía estar mal**, porque el beneficiario
es la dirección que asigna el proveedor de pago y rechazar bloquearía todos los depósitos.

Con §2 eso **se da vuelta en su parte central y sobrevive en su parte lateral**:

- **Lo que se da vuelta:** el depósito estaba efectivamente mal formado — el par (mint, beneficiario)
  era imposible de liquidar (§2.2). Rechazarlo no habría bloqueado el producto: habría **destapado un
  error de configuración el 2026-08-05**, en el primer depósito (slot 481455889), en vez de dejar que
  se repitiera 4 veces en 5 días y terminara en 4 refunds manuales. La premisa "el beneficiario que
  asigna el proveedor es por definición válido" es falsa: válido como dirección, sí; capaz de recibir
  *ese* token, no.
- **Lo que sobrevive:** el efecto "bloquearía todos los depósitos" es cierto **mientras la ATA no
  exista** (§3.4). No es un argumento contra (a); es su precondición de deploy, y ahora que el deploy
  está autorizado es el gate de §4.8.5.

Queda escrito porque es la clase de premisa que se acepta sin medirla: una que suena a respeto por un
sistema externo y en realidad transfiere la responsabilidad de un invariante a alguien que no la tomó.

### 3.6 (d) La combinación, dicha como plan y no como suma de buenas intenciones

| Pieza | Repo | Estado en esta HU | Cuándo tiene efecto |
|---|---|---|---|
| (a) `deposit` exige la ATA canónica del beneficiario | `solana-programs` | **Se implementa** (W2) | Al desplegar (W6), y sólo si su gate se cumple |
| Detección del mismo defecto sobre el programa YA desplegado | `solana-programs` | **Se implementa** (W3) | **Hoy**, sin ningún deploy |
| Upgrade a devnet | `solana-programs` | **Se planifica y se ejecuta** (W6), autorizado, con gate | Al correr W6 |
| (c) el co-firmante compara el mint contra `SOLANA_USDC_MINT` | `wasiai-facilitator` | **Handoff**, no se toca | HU aparte |
| Mandar `beneficiary_ata` desde el cliente | `chaski-v3` | **Handoff, y es el GATE de W6** (§4.8.5) | Antes del deploy |
| Provisioning de la ATA del beneficiario | operación | **Precondición de deploy**, verificable con W3 | Antes del deploy |
| Recuperar los 0,016008 SOL de alquiler | operación / WKH-327 | **Residuo declarado** (§2.8.2) | Fuera de esta HU |
| Corrección de la prosa (AC-3, AC-4, AC-5) | `solana-programs` | **Se implementa** (W4) | Al mergear |

Reparto que vale notar: **W3 entrega valor sin deploy y W2 no.** Si el gate de W6 no se cumple, la HU
igual mejoró la capacidad de detectar el problema el día que vuelva a pasar.

### 3.7 Cumplimiento explícito del AC-6

El AC-6 exige constancia de que la opción se validó **contra** la medición 1, y no antes. Acá está:
la medición 1 (§2.1) y su complemento (§2.2) se corrieron **antes** de elegir, y **cambiaron la
elección**: descartaron "destinatario inválido", degradaron (c) de raíz suficiente a raíz insuficiente
(§3.2.2), y produjeron el argumento decisivo contra (b) (§3.1.2). Si §2.2 hubiera devuelto "el
beneficiario no tiene ATA para ningún mint y nunca recibió nada", (a) habría sido un guard que rechaza
el 100% de los depósitos para siempre y la decisión habría sido otra.

Y §2.8 agregó una validación que no estaba disponible cuando se eligió: el argumento 1 de §3.1 sólo
se pudo escribir **después** de que los refunds existieran. La decisión no cambió; su respaldo creció.

---

## 4. Diseño técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué | Wave | Exemplar |
|---|---|---|---|---|
| `programs/escrow/src/lib.rs` | Modificar | `Deposit`: una cuenta nueva + `#[instruction(...)]`; los doc comments que esta HU vuelve falsos | W2 | `lib.rs:614-619` |
| `tests/escrow.ts` | Modificar | 6 tests nuevos + helpers parametrizados por mint + `expectRevertOnAccount` | W1 | `tests/escrow.ts:326-351`, `tests/escrow-index.ts:198-200` |
| `scripts/list-live-escrows.py` | Modificar | Sacar el eje "antes/después del upgrade"; verdicto derivado del dato; **chequeo nuevo de la ATA del beneficiario**; salida markdown | W3 | el propio script (`:147-212`) |
| `README.md` | Modificar | 7 sitios de prosa + el literal `55` + los hashes y el slot del deploy nuevo | W4, W6.4 | — |
| `SECURITY.md` | Modificar | `:91-92` (el mint) y `:99-105` (source vs chain, AC-5) | W4, W6.4 | — |
| `doc/publish-idl-onchain.md` | Modificar | `:43-51` ("Current state") + el ciclo de republicación del IDL | W4, W6.4 | `:135-146` |
| `.nexus/project-context.md` | Modificar | `:63` (cross-ref roto a `README.md:769`) y `:145` (literal `55`) | W4 | — |
| `.github/workflows/verified-build.yml` | Modificar | Los dos hashes del binario nuevo, **sólo en W6.4** (después del deploy) | W6.4 | `README.md:822-837` |
| `doc/mutation-run.md` | Modificar | Sección nueva con M20..M24 y la baseline nueva | W5 | `doc/mutation-run.md:16-38` |
| `doc/sdd/004-.../idl-hash.md` | **Crear** | El sha256 canónico nuevo, por qué vive sólo acá hasta W6, y su sección de cierre | W0.3, W6.4 | `doc/sdd/003-.../idl-hash.md` |
| `doc/sdd/004-.../runbook-deploy.md` | **Crear** | El upgrade paso por paso, con su gate y sus abortos | W4 | `README.md:966-1000` |
| `doc/sdd/004-.../w1-red.txt`, `w5/M*-summary.txt`, `w6/*.txt` | **Crear** | Evidencia cruda, con cabecera que dice de qué pasada es | W1, W5, W6 | `doc/sdd/003-.../w4/` |

**Fuera de Scope IN, sin excepciones:** `chaski-v3`, `wasiai-facilitator`, `wasiai-a2a`,
`wasiai-remittance-agents`, `m5-keys/`, y cualquier archivo de `target/` que no sea producto de
`anchor build`.

### 4.2 El cambio al programa

#### Forma A (preferida) — 1 cuenta nueva, 0 códigos de error nuevos

```rust
#[derive(Accounts)]
#[instruction(remittance_id: [u8; 16], beneficiary: Pubkey)]   // <- `beneficiary` es NUEVO acá
pub struct Deposit<'info> {
    // ... sender, mint, escrow_state, vault, sender_ata,
    //     token_program, associated_token_program, system_program:  SIN CAMBIOS ...

    // AL FINAL DE LA LISTA A PROPOSITO, despues de system_program, rompiendo la convencion de
    // "los programas van ultimos". El motivo es el orden de despliegue y esta en el SDD §4.7:
    // una cuenta agregada al final la ignora el binario viejo (le queda en remaining_accounts),
    // y una cuenta insertada en el medio se la come el `token_program` del binario viejo.
    #[account(
        associated_token::mint = mint,
        associated_token::authority = beneficiary
    )]
    pub beneficiary_ata: Account<'info, TokenAccount>,
}
```

Sin `mut`: no se le transfiere nada en `deposit`, sólo se comprueba que existe y es la correcta. Menos
privilegio, y hace imposible que un cambio futuro le mande tokens desde acá sin que alguien tenga que
agregar el `mut` a mano.

Base para creer que compila (leído, no supuesto):
`anchor-syn` 1.1.2 `codegen/accounts/constraints.rs:1311` genera `let wallet_address =
#wallet_address.key();`, y `anchor-lang` 1.1.2 `src/lib.rs:545` tiene `impl Key for Pubkey`. Los args
declarados en `#[instruction(...)]` están en scope dentro de `try_accounts` — el propio archivo ya lo
usa para `remittance_id` en las seeds (`lib.rs:553`). **Aun así no lo afirmo: W0.2 lo compila.**

#### Forma B (fallback, sólo si W0.2 falla) — 2 cuentas nuevas, 1 código de error nuevo

Si `associated_token::authority` no acepta un arg, hay que darle una **cuenta**. Y como no puede
llamarse `beneficiary` (choca con el arg homónimo en el scope generado), la forma es: quitar
`beneficiary` del `#[instruction(...)]`, declarar la cuenta `beneficiary: SystemAccount<'info>`
(espejo de `Release.beneficiary`, `lib.rs:592`), y cruzarla contra el arg **en el cuerpo**:

```rust
require_keys_eq!(ctx.accounts.beneficiary.key(), beneficiary, ErrorCode::BeneficiaryMismatch);
```

con `BeneficiaryMismatch` **apendizado al final** del enum (código 6009), por la regla posicional de
`lib.rs:494-499`. Las dos cuentas nuevas van igualmente al final de la struct.

El cruce contra el arg **no es opcional en la forma B**: sin él, un cliente que mande el arg X y la
cuenta Y grabaría `escrow.beneficiary = X` (`lib.rs:167`) y validaría la ATA de Y. Eso no sería un
guard: sería un guard que mira al lado.

#### Qué error emite, y por qué no se agrega un código nuevo en la forma A

| Caso | Error de Anchor |
|---|---|
| La ATA del beneficiario **no existe** | `AccountNotInitialized` (3012) |
| Existe pero no es la ATA canónica de (beneficiary, mint) | `ConstraintAssociated` |
| Existe, es un token account, pero de otro dueño | `ConstraintTokenOwner` |
| Existe pero es de otro mint | `ConstraintAssociated` (la dirección canónica no coincide) |

Los tres últimos se pinnean **por nombre**, nunca por número: los códigos de constraint de Anchor no
son parte del contrato de este repo, los de `ErrorCode` sí (CD-11).

MEDIDO (`anchor-syn` 1.1.2 `codegen/accounts/try_accounts.rs:87`): cada campo envuelve su error con
`.with_account_name(<nombre del campo>)`, y MEDIDO
(`node_modules/@coral-xyz/anchor/dist/cjs/error.js:113,132-139`) el cliente parsea el log
`AnchorError caused by account: <nombre>. Error Code: …` y expone ese nombre en `error.origin` **como
string**. Así que el 3012 de `beneficiary_ata` **es distinguible** del 3012 de `sender_ata`: no por el
número, que es el mismo, sino por `error.origin` y por la línea de log.

Por eso la forma A no agrega un `ErrorCode` nuevo: Anchor ya nombra la cuenta, un código nuevo no
agregaría información y sí consumiría un slot posicional. **Esto acota la ambigüedad; no la
elimina**: un consumidor que sólo mire `errorCode.code` sigue viendo `3012` a secas. Mutante que
restaura la ambigüedad completa: cambiar el tipo del campo a `UncheckedAccount<'info>` (M22 en §9),
que hace desaparecer el 3012 y el nombre juntos.

⚠️ `chaski-v3/src/infrastructure/solana-wallet.ts:793-800` ya tiene un docblock que dice que el 3012
"no desambigua las dos causas" para `close`. Con lo medido arriba, `error.origin` sí las desambigua.
No es una edición de esta HU (otro repo): es información concreta para el handoff.

#### Lo que este guard NO abre

- No se le puede sustituir la cuenta: Anchor compara contra la dirección canónica derivada de
  (beneficiary, mint) y rechaza cualquier otra (`constraints.rs:1318-1322`).
- No agrega un vector de grief por front-creation. Al revés que el `vault` (`lib.rs:558-562`, donde
  crear la ATA primero **bloquea** el depósito), acá crearla primero **habilita** el depósito. Es el
  único lugar del programa donde que un extraño cree una ATA ajena ayuda.
- Sí agrega una denegación **del propio beneficiario**: si cierra su ATA, no se puede depositar para
  él. Impacto: la tx falla sin mover plata, y el incentivo apunta al revés (es el que cobra). Se
  declara, no se mitiga.

### 4.3 El script (AC-3, y el detector que funciona sin deploy)

`scripts/list-live-escrows.py`. Cuatro cambios, en orden de importancia:

1. **Chequeo nuevo: ¿el beneficiario puede recibir?** Por cada escrow, un
   `getTokenAccountsByOwner(beneficiary, {mint})` (sólo lectura, mismo transporte `urllib` + stdlib
   que ya usa, `:69-83`). Salida por escrow: `beneficiary can receive: yes (<ata>, balance <n>)` /
   **`no — beneficiary has NO token account for this mint; release cannot be built`**. Es el chequeo
   que habría nombrado el problema el 2026-08-05, **funciona contra el binario ya desplegado**, y es
   además el verificador del gate de §4.8.5.
2. **Sacar el eje "antes/después del upgrade".** El docstring (`:5-17`) y el cierre (`:198-211`) están
   escritos para el instante previo al deploy de WKH-326 (slot `481495859`, 2026-08-05). El verdicto
   de `:170` pasa a ser derivable sólo de lo que el script leyó: `REFUND-ONLY: the release window
   closed at <iso(deadline)>; the only exit is a refund signed by <sender>`. Y se borra "Each of these
   can be released by its authority RIGHT NOW" (`:206-207`), que recomienda una operación de dinero
   que revierte.
3. **Todo lo que imprime lleva el slot.** Ya imprime `cluster clock at slot N` (`:150`); pasa a
   repetirlo en el bloque de cierre, para que un pegado parcial de la salida siga trayendo su slot.
4. **`--markdown`**: la misma información como tabla markdown, con encabezado `measured <iso> at slot
   <N> against <cluster>`. Es para que los párrafos del README se **generen** en vez de escribirse
   (AC-4, segunda mitad).

Se **mantiene** el nombre `--exit-nonzero-if-blocking`. Verificado con barrido sobre `.yml`, `.sh`,
`.md` y `.json` del repo: no hay consumidor programático — sólo prosa (`README.md:142,974,999`) y un
comentario en `scripts/deploy-devnet.sh:115`. Renombrarlo sería un cambio de interfaz sin beneficio;
se documenta que el nombre es histórico.

⚠️ Sobre `--markdown` y lo que aporta de verdad: **no impide que el README envejezca.** El mutante de
una línea que restaura el comportamiento viejo es *que nadie corra el comando*. Lo que sí hace es
bajar el costo de refrescar a un comando y garantizar que cada línea refrescada traiga su slot. Lo que
reinicia ese límite: cualquier actividad en devnet. Medido: entre el slot `482578481` y el
`482583139` de esta misma sesión, 4 filas de la tabla de §2.1 cambiaron de estado.

### 4.4 La prosa (AC-4, AC-5)

Los 8 sitios, con el texto exacto a buscar (los números de línea son de `8fca472` y se desplazan):

| # | Sitio | Texto a encontrar | Qué tiene que pasar |
|---|---|---|---|
| P1 | `README.md:26` | "the two escrows still holding funds" | Al slot `482583139` **no hay ninguno**: 0 en `Deposited`. Con fecha **y slot**. Es el `:27` del AC-4, corregido en §2.6 |
| P2 | `README.md:142-146` | "Run today it exits 1 again… **a deposit** made afterwards" | Hoy sale 0 (slot `482583139`). Reescribir como medición fechada o derivar del script |
| P3 | `README.md:615-622` | "One escrow on devnet is in the on-chain half of that state **right now**" + `4VopXGzB…` | La cuenta está ausente (slot `482578944`) y su historia es Deposit→Refund→Close (§2.5). El ejemplo pasa a ser **histórico y fechado** |
| P4 | `README.md:540-546` | "As of 2026-08-05 the only two escrows… 15 units" | Fueron 4 y 40, ahora 0. **Tiene fecha y envejeció igual**: hace falta el slot y una oración que no lea como propiedad vigente |
| P5 | `README.md:722-741` | "Of the eight `EscrowState` accounts… six… two" + los 4 pubkeys | 10 cuentas, 0 en `Deposited`. Las 4 direcciones están ausentes. Mejor candidato a **generarse** con `--markdown` |
| P6 | `README.md:978` | "still possible until the upgrade lands" | Ese upgrade aterrizó (slot `481495859`). Y es el runbook que W6 va a seguir: dejarlo así hace que el propio deploy de esta HU se apoye en un supuesto vencido |
| P7 | `SECURITY.md:91-92` | "The mint used in testing is one we control" | El 100% del saldo custodiado estuvo en el mint de Circle, con freeze authority ajena (slot `482578725`) |
| P8 | `doc/publish-idl-onchain.md:43-51` | "Current state, as read from devnet" / `Exists? **No.**` / `fb64c937…` | La cuenta existe (slot `482579471`, owner `ProgM6JCC…`, 5292 bytes) y el hash vigente es `bfbdfe5a…` |

**AC-5**, dos sitios (no uno), y con el deploy autorizado tienen dos momentos:

- `README.md:25` — "Source vs deployed | **They agree.**" En **W4** (post-cambio, pre-deploy) tiene
  que decir que el árbol **diverge a propósito** y que el deploy es un paso posterior de esta misma
  HU, **sin implicar que ya se hizo**. En **W6.4** (post-deploy) se reescribe con el slot nuevo y los
  hashes leídos de la cadena.
- `SECURITY.md:99-105` — "The source and the chain agree today". Mismo caso en dos momentos. Es el
  archivo que lee quien reporta una vulnerabilidad: si dice que coinciden cuando no, un finding contra
  `main` se va a leer como un finding contra la cadena.

`.github/workflows/verified-build.yml`: la bandera `SOURCE_REPRODUCES_CHAIN` está en `true` y en
`false` **exige** que el rebuild difiera de devnet (`README.md:822-837`). Con `lib.rs` cambiado y sin
deploy todavía, el rebuild **va a** diferir. Ver R4: no se toca en W4 y sí en W6.4. La ventana entre
W2 y W6 tiene el CI en rojo **correctamente**.

#### El literal `55`, y por qué se reduce en vez de actualizarse

8 sitios lo escriben a mano: `README.md:29,30,772`, `doc/mutation-run.md:56,58,157`,
`.nexus/project-context.md:63,145`, `SECURITY.md:106`. W1 agrega 6 tests, así que los 8 quedan viejos
a la vez.

En vez de escribir el número nuevo 8 veces (que es el defecto de la entrada 5 del auto-blindaje de
WKH-326):

- `README.md:29,30,772` **mantienen el número**: es la tabla de portada y el renglón de la corrida
  medida, y ahí el número es el contenido.
- `SECURITY.md:106` y `.nexus/project-context.md:145` pasan a describir la suite sin cifra, apuntando
  al renglón del README.
- `.nexus/project-context.md:63` deja de citar `(README.md:769)` — que **ya está corrido**, el texto
  está en `:772` — y pasa a citar el **título de la sección**. Un ancla no se desplaza cuando alguien
  edita 3 líneas más arriba.
- `doc/mutation-run.md:56,58,157` son **históricos** (43/54/55 son baselines de corridas pasadas) y
  **no se tocan**: reescribirlos borraría el "antes". Se agrega la baseline nueva como cuarta entrada.

De 8 sitios que hay que sincronizar a mano se pasa a 3, adyacentes, en un archivo. **Mutante que
restaura la dispersión: volver a escribir el literal en cualquiera de los otros 5.** Lo que reinicia
el límite: agregar o quitar un test.

### 4.5 Flujos

**Happy path (post-deploy):** el cliente arma `deposit` con las 9 cuentas → Anchor valida la ATA
canónica del beneficiario → se escriben los campos de `EscrowState` (`lib.rs:165-173`, sin cambios) →
CPI `transfer` `sender_ata → vault`. Después, dentro del deadline, `release` encuentra
`beneficiary_ata` existente **porque es la misma cuenta que el depósito exigió**.

**Camino de error nuevo:** el beneficiario no tiene ATA para el mint → la tx revierte en
`try_accounts`, **antes** de escribir `EscrowState` y antes de cualquier CPI. Cero lamports movidos,
cero cuentas creadas (`escrow_state` y `vault` son `init` y no llegan a inicializarse). El error dice
`AccountNotInitialized` y nombra `beneficiary_ata`. Remedio: una tx permisionada de
`createAssociatedTokenAccount`, ~0,002 SOL, la puede pagar cualquiera.

**Camino que sigue existiendo, y hay que decirlo:** ATA presente en el depósito, cerrada después → el
`release` falla igual que hoy, con 3012 sobre `beneficiary_ata`. Fijado en T15.

### 4.6 Impacto en el IDL y en el sha256 canónico — medido, no supuesto

MEDIDO sobre `target/idl/escrow.json` (md5 `c8e10be9…`, `main` @ `8fca472`):

| Cambio | ¿Aparece en el IDL? | Evidencia |
|---|---|---|
| Agregar un `constraint = …` | **No** | El IDL no representa constraints: `sender_ata` sale como `{"name":"sender_ata","writable":true}` y sus `token::mint`/`token::authority` no figuran |
| Agregar `address = <const>` a una cuenta | **Sí** | `token_program` sale con `"address":"Tokenkeg…"`. Es lo que descalifica a (c)-on-chain como cambio barato (§3.2) |
| Agregar una cuenta | **Sí** | y trae además un bloque `pda` |
| Agregar un `ErrorCode` | **Sí** | `errors` tiene 9 entradas, 6000..6008 |
| Editar un `///` o `//!` | **Sí** | `README.md:31`, medido en las dos direcciones |
| Editar un `///` sobre un `const` | **No** | no hay sección `constants` en este IDL (verificado: `'constants' in idl` es `False`) |

⇒ **Esta HU mueve el sha256 canónico del IDL por construcción**, porque agrega una cuenta. No hay
forma de hacer (a) sin moverlo.

El bloque `pda` que va a emitir para `beneficiary_ata` tiene la forma que ya emite para el
`beneficiary_ata` de `release` — seeds `[authority, const <token program>, mint]`, `program` = el
programa de ATA — con una diferencia: en la forma A el primer seed será `{"kind":"arg","path":
"beneficiary"}` en vez de `{"kind":"account","path":"beneficiary"}`. **W0.3 lo mide y lo escribe;
nadie lo supone.** Con `[features] resolution = true` (`Anchor.toml:7`), un cliente 0.30.1 *podría*
derivar esa cuenta del IDL — lo cual reduciría el cambio de `chaski-v3` a un re-pin. **No lo verifico
acá** (otro repo) y nada de este diseño se apoya en eso.

**Consecuencias, y la regla que las administra:**

- Los dos consumidores pinnean `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`
  (`chaski-v3` `bd85dfa`, `wasiai-facilitator` `f9bddce`). Con el hash movido, **cada uno va a tener 1
  test rojo**. Es esperado, es el mismo patrón que WKH-326, y **no se arregla desde acá** (CD-7).
- El hash nuevo vive **sólo** en `doc/sdd/004-.../idl-hash.md` hasta que W6 despliegue. No entra al
  README ni a `publish-idl-onchain.md` ni a ningún consumidor antes de eso (CD-4).
- Antes de creerle al canonicalizador, **hay que correrlo sobre una entrada de valor conocido**: sobre
  el IDL del árbol base tiene que devolver `bfbdfe5a…`. Si devuelve otra cosa, el canonicalizador está
  mal y el número nuevo no vale nada (auto-blindaje WKH-326 entrada 2: un snippet de python daba
  `447a05a7…` por `ensure_ascii`). El algoritmo bueno es el de
  `chaski-v3/contracts/idl/canonical-hash.ts`, **leído**, no importado ni copiado al repo.

#### Los tres doc comments falsos: qué se corrige acá y qué no

`README.md:31` documenta que hay 3 `///`/`//!` con texto falso, corregidos con `//` adyacentes, que
esperan "el próximo cambio que mueva el hash de todos modos". Esta HU es un cambio así **y además
republica el IDL** (W6.4), o sea que la ventana está abierta de verdad. Decisión:

| Doc comment | Qué dice de más | ¿Se corrige acá? |
|---|---|---|
| `lib.rs:530-546` (`Deposit.mint`) | Que un co-firmante off-chain rechaza mints inesperados. No existe (`:518-529`) | **SÍ.** Esta HU toca esta struct y le agrega un guard relacional. Dejarlo sería publicar en el IDL un párrafo falso **por dos motivos** en vez de uno, y que además contradice al guard nuevo |
| `lib.rs:30-32` + `:16-19` + `:27-28` (el `//!` del módulo) | "clamped", cuando `deposit` rechaza; y la tabla de instrucciones no menciona la exigencia nueva | **PARCIAL.** Se agrega la exigencia nueva a la tabla y al párrafo `:27-28`, porque esta HU la introduce. **No** se toca "clamped": es de otra HU, ya tiene su `//` al lado, y ampliar el diff del único archivo del money-path por prosa ajena agrega superficie de revisión sin ganancia funcional |
| `lib.rs:411-413` (`MAX_ENTRIES`) | Que el índice sólo lista escrows `Deposited` | **NO.** Ajeno a esta HU, ya tiene su bloque `//` (`:386-410`), y MEDIDO: al no haber sección `constants` en el IDL, ese `///` nunca llega al IDL, así que ni siquiera está publicado |

Regla de W2, textual: **se corrige el doc comment que esta HU vuelve falso; el que ya era falso antes
sigue con su `//` adyacente.** Y en `README.md:31` se anota que la ventana de W6 no se usó para los
otros dos y por qué, en vez de borrar el párrafo.

### 4.7 Orden de despliegue: por qué la cuenta va AL FINAL, y el hallazgo del `remainingAccounts`

`README.md` (sección "Deploying") documenta que para la cuenta `sender_ata` de `close` **no existe un
orden de despliegue seguro**: las dos combinaciones cruzadas fallan. Acá se puede hacer mejor, y sale
de leer el codegen.

MEDIDO en `anchor-syn` 1.1.2 `codegen/accounts/try_accounts.rs:48,51,64-65`: el único error de conteo
que Anchor genera es `AccountNotEnoughKeys`, o sea por cuentas **de menos**. Las que sobran quedan en
el slice residual, que `anchor-lang` 1.1.2 `src/context.rs:68` expone como `remaining_accounts`. No
hay chequeo de "exactamente N".

| Posición de `beneficiary_ata` | Cliente nuevo + programa viejo | Cliente viejo + programa nuevo |
|---|---|---|
| Insertada después de `sender_ata` | **Falla**: el programa viejo lee la cuenta 6 como `token_program` → programa inválido | Falla (cuenta de menos) |
| **Apendizada al final** | **Funciona**: le queda en `remaining_accounts`, y `Deposit` no las mira | Falla (cuenta de menos) |

⇒ Apendizándola al final, el orden **cliente primero, programa después** deja de tener una ventana en
la que los depósitos fallan.

#### ⚠️ Hallazgo que cambia el detalle: el cliente real YA manda una cuenta extra al final

MEDIDO leyendo `chaski-v3/src/infrastructure/solana-wallet.ts:410-417`: el `deposit` se arma con
`.accounts({sender, mint, escrowState, vault, senderAta})` y **`.remainingAccounts([{pubkey:
reference, ...}])`** — un pubkey de referencia estilo Solana Pay que el programa nunca lee. O sea que
**la última cuenta de la tx de hoy no es `system_program`: es `reference`.**

Tres consecuencias, y ninguna tumba el diseño:

1. **El orden cliente-primero sigue siendo seguro.** Cliente nuevo emite `[…8 declaradas…,
   beneficiary_ata, reference]`; el programa viejo consume 8 y deja las **dos** en
   `remaining_accounts`, que no mira. Funciona.
2. **El modo de falla del cliente viejo es engañoso, y hay que documentarlo.** Cliente viejo emite
   `[…8…, reference]`; el programa nuevo lee `reference` como `beneficiary_ata` y, como es un pubkey
   sin cuenta, tira `AccountNotInitialized` **nombrando `beneficiary_ata`**. La causa real es "el
   cliente no se actualizó", y el error apunta a otra cosa. Va escrito en el runbook y en el handoff.
3. **`reference` se corre de índice 8 a 9.** Si algo del lado de `chaski-v3` o de un explorador lee
   ese pubkey por posición fija en vez de por barrido de `accountKeys`, se rompe. **No lo verifiqué**
   (otro repo) y es un punto obligatorio del handoff, no una suposición de este SDD.

#### Cómo se verifica sin desplegar y sin el binario viejo a mano

- En bankrun (T14 de §7): llamar `deposit` con **una cuenta extra al final** y asertar que igual pasa.
  Prueba el mecanismo sobre la struct concreta. **Lo que NO prueba: el binario viejo**, porque bankrun
  carga el `.so` nuevo.
- Para el binario viejo, W6.1 corre un `simulateTransaction` con `sigVerify: false` contra devnet
  **antes** del upgrade, con la lista de cuentas nueva. Es sólo lectura, no requiere firma, y mide
  contra el binario que está corriendo de verdad.

### 4.8 El upgrade (W6) — autorizado, devnet, con gate

#### 4.8.1 Qué está autorizado y qué no

| | |
|---|---|
| **Autorizado** | `anchor deploy` del programa `escrow` a **devnet**, vía `scripts/deploy-devnet.sh` |
| **Prohibido** | Mainnet, en cualquier forma (CD-20). Ampliar el `programdata` si no entra (CD-21). Abrir, listar o referenciar `m5-keys/` (CD-2) |
| **Precondición operativa** | El path del keypair de `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` lo provee el founder (§2.9.1). El SDD no lo busca |

#### 4.8.2 Los pasos, y en este orden

| Paso | Qué | Aborta si |
|---|---|---|
| W6.0 | **GATE** de §4.8.5. Si no está cumplido, W6 **no arranca** | el gate no está cumplido |
| W6.1 | Preflight: `programdata-capacity.py` contra el artefacto **nuevo** (§2.9.2, el número a no superar es 412.568). `list-live-escrows.py` para enumerar y decidir. `simulateTransaction` con la lista de cuentas nueva contra el binario viejo (§4.7) | el binario no entra (CD-21), o hay un escrow vivo que el upgrade cambiaría de manos sin decisión escrita |
| W6.2 | `./scripts/deploy-devnet.sh <path del keypair>`. El script lee la authority de la cadena y aborta antes de mandar un byte si no coincide (`:79-89`) | cualquiera de sus dos preflights |
| W6.3 | **Verificación byte a byte contra la cadena**: `onchain-hash.py --expect-artifact-sha256 <nuevo> --expect-verify-hash <nuevo>`. Registrar el slot del deploy nuevo | los hashes no coinciden |
| W6.4 | Republicar el IDL (camino del buffer, `doc/publish-idl-onchain.md:135-146`: `anchor idl init` falla y está documentado). Actualizar los dos hashes del binario en `verified-build.yml` y el README, `SOURCE_REPRODUCES_CHAIN`, el slot en `README.md:25` y `SECURITY.md:99-105`, y la sección de cierre de `idl-hash.md` | — |
| W6.5 | Correr `list-live-escrows.py` otra vez y guardar la salida con su slot. Verificar que un `deposit` real contra el programa nuevo se comporta como T13 predice | — |

#### 4.8.3 Los dos controles que se reusan, en vez de inventar

1. **`onchain-hash.py --expect-*`**: es el mismo control con el que se verificó el upgrade de
   `6b0bd67` (slot `481495859`, hashes `59ec1098…` / `455e4e36…`, §2.9.1). No hace falta escribir
   nada nuevo.
2. **`programdata-capacity.py`**: corre **antes** de mandar un byte, y ya está encadenado dentro de
   `deploy-devnet.sh:103-107`. Correrlo aparte en W6.1 es para tener el número **antes** de decidir.

#### 4.8.4 Lo que el upgrade NO hace

- **No recupera nada.** Los 40 USDC volvieron por `refund` (§2.8) y los 0,016008 SOL de alquiler
  siguen inmovilizados hasta que alguien llame `close` (§2.8.2). Un upgrade no toca ninguna de las
  dos cosas.
- **No arregla los depósitos ya hechos.** El guard nuevo aplica a `deposit`, o sea a lo que venga.
- **No valida el mint.** Eso es (c), y vive en otro repo (§3.2).

#### 4.8.5 El GATE, y no es opcional

> **W6 no se ejecuta hasta que `chaski-v3` mande `beneficiary_ata` en su `deposit`, y hasta que el
> beneficiario en uso tenga ATA para el mint en uso.**

Las dos mitades, con lo que las hace verificables:

| Mitad | Por qué | Cómo se verifica |
|---|---|---|
| El cliente manda la cuenta | Si no, el programa nuevo lee `reference` como `beneficiary_ata` y **todo depósito falla** (§4.7). El diseño append-last hace que el cliente nuevo funcione contra el programa viejo, así que **cliente primero no tiene ventana de falla** | Con el `simulateTransaction` de W6.1 contra el binario viejo, y con un depósito real de `chaski-v3` antes del deploy |
| El beneficiario tiene ATA | Si no, el programa nuevo rechaza el 100% de los depósitos (§3.4). MEDIDO al slot `482578601`: hoy **no la tiene** para el mint de Circle | Con el chequeo nuevo del script (W3): `beneficiary can receive: yes` |

**Y esto es lo importante: el gate depende de un cambio en `chaski-v3`, que está fuera del Scope IN de
esta HU (CD-7).** O sea que esta HU puede **implementar, testear, mutar y dejar listo** el upgrade,
pero su ejecución depende de una HU de otro repo. Las dos salidas posibles, y las dos son legítimas:

- **A** — Se abre la HU de `chaski-v3` primero; cuando aterriza, W6 corre. Es el camino sin ventana de
  falla, y el que recomiendo.
- **B** — El founder acepta explícitamente una interrupción de depósitos y W6 corre antes. Entonces
  hay que decir cuánto dura y quién avisa. **Este SDD no elige B por su cuenta.**

Escribirlo así, y no como "desplegar cuando esté listo", es la diferencia entre un plan y una
intención: si alguien corre W6 sin el gate, el resultado medible es que ningún depósito entra.

---

## 5. Constraint Directives

### Heredados del work-item

- **CD-1** — **REESCRITO por autorización del founder del 2026-08-10.** El upgrade del programa a
  **devnet** está AUTORIZADO y se planifica en W6, con el gate de §4.8.5. Sigue **PROHIBIDO**:
  mainnet en cualquier forma; ampliar el `programdata` si el binario no entra (se reporta, no se
  paga); y mover fondos por iniciativa del Dev — los 4 refunds los ejecutó el founder (§2.8), y los 4
  `close` del alquiler son residuo declarado (§2.8.2), no trabajo de esta HU.
- **CD-2** — PROHIBIDO abrir, listar o citar `m5-keys/`, **incluso para averiguar si la llave de la
  upgrade authority está ahí**. Si la conclusión es que sólo puede venir de ahí, se escribe como
  pregunta al founder y se sigue (§2.9.1).
- **CD-3** — OBLIGATORIO que la opción elegida esté respaldada por la medición 1. Cumplido y
  documentado en §3.7.
- **CD-4** — Reinterpretado y ampliado, no relajado. Esta HU **mueve el hash por construcción**
  (§4.6), así que la regla operativa es: (i) el hash nuevo vive sólo en
  `doc/sdd/004-.../idl-hash.md` **hasta W6.4**; (ii) no se re-pinnea en ningún consumidor en ninguna
  wave (CD-7); (iii) se corrige el doc comment que **esta HU** vuelve falso y ninguno más (§4.6).
- **CD-5** — PROHIBIDO escribir en el repo una afirmación sobre saldo, cuenta o estado on-chain sin
  fecha **y slot** en la misma línea. Se extiende: una fecha sin slot no alcanza, y una oración con
  fecha escrita como propiedad vigente tampoco (§2.7 caso 6 es la prueba, y §2.8 la volvió a probar en
  la misma sesión).

### Nuevos de este SDD

- **CD-6** — OBLIGATORIO que `Deposit.beneficiary_ata` valide **exactamente lo mismo** que
  `Release.beneficiary_ata` (`associated_token::mint` + `associated_token::authority`). PROHIBIDO
  `token::` en su lugar: aceptaría depósitos que `release` rechazaría (§3.3).
- **CD-7** — PROHIBIDO escribir en `chaski-v3`, `wasiai-facilitator`, `wasiai-a2a` y
  `wasiai-remittance-agents`. Se los puede **leer** para medir impacto. Sus tests de hash van a quedar
  rojos y eso es el resultado esperado, no un pendiente de esta HU.
- **CD-8** — PROHIBIDO `init` o `init_if_needed` sobre `beneficiary_ata` en cualquier instrucción
  (§3.1). Un `init_if_needed` acá completa el pago del activo equivocado y le saca la salida al
  `refund`.
- **CD-9** — PROHIBIDO tratar el `target/deploy/escrow-keypair.json` que `anchor build` genere en el
  worktree como si fuera la llave del programa (§1.2). El deploy usa el keypair que da el founder, por
  argumento, y nada más.
- **CD-10** — OBLIGATORIO, antes de tocar nada: `anchor build` y registrar los md5 de
  `target/deploy/escrow.so`, `target/idl/escrow.json` y `programs/escrow/src/lib.rs`. Después de cada
  mutante, **restaurar Y rebuildear**, comparando los tres md5 contra esa referencia en vez de
  suponerlos (`doc/mutation-run.md:48-52`, trampa 1 del project-context).
- **CD-11** — OBLIGATORIO que cada test de revert nuevo pinnee el **nombre** del código de Anchor
  (nunca el número: los códigos de constraint no son parte del contrato de este repo, los de
  `ErrorCode` sí) y, cuando el punto del test sea *qué cuenta* falló, que asertee además
  `error.origin` o la línea `AnchorError caused by account: <nombre>` (§4.2).
- **CD-12** — PROHIBIDO cambiar la firma de `deposit` (los 5 args) y PROHIBIDO tocar el layout de
  `EscrowState`. Los 154 bytes son el canario de `tests/escrow.ts:283-290`. Y ahora hay 8 cuentas en
  cadena cuyo alquiler depende de que sigan deserializando (§2.8.2).
- **CD-13** — PROHIBIDO agregar un `ErrorCode` en la forma A. En la forma B, el único permitido es
  `BeneficiaryMismatch` **apendizado al final** (6009), nunca insertado.
- **CD-14** — PROHIBIDO modificar los helpers existentes de `tests/escrow.ts` de forma que cambie
  algún call site actual. Se parametrizan con un argumento **opcional al final** que default al `mint`
  de módulo, para que los 10 tests vigentes queden byte a byte iguales.
- **CD-15** — PROHIBIDO `it.skip`, `describe.skip` y `existsSync + it.skip`. Si falta el artefacto de
  build la suite tiene que explotar (`tests/escrow-index.ts:25-27`). AC-2 exige 0 saltados.
- **CD-16** — OBLIGATORIO que cada `.txt` de evidencia cruda traiga cabecera con pasada, baseline,
  commit del fuente, md5 de `lib.rs`, y un discriminador derivable del propio contenido
  (auto-blindaje WKH-326 entrada 6).
- **CD-17** — PROHIBIDO usar `git status | head` (ni ningún pipe que colapse) como prueba de "no toqué
  X". `git status --porcelain` completo, más `ls -l` de los archivos concretos que serían la violación
  (auto-blindaje WKH-326 entrada 3).
- **CD-18** — PROHIBIDO presentar `min..max` de N corridas como si fuera una cota. Si no se conoce el
  mecanismo, se escribe el mecanismo o se escribe "no acotado". Para el CU de `deposit` el mecanismo
  ya está medido en cadena: **≡ 975 (mod 1500)** en las 4 txs reales (§2.8.4). El delta de la cuenta
  nueva se reporta como cambio del residuo.
- **CD-19** — PROHIBIDO `cargo fmt` sobre el programa. El árbol no pasa `--check` hoy y no está
  enforced; reformatear como efecto colateral haría ilegible el diff del único archivo del money-path.
- **CD-20** — PROHIBIDO cualquier operación contra mainnet. `scripts/deploy-devnet.sh` pinnea el
  cluster (`:119-122`) y así se queda.
- **CD-21** — PROHIBIDO ampliar el `programdata`. Si W6.1 dice que el binario no entra, el upgrade
  **no se ejecuta**: se reporta el faltante en bytes y el rent que costaría, con la referencia de la
  ampliación anterior (+150.000 bytes ⇒ 1,044 SOL, irreversible).
- **CD-22** — PROHIBIDO ejecutar W6 sin el gate de §4.8.5 cumplido, y PROHIBIDO declararlo cumplido
  sin la salida del script que lo demuestre (`beneficiary can receive: yes`) y sin la simulación
  contra el binario viejo.
- **CD-23** — OBLIGATORIO que, entre W2 y W6.4, `README.md:25` y `SECURITY.md:99-105` digan que el
  árbol **diverge** de lo desplegado, y PROHIBIDO que en esa ventana digan o insinúen que ya se
  desplegó. `SOURCE_REPRODUCES_CHAIN` no se toca hasta W6.4: el CI en rojo en esa ventana es correcto.

---

## 6. Waves

W0 es serial y es un gate. W1, W3 y W4 no comparten archivos y pueden ir en paralelo (con la salvedad
de que W4 consume la salida de W3). W2 depende de W1. W5 depende de W2. W6 depende de W5 **y del gate
de §4.8.5**.

### W0 — serial, gate. Baseline y el spike que decide la forma

| Paso | Qué | Salida |
|---|---|---|
| W0.1 | `anchor build` en el worktree. Registrar los 3 md5 (CD-10). Correr la suite: **55 passing, 0 failing** | `w0-baseline.txt` con la cabecera de CD-16 |
| W0.2 | **SPIKE**: ¿`associated_token::authority = <arg de instrucción>` compila en Anchor 1.1.2? Agregar sólo la cuenta y el `#[instruction(...)]`, `anchor build`, guardar la salida del compilador **compile o no**. Restaurar y rebuildear (CD-10) | `w0-spike-form-a.txt`. Decide forma A o B (§4.2) |
| W0.3 | Con la forma elegida, medir el sha256 canónico nuevo, el bloque `pda` de `beneficiary_ata` y el orden final de cuentas. **Antes**, correr el canonicalizador sobre el IDL base y comprobar que da `bfbdfe5a…`; si no, parar | `idl-hash.md` |

Criterio de salida: la forma está decidida **con la salida del compilador en un archivo**, y el
canonicalizador reprodujo un valor conocido.

### W1 — tests primero, en rojo (∥ con W3)

`tests/escrow.ts` únicamente. Los 6 tests de §7 + los helpers + `expectRevertOnAccount`. Contra el
programa **sin cambiar**, T10..T13 tienen que FALLAR (el depósito pasa cuando no debería) y T14/T15
tienen que pasar. Esa es la evidencia de que los tests miran algo.

Salida: `w1-red.txt`, con cabecera y el conteo `passing + failing`.

⚠️ Auto-blindaje entrada 1: **ningún assert de T13 va dentro de un loop** de forma que aborte antes de
llegar al caso que la HU tiene que exhibir.

### W2 — el programa (depende de W1)

`programs/escrow/src/lib.rs` únicamente. La cuenta, el `#[instruction(...)]`, y las correcciones de
doc comment del §4.6 (una `///` completa, dos renglones del `//!`, y nada más). Al final: `anchor
build` + suite → **61 passing, 0 failing**.

### W3 — el script (∥ con W1)

`scripts/list-live-escrows.py` únicamente. Los 4 cambios de §4.3. Verificación: correrlo contra
devnet (sólo lectura) y comprobar que (i) ningún renglón menciona un upgrade, (ii) el chequeo de la
ATA del beneficiario imprime `no` para el mint de Circle, (iii) la salida trae su slot. Guardarla.

### W4 — prosa y runbook (después de W3)

`README.md`, `SECURITY.md`, `doc/publish-idl-onchain.md`, `.nexus/project-context.md`, y crear
`runbook-deploy.md`. Los 8 sitios de §4.4 + los 2 del AC-5 en su forma **pre-deploy** (CD-23) + la
reducción del literal `55`.

⚠️ Paso final obligatorio de W4: re-verificar que ningún `archivo:línea` citado en el README, en
`SECURITY.md` o en este SDD quedó corrido por las propias ediciones de W4. Los barridos miran lo que
escribiste, no lo que desplazaste.

### W5 — mutantes (depende de W2)

M20..M24 de §9.1, uno a la vez, con el protocolo de md5 de CD-10. Capturas crudas en
`doc/sdd/004-.../w5/` con cabecera. Sección nueva en `doc/mutation-run.md` y la cuarta baseline.

### W6 — el upgrade a devnet (depende de W5 y del GATE de §4.8.5)

Los 6 pasos de §4.8.2. Requiere el path del keypair del founder (§2.9.1) y el gate cumplido (CD-22).
Si el gate no se cumple, **W6 no arranca y la HU se cierra sin desplegar**, con el estado exacto
escrito en el report. Eso no es un fracaso de la HU: es el orden que evita cortar los depósitos.

---

## 7. Plan de tests

Todos en `tests/escrow.ts`. Numeración: continúa desde el test 9 (`:574`).

| # | Test | Qué cubre | Estado esperado en W1 (pre-fix) |
|---|---|---|---|
| T10 | `deposit` cuyo beneficiario NO tiene ATA para el mint revierte con `AccountNotInitialized`, `error.origin == "beneficiary_ata"`; y después `escrow_state` **no existe**, `vault` **no existe**, y el saldo de `sender_ata` quedó igual | El caso medido en §2.2. Es el AC-1 | **FALLA** (el depósito pasa) |
| T11 | `deposit` pasando una ATA del beneficiario **de otro mint** revierte, con el nombre del código pinneado | La confusión de mints de §2.3, del lado del destino | **FALLA** |
| T12 | `deposit` pasando una token account del mint correcto pero **de otro dueño** revierte | Que el guard mire al beneficiario y no a cualquiera. Mata M21 | **FALLA** |
| T13 | **Regresión del incidente**, extremo a extremo: beneficiario con ATA sólo en el mint A; `deposit` sobre el mint B **revierte**; se crea la ATA del beneficiario para B; el **mismo** `deposit` ahora entra y un `release` dentro del deadline paga el monto exacto | La HU entera, con la forma del incidente. Y demuestra el remedio de una transacción del §3.4 | **FALLA** en la primera mitad |
| T14 | Happy path con **una cuenta extra al final** de la lista → pasa | El mecanismo del que depende el orden de despliegue de §4.7, y el que hace que el `reference` de `chaski-v3` no estorbe. **No** prueba el binario viejo | **PASA** |
| T15 | El beneficiario **cierra** su ATA después de un `deposit` válido → `release` revierte con `AccountNotInitialized` sobre `beneficiary_ata` | El **límite** del fix (§3.3). Es el test de honestidad: existe para que nadie lea "esto ya no puede pasar" | **PASA** (mide el estado actual, que el fix no cambia) |

Baseline nueva: **61 passing, 0 failing** (55 + 6). Ninguno saltado (CD-15, AC-2).

### Helpers a agregar (CD-14: sin tocar ningún call site actual)

- `createMint6(mintAuthority)` ya está parametrizado (`tests/escrow.ts:79-104`): se llama dos veces, sin cambios.
- `createAta(owner, mintOverride = mint)`, `mintTo(dest, amount, mintOverride = mint)`,
  `pdas(rid, mintOverride = mint)`: parámetro **opcional al final**. Los 10 call sites vigentes quedan
  idénticos.
- `expectRevertOnAccount(p, code, accountName)`: **helper nuevo**, no una modificación de
  `expectRevert` (`:218-239`). Asertea el código igual que el viejo y además
  `e.error.origin === accountName`, con fallback a que los logs contengan `AnchorError caused by
  account: <accountName>`. El fallback es necesario porque en bankrun no todo error llega como
  `AnchorError` — el `expectRevert` existente ya tiene esa doble vía por el mismo motivo.

### Lo que los tests NO cubren, dicho antes de que alguien lo pregunte

- **Ninguno corre contra el binario desplegado.** bankrun carga `target/deploy/escrow.so`. Lo que pasa
  en devnet se verifica en W6.1 (simulación) y W6.5 (depósito real).
- **Ninguno usa el mint real de Circle.** No se puede mintear en bankrun
  (`tests/escrow-index.ts:29`). Los dos mints de los tests son sintéticos de 6 decimales. Se reproduce
  la **forma** del incidente (dos mints, ATA en uno), no sus direcciones.
- **Ninguno mide el compute contra la cadena.** El delta se reporta con su mecanismo (CD-18), y la
  referencia de producción es §2.8.4: `deposit` ≡ 975 (mod 1500), peor caso real medido 38.475 CU
  contra los 120.000 que declara el cliente.

---

## 8. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | Se despliega (a) sin que `chaski-v3` mande la cuenta ⇒ **todos** los depósitos fallan, con un error que además apunta a la cuenta equivocada (§4.7) | **Alta** si se ignora el gate | **Alto**: corta el producto | GATE de §4.8.5 + CD-22. El diseño append-last hace que cliente-primero no tenga ventana de falla. W6.1 lo simula contra el binario viejo |
| R2 | Se despliega (a) sin crear antes la ATA del beneficiario ⇒ todos los depósitos fallan | **Alta**: hoy no existe (slot `482578601`) | Alto | Segunda mitad del gate. Lo verifica el chequeo nuevo de W3 |
| R3 | El spike W0.2 falla y la forma B agrega 2 cuentas + 1 error ⇒ diff más grande | Media | Medio | Las dos formas están especificadas. B no cambia la decisión, sólo su costo |
| R4 | El hash del IDL se mueve y alguien lo re-pinnea antes de W6.4 "para poner el CI en verde" | Media | Alto: pinnearía un IDL que no está en cadena | CD-4 + CD-7 + CD-23. El rojo de los consumidores y del `verified-build` es el resultado esperado en la ventana W2→W6.4 |
| R5 | (c) queda sin dueño y el mint sigue sin validarse aguas arriba | Media | Medio-alto | Handoff explícito a `wasiai-facilitator` (§3.6) y en el report. **Esta HU no lo cierra y no dice que lo cierre** |
| R6 | Se restaura un mutante sin rebuildear y la suite reporta fallas del binario mutado | Media (pasó dos veces en este repo) | Alto | CD-10, protocolo de md5 |
| R7 | Las ediciones de W4 corren los `archivo:línea` que W4 acaba de escribir | **Alta** | Bajo por hallazgo, alto en volumen | Paso final de W4; cada cita lleva además el **texto** a buscar |
| R8 | El beneficiario cierra su ATA entre depósito y release | Baja (no tiene incentivo) | Medio | Fuera del alcance de (a). Fijado en T15 y escrito como límite en §3.3 |
| R9 | El binario nuevo no entra en el `programdata` | **Baja**: 137.768 bytes de margen (§2.9.2) | Alto (1,044 SOL de referencia) | W6.1 lo mide contra el artefacto nuevo. **CD-21: no se paga, se reporta** |
| R10 | El deploy se hace con un keypair que no es la authority ⇒ sube el binario entero y muere en el loader | Baja | Medio (buffer con SOL colgado) | `deploy-devnet.sh:76-89` lo compara contra la cadena y aborta antes de mandar un byte |
| R11 | `reference` se corre de índice 8 a 9 y algo del lado del cliente lo lee por posición | **No medido** (otro repo) | Medio | Punto obligatorio del handoff a `chaski-v3` (§4.7, consecuencia 3). No se asume que esté bien |
| R12 | Un cambio de layout de `EscrowState` inmoviliza para siempre los 0,016008 SOL de las 8 cuentas vivas | Baja | Bajo en valor, permanente en tipo | CD-12 + el canario de `tests/escrow.ts:283-290` |

---

## 9. Lo que este SDD NO cierra: el mutante de una línea, caso por caso

Regla de esta sesión: si puedo nombrar un mutante de una línea que restaura el comportamiento viejo,
la frase no puede decir "elimina". Acá está la lista, y es también la lista de mutantes de W5.

### 9.1 Mutantes del guard nuevo (van a `doc/mutation-run.md`)

| # | Mutante (una línea) | Qué restaura | Tests que tienen que morir |
|---|---|---|---|
| M20 | Borrar el campo `beneficiary_ata` de `Deposit` | El comportamiento exacto de hoy: el depósito acepta un beneficiario que no puede recibir | T10, T11, T12, T13 |
| M21 | `associated_token::authority = beneficiary` → `= sender` | Un guard que mira al remitente. Pasaría cualquier depósito en que el **sender** tenga ATA, o sea todos | T12, T13 |
| M22 | `Account<'info, TokenAccount>` → `UncheckedAccount<'info>` | Desaparece la exigencia de que exista, y con ella el 3012 **y** el nombre de cuenta | T10, T13 |
| M23 | `associated_token::mint/authority` → `token::mint/authority` | Acepta cualquier token account del beneficiario, incluida una que no es la ATA canónica que `release` exige | T11, T13 |
| M24 | (forma B únicamente) Borrar el `require_keys_eq!` del cuerpo | El guard valida la ATA de una cuenta y graba otro beneficiario | un test específico de la forma B |

### 9.2 Afirmaciones de este SDD, con su mutante y con lo que reinicia su límite

| Afirmación | Mutante de una línea | Qué reinicia el límite |
|---|---|---|
| "Si el `deposit` entró, el `release` no falla por esta causa" | M20 / M23 | El beneficiario cerrando su ATA después del depósito (T15). **Por eso no digo "elimina": acota el caso "nunca existió" y deja abierto "existía y se cerró"** |
| "El 3012 es distinguible entre `sender_ata` y `beneficiary_ata`" | M22 | Un consumidor que sólo mire `errorCode.code`. Distingue **el que lee `origin` o los logs**, no el que lee el número |
| "El orden cliente-primero no tiene ventana de falla" | Mover `beneficiary_ata` una posición hacia arriba (§4.7) | Nada del lado del programa; sí un cliente que arme la lista por posición fija (R11) |
| "`--markdown` hace que el README no envejezca" | **No hace falta un mutante: la frase es falsa y no la escribo.** El "mutante" es que nadie corra el comando | Cualquier actividad en devnet. Medido: 4 filas de §2.1 cambiaron de estado entre los slots `482578481` y `482583139`, dentro de esta sesión |
| "El literal 55 deja de estar disperso" | Volver a escribirlo en cualquiera de los 5 sitios de los que se saca | Agregar o quitar un test: los 3 sitios que quedan siguen siendo manuales |
| "El upgrade no necesita más rent" | Ninguno de código: es una **derivación** (§2.9.2) hasta que W6.1 la mida contra el artefacto nuevo | Cualquier cosa que haga crecer el binario ~137.768 bytes. El número a no superar es 412.568 |
| "Los 40 USDC volvieron" | Ninguno: está medido (§2.8.1, slots `482579398`..`482580179`, ATA del sender 10.000.000 → 50.000.000) | Nada. Es un hecho pasado. **Y el arreglo no tuvo nada que ver: previene, no recupera** |
| "El script detecta el problema hoy, sin deploy" | Borrar el `getTokenAccountsByOwner` nuevo | Que nadie lo corra. Es un detector, no un guard: no impide nada |
| "El alquiler se recupera con `close`" | Ninguno de código: `close` existe y funcionó en cadena (slot 482045751) | Que nadie llame `close`. Los 0,016008 SOL siguen inmovilizados hasta entonces (§2.8.2) |

---

## 10. Auto-Blindaje heredado

Paso obligatorio. `doc/sdd/_INDEX.md` tiene **una** HU en estado DONE (WKH-326), así que **no puedo
establecer "patrón recurrente" en el sentido de ≥2 HUs con el mismo error**: no hay universo para eso,
y decir que lo hay sería inventar una estadística. Lo que sí hago es heredar las 6 entradas de
`003-.../auto-blindaje.md`, de las que **5 son directamente aplicables**:

| Entrada de WKH-326 | Cómo se aplica acá | Dónde quedó |
|---|---|---|
| 1 — un assert por iteración tapaba el error que el test tenía que mostrar | T13 tiene dos mitades y la primera tiene que fallar; ningún assert puede abortar antes | W1, §6 |
| 2 — el canonicalizador de hash no reproducía un valor conocido | Antes de creerle al hash nuevo, tiene que devolver `bfbdfe5a…` sobre el IDL base | W0.3, §4.6 |
| 3 — `git status \| head` dijo "limpio" sobre un árbol sucio | Verificar "no toqué chaski-v3" con `--porcelain` completo + `ls -l` de archivos nombrados | **CD-17** |
| 4 — un rango medido presentado como cota | El CU de `deposit` va con su congruencia (≡ 975 mod 1500, §2.8.4), no con un `min..max` | **CD-18** |
| 5 — un criterio pass/fail escrito como literal envejeció y acusó a quien restauró bien | El literal `55` está en 8 sitios y esta HU lo mueve: se **reduce a 3**, no se actualiza 8 veces | §4.4, W4 |
| 6 — la evidencia cruda quedó de una pasada y la prosa de otra | Cada `.txt` con cabecera y un discriminador derivable del contenido | **CD-16** |

Y tres lecciones que este SDD agrega por su cuenta, las tres medidas hoy:

1. **Una afirmación sobre la cadena con fecha correcta puede ser falsa igual.** `README.md:540-546`,
   fechada 2026-08-05, envejeció en 3 días sin que nadie editara el archivo. La fecha dice cuándo se
   midió, no que siga siendo cierto. ⇒ extensión del CD-5, y el `--markdown` de W3.
2. **Un `archivo:línea` corrido por uno se lee plausible.** El AC-4 apuntaba a `README.md:27` y el
   caso está en `:26`; `:27` es una afirmación verdadera, así que el verificador habría visto algo
   coherente y seguido de largo. ⇒ cada cita de este SDD lleva el **texto** a buscar, no sólo el
   número.
3. **Medí desde el directorio equivocado y anoté un desajuste que no existía.** `rustc` da 1.97.1
   afuera del checkout y 1.89.0 adentro (§2.9.3). ⇒ toda medición de toolchain se hace desde la raíz
   del repo, y se dice desde dónde.

---

## 11. Uncertainty markers

| Marker | Sección | Descripción | ¿Bloquea? |
|---|---|---|---|
| `[NEEDS CLARIFICATION]` | §3.2, §3.4 | **¿Cuál es el mint pretendido en devnet: el de Circle (`4zMMC9srt…`) o el nuestro (`8yRX3fZ2…`)?** No determinable desde este repo. Decide si "el mint estaba mal" o "el provisioning del beneficiario estaba mal" | **No** bloquea `SPEC_APPROVED` ni la implementación (§3.2.2: el diseño es robusto a las dos ramas). **Sí bloquea W6**: hay que saber para qué mint crear la ATA |
| `[NEEDS CLARIFICATION]` | §3.4, §4.8.5, R2 | **¿Quién provisiona la ATA del beneficiario, y en qué momento del flujo?** El work-item ya lo marcó (origen de la dirección, TransFi) | **No** para implementar. **Sí para W6**: es la mitad 2 del gate |
| `[NEEDS CLARIFICATION]` | §4.8.5 | **¿Camino A (HU de `chaski-v3` primero) o camino B (interrupción de depósitos aceptada)?** Es una decisión del founder, no del SDD | **Sí bloquea W6.** No bloquea W0..W5 |
| `[NEEDS CLARIFICATION]` | §2.9.1 | **Path del keypair de `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`.** El repo sólo tiene placeholders, y `~/.config/solana/id.json` no existe. `m5-keys/` no se abre ni se referencia (CD-2) | **Sí bloquea W6.2.** No bloquea nada más |
| `[TBD]` | §4.2 | Forma A vs forma B: la decide el compilador en W0.2 | **No.** Las dos están especificadas |
| `[TBD]` | §4.6 | El sha256 canónico nuevo y el bloque `pda` exacto de `beneficiary_ata` | **No.** Se miden en W0.3 |
| `[TBD]` | §4.7, R11 | Si algo de `chaski-v3` lee `reference` por posición fija | **No** para este repo. Punto obligatorio del handoff |

**Ningún `[NEEDS CLARIFICATION]` bloquea `SPEC_APPROVED`.** Los dos que el work-item marcaba como
bloqueantes de F2 (mediciones 1 y 3) están **resueltos y medidos** en §2.1-2.5. Cuatro bloquean W6, y
eso está escrito como gate en vez de descubrirse en el momento del deploy.

---

## 12. Cómo repetir cada medición

Todo lo de §2 es **sólo lectura**: `urllib` contra el RPC público de devnet, sin keypair, sin firma.
El slot que devuelvan va a ser mayor que el de este documento; lo que importa es que cada corrida
imprima el suyo.

```bash
cd /home/ferdev/.openclaw/workspace/solana-programs

# §2.1 y §2.8 — los EscrowState, su estado, y el header con el slot.
#               Necesita target/idl/escrow.json (de `anchor build`) para el discriminador.
python3 scripts/list-live-escrows.py --url devnet

# §2.2 — ¿tiene el beneficiario una cuenta de token para cada mint?
#        (después de W3, esto lo imprime el script de arriba, por escrow)
curl -s https://api.devnet.solana.com -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner",
  "params":["Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq",
            {"mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"},
            {"encoding":"jsonParsed"}]}'
# esperado: "value": []   ← cero cuentas. Con el mint 8yRX3fZ2... da una, con 12500000.

# §2.4, §2.5 y §2.8.1 — la historia de un escrow: qué instrucciones aterrizaron y en qué slot
curl -s https://api.devnet.solana.com -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress",
  "params":["Crqz6hQoChPaP3TVPU4H7kbXo4FPUXz3NzriG3JYmWdw",{"limit":20}]}'
# y por cada firma, getTransaction con jsonParsed: los logs traen
# "Program log: Instruction: Deposit|Refund|Close", meta.err y meta.computeUnitsConsumed

# §2.8.2 — el alquiler que quedó inmovilizado (lamports de las 8 cuentas)
curl -s https://api.devnet.solana.com -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"getAccountInfo",
  "params":["2zWkoznm86cqX6bWExsR3Wvw5njffDpxuCJCXTsT7LWb",{"encoding":"base64"}]}'
# esperado: lamports 1962720, space 154, y el byte de status en offset 8+32*4+8+8 == 2 (Refunded)

# §2.7 — la cuenta del IDL on-chain que publish-idl-onchain.md:48 dice que no existe
curl -s https://api.devnet.solana.com -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"getAccountInfo",
  "params":["7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC",{"encoding":"base64"}]}'
# esperado: existe, owner ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S, space 5292

# §2.9.1 — la upgrade authority, el slot del último deploy y los dos hashes del binario
python3 scripts/onchain-hash.py --program-id DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x --url devnet

# §2.9.2 — ¿entra el binario en el espacio ya reservado?
python3 scripts/programdata-capacity.py \
  --program-id DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  --artifact target/deploy/escrow.so --url devnet

# §2.9.3 — el toolchain, y hay que correrlo DESDE LA RAIZ DEL REPO (lección 3 de §10)
rustc --version    # 1.89.0 adentro del checkout; 1.97.1 afuera. El de adentro es el que cuenta
solana --version   # 3.1.10 (Agave) — es el que elige el compilador que emite el .so
anchor --version   # 1.1.2
```

Y las cinco afirmaciones sobre Anchor de §4.2 y §4.7, que se verifican **leyendo**, no corriendo:

```
anchor-syn  1.1.2  src/codegen/accounts/constraints.rs:1269-1324   qué chequea associated_token::
anchor-syn  1.1.2  src/codegen/accounts/try_accounts.rs:48,64,87   cuentas de menos / with_account_name
anchor-lang 1.1.2  src/lib.rs:541-545                              impl Key for Pubkey
anchor-lang 1.1.2  src/accounts/account.rs:313-318                 de dónde sale AccountNotInitialized
anchor-lang 1.1.2  src/context.rs:68                               las cuentas de sobra van a remaining_accounts
node_modules/@coral-xyz/anchor/dist/cjs/error.js:113,132-139       origin es un string
chaski-v3   src/infrastructure/solana-wallet.ts:410-417            .accounts(5) + .remainingAccounts([reference])
```

---

## 13. Readiness Check

| # | Criterio | Estado |
|---|---|---|
| 1 | Los 2 bloqueantes de F2 del work-item están resueltos con medición fechada y con slot | **SÍ** — §2.1-2.5, slots `482578481`..`482579471` |
| 2 | La opción de diseño está elegida y argumentada **contra el dato**, no contra una opinión | **SÍ** — §3. (a) elegida; (b) rechazada con 4 argumentos, el primero imposible de escribir antes de §2.8; (c) degradada a handoff con el argumento de §3.2.2 |
| 3 | AC-6 cumplido: consta que la elección se validó contra la medición antes de implementar | **SÍ** — §3.7, con el contrafáctico |
| 4 | Todos los exemplars existen (verificados con Read en esta sesión) | **SÍ** — §1 y §1.1. Ningún path inventado |
| 5 | El impacto en el IDL está **medido**, no supuesto | **SÍ** — §4.6, tabla de 6 filas contra `target/idl/escrow.json` |
| 6 | Los CDs del work-item están heredados; CD-1 actualizado por la autorización nueva sin perder lo prohibido | **SÍ** — §5. CD-1 reescrito, CD-2 reforzado, CD-20..CD-23 nuevos |
| 7 | Cada afirmación de "ya no puede pasar" tiene su mutante de una línea nombrado | **SÍ** — §9.2, 9 filas, incluida una donde la frase se declara falsa y no se escribe |
| 8 | El plan de tests dice qué **no** cubre | **SÍ** — §7, tres límites, y T15 existe sólo para fijar uno de ellos |
| 9 | Auto-Blindaje histórico leído y aplicado | **SÍ** — §10. 5 de 6 entradas ⇒ CD-16, CD-17, CD-18, W0.3, W1. Más 3 lecciones nuevas medidas hoy |
| 10 | Ningún `[NEEDS CLARIFICATION]` bloquea `SPEC_APPROVED` | **SÍ** — §11: 4 abiertos, 4 bloquean **W6** y ninguno bloquea F2.5/F3, y para cada uno está escrito qué bloquea |
| 11 | El upgrade está planificado con sus precondiciones **medidas**, no supuestas | **SÍ** — §2.9: authority `4wPhH4dC…` leída de la cadena; 137.768 bytes de margen; toolchain alineado. La cuarta (el keypair) es operativa y está escrita como tal |
| 12 | `m5-keys/` no fue abierta, listada ni usada como respuesta | **SÍ** — §2.9.1 concluye leyendo `README.md`, `deploy-devnet.sh` y `doc/publish-idl-onchain.md`, y escribe la pregunta al founder |
| 13 | El SDD no dice en ningún lugar que el arreglo destraba o recupera fondos | **SÍ** — §0.1, §2.8.3, §4.8.4 y la fila correspondiente de §9.2 lo dicen al revés y de forma explícita |
| 14 | No se escribió código de producción en F2, y no se desplegó nada | **SÍ** — el único archivo creado es este `sdd.md`. Todas las llamadas RPC de esta sesión fueron de lectura |
| 15 | Waves con archivos exactos y sin dos waves escribiendo el mismo archivo en la misma fase | **SÍ** — §6. W1→`tests/escrow.ts`, W2→`lib.rs`, W3→el script, W4→prosa (pre-deploy), W5→`mutation-run.md`, W6→deploy + prosa post-deploy |
| 16 | El deploy tiene un gate escrito, con lo que lo verifica, y con las dos salidas posibles nombradas | **SÍ** — §4.8.5 + CD-22. Y está dicho que el gate depende de otro repo |

**Veredicto: LISTO para `SPEC_APPROVED`.**

Lo que este SDD **no** resuelve y no pretende: el mint no queda validado aguas arriba (vive en
`wasiai-facilitator`, §3.6); los 0,016008 SOL de alquiler de las 8 cuentas siguen inmovilizados hasta
que alguien llame `close` (§2.8.2, residuo declarado); y **W6 no puede ejecutarse hasta que
`chaski-v3` mande la cuenta nueva** (§4.8.5), que es una HU de otro repo. Si el founder elige el
camino B, la HU puede cerrar con el programa desplegado y una interrupción de depósitos declarada; si
elige el A, cierra con W0..W5 hechos y W6 esperando.

---

*SDD generado en F2 por nexus-architect. Árbol base `8fca47294f6cd8e7ecefd330e278e63078957e26`.
Mediciones on-chain del 2026-08-10, slots `482578481`..`482583313`, devnet, sólo lectura.*
