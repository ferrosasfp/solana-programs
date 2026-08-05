Verificación completa. Cierro con el reporte.

**Nota sobre el output**: mis instrucciones de ejecución me prohíben escribir archivos `.md` de reporte — el orquestador lee mi salida de texto. Va el `cr-report.md` completo acá abajo, listo para persistir verbatim en `/home/ferdev/.openclaw/workspace/solana-programs/doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/cr-report.md`.

---

# CR — WKH-326 · el cupo del índice liberado en `close`

**Rama**: `feat/326-cap-del-indice-liberado-en-close` (7 commits, HEAD `36d9ed0`)
**Veredicto**: **APROBADO con MENORes** — 0 BLOQUEANTEs, 7 MENORes.

## 0. Lo que corrí, no lo que leí

| Control | Comando / archivo | Resultado |
|---|---|---|
| Suite completa sobre el binario del branch | `npx ts-mocha ... tests/**/*.ts`, árbol limpio, `escrow.so` md5 `d4b736cf…` | **54 passing, 0 failing** — reproduce la línea base de `doc/mutation-run.md:41` |
| md5 del `.so` post-W5 | `md5sum target/deploy/escrow.so` → `d4b736cf6b9e15421e7cb1d75f3d8e0d` | coincide **exacto** con lo afirmado en `idl-hash.md:37` |
| sha256 canónico del IDL construido | algoritmo de `chaski-v3/contracts/idl/canonical-hash.ts` reimplementado en scratch, sobre `target/idl/escrow.json` | `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922` — **idéntico** a `idl-hash.md:10` y a los dos `w3/*-pin.txt` |
| Mecanismo de CD-14 (clave ausente ≠ omitida) | `Program(idl).methods.close(...).accountsPartial({...})` offline, con y sin la clave | **sin la clave**: 7 keys, `keys[6]` = la PDA `["escrow-index", sender]`. **con `escrowIndex: null`**: 7 keys, `keys[6]` = `programId`. Confirma el `///` y el test 13b sin depender de ellos |
| Discriminadores | IDL vendoreado pre-326 de `chaski-v3` vs `target/idl/escrow.json` | los 6 idénticos; los literales de test 19 salen del vendoreado, como dice su comentario |
| CU del test 21 | 2 corridas seguidas de `tests/escrow-index.ts` | ver MNR-2 |

> ⚠️ **Riesgo de proceso para el orquestador, no finding**: durante mi revisión el árbol de `solana-programs` estuvo transitoriamente **mutado por el AR paralelo** (a las 14:16 `programs/escrow/src/lib.rs` tenía M19 aplicado — `seeds`/`bump` borrados de `escrow_index` — y `target/` estaba rebuildeado desde ahí; a las 14:17 volvió limpio). Dos agentes compartiendo un mismo checkout hacen que cualquier medición sobre `target/` sea válida sólo si se verifica `git status --porcelain` limpio **en el mismo comando**. Todas mis mediciones de arriba están tomadas con el árbol confirmado limpio en `36d9ed0`.

## 1. El eje principal: prosa que afirma de más

Criterio aplicado a cada comentario nuevo y a cada línea nueva del README: *¿se puede refutar con un input concreto?*

### 1.1 El bloque de `lib.rs:386-410` (el que antes describía el defecto) — **OK**

Ya no describe un mundo que no existe ni promete uno que no es. Verifiqué frase por frase:

- `:390` "La premisa sigue siendo falsa" → cierto: `register_escrow` sigue chequeando `Deposited` una sola vez (`lib.rs:751` constraint de `RegisterEscrow`).
- `:396-397` "`release` y `refund` siguen sin tocar el índice — se puede comprobar leyendo sus dos Contexts" → comprobado, ninguno declara `escrow_index`.
- `:398-401` "el cap dejó de ser monótono … test 14 corre exactamente 33 ciclos y antes de este cambio moría con EscrowIndexFull / 6005" → `w0-red.txt:7736-7737` muestra ese 6005 exacto contra el binario viejo, y la suite verde de hoy muestra los 33 ciclos pasando.
- `:403-410` **"QUÉ SIGUE EN PIE, y es refutable con un input concreto"** — los tres casos están, incluido el que el work-item exige no perder: *"Si el sender nunca llama `close`, el cupo no se libera"* (`:404-405`). **No quedó ninguna frase, en ningún archivo, diciendo que el cupo ya no se puede llenar.**

### 1.2 El comentario del campo `entries` (`lib.rs:425-428`) — **OK**

"Salen por dos caminos y sólo por esos dos" es exhaustivo y verdadero: los únicos `retain` sobre `entries` son `lib.rs:342` (close) y `lib.rs:377` (deregister); el único `push` es `lib.rs:363`. `git grep` sobre el diff confirma que no hay un tercer escritor.

### 1.3 La cuenta nueva con `///` (`lib.rs:704-720`) — **OK, y es la parte mejor hecha del cambio**

Es el texto que alguien va a leer desde el IDL vendoreado sin ver el `.rs`, y dice lo que necesita saber. Verifiqué las cuatro afirmaciones **sin usar los tests del dev**:

| Afirmación | Línea | Cómo la verifiqué |
|---|---|---|
| "Omitirla se escribe `escrowIndex: null` EXPLÍCITO" | `:708` | con `null` el cliente manda 7 keys y `keys[6] = programId` (medido) |
| "Dejar la clave afuera NO la omite: el cliente deriva la PDA a partir de las seeds que declara este IDL" | `:708-711` | sin la clave, `keys[6]` = `GTvBYPT2hk…` = exactamente `findProgramAddress(["escrow-index", sender])`. Y el IDL construido **sí** declara `pda.seeds = [const "escrow-index", account "sender"]` en `close.accounts[6]` |
| "si esa cuenta no existe la tx revierte con `AccountNotInitialized` (3012)" | `:711` | test 13b lo ejecuta y pinnea el código; el mutante M19 lo confirma desde el otro lado |
| "Omitirla cuando el índice SÍ existe … deja la entrada colgada … reintroduce, para ese id, el cap monótono" | `:714-717` | cierto por construcción del `if let Some` (`lib.rs:341`). **Es lo único de este bloque que ningún test ejerce** → MNR-5 |

No promete de más: dice explícitamente que la omisión **reintroduce** el defecto para ese id, en vez de vender la cuenta como solución total.

### 1.4 README — **OK con una nota**

- Tabla de Instructions `README:286`: "removes the id from the sender's index **when** the optional `escrow_index` account is passed" — condicional, correcto.
- Invariante 9 `README:455-461`: "Three instructions write it now" + test 15 citado. Correcto.
- Invariante 11 `README:471-478`: "The bound is **no longer monotonic** over the sender's lifetime … **That only holds for senders who do call `close` with the index**". La cláusula de escape está.
- Known limitations `README:613-637`: el título pasó a **"The index still fills up for a sender who does not call `close` with it"** y enumera **tres** caminos que siguen llenándolo, incluido el que se pierde fácil (`:632-634`, entradas cuyo `EscrowState` ya se cerró antes de este cambio, para las que `close` ya no sirve). Honesto.
- "No safe deployment order" `README:1003-1010`: probé el que parecía el punto débil — "Both directions fail" — y **se sostiene**: un cliente nuevo manda también `sender_ata` en la posición 4, que el programa viejo espera que sea `token_program`, así que esa dirección rompe por la primera cuenta aunque la séptima sea ignorable. La frase `:1009-1010` ("un cliente que manda `escrowIndex: null` … igual no coincide con la lista vieja, que tiene seis cuentas y no siete") la verifiqué midiendo: con `null` el cliente manda **7** keys. Correcta al pie de la letra.
- Nota menor: el texto del link en `README:263` sigue diciendo "the index fills up with finished escrows" aunque el título al que apunta ya no dice eso. El ancla (`#known-limitations`) funciona igual. No lo cuento como finding.

## 2. Fidelidad al Story File y las tres desviaciones declaradas

### 2.1 Desviación 1 — la forma del assert del test 14: **NO se debilitó**

El Story File (`story-HU-326.md:433`, `:777`) especifica `entries.length <= 1` **al final de cada ciclo**. El dev mide por ciclo (`tests/escrow-index.ts:924-926`) y asserta `Math.max(...perCycleLen) ≤ 1` después del loop (`:932-935`). `max(x_i) ≤ 1` ⟺ `∀i: x_i ≤ 1`: **es el mismo predicado sobre los mismos valores**, sólo cambia cuándo aborta. Además imprime la serie completa en el mensaje de error, así que el diagnóstico es mejor que el original. La justificación (llegar al ciclo 33 para exhibir el 6005) está probada por `w0-red.txt:7736-7737`.

Nota verificada, y por eso MNR-7: el criterio `≤ 1` que hereda del Story File es **una unidad más flojo que el invariante real** (contra el binario correcto el máximo es 0, lo dice el propio `auto-blindaje.md:17`), y esa unidad es exactamente la que deja pasar a M16 por el test 14 — `w4/M16-summary.txt` mata 12, 18 y 21, **no** el 14.

### 2.2 Desviación 2 — parámetros opcionales en los helpers: **ningún call site viejo cambió de cuentas**

Verificado expresión por expresión, no por confianza en el default:

- `deposit` (`:202-231`): antes `pdas(remittanceId)` → `escrowPda(rid, sender)` + `getAssociatedTokenAddressSync(mint, escrowState, true)`. Ahora `escrowPda(rid, signer=sender)` + `ataOf(escrowState)` donde `ataOf` (`:198-200`) **es literalmente** `getAssociatedTokenAddressSync(mint, owner, true)`. `senderAta` (const creado en `:418` con `createAta(sender)`, que usa la misma llamada) ≡ `ataOf(sender.publicKey)`. Direcciones idénticas.
- `release` (`:299-320`): `escrowOwner: Keypair = sender` → `sender: escrowOwner.publicKey`. Idéntico para todo llamador viejo.
- `close` es helper **nuevo** en esta suite (no existía en `main`), así que no hay call site viejo que romper.
- `escrow-window.ts:270-274`: el 4º parámetro tiene default `null` y la clave `escrowIndex` va **siempre** presente en el objeto (`:288`) — CD-14 respetado en el default, no sólo en los tests nuevos.
- `escrow.ts:516` y `:556`: los dos `close` viejos ahora llevan `escrowIndex: null` explícito.
- Grep de los **5** builders de `close` en las tres suites: los 5 incluyen la clave, salvo `escrow-index.ts:877` que la omite **a propósito** (es el test 13b).

### 2.3 Desviación 3 — el consumidor que el grep no había visto: **cierto, y el argumento se sostiene**

`chaski-v3/src/infrastructure/settlement/solana-deposit-beneficiary.test.ts:118-129`: el test toma `close.discriminator` del IDL vendoreado y construye a mano una tx con `Buffer.concat([discriminator, Buffer.alloc(16,0)])` (`:126-128`). **No usa la lista de cuentas en ningún punto.** Y el discriminador no se movió: los 6 del IDL vendoreado pre-326 son byte a byte los 6 del IDL que construye esta rama (medido). La frase de `README:1019-1025` es exacta.

Re-corrí yo el grep sobre los cuatro repos consumidores: el único hit fuera de IDLs vendoreados es ése. La afirmación "no consumer builds `close` at all right now" se sostiene hoy.

### 2.4 Las 17 CDs

| CD | Veredicto | Cómo lo verifiqué |
|---|---|---|
| CD-1 no desplegar | **OK** | ningún `deploy`/`idl init` en el diff; `.so` local sólo |
| CD-2 no escribir en consumidores | **OK** | `git status --porcelain` de los 3 archivos nombrados en `chaski-v3` → vacío; `wasiai-facilitator` limpio; **`ESCROW_IDL_SHA256` sigue en `fb64c937…`** en `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:22` y `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:30` |
| CD-3 ventana de custodia | **OK** | ninguna línea con `CUSTODY_SECS` en el diff |
| CD-4 orden de enums/errores | **OK** | ninguna línea de `EscrowStatus` ni `#[msg(...)]` en el diff |
| **CD-5 sólo `close` cambia** | **OK** | los 4 hunks de `lib.rs` son: cuerpo de `close` (`:336-343`), bloque `//` de MAX_ENTRIES (`:386-410`), comentario de `entries` (`:425-428`), `struct Close` (`:704-726`). Y test 20 (`:1089-1138`) lo pinnea contra el artefacto: cuentas, args y ausencia de `optional` en las otras cinco |
| **CD-6 `//` salvo la excepción** | **OK** | `git diff \| grep -c '^+\s*///'` = **17**, y son exactamente las 17 líneas del bloque contiguo `lib.rs:704-720`. Cero `///` nuevos en cualquier otro lado |
| CD-7 `MAX_ENTRIES` sigue en 32 | **OK** | `lib.rs:414` sin tocar |
| CD-8 registrar M15..M19 | **OK** | `doc/mutation-run.md:33-37` + sección `:39-68`; ver MNR-3/MNR-4 |
| CD-9 no abrir m5-keys / no git destructivo | **OK** | no aparecen en el diff ni en el historial de la rama |
| CD-10 W0 rojo registrado | **OK** | `w0-red.txt:7719-7743`: 43 passing / 2 failing, con el `EscrowIndexFull` 6005 del 33º y el `[A,B]` vs `[B]` del test 12 |
| CD-11 build antes de cada corrida | **N/V** | no auditable a posteriori; el control indirecto (los md5 de `w4`) sí está |
| **CD-12 nada de `cargo fmt`** | **OK** | el diff de `lib.rs` es +58/−18 y estrictamente local; `lib.rs:377` sigue siendo la línea larga sin formatear que `main` ya tenía |
| **CD-13 nada de `init`** | **OK** | `struct Close` (`:660-727`) no tiene `init` ni `init_if_needed`; y test 13 (`:846-868`) lo prueba en runtime: `getAccount(pda)` sigue `null` **después** del close (`:864-867`) |
| CD-14 la clave siempre presente | **OK** | los 5 builders, ver §2.2 |
| CD-15 la cuenta va última | **OK** | `lib.rs:726` y test 19 `:1075-1086` sobre el IDL construido |
| **CD-16 el `retain` viejo intacto** | **OK** | `lib.rs:377` no aparece en ningún hunk; y no hay helper compartido: la duplicación deliberada se mantiene (`:342` vs `:377` son dos expresiones separadas). Es lo que hace que M15/M16/M17 sólo toquen `close` |
| **CD-17 el hash no afirmado fuera de la evidencia** | **OK** | `git grep bfbdfe5a…` devuelve **3** hits, los 3 dentro de `doc/sdd/003-…/` (`idl-hash.md:10`, `w3/chaski-v3-pin.txt:14`, `w3/wasiai-facilitator-pin.txt:13`). `idl-hash.md:3-5` dice explícitamente *"Este número vive SOLO acá… El re-pin es trabajo de la HU de deploy, una sola vez, con el hash que efectivamente se publique en cadena"* — **no** lo afirma como el que va a quedar desplegado |

## 3. Calidad de los 11 tests

**¿Cada uno puede fallar?** Sí, salvo dos que son guardas de no-deriva por diseño:

| Test | Lo mata | Nota |
|---|---|---|
| 12 | M15, M16, M17 + W0 | el assert es el contenido **exacto** de `entries` (`:840`), que es lo que distingue "no corrió el retain" de "borró todo" de "reordenó" |
| 13 | M18 | tiene precondición explícita (`:850-853`) además de la postcondición |
| 13b | M19 (client-side) | ver MNR-3 |
| 14 | W0 (6005), M15 | ver MNR-7 |
| 15 | M19 | **es el que prueba la guarda on-chain**: sin las seeds deja de revertir |
| 16 | ninguno | guarda de AC-5 (el write del índice no mueve tokens); pasaría también sin el fix. Correcto que así sea |
| 17 | — | prueba el orden constraint-antes-que-cuerpo |
| 18 | M16, M17 | |
| 19 | M19 no lo toca (el `optional` y el orden no cambian) | pinnea CD-15 y los discriminadores |
| 20 | ninguno | guarda de AC-9 / CD-5; pasaría sin el fix, y debe |
| 21 | M15, M16, M18 | ver MNR-2 y MNR-3 |

**¿Pinnean el código exacto?** Sí. Los tres tests de revert nuevos usan `expectRevert` (`:370-391`), que compara `e.error.errorCode.code` contra un literal: `"AccountNotInitialized"` (`:900`), `"ConstraintSeeds"` (`:966`), `"EscrowNotTerminal"` (`:1008`). Ninguno dice "tira algo".

**¿Asserts de ausencia sin su assert de presencia?** Revisé los cuatro candidatos y **ninguno mide en vacío**:
- test 13 `:864-867` (la PDA no existe) tiene su precondición en `:850-853`, con mensaje.
- test 15 `:966-971`: el índice de la víctima se lee **antes** (`:948-950`) y **después** (`:968-971`) con el mismo `deep.equal([hex(victimId)])`.
- test 16 `:988` `expect(vaultABefore, "release already emptied vault A").to.equal(0n)` es justamente el assert de presencia que evita que los deltas midan nada.
- test 21 `:1220-1222` (`entries` vacío) no tiene un `[A]` previo, **pero** `program.account.escrowIndex.fetch(pda)` tira si la cuenta no existe, y M15/M16 lo matan — o sea que el assert sí discrimina.

**Test 13b** merece mención aparte: es el único que convierte un footgun de cliente en algo ejecutable, y su comentario `:889-891` anticipa el falso verde (*"If this ever equals the programId, the client DID omit the account … that is a finding, not a green test"*). Reproduje su mecanismo por fuera y da lo mismo.

## 4. Findings

Ninguno bloquea. Ordenados por valor.

---

**MNR-1 — [Prosa / Tests] "aborta en el ciclo 1" es falso con el assert que la propia frase cita: aborta en el ciclo 2**

- **Archivo:línea**: `tests/escrow-index.ts:911-913` y `doc/sdd/003-…/auto-blindaje.md:9-11`.
- **Qué dice**: *"asserting inside would abort at cycle 1 against the un-fixed binary"* / *"contra el binario de hoy el test aborta en el **ciclo 1** (el índice acumula: `[A]`, `[A,B]`, …)"*.
- **Reproducción**: el assert citado es `entries.length <= 1` (`story-HU-326.md:433`). Contra el binario sin el fix, al final del ciclo 1 `entries = [A]` ⇒ `1 <= 1` **pasa**. Recién al final del ciclo 2 vale `[A,B]` ⇒ `2 <= 1` falla. El propio `w0-red.txt:7726-7731` muestra ese `[A,B]` de dos entradas contra el binario viejo.
- **Impacto**: cero funcional; la conclusión de la entrada (el assert adentro esconde el 6005 del 33º) sigue siendo correcta. Pero está en el registro que existe **para que la próxima HU no repita el error**, y una frase falsable y falsa ahí vale menos que ninguna frase.
- **Sugerencia**: "ciclo 2" en los dos lugares, o decir "aborta mucho antes del 33 (en el ciclo 2 con `≤ 1`, en el 1 si el assert fuera `== 0`)".

---

**MNR-2 — [Tests] El número que el test 21 imprime como "difference" es ruido: cambia de signo entre corridas, y el comentario no lo dice**

- **Archivo:línea**: `tests/escrow-index.ts:1215` (el `console.log`), nota de cabecera `:1161-1166`.
- **Reproducción** (dos corridas consecutivas de `npx ts-mocha … tests/escrow-index.ts`, árbol limpio, mismo binario `d4b736cf`):

  ```
  corrida 1: with index = 21143 | escrowIndex=null = 23190 | difference = -2047
  corrida 2: with index = 22643 | escrowIndex=null = 18690 | difference =  3953
  ```

  O sea: en la corrida 1 el `close` **con** índice salió **más barato** que el que no lo lleva. Eso es imposible como costo del write y es puramente la búsqueda de bump de dos escrows distintos (múltiplos de ~1.500 CU, igual que documenta T11).
- **Impacto**: quien lea la línea "difference" la va a leer como el costo del índice, que es lo único que un test llamado "close with and without the index" sugiere medir. El nombre se salva porque dice **"report"** y no "compare", y el paréntesis "(same run, DIFFERENT escrows)" insinúa el mecanismo — pero nunca dice la conclusión: **esa diferencia está dentro del ruido y puede ser negativa**. La vara la puso el propio repo en T11 (`:767-768`), que **cuantifica** ("over 28 runs it ranged 52_826..79_826 CU, always in steps of 1_500"). T21 no cuantifica nada.
- **Sugerencia**: o sacar el tercer `console.log`, o etiquetarlo con lo medido — algo del tipo `difference (DENTRO del ruido del bump search: -2047 y +3953 en dos corridas seguidas; NO es el costo del índice)`.

---

**MNR-3 — [Registro de mutación] El matiz de M18 sobre el test 21 atribuye la muerte a la aserción equivocada**

- **Archivo:línea**: `doc/mutation-run.md:62-63`.
- **Qué dice**: *"M15, M16 and M18 also kill test 21, whose last assertion is that the index is empty after both closes. That is a side effect of how 21 is written."*
- **Reproducción**: para M15 y M16 es cierto. Para **M18** (`if let Some` → `.as_mut().unwrap()`) el test 21 no llega nunca a esa aserción: el segundo `close` de 21 pasa `escrowIndex: null` (`tests/escrow-index.ts:1206-1209`), el `unwrap()` sobre `None` panica y la **tx** falla, así que el test muere en `processIxs` (`:1206`) y no en `:1220-1222`. La confirmación está en el propio `w4/M18-summary.txt`: también mata el test 13, D1, D1b, E2, E3 y `escrow.ts` 8, que son **todos** closes con `escrowIndex: null` y ninguno mira el índice.
- **Impacto**: la sección existe justamente para que "5 KILLED" no sobreestime la cobertura; un matiz mal atribuido la sobreestima igual, en el sentido contrario (hace parecer accidental una muerte que en M18 es directa y legítima).
- **Sugerencia**: separar — M15/M16 matan a 21 por la aserción final (efecto colateral); M18 lo mata porque el `close` sin índice deja de ejecutar (mismo motivo por el que mata a 13, D1, D1b, E2, E3 y `escrow.ts` 8).

---

**MNR-4 — [Registro de mutación] La receta "How to repeat it" quedó con la línea base vieja y con md5 pre-W5, sin decir que lo son**

- **Archivo:línea**: `doc/mutation-run.md:108` (`# must be 43 passing`) y `:46-47` (los tres md5 de referencia).
- **Reproducción**: hoy, sobre `36d9ed0` con el árbol limpio, la suite da **54 passing** (lo corrí) y los md5 son `lib.rs = e21a3f5e…` y `escrow.so = d4b736cf…`, no `2e56fb6a…` / `70480969…`. Quien siga la receta de `:102-109` al pie de la letra ve 54 donde el archivo le promete 43, y ve dos md5 distintos de los que el mismo archivo llama "the reference" — es decir, exactamente la señal que el archivo enseña a leer como "el binario quedó mutado". `idl-hash.md:37-41` explica el cambio del `.so` (los macros de Anchor embeben el número de línea, y W5 corrió las líneas), pero `mutation-run.md` no lo cruza.
- **Impacto**: la próxima corrida de mutación arranca dudando de su propio árbol.
- **Sugerencia**: en `:108` poner 54, y una línea en `:46-47` aclarando que esos tres md5 son los del árbol **pre-W5** con puntero a `idl-hash.md:37`.

---

**MNR-5 — [Test coverage] El segundo footgun documentado (`escrowIndex: null` con índice existente) no tiene test, al lado de uno que sí lo tiene**

- **Archivo:línea**: lo afirman `lib.rs:714-717` (y viaja al IDL) y `README:626-628`. Ningún test lo ejerce: los 5 builders de `close` con `null` (`escrow.ts:516`, `:556`, `escrow-window.ts:288` y el test 13) son todos de senders que **nunca** llamaron `register_escrow`.
- **Reproducción del test que falta**: `deposit(id) → register(id) → release(id) → close(id, …, null)`; esperado: la tx **confirma** y `entries` sigue conteniendo `[id]`. Hoy nada lo pinnea.
- **Impacto**: bajo — la propiedad se sigue trivialmente del `if let Some` (`lib.rs:341`). Pero el archivo se fija su propia vara en `tests/escrow-index.ts:322-325`: *"Test 13b keeps that footgun executable instead of only written down"*. El footgun de al lado, que es el que reintroduce el cap monótono, quedó sólo escrito.
- **Sugerencia**: un `13c` de seis líneas reusando el helper (ya acepta `null`).

---

**MNR-6 — [Docs de proceso] `_INDEX.md` se contradice a sí mismo dentro del mismo archivo**

- **Archivo:línea**: `doc/sdd/_INDEX.md:26` da estado **"F1 — in progress"** y lista sólo el `work-item.md` como artefacto; `:31` dice **"Implementado y probado, sin desplegar (CD-1)"**.
- **Impacto**: nulo hoy; lo cierra el agente de docs en DONE. Lo listo porque el archivo entra en el diff de esta rama (commit `a546384`) y porque una tabla de estado que dice una cosa y su resumen que dice otra es exactamente lo que hace que nadie vuelva a mirar la tabla.
- **Sugerencia**: que F5/DONE actualice fila y artefactos juntos.

---

**MNR-7 — [Tests, opcional] El `≤ 1` del test 14 es una unidad más flojo que el invariante, y esa unidad es la que deja pasar a M16**

- **Archivo:línea**: `tests/escrow-index.ts:932-935`.
- **Aclaración de encuadre**: **no es incumplimiento del Story File** — `story-HU-326.md:433` y `:777` especifican `entries.length ≤ 1`, y el dev lo respetó al pie de la letra (ver §2.1). Lo reporto como oportunidad, no como desvío.
- **Reproducción**: contra el binario correcto el valor por ciclo es siempre **0** (`auto-blindaje.md:17` lo dice). Con M16 (`retain` invertido a `==`) el ciclo queda en exactamente **1** entrada estable, así que `Math.max(...) ≤ 1` **pasa**: `w4/M16-summary.txt` mata 12, 18 y 21, y no el 14.
- **Impacto**: ninguno en cobertura total (M16 muere tres veces por otro lado). Es sólo que el test que más caro sale de correr —33 ciclos completos— podría estar matando un mutante más gratis.
- **Sugerencia**: `to.equal(0)` sobre el máximo, o dejarlo y anotar en el test por qué el 1 está permitido.

---

## 5. Qué encontré sólido (con evidencia, para que se distinga de no haber mirado)

1. **El fix es de tres líneas y está en el lugar correcto.** `lib.rs:341-343` va después de los CPIs y su comentario `:336-340` explica el orden con una afirmación verificable ("los constraints del Context — incluido `is_terminal()` — corren antes"), que el test 17 (`:1002-1020`) ejecuta: `close` sobre un `Deposited` revierte `EscrowNotTerminal` **y** deja la entrada donde estaba.
2. **La duplicación deliberada del `retain` (CD-16) no es un descuido, es lo que hace que el plan de mutación signifique algo.** M15/M16/M17 tocan sólo `close` y ninguno mueve `deregister_escrow`; si estuvieran factorizados, cada mutante habría roto los dos caminos y los tests 4b/4c habrían enmascarado el resultado.
3. **La evidencia de W3 es honesta hasta lo incómodo**: `w3/chaski-v3-pin.txt` y `w3/wasiai-facilitator-pin.txt` están commiteados **en rojo**, mostrando que el test del sibling de los dos consumidores falla con `Received: bfbdfe5a…` contra el pin `fb64c937…`. Es la consecuencia esperada de no re-pinnear (CD-2), y quedó registrada en vez de escondida.
4. **`idl-hash.md` documenta el control que hace creíble al hash nuevo** (`:25-26`): corrieron el canonicalizador sobre una entrada de valor conocido (el IDL de `main`) y verificaron que devuelve `fb64c937…` **antes** de creerle sobre la entrada nueva. Reproduje el resultado final y da `bfbdfe5a…`.
5. **`auto-blindaje.md:39-53`** documenta que `git status --short | head -5` bajo `rtk` se lee como "limpio" sobre un árbol sucio, y cómo lo reemplazó. Es la misma trampa con la que me crucé yo en este CR (y por eso todas mis mediciones van con `--porcelain` completo).
6. **Test 19 no se prueba a sí mismo**: los seis discriminadores están copiados del IDL **vendoreado pre-326** de `chaski-v3`, no del build propio (comentario `:1042-1045`), y verifiqué que efectivamente coinciden byte a byte con esa fuente externa.

## 6. Veredicto

**APROBADO con MENORes.** 0 BLOQUEANTEs. Los 7 MENORes son de precisión de prosa y de registro; ninguno rompe un AC, ninguno toca el money-path, ninguno bloquea el gate. Los de más valor son **MNR-2** (un número publicado que mide ruido y puede salir negativo) y **MNR-1/MNR-3/MNR-4** (tres frases falsables y falsas en los dos documentos que existen justamente para que no haya que volver a mirar). Si el orquestador quiere un fix-pack corto, ese es el orden.

---

**Resumen para el orquestador**

- Veredicto CR: **APROBADO con MENORes** (0 BLQ / 7 MNR). No re-lanza al Dev por gate; el fix-pack es opcional y de bajo costo.
- Suite reproducida por mí: **54 passing, 0 failing** sobre `36d9ed0` con árbol limpio y `escrow.so` md5 `d4b736cf…` (el que documenta `idl-hash.md:37`).
- El hash `bfbdfe5a…` lo recalculé de cero y coincide; CD-2 y CD-17 verificados (los consumidores siguen pinneados en `fb64c937…`).
- **Riesgo de proceso a informar**: el AR paralelo mutó y rebuildeó el árbol compartido de `solana-programs` durante mi revisión (M19 aplicado a las 14:16, restaurado a las 14:17). Si el AR reporta mediciones sobre `target/`, pedile que confirme `git status --porcelain` limpio **en el mismo comando**; yo lo hice y por eso mis números son válidos.
- No escribí el `cr-report.md` en disco (restricción de mi runtime: los reportes van en el mensaje). El contenido de arriba es el archivo, listo para persistir en `/home/ferdev/.openclaw/workspace/solana-programs/doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/cr-report.md`.
