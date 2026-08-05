# Work Item — [WKH-326] El tope de 32 del índice de escrows deja de crecer para siempre

Fase: F1 (NexusAgil QUALITY) · Analyst · 2026-08-05
Repo: `solana-programs` · Programa: `escrow` (`DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`, devnet)

---

## Resumen

`EscrowIndex` acumula ids y **nadie los saca**. Hoy `MAX_ENTRIES = 32`
(`programs/escrow/src/lib.rs:400`) no acota escrows abiertos simultáneos: acota **ids registrados en
toda la vida del remitente**, exitosos o no. Esta HU hace que `close` saque del índice la entrada del
escrow que está cerrando, con lo que el cupo vuelve a ser lo que el nombre y el dimensionamiento
dicen. Se entrega **implementado y probado, en una rama, SIN desplegar**.

---

## El defecto, verificado línea por línea

No es una hipótesis. El propio archivo ya lo documenta en un bloque `//` (`lib.rs:377-396`) y el
README lo publica (`README.md:607-623`). Lo que verifiqué leyendo el fuente:

| Afirmación | Evidencia |
|---|---|
| `register_escrow` exige `Deposited` **una sola vez**, en el instante del registro | `lib.rs:701` (constraint del Context `RegisterEscrow`) |
| y hace `push` del id si no está | `lib.rs:353-355` |
| `release` **no** declara la cuenta `escrow_index` | `struct Release`, `lib.rs:567-607`: 8 cuentas, ninguna es el índice |
| `refund` **no** declara la cuenta `escrow_index` | `struct Refund`, `lib.rs:609-642`: 7 cuentas, ninguna es el índice |
| `close` **no** declara la cuenta `escrow_index` | `struct Close`, `lib.rs:644-687`: 6 cuentas, ninguna es el índice |
| lo único que borra una entrada es `deregister_escrow` | `lib.rs:368`, `entries.retain(|e| *e != remittance_id)` |
| el 33º `register_escrow` de un mismo sender revierte | `lib.rs:345` (`require!`) → `EscrowIndexFull` = 6005 (`lib.rs:481-482`) |

**Consecuencia medible, y así se refuta:** hacé 32 ciclos completos `deposit → register_escrow →
release → close` con el mismo sender. Las 32 cuentas `EscrowState` quedan cerradas y el índice queda
con 32 entradas. El 33º `register_escrow` revierte con `EscrowIndexFull` (6005). Hoy pasa; después de
esta HU no tiene que pasar. Ese es el test que arranca en rojo.

**Qué NO es:** no hay fondos en riesgo. El índice no custodia tokens (invariante 10 del README,
`README.md:461-466`), `deposit` no toca el índice, y un `deregister_escrow` por id terminado libera
lugar. Es un camino que se traba, no plata que se pierde.

## Por qué ahora y no después

Hoy **no le duele a nadie**, y eso es lo que hace que sea barato arreglarlo ahora.
`register_escrow` no tiene ningún llamador cliente: `chaski-v3` arma **sólo** `deposit`
(`chaski-v3/src/infrastructure/solana-wallet.ts:315-322`, la única `program.methods.*` de ese camino)
y el facilitator firma `release` y lee `EscrowState`. R4, el camino cliente que llamaría a
`register_escrow`, no está construido.

La causalidad que ordena la urgencia es ésta, y es lo único que la justifica:

> La forma más pesada soportada, la que acepta el co-firmante off-chain y la que este repo mide en
> 57.326 CU, es **`deposit` + `register_escrow` en UNA transacción atómica**
> (`README.md:370`, `tests/escrow-index.ts:732-772`).
> En esa forma, el `EscrowIndexFull` del `register_escrow` 33º **revierte el depósito entero**.

O sea: mientras `register_escrow` no tenga llamador, el bug es un error legible en una instrucción
que nadie manda. El día que R4 aterrice, el mismo bug es "tu remesa número 33 no se puede enviar".
Hay que resolverlo **antes de R4**. Un `deposit` suelto sigue entrando igual — `deposit` no toca el
índice — así que R4 no queda bloqueado por esta HU, pero **no debe desplegarse antes que ella**.

---

## Sizing

- **SDD_MODE:** `full`
- **Estimación:** M
- **Modo NexusAgil:** QUALITY

Justificación (no es el default por inercia): es un programa on-chain que custodia dinero, el cambio
**modifica la interfaz de una instrucción** y por lo tanto mueve el sha256 canónico del IDL que dos
consumidores pinnean y que está publicado en cadena, y el repo lo va a revisar David (mentor
Solana LATAM Labs). Tres razones independientes; cualquiera sola ya sacaría esto de FAST.

- **Branch sugerido:** `feat/326-cap-del-indice-liberado-en-close`
- **Skills de dominio (máx 2):** `solana-anchor`, `security-review`

---

## Los cuatro caminos: el elegido y por qué se descartan los otros

### ELEGIDO — (a) `close` saca la entrada además de devolver el rent

**El argumento a favor no es de conveniencia, es de autorización.** `close` ya tiene, en su propio
Context, las dos cosas que hacen falta y que ninguna otra instrucción tiene juntas:

1. **El firmante correcto ya está ahí.** `sender: Signer<'info>` (`lib.rs:648`). El `EscrowIndex` es
   una PDA sembrada `["escrow-index", sender]` y su guard de ownership **son las seeds mismas**
   (invariante 9 del README, `README.md:453-459`). En `close` el sender firma, así que agregar el
   índice **no debilita esa invariante**: la sigue cumpliendo por construcción.
2. **El momento correcto ya está chequeado.** `constraint = escrow_state.status.is_terminal()`
   (`lib.rs:662`). La entrada se saca exactamente cuando el escrow dejó de existir, ni antes.
3. **El id ya está en la instrucción.** `close(ctx, remittance_id)` (`lib.rs:298`) recibe los mismos
   16 bytes que hay que sacar del índice. No hay que buscar nada.
4. **Una sola acción hace las tres cosas:** barre el vault, cierra las dos cuentas devolviendo
   ~0,004 SOL al sender (`close = sender`, `lib.rs:663`), y libera el cupo del índice.

**Lo que este camino NO resuelve, escrito para que nadie le atribuya de más:** si el sender nunca
llama `close`, el cupo tampoco se libera. Eso es cierto y queda en pie. Lo que cambia es que deja de
haber un cupo que **sólo puede crecer**: pasa a existir un camino que lo baja, ese camino le paga al
sender por usarlo (~0,004 SOL de rent recuperado, ver WKH-327), y `deregister_escrow` sigue ahí como
salida manual. No confundir "el problema tiene solución" con "el problema se resuelve solo".

**El costo real:** agregar `escrow_index` al Context de `close` es un cambio de interfaz. El IDL se
mueve. Se acepta a conciencia, y la sección "Impacto en el IDL" de abajo dice exactamente qué se
rompe y qué no.

### (b) Que lo saquen `release` y/o `refund` — DESCARTADO

Libera antes, y por eso hay que decir con precisión por qué no.

- **`release` es el problema.** Lo firma `authority: Signer<'info>` (`lib.rs:570`), el operador. El
  `sender` en ese Context es un `SystemAccount<'info>` que **no firma** (`lib.rs:573`, el comentario
  del propio archivo lo dice: "solo aporta su key a las seeds del PDA. NO firma"). Si se agrega
  `escrow_index` sembrado con ese `sender`, **las seeds dejan de ser el guard de ownership**: el
  operador pasa a poder nombrar y mutar una cuenta del sender sin su firma. El daño concreto está
  acotado (sólo puede `retain` el id de ese escrow), pero la invariante 9 del README pasaría de "no
  podés nombrar el índice de otro sin su firma" a "no podés, salvo la authority, para un id". Una
  invariante con una excepción no es una invariante: es una nota al pie que el próximo lector tiene
  que re-derivar.
- **`release` además es el único de los tres con consumidor vivo.** El facilitator lo firma hoy
  (`README.md:1000-1001`). Cambiar su lista de cuentas es un corte en vivo con las dos direcciones
  rotas (cliente nuevo contra programa viejo manda una cuenta de más; cliente viejo contra programa
  nuevo omite una). `close` no tiene ese problema porque **nadie lo construye todavía**.
- **`refund` solo no alcanza.** Ahí el sender sí firma (`lib.rs:613`), así que el problema de
  autorización no existe. Pero cubre una sola de las dos salidas terminales: un escrow que se
  releasea nunca pasa por `refund`, y ésa es la salida del camino feliz. Sería medio arreglo, y
  encima habría que agregar la cuenta igual a `close` para el otro medio.

### (c) Que el cliente llame `deregister_escrow` aparte — DESCARTADO como solución, RETENIDO como escape

Cero cambio de programa, cero movimiento del IDL, y la instrucción ya existe y está probada
(`lib.rs:364-370`, `tests/escrow-index.ts:625-665`). Es genuinamente la opción más barata.

Se descarta como **la** solución por una razón: depende de que el sender vuelva a mandar una segunda
transacción, pagando su fee, para una operación de contabilidad de la que no obtiene nada. Y el
índice existe justamente para el caso en que el sender **no** tiene a mano lo que hace falta
(perdió los 16 bytes del `remittance_id`, `README.md:244-249`). Construir el arreglo del cap sobre el
supuesto de que el sender vuelve es apoyarse en lo único que este subsistema asume que no pasa.

**Se retiene** como escape hatch por dos motivos concretos, y por eso `deregister_escrow` no se toca:
1. Es la **única** salida para entradas cuyo `EscrowState` ya fue cerrado antes de esta HU. `close`
   no las va a poder limpiar porque esas cuentas ya no existen — el propio comentario de
   `deregister_escrow` explica que por eso no exige estado terminal (`lib.rs:360-363`).
2. Mientras esto no esté desplegado, es lo único que hay.

### (d) Subir `MAX_ENTRIES` — DESCARTADO, y hay que decirlo con esas palabras

**Es correr el problema, no resolverlo.** El crecimiento del índice es monótono: sin baja, cualquier
cota finita se alcanza. Subir a 64 mueve la pared de la remesa 33 a la 65 y no cambia nada
estructural.

Y agranda la cuenta, con un número: `EscrowIndex` hoy son 558 bytes = 4.774.560 lamports de rent
(medido, `tests/escrow-index.ts:711-713`). Con `MAX_ENTRIES = 64` serían 1.070 bytes =
`(128 + 1070) * 6960` = **8.338.080 lamports (~0,0083 SOL)**, y ese rent lo paga el sender
(`payer = sender`, `lib.rs:710`) y **no es recuperable**: no existe instrucción que cierre el índice
(`README.md:625-628`). O sea que el precio de correr la pared se le cobra al remitente y no se le
devuelve.

Con el camino (a), `MAX_ENTRIES = 32` recupera el significado que su propio doc comment le atribuye
(`lib.rs:397-399`: "máximo de escrows ABIERTOS indexables por sender"), así que no hay que tocarlo.

---

## Acceptance Criteria (EARS)

Cada AC dice con qué input concreto se refuta. Un AC que no se pueda refutar con una transacción no
está terminado.

- **AC-1** — WHEN `close` se invoca con la cuenta `escrow_index` del sender que firma, y ese índice
  contiene el `remittance_id` del escrow que se está cerrando, the system SHALL quitar exactamente
  esa entrada y SHALL dejar las demás entradas en su orden original.
  *Refutación:* registrar los ids A y B (en ese orden), releasear A, cerrar A pasando el índice.
  `entries` tiene que quedar exactamente `[B]`. Si queda `[A, B]`, `[]`, o `[B, A]`, el AC falla.

- **AC-2** — IF el sender que firma nunca creó su PDA `EscrowIndex`, THEN `close` SHALL completarse
  con éxito y SHALL NOT crear esa cuenta.
  *Refutación:* `deposit` → `release` → `close`, **sin llamar nunca a `register_escrow`**. La tx
  tiene que confirmar, y `getAccountInfo(["escrow-index", sender])` tiene que devolver `null` después.
  Si revierte con `AccountNotInitialized` (3012), el AC falla. Si la cuenta existe después, también
  falla (habría cobrado 4.774.560 lamports de rent por una cuenta vacía).
  *Por qué este AC es el más importante de la lista:* es exactamente el camino que corre en
  producción hoy (`chaski-v3` arma sólo `deposit`), así que romperlo rompe lo que funciona.

- **AC-3** — WHEN un mismo sender completa el ciclo `deposit → register_escrow → release → close`
  repetidamente, the system SHALL aceptar el `register_escrow` número 33 y todos los siguientes.
  *Refutación:* correr 33 ciclos completos. El `register_escrow` 33º tiene que confirmar, y
  `entries.length` tiene que ser ≤ 1 al final de cada ciclo. Hoy el 33º revierte con
  `EscrowIndexFull` (6005): **este test tiene que estar ROJO contra el binario actual antes de que se
  escriba una línea del fix** (CD-10).

- **AC-4** — IF el llamador pasa una cuenta `escrow_index` cuyas seeds no derivan del sender que
  firma, THEN `close` SHALL revertir con `ConstraintSeeds` y SHALL NOT modificar ninguno de los dos
  índices.
  *Refutación:* el atacante cierra un escrow propio pero pasa la PDA de índice de la víctima. Tiene
  que revertir con ese código exacto (no "tira algo", `tests/escrow-index.ts:328-350`) y el índice de
  la víctima tiene que quedar byte por byte igual. Espejo de `escrow-index.ts` 4c.

- **AC-5** — the system SHALL mover exactamente los mismos montos de tokens en `close` después de
  este cambio que antes de él.
  *Refutación:* con el vault conteniendo N unidades al momento del `close`, el `sender_ata` tiene que
  crecer exactamente N, el balance del beneficiary tiene que quedar en 0 de delta, y el vault tiene
  que quedar cerrado. Los tests D1 y D1b de `escrow-window.ts` (barrido del vault) tienen que seguir
  verdes sin que se les toque una aserción.

- **AC-6** — WHILE `escrow_state.status` es `Deposited`, `close` SHALL revertir con
  `EscrowNotTerminal` (6004) y SHALL NOT quitar ninguna entrada del índice.
  *Refutación:* `deposit` → `register_escrow` → `close` pasando el índice, antes del deadline. Tiene
  que revertir con 6004 **y** `entries` tiene que seguir siendo `[id]`. Un `close` que limpia el
  índice y después revierte no existe (la tx es atómica), pero el AC obliga a asertar las dos cosas,
  porque el orden de los constraints es lo que lo garantiza y el orden se puede cambiar sin querer.

- **AC-7** — WHEN `close` se invoca con un índice que **no** contiene el `remittance_id` del escrow,
  the system SHALL completarse con éxito y SHALL dejar `entries` sin cambios.
  *Refutación:* `deposit` → `register_escrow` → `release` → `deregister_escrow` → `close` con el
  índice. La tx tiene que confirmar. Si revierte, el AC falla: sería una regresión respecto de la
  idempotencia que `deregister_escrow` ya garantiza (`lib.rs:368`, `retain` no falla si no está).

- **AC-8** — WHEN el programa se rebuildea, the system SHALL generar un `target/idl/escrow.json` que
  (i) declara exactamente 6 instrucciones, (ii) conserva los 6 discriminadores actuales, y (iii)
  declara `escrow_index` en la lista de cuentas de `close`.
  *Refutación:* aserción contra el artefacto construido, no contra el fuente (misma técnica que
  `escrow-index.ts:521-545`). El discriminador de `close` tiene que seguir siendo
  `[98, 165, 201, 177, 108, 65, 206, 96]`; los de `deposit`, `release`, `refund`, `register_escrow` y
  `deregister_escrow`, intactos. Si aparece una 7ª instrucción, el AC falla.

- **AC-9** — the system SHALL conservar sin cambios la lista de cuentas, los args y el discriminador
  de `deposit`, `release`, `refund`, `register_escrow` y `deregister_escrow`.
  *Refutación:* los tests que ya pinnean esas listas **en los consumidores** tienen que quedar verdes:
  `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:62-94` (deposit 8 cuentas, refund 7, register 4,
  por posición) y `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:46-79` (6 nombres +
  6 discriminadores). Se corren **leyendo** esos repos, sin escribirlos (CD-2).

---

## Scope IN

| Qué | Dónde |
|---|---|
| Handler `close`: sacar la entrada del índice | `programs/escrow/src/lib.rs:298-336` |
| `struct Close`: agregar la cuenta `escrow_index` | `programs/escrow/src/lib.rs:644-687` |
| Reescribir el bloque `//` que hoy describe el defecto | `programs/escrow/src/lib.rs:377-396` |
| Reescribir el comentario del campo `entries` | `programs/escrow/src/lib.rs:411-412` |
| Tests del cap, la fuga y los caminos de atacante | `tests/escrow-index.ts` |
| Helper de `close` (cambia la lista de cuentas) | `tests/escrow.ts` (tests 7 y 8), `tests/escrow-window.ts` (D1, D1b, D2) |
| Mutante nuevo del `retain` y qué test lo mata | `doc/mutation-run.md` |
| "Known limitations": la entrada del índice que se llena | `README.md:607-623` |
| Invariantes 9 y 11 (el índice y su cota) | `README.md:453-459`, `README.md:468-473` |
| Tabla de Instructions (guards de `close`) | `README.md:285` |
| Sección "Recovering an escrow whose id was lost" | `README.md:244-276` |
| Artefactos de proceso de esta HU | `doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/` |
| Regenerados por `anchor build`, no se editan a mano | `target/idl/escrow.json`, `target/types/escrow.ts` |

## Scope OUT

| Qué queda afuera | Dónde vive | Por qué |
|---|---|---|
| **Cualquier deploy** | `scripts/deploy-devnet.sh` | Irreversible; lo autoriza el founder aparte (CD-1) |
| Republicar el IDL on-chain | cuenta `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC`, `doc/publish-idl-onchain.md` | Va con el deploy |
| Re-pinnear el hash en los consumidores | `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:22`, `chaski-v3/contracts/CONTRACT-VERSIONS.md`, `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:30`, y los dos IDL vendoreados | Se pinnea el hash FINAL, una sola vez, en la HU de deploy |
| R4 (cliente que llama `register_escrow`) | `chaski-v3` | Otra HU; ésta la habilita |
| WKH-327 (cliente que llama `close`) | `chaski-v3` | Otra HU; ver sección dedicada |
| `MIN_CUSTODY_SECS` / `MAX_CUSTODY_SECS` | `lib.rs:121`, `lib.rs:129` | Prohibido (CD-3); su cambio depende de una medición que no existe |
| `MAX_ENTRIES` | `lib.rs:400` | Camino (d), descartado con argumento (CD-7) |
| Los tres doc comments falsos que lista el README | `README.md:32`; `lib.rs:30-32`, `lib.rs:514-518`, `lib.rs:397-399` | Se corrigen cuando se republique el IDL, o sea en la HU de deploy (DT-7) |
| Instrucción para cerrar el `EscrowIndex` y recuperar sus 4.774.560 lamports | no existe; `README.md:625-628` | Es otra HU. `close` NO recupera el rent del índice, sólo el de `EscrowState` + vault |
| Payout freeze / `PayoutPending` / `begin_payout` / `abort_payout` | `README.md:481-508`, rama `feat/ventana-de-custodia-fase2` | Ver "Agrupamiento" |
| Emisión de eventos | no existe hoy | Ver "Agrupamiento" |
| `cargo fmt` | `README.md:872-877` | El árbol no pasa `--check` hoy; reformatear acá enmascararía el diff que este repo existe para mantener verificable |

---

## Decisiones técnicas (DT-N)

- **DT-1** — Se toma el camino **(a)**: `close` saca la entrada. Argumento completo arriba; el núcleo
  es que `close` es la única instrucción que ya tiene, juntos, al firmante correcto (`sender: Signer`,
  `lib.rs:648`), el momento correcto (`is_terminal()`, `lib.rs:662`) y el id que hay que borrar
  (`lib.rs:298`), y la única de las tres terminales que **no tiene consumidor construyéndola hoy**
  (`README.md:987-1002`), o sea la única donde el cambio de interfaz es una restricción hacia adelante
  y no un corte en vivo.

- **DT-2** — La cuenta `escrow_index` entra en `Close` como **opcional**
  (`Option<Account<'info, EscrowIndex>>`), no como cuenta obligatoria.
  **Por qué, y es el punto donde este cambio se puede romper solo:** el índice se crea con
  `init_if_needed` **únicamente** en `register_escrow` (`lib.rs:708-714`). Para todo escrow que nunca
  se registró, esa cuenta **no existe**. Un `Account<'info, EscrowIndex>` obligatorio haría que
  `close` revierta con `AccountNotInitialized` (3012) para exactamente el camino que corre hoy en
  producción. Un arreglo del cap que rompe el cierre de cuentas de todos los que no usan el índice es
  peor que el bug.
  **Alternativa descartada:** poner `init_if_needed` en `close`. Le haría crear al sender una cuenta
  de 558 bytes (4.774.560 lamports) para recuperar 4.002.000 lamports de `EscrowState` + vault. Le
  cobraría **más de lo que le devuelve**, y dejaría una cuenta vacía cuyo rent no se puede recuperar
  (`README.md:625-628`).

- **DT-3** — La baja se hace con el **mismo `retain`** que ya usa `deregister_escrow`
  (`lib.rs:368`), no con una búsqueda nueva. Es idempotente por construcción y no puede hacer panic
  si el id no está (AC-7). Una segunda implementación de la misma operación es una segunda
  oportunidad de que difieran.

- **DT-4** — `deregister_escrow` **no se borra ni se cambia**. Sigue siendo la única salida para
  entradas cuyo `EscrowState` ya fue cerrado antes de este cambio, y su comentario ya explica por qué
  no exige estado terminal (`lib.rs:360-363`). Además es el escape hatch mientras esto no esté
  desplegado.

- **DT-5** — `MAX_ENTRIES` se queda en 32. Con (a) el cap deja de ser monótono y 32 vuelve a
  significar lo que su doc comment dice (`lib.rs:397-399`).

- **DT-6** — **Agrupamiento: se implementa solo, se despliega agrupado — pero no con las dos.**
  Ver la sección "Agrupamiento" abajo.

- **DT-7** — Los tres doc comments falsos (README.md:32) **no** se corrigen acá. El README ya
  establece la regla: se corrigen la próxima vez que se republique el IDL en cadena, y eso pasa en el
  deploy. Corregirlos acá los dejaría en un hash intermedio que nunca se publica, o sea sin ganancia
  y con más diff que revisar.

- **DT-8** — El test que reproduce la fuga se escribe **antes** que el fix y se registra su salida en
  rojo (CD-10). Este repo ya se comió dos veces el caso de un artefacto que no correspondía al fuente
  (`doc/mutation-run.md:9-15`); un test que nunca se vio fallar no prueba nada.

---

## Constraint Directives (CD-N)

- **CD-1** — **PROHIBIDO DESPLEGAR.** Prohibido `anchor deploy`, `solana program deploy`,
  `solana program extend`, `solana program write-buffer`, `anchor idl init|upgrade|publish`, y
  `scripts/deploy-devnet.sh`. Prohibido tocar devnet con cualquier transacción de escritura. La
  entrega es: rama + suite verde + `target/idl/escrow.json` regenerado. Nada más.
- **CD-2** — PROHIBIDO escribir en `chaski-v3/`, `wasiai-facilitator/`, `wasiai-a2a/`,
  `wasiai-remittance-agents/`. Se leen para verificar consumidores; no se tocan. En particular,
  PROHIBIDO re-pinnear `ESCROW_IDL_SHA256` en ninguno de los dos repos.
- **CD-3** — PROHIBIDO tocar `MIN_CUSTODY_SECS` (`lib.rs:121`) y `MAX_CUSTODY_SECS` (`lib.rs:129`).
- **CD-4** — PROHIBIDO cambiar el orden o la cantidad de variantes de `EscrowStatus`
  (`lib.rs:433-445`). PROHIBIDO insertar variantes de `ErrorCode` fuera del final (`lib.rs:463-490`):
  los códigos son posicionales desde 6000.
- **CD-5** — PROHIBIDO cambiar cuentas, args o discriminadores de `deposit`, `release`, `refund`,
  `register_escrow` y `deregister_escrow`. **Sólo `close` cambia.**
- **CD-6** — OBLIGATORIO que todo comentario **nuevo** use `//`, no `///` ni `//!`. Los doc comments
  viajan al IDL y le mueven el sha256 (`README.md:32`). El hash se mueve **una vez y por la cuenta
  nueva**, no por prosa. Excepción única y explícita: si el SDD decide documentar la cuenta
  `escrow_index` de `close` con `///` para que aparezca en el IDL, tiene que declararlo como decisión.
- **CD-7** — PROHIBIDO subir `MAX_ENTRIES` (`lib.rs:400`) en esta HU.
- **CD-8** — OBLIGATORIO agregar al menos un mutante a `doc/mutation-run.md` que rompa el `retain`
  nuevo (borrarlo, y cambiarlo por uno que borre la entrada equivocada) y registrar qué test lo mata.
  En este repo un guard sin mutante no cuenta como probado.
- **CD-9** — PROHIBIDO abrir `chaski-v3/m5-keys/`. PROHIBIDO imprimir secretos. PROHIBIDO git
  destructivo (`reset --hard`, `push --force`, `clean -fd`).
- **CD-10** — OBLIGATORIO que el test de AC-3 (la fuga del cap) se vea **ROJO** contra el binario
  actual antes de escribir el fix, y que esa salida quede registrada en la evidencia de F4.
- **CD-11** — OBLIGATORIO correr `anchor build` antes de cada corrida de la suite. bankrun y
  `anchor deploy` shippean lo que está en `target/deploy/`, **no compilan**
  (`README.md:774-777`, `doc/mutation-run.md:9-15`).
- **CD-12** — PROHIBIDO reformatear el archivo con `cargo fmt`. El repo no lo enforcea a propósito
  (`README.md:872-877`) y un reformateo entierra el diff que hay que revisar.

---

## Impacto en el IDL y sus consumidores

**El hash se va a mover, y acá eso es esperado, no un accidente.** Agregar una cuenta a `close`
cambia `target/idl/escrow.json`, y por lo tanto su sha256 canónico.

Hash actual pinneado en los dos consumidores:
`fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071`

### Dónde está clavado (localizado leyendo los archivos, 2026-08-05)

| Repo | Archivo | Qué clava |
|---|---|---|
| `chaski-v3` | `contracts/idl/escrow-idl.hash.test.ts:22` | la constante `ESCROW_IDL_SHA256` |
| `chaski-v3` | `contracts/CONTRACT-VERSIONS.md` | el hash publicado; hay un test que exige que el doc y la constante coincidan (`escrow-idl.hash.test.ts:107-142`) |
| `chaski-v3` | `src/infrastructure/solana/escrow-idl.ts` | el IDL vendoreado |
| `wasiai-facilitator` | `src/chains/escrow-idl.hash.test.ts:30` | la constante `ESCROW_IDL_SHA256` |
| `wasiai-facilitator` | `src/chains/escrow-idl.ts` | el IDL vendoreado |
| cadena | cuenta de metadata `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC` | el IDL publicado on-chain (`README.md:32`) |

También hay copias del IDL vendoreado en worktrees de `chaski-v3`
(`wt-preflight`, `wt-wkh320`, `wt-e0e1-desacople`, `wt-readme-vision`, `wt-historial-remesas`,
cada uno con `src/infrastructure/solana/escrow-idl.ts`). Son ramas del mismo repo, no consumidores
independientes: se actualizan por merge, no una por una.

### Qué se pone en rojo y qué NO — dicho con precisión

Se pone en rojo, y sólo esto:
- `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:26-28` (AC-2) y su AC-3 sibling.
- `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:33-35` (AC-2) y su AC-3 sibling.

**Sigue verde**, y esto es lo que hace que el cambio sea barato:
- `chaski-v3` `AC-R2b-3/4` (`escrow-idl.hash.test.ts:45-95`) pinnea las listas de cuentas por posición
  de **`deposit`, `refund` y `register_escrow`** — ninguna de las tres cambia.
- `wasiai-facilitator` `R2a` (`escrow-idl.hash.test.ts:46-79`) pinnea los 6 nombres y los
  6 discriminadores. Anchor hashea el **nombre** de la instrucción, no su lista de cuentas, así que
  agregarle una cuenta a `close` **no mueve su discriminador**.
- El decode de `EscrowState` no se mueve: `EscrowStatus` sigue con 3 variantes y el layout de la
  cuenta no se toca. Lo que el facilitator realmente hace (firmar `release`, leer `EscrowState`)
  queda intacto.

### Qué hay que hacer con esto, y cuándo

En esta HU: **nada**. No se re-pinnea nada (CD-2). El hash intermedio no se publica.
En la HU de deploy, y en este orden: republicar el IDL on-chain → actualizar los dos IDL vendoreados
→ re-pinnear las dos constantes → actualizar `CONTRACT-VERSIONS.md` (hay un test que lo exige).

### Precedente de que este movimiento es rutinario acá

El hash ya se re-pinneó al menos dos veces con este mismo procedimiento, y los comentarios de los dos
tests documentan el diff instrucción por instrucción de cada vez:
`aa53c03f…` → `4bcc34a9…` (HU-SOL-20, `register_escrow` + `deregister_escrow`) → `fb64c937…`
(2026-08-01, la ventana de custodia, que **también** le agregó una cuenta a `close`: `sender_ata`).
Este cambio es el mismo tipo de movimiento que aquél, sobre la misma instrucción.

---

## Relación con WKH-327 (recuperación del alquiler)

**WKH-327 está bloqueada esperando esta decisión, y la decisión la colapsa.**

WKH-327 es el camino cliente para cerrar cuentas y recuperar el alquiler. Cada remesa deja
inmovilizados, del bolsillo de quien envía:

| Cuenta | Bytes | Lamports |
|---|---|---|
| `EscrowState` | 154 | 1.962.720 |
| vault (ATA) | 165 | 2.039.280 |
| **Total recuperable por `close`** | | **4.002.000 (~0,004 SOL)** |

(Los dos primeros números están medidos por la suite, `tests/escrow-index.ts:711-713`.)

**Con el camino (a) elegido, una sola instrucción resuelve los dos problemas.** WKH-327 se reduce a
"construir y mandar `close`", porque ese `close` va a (i) barrer el vault, (ii) cerrar las dos cuentas
devolviendo los 4.002.000 lamports al sender, y (iii) liberar el cupo del índice. **No hay que
construir dos caminos en paralelo**, y en particular **no** hay que construir un camino cliente
separado para `deregister_escrow`.

Tres condiciones que WKH-327 tiene que respetar, y conviene que estén escritas acá para que no se
descubran después:

1. **WKH-327 se construye contra la lista de cuentas POST-WKH-326.** La lista de cuentas de `close`
   no tiene orden de deploy seguro: cliente nuevo contra programa viejo manda una cuenta de más,
   cliente viejo contra programa nuevo omite una, y las dos direcciones fallan
   (`README.md:987-1002`). Hoy eso es tolerable porque **ningún consumidor construye `close`**;
   escribir el primero contra la lista vieja convertiría una restricción hacia adelante en un corte.
2. **`close` NO recupera el rent del `EscrowIndex`** (4.774.560 lamports). No existe instrucción que
   cierre esa cuenta (`README.md:625-628`). Es un costo de una sola vez por sender, no por remesa,
   pero si WKH-327 le promete al usuario "recuperás tu alquiler" tiene que decir cuál.
3. **La cuenta `escrow_index` es opcional en `close` (DT-2)**, así que WKH-327 tiene que decidir
   cuándo pasarla. Regla simple y verificable: pasarla si la PDA `["escrow-index", sender]` existe
   (un `getAccountInfo`), omitirla si no. Pasarla cuando no existe hace revertir la tx; omitirla
   cuando existe deja la entrada colgada y vuelve el bug.

---

## Agrupamiento

En la cola hay otros dos cambios que también tocan la interfaz del programa: **congelar el reembolso
durante el pago** (`PayoutPending` + `begin_payout` / `abort_payout`) y **emitir eventos** (hoy el
programa no emite ninguno).

**Decisión: WKH-326 se implementa SOLA, y su deploy se agrupa con el de eventos, NO con el del
congelamiento del reembolso.**

El argumento no es de gusto, es de precondición. El congelamiento del reembolso tiene una que las
otras dos no tienen, y está escrita en el README (`README.md:499-508`):

> 1. Los dos consumidores publican un IDL con las cuatro variantes y lo pinnean.
> 2. Los dos manejan el estado nuevo explícitamente: `verifyVault` en el facilitator tiene que
>    decidir qué significa `PayoutPending` para un release que le piden firmar, y `refundEscrow` en
>    `chaski-v3` tiene que decodificarlo sin tirar.
> 3. Recién ahí el programa agrega la variante, y recién ahí se despliega.

Y el motivo de esa precondición es que el `coder.decode` de `chaski-v3` está en el camino del refund
y **no** está adentro de un `try` (`chaski-v3/src/infrastructure/solana-wallet.ts:352`, citado en
`README.md:492-497`): con un status byte de 3, la persona que mandó la remesa no puede recuperar su
plata desde el producto. O sea que esa HU necesita trabajo **en los dos consumidores antes** del
deploy del programa.

WKH-326 y los eventos no tienen esa precondición: los dos mueven el hash del IDL y ninguno cambia el
decode de `EscrowState`. Agrupar WKH-326 con el congelamiento subordinaría un arreglo barato y
autocontenido a uno que está bloqueado por trabajo en otros dos repos.

**Lo que sí vale del argumento de agrupar:** cambiar la interfaz una sola vez cuesta la mitad de un
ciclo de deploy + actualización de los dos consumidores. Por eso lo que se agrupa es **el deploy**,
no la implementación. Cada HU va en su rama, con su suite verde y su IDL regenerado, y una única HU
de deploy publica el IDL final y re-pinnea los consumidores **una sola vez**. Como el deploy está
fuera de alcance acá de todos modos (CD-1), esta HU sólo deja la recomendación registrada.

---

## Waves

| Wave | Qué | Sale con |
|---|---|---|
| **W0** | Tests en ROJO primero: el ciclo de 33 (AC-3) y la fuga básica register→release→close (AC-1). Se registra la salida roja. | Evidencia de CD-10 |
| **W1** | `struct Close` suma `escrow_index` opcional; el handler hace el `retain`. `anchor build`. | AC-1, AC-2, AC-8 |
| **W2** | Adversariales: índice de la víctima (AC-4), estado no terminal (AC-6), id ausente (AC-7), sin índice nunca creado (AC-2), tokens sin moverse (AC-5). Helpers de `close` actualizados en los 3 archivos de test. | AC-2, AC-4, AC-5, AC-6, AC-7 |
| **W3** | No-regresión de interfaz: aserción contra el IDL construido (AC-8) y corrida de los tests de pin de los dos consumidores **en modo lectura** (AC-9). | AC-8, AC-9 |
| **W4** | Mutación: romper el `retain` de dos formas distintas y registrar qué test mata cada mutante en `doc/mutation-run.md`. Rebuild y restauración del artefacto (CD-11). | CD-8 |
| **W5** | Documentación: `README.md` (Known limitations, invariantes 9 y 11, tabla de Instructions, sección de recuperación) y los comentarios `//` de `lib.rs:377-396` y `:411-412`, que hoy describen el defecto. Registrar el sha256 nuevo del IDL **sin re-pinnear a nadie**. | Entregable final |

Las waves son secuenciales. W0 no se puede saltar: es lo único que distingue "arreglé el bug" de
"escribí un test que pasa".

---

## Missing Inputs

- **[bloqueante — se resuelve en F2, empíricamente]** ¿Anchor 1.1.2 emite las cuentas opcionales en el
  IDL de forma que `@coral-xyz/anchor` 0.30.1 (el que usan los tests de este repo, `package.json:10`,
  y los dos consumidores) sepa construir la instrucción omitiéndola? **No se asume que sí.** Si no
  funciona, la alternativa es `UncheckedAccount` + deserialización manual con verificación de
  discriminador y seeds — más código, menos declarativo, y hay que pesarlo contra DT-2. El SDD tiene
  que resolver esto con una prueba, no con una cita de documentación.
- **[se resuelve en F2]** La forma exacta de las seeds y el bump del `escrow_index` opcional en
  `Close`. Con `Option<Account<...>>` no se puede usar `bump = escrow_index.bump` de la misma manera
  que en `DeregisterEscrow` (`lib.rs:725-730`); hay que decidir entre re-derivar el bump canónico
  (cuesta CU) o leerlo de la cuenta.
- **[no se pudo verificar en esta fase]** No tuve herramienta de shell ni de grep en F0, así que **no
  re-corrí** el grep de consumidores que el README dice haber corrido el 2026-08-01
  (`README.md:999-1002`). Lo que **sí** verifiqué leyendo archivos: `chaski-v3` arma únicamente
  `deposit` en su camino de depósito (`src/infrastructure/solana-wallet.ts:315-322`) y ninguno de los
  archivos que leí construye `close`. **F2 tiene que re-correr el grep** de `close` / `registerEscrow`
  / `deregisterEscrow` en los dos consumidores y dejar la salida en el SDD. Si aparece un builder de
  `close`, DT-1 hay que revisarlo: dejaría de ser una restricción hacia adelante y pasaría a ser un
  corte en vivo.
- **[no se pudo verificar en esta fase]** El compute extra que agrega el `retain` + la carga de la
  cuenta del índice a `close`. Hoy no hay una medición de CU de `close` en la suite (la que existe es
  de `deposit + register_escrow`, `tests/escrow-index.ts:732-772`). No es bloqueante — `close` es una
  tx propia y chica — pero W2 debería reportar el número en vez de suponerlo.
- **[TBD]** Los identificadores exactos de las otras dos HUs de la cola (congelar el reembolso,
  emitir eventos) no me fueron dados; se referencian por descripción y por la sección
  `README.md:481-508`.
- **[TBD]** Qué pasa con las entradas ya presentes en índices vivos. Hoy **no hay ninguna cuenta
  `EscrowIndex` en devnet** (`README.md:104-105`), así que la migración es vacía y no hay que
  construirla. Esa afirmación viene del README, no la comprobé contra la cadena en esta fase: si en el
  momento del deploy ya existieran índices, hay que decidir si se limpian con `deregister_escrow`
  antes.

---

## Análisis de paralelismo

- **WKH-326 bloquea a WKH-327.** El cliente de `close` tiene que construirse contra la lista de
  cuentas post-326, porque la lista de cuentas de `close` no tiene orden de deploy seguro
  (`README.md:987-1002`).
- **WKH-326 no bloquea a R4, pero R4 no debe desplegarse antes.** Se pueden desarrollar en paralelo
  (tocan repos distintos). Lo que no puede pasar es que R4 llegue a producción con el cap todavía
  monótono: ahí el `EscrowIndexFull` se lleva puesto el depósito en la tx atómica.
- **Puede ir en paralelo con la HU de eventos.** Tocan partes distintas del archivo. El **deploy** de
  las dos va junto (DT-6).
- **No puede ir en paralelo con nada que edite `struct Close`** (`lib.rs:644-687`) ni los helpers de
  `close` de los tres archivos de test: colisionan línea a línea.
- **No debe agruparse con el congelamiento del reembolso**, que está bloqueado por trabajo previo en
  los dos consumidores (`README.md:499-508`).
