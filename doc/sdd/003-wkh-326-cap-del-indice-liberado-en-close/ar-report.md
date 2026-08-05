## AR — WKH-326 · `close` saca del índice la entrada del escrow que cierra

**Repo:** `/home/ferdev/.openclaw/workspace/solana-programs` · rama `feat/326-cap-del-indice-liberado-en-close` (7 commits sobre `main`)

**VEREDICTO: RECHAZADO — 1 BLOQUEANTE-BAJO activo.** El código on-chain no cedió a ningún ataque. Lo único que rompe es prosa: hay números en el README y en el runbook de mutación que **esta misma rama vuelve falsos**, y uno de ellos da un criterio de pass/fail equivocado en el protocolo con el que este repo ya se comió dos errores.

> Nota de proceso: la política del harness me prohíbe escribir archivos `.md` de reporte. El contenido de abajo es el `ar-report.md` completo, listo para persistirse en `doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/ar-report.md` si el orquestador lo quiere en disco.

---

## Estado del entorno tras el AR — verificado, no prometido

Corrí dos mutantes, un build con el fuente pre-W5, un `cargo fmt --check` con el fuente de `main`, y una suite adversarial temporal de 7 casos. Todo revertido:

```
solana-programs   git status --porcelain -> vacío
                  md5 lib.rs / escrow.json / escrow.so / escrow.ts == baseline
chaski-v3         git status --porcelain -> vacío
wasiai-facilitator git status --porcelain -> vacío
suite final: 54 passing, 0 failing
```

---

## Las seis afirmaciones del Dev

| # | Afirmación | Veredicto | Cómo lo comprobé |
|---|---|---|---|
| 1 | Los 5 mutantes están KILLED | **CONFIRMADA** (2 de 5 verificados por mí) | ver abajo |
| 2 | Los 7 tests volvieron a verde sin tocar una aserción | **CONFIRMADA, y es más fuerte de lo que dice** | ver abajo |
| 3 | El `.so` cambió post-W5 sin cambio de lógica | **CONFIRMADA — pero su repro no repro** (MNR-1) | ver abajo |
| 4 | M19 mata al 13b por el CLIENTE; el guard on-chain lo prueba el 15 | **CONFIRMADA, literal** | ver abajo |
| 5 | Exactamente 1 rojo por repo, mismo hash | **CONFIRMADA** | ver abajo |
| 6 | Cero deploys, cero txs contra devnet | **CONFIRMADA, y contra la cadena** | ver abajo |

### 1 — Mutantes: apliqué M16 y M19 con el protocolo completo

Protocolo: md5 baseline → romper → `anchor build` → suite → restaurar → `anchor build` → verificar md5.

**M16** (`retain(|e| *e != id)` → `==`, `lib.rs:342`, aplicado con `assert count==1` para no tocar el `retain` de `deregister_escrow` en `:377`):

```
51 passing, 3 failing
 1) 12 ... AssertionError: expected [ '78…' ] to deeply equal [ '79…' ]   (escrow-index.ts:837)
 2) 18 ... AssertionError: expected [] to deeply equal [ '92…' ]          (escrow-index.ts:1036)
 3) 21 ... AssertionError: expected [ '93…' ] to deeply equal []          (escrow-index.ts:1222)
```
Idéntico, test por test, a `w4/M16-summary.txt`. **KILLED.**

**M19** (se le sacan `seeds` + `bump` a `escrow_index` en `struct Close`, `lib.rs:722-726`):

```
52 passing, 2 failing
 1) 13b ... Error: Account `escrowIndex` not provided.  (@coral-xyz/anchor common.ts:51)
 2) 15  ... expected tx to revert with ConstraintSeeds  (expectRevert, escrow-index.ts:390)
```
Idéntico a `w4/M19-summary.txt`. **KILLED.**

Restauración verificada las dos veces con `diff` contra el md5 baseline, no asumida.

### 2 — El diff de los tests: más limpio de lo que el Dev afirma

`git diff main..HEAD -- tests/escrow.ts tests/escrow-window.ts` = 12 insertions, 1 deletion. La única línea borrada es `vault: PublicKey` → `vault: PublicKey,` (coma para el parámetro nuevo). **Cero aserciones tocadas.**

Y extendí la comprobación a `tests/escrow-index.ts`, que el Dev no menciona: `git diff main..HEAD -- tests/escrow-index.ts | grep -c "^-.*expect\|^-.*assert"` → **0**. Las únicas líneas borradas ahí son firmas de helpers (`deposit` gana `signer`, `release` gana `escrowOwner`). AC-5 se sostiene.

### 3 — El `.so` post-W5: la conclusión es cierta, el repro que ofrecen no sirve

Lo probé de una forma que el Dev no usó y que es más fuerte:

```
$ git show bdd9d92:programs/escrow/src/lib.rs   # el fuente del run de mutación (W4)
  md5 = 2e56fb6a09006c304c2132d5b42eebf6   ← exactamente el que registra mutation-run.md:44
$ anchor build
  target/deploy/escrow.so  md5 = 70480969808b8fd839f3b8bfe1d8775b   ← exactamente el registrado
  target/idl/escrow.json   md5 = c8e10be9a38bd96b4f0e2ebb422c0c28   ← idéntico al de HEAD

$ diff <(git show bdd9d92:…/lib.rs | grep -v '^\s*//') \
       <(git show HEAD:…/lib.rs   | grep -v '^\s*//')
  (vacío)
```

O sea: entre el binario contra el que corrieron los 5 mutantes y el binario de HEAD **no hay una sola línea de código de diferencia**, sólo comentarios. Los md5 de referencia de `doc/mutation-run.md:44-46` son reproducibles hoy. Y el IDL no se movió con los `//` de W5, que era lo que CD-6 protege.

Lo que **no** se sostiene es la refutación ofrecida (`idl-hash.md:41`): corrí `strings target/deploy/escrow.so | grep lib.rs` y devuelve 3 hits, los tres la **ruta** del fuente, ningún número de línea. El mecanismo sí es observable, pero en los logs de runtime, no ahí: `grep -o "AnchorError thrown in programs/escrow/src/lib.rs:[0-9]*" suite.log` → `:148 :155 :159 :198 :207 :246 :250 :354`. → **MNR-1**.

### 4 — El guard de ownership está probado on-chain, no por el cliente

Literal, en mi corrida de M19:
- **13b** muere con `Error: Account 'escrowIndex' not provided` lanzado por `@coral-xyz/anchor/src/program/common.ts:51` — **error del cliente**, la tx nunca sale. Confirmado: 13b NO prueba el guard on-chain.
- **15** muere con `expected tx to revert with ConstraintSeeds` desde `expectRevert` (`escrow-index.ts:390`), o sea **la tx confirmó**. Ése es el guard on-chain, y `expectRevert` (`escrow-index.ts:376-393`) pinnea el código exacto vía `e.error.errorCode.code`, no un "tira algo".

Además lo reforcé con una sonda propia (P7, abajo): el atacante **con su propio índice ya creado** pasando el índice de la víctima → `ConstraintSeeds`, y **los dos** índices quedan intactos entrada por entrada. Eso cubre la parte de AC-4 ("ninguno de los dos índices") que el test 15 no ejercita, porque su atacante no tiene índice.

### 5 — Consumidores: 1 rojo por repo, mismo hash, cero escrituras

Corridos por mí en modo lectura. `chaski-v3` está en `feat/040-wkh-325-…` con el árbol **limpio** (la otra HU ya cerró); ninguno de los tres archivos que importan cambió (md5 idénticos antes y después de mis corridas).

```
chaski-v3 · contracts/idl/escrow-idl.hash.test.ts   → 1 failed | 5 passed
wasiai-facilitator · src/chains/escrow-idl.hash.test.ts → 1 failed | 3 passed
ambos: Expected fb64c937… / Received bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922
```

El rojo es **sólo** el `expect` del hash del sibling. Verdes: los pins de listas de cuentas por posición y los 6 discriminadores.

### 6 — Cero deploys: comprobado contra devnet, no sólo contra el diff

Ningún commit toca `scripts/deploy-devnet.sh`, keypairs ni `target/` (gitignoreado). Y un `getAccountInfo` de sólo lectura sobre la programData del programa:

```
programData UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR
last deployed slot = 480_496_830 ; slot actual = 481_464_170
Δ ≈ 967.000 slots ≈ 4,5 días  → último deploy ~2026-08-01 (la ventana de custodia), no hoy
```

*(No abrí `m5-keys/`. `solana program show` falla en este entorno porque el signer por defecto apunta ahí; usé JSON-RPC directo, sólo lectura.)*

---

## Los vectores de diseño: qué ataqué y qué no cedió

Escribí una suite adversarial temporal (`tests/zz-ar-probe.ts`, **borrada**, árbol verificado limpio) con los helpers reales de `escrow-index.ts`:

| Sonda | Ataque | Resultado |
|---|---|---|
| **P1** | `escrowIndex` = un `EscrowState` (cuenta del **mismo programa**, discriminador ajeno) | `AccountDiscriminatorMismatch`; el `EscrowState` ajeno sigue `Deposited` |
| **P2** | `escrowIndex` = `senderAta` (cuenta de **otro programa**) | `AccountOwnedByWrongProgram`; balance intacto |
| **P3** | AC-7 con índice **lleno de 32 entradas ajenas**, cerrando un id no registrado | **CONFIRMA**, y las 32 entradas quedan idénticas |
| **P4** | Índice lleno que **sí** contiene el id (posición 16 de 32) | **CONFIRMA**; quedan 31, en el orden original, sin la del cerrado |
| **P5** | Índice **vacío** (register → deregister) | **CONFIRMA**, `entries` sigue `[]` |
| **P6** | **Cliente legacy**: `close` armado con la lista vieja de 6 cuentas | `custom program error: 0xbbd` = **3005 `NotEnoughAccountKeys`**; el `EscrowState` sigue en pie |
| **P7** | Atacante **con índice propio** pasando el de la víctima | `ConstraintSeeds`; los **dos** índices intactos |

Y las preguntas del brief, una por una:

- **¿Se puede pasar el índice de otro sender y que el programa lo mute?** No. El guard son las seeds y **se evalúan** — lo probó M19 (sacándolas, la tx confirma). P1/P2/P7 cierran los caminos laterales (tipo ajeno, programa ajeno, atacante con índice propio).
- **¿Hay un camino donde las seeds no se evalúen?** Sólo `None`, y ahí no se toca nada. Anchor 1.1.2 evalúa `seeds`+`bump` dentro de la rama `Some` (confirmado: quitarlas cambia el comportamiento).
- **¿El `retain` puede correr antes de `is_terminal()`?** No: el constraint vive en `escrow_state` (cuenta #2 del Context, `lib.rs:678`) y corre en `try_accounts`, antes del cuerpo; el `retain` está en `lib.rs:337-343`, al final del handler. Test 17 lo pinnea con **dos** aserciones (código 6004 + `entries === [id]`).
- **`close` sin índice (el camino de producción):** intacto. `escrow.ts` 7/8, `escrow-window` D1/D1b/D2/E2/E3 verdes **sin tocar aserciones**, y test 13 asserta además que la PDA sigue `null` después (o sea, nadie metió `init_if_needed`).
- **El cupo de 33:** el ciclo corre de verdad. Contra el binario viejo, `w0-red.txt:4286` muestra el `EscrowIndexFull`/6005 en el 33º y `43 passing, 2 failing`. Contra el nuevo, verde. La reescritura (medir por ciclo, asertar el máximo después) **no debilita** el criterio del Story File (`story-HU-326.md:433,777`, que ya pedía `≤ 1`) — ver MNR-3 para el matiz.
- **CD-5 / AC-9 — sólo `close` cambia:** lo verifiqué contra una fuente **independiente**, el IDL vendoreado pre-cambio de `chaski-v3`, con un diff estructural recursivo contra `target/idl/escrow.json`:
  ```
  LEN /instructions[0]/accounts 6 -> 7
  EXTRA /instructions[0]/accounts[6] = escrow_index (optional:true, writable:true, pda seeds ["escrow-index", sender])
  (nada más)
  ```
  Cero diferencias en discriminadores, args, layouts de cuentas, tipos y docs de las otras cinco. Y los literales pinneados en los tests 19/20 coinciden byte a byte con ese IDL vendoreado (incluido `release` con 9 cuentas), o sea que el pin **no** se copió del build propio.
- **CD-13 (`init`/`init_if_needed`):** `grep -n "init"` sobre el bloque `struct Close` → **exit 1, cero hits**.
- **CD-16 (el `retain` de `deregister_escrow` no se toca ni se unifica):** siguen siendo dos expresiones duplicadas, `lib.rs:342` y `lib.rs:377`. Ningún helper compartido. Y el mutante M16 aplicado a una **no** afecta a la otra: lo comprobé aplicándolo con `assert count == 1`.

Extras: `cargo clippy --all-targets -- -D warnings` limpio. `cargo fmt --check` deja 5 hunks — **los mismos 5 que en `main`** (lo medí swapeando el `lib.rs` de `main`), o sea que la HU no agregó drift y CD-12 se respetó.

---

## Las 11 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | **Security** | **OK** — guard de ownership por seeds probado on-chain (M19 + test 15) y reforzado por P1/P2/P7. `bump = escrow_index.bump` es seguro acá porque `register_escrow` (`lib.rs:708-714`) es lo único que crea la cuenta y usa bump canónico: no existe un `EscrowIndex` de este programa en dirección no canónica. Sin escalada de privilegio nueva: `close` sólo puede sacar el id que él mismo cierra, y `deregister_escrow` ya permitía más. |
| 2 | **Error Handling** | **OK** — no hay `catch` que trague nada. Todo revert pinnea el código exacto vía `expectRevert` (`escrow-index.ts:376-393`); §8.1 del SDD documenta que D2 reventaba por el motivo equivocado y sólo el pin lo delató. `retain` no puede hacer panic con id ausente (P3/P5). |
| 3 | **Data Integrity** | **OK** — orden de constraints correcto (test 17 + P-análisis). Idempotencia verificada con índice vacío (P5), lleno-sin-el-id (P3) y lleno-con-el-id (P4, orden preservado). Sin concurrencia: Solana serializa escrituras sobre la misma cuenta y `close` es atómico. La cuenta no se realloca; `entries` sólo se achica. |
| 4 | **Performance** | **OK** — T21 mide y guarda contra `CU_REGRESSION_GUARD = 300_000`. Peor `close` observado en F2: 28.643 CU; en mi corrida el runtime reporta ~21.690. `retain` es O(32) sobre 16 bytes. |
| 5 | **Integration** | **OK, con el costo medido** — 1 rojo por consumidor, sólo el `expect` del hash; los pins de forma quedan verdes. Diff estructural del IDL = 1 cuenta agregada, nada más. Y cuantifiqué el breaking change que el README declara: un cliente legacy de 6 cuentas ahora muere con **3005 `NotEnoughAccountKeys`** sin tocar estado (P6). Ningún consumidor arma `close` (re-verifiqué el grep del SDD §4). |
| 6 | **Type Safety** | **OK** — Rust sin `unwrap`/`expect` nuevos; el `if let Some` es la forma correcta. En TS los `(idl as any)` de los tests 19/20 son el patrón preexistente para leer el artefacto crudo. |
| 7 | **Test Coverage** | **MENOR** — ver MNR-3. 11 tests nuevos, 5 mutantes, cobertura por AC completa; el único hueco que encontré (close contra índice vacío) lo corrí yo y pasa. |
| 8 | **Scope Drift** | **MENOR** — ver MNR-4. Ni un archivo de `src/` fuera de scope; `deregister_escrow`, `MAX_ENTRIES`, `MIN/MAX_CUSTODY_SECS` y `EscrowStatus` intactos (CD-3/4/7/16 verificados). |
| 9 | **Destructive Migrations** | **N/A en su forma SQL; analizada en su forma on-chain: OK.** No hay migración de datos: el layout de `EscrowIndex` y de `EscrowState` no se toca (tests 1b/E1/E1b/E2/E3 verdes contra cuentas legacy hechas a mano). Lo destructivo posible sería el cambio de interfaz de `close`, que **no es reversible por deploy** — y está fuera de scope por CD-1, con el plan de rollout escrito en `README.md:1001-1013`. Cero deploys verificado on-chain. |
| 10 | **RPC con SECURITY DEFINER** | **N/A** — no hay Postgres. El análogo Solana (código que firma con privilegios que el caller no tiene) sí existe: el handler firma el sweep del vault con las seeds del PDA `escrow_state` (`lib.rs:300-332`), pero eso es preexistente y esta HU no lo toca. La cuenta nueva **no** se manipula con autoridad de PDA: se valida declarativamente contra la firma del `sender`. |
| 11 | **Cache Invalidation** | **N/A** — no hay cache. El análogo es el IDL vendoreado en los dos consumidores, que es una copia cacheada de la interfaz; su política de invalidación son los tests de pin, y se pusieron rojos exactamente como se predijo. La invalidación real (re-pin) está deliberadamente diferida a la HU de deploy (CD-2/CD-17), que es lo correcto: pinnear un hash intermedio que nunca se publica sería peor. |

---

## Hallazgos, ordenados por gravedad

### BLQ-BAJO-1 — Tres números que esta rama vuelve falsos, y uno de ellos es un criterio de pass/fail
**Categoría:** Integration / documentación operativa
**Archivo:línea:** `README.md:29`, `README.md:30`, `README.md:761`, `doc/mutation-run.md:108`

**Qué está mal.** La suite de esta rama tiene **54** tests. El repo sigue diciendo 43 en cuatro lugares, y uno de ellos no es informativo sino **el criterio de éxito del protocolo de restauración**:

```
README.md:29  | Test coverage | 43 tests, all passing locally. …
README.md:30  | CI | **Green.** clippy, `anchor build` and the 43 tests run on every push.
README.md:761 Last measured run: **43 passing**, in about 3 seconds.
doc/mutation-run.md:108  anchor test --skip-build --skip-deploy --skip-local-validator   # must be 43 passing
```

Lo grave es el último, y es una contradicción **dentro del archivo que el Dev editó en esta HU**: `doc/mutation-run.md:41` dice "baseline **54 passing**" y 67 líneas más abajo el how-to dice "must be 43 passing".

**Reproducción.**
```bash
cd solana-programs && anchor build
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/escrow.ts tests/escrow-index.ts tests/escrow-window.ts
#   -> 54 passing            (esperado por README/runbook: 43)
grep -n "43 " README.md doc/mutation-run.md
```

**Impacto.** Quien siga el runbook de mutación (el mismo con el que este repo ya se equivocó **dos veces**, `doc/mutation-run.md:9-15`) restaura bien, ve 54, y concluye que la restauración falló. Y David lee la fila "Test coverage" del status table antes que cualquier otra cosa del repo. La convención de este repo es mantener ese número al día: en `main` dice 43 y `main` tiene 43.

**Sugerencia.** Los cuatro a 54, y en `doc/mutation-run.md:108` dejar el número atado a la rama (o decir "the baseline recorded at the top of this file") para que no vuelva a envejecer en la próxima HU. No escribo el fix.

---

### MNR-1 — La refutación ofrecida para el cambio del `.so` no refuta nada
**Categoría:** Test Coverage / prosa verificable
**Archivo:línea:** `doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/idl-hash.md:41`

Dice: *"Refutable: `strings target/deploy/escrow.so | grep lib.rs`"*. Corrí el comando: 3 hits, los tres la **ruta** (`programs/escrow/src/lib.rs`, `src/lib.rs`), **cero números de línea**. La conclusión es correcta (la probé con el diff sin comentarios, §"afirmación 3"), pero el input que el documento ofrece para tumbarla no puede tumbarla ni confirmarla.

**Repro:** `strings target/deploy/escrow.so | grep lib.rs` → ningún `:NNN`.
**Repro que sí sirve:** `grep -o "AnchorError thrown in programs/escrow/src/lib.rs:[0-9]*" <log de la suite> | sort -u` → 8 números distintos.
**Impacto:** en un repo cuyo método es "cada frase se refuta con un input concreto", una refutación que no ejecuta es la clase exacta de prosa que este proyecto caza. **Sugerencia:** cambiar el comando por el de los logs, o por el diff `grep -v '^\s*//'`, que es el que realmente prueba "cero cambio de lógica".

---

### MNR-2 — El README afirma que el hash del IDL publicado coincide con este repositorio; en esta rama no
**Categoría:** Integration
**Archivo:línea:** `README.md:32`; `doc/publish-idl-onchain.md:7-9`, `:48`, `:135`

`README.md:32`: *"su canonical sha256 **matches this repository** and both consumers"*, con `fb64c937…`. En esta rama el artefacto construido da `bfbdfe5a…` (lo verifiqué corriendo el canonicalizador de `chaski-v3` en modo lectura, y los dos consumidores llegan al mismo número). Ninguna de esas líneas está en el Scope IN, y **CD-17 prohíbe escribir el hash nuevo fuera de la evidencia de la HU** — así que el fix no es poner el número, es una nota de una línea ("desde WKH-326 el IDL construido va por delante del publicado; ver `doc/sdd/003-…/idl-hash.md`"). Sin eso, al mergear a `main` el repo afirma algo falso sobre sincronía IDL↔cadena en un repo que custodia dinero.
**Repro:** `anchor build` en la rama + el canonicalizador de `chaski-v3/contracts/idl/canonical-hash.ts` sobre `target/idl/escrow.json` → `bfbdfe5a…` ≠ `fb64c937…` de `README.md:32`.
*(Lo clasifico MENOR y no BLQ-BAJO a propósito: la rama no está desplegada y la HU de deploy tiene el re-pin en su alcance. Si el equipo mergea a `main` antes de desplegar, sube a BLQ-BAJO.)*

---

### MNR-3 — El test 14 asserta `≤ 1` donde el valor correcto es exactamente 0, y hay un mutante que lo aprovecha
**Categoría:** Test Coverage
**Archivo:línea:** `tests/escrow-index.ts:932-935`

```ts
expect(Math.max(...perCycleLen), `entries per cycle: …`).to.be.at.most(1);
```
Bajo la implementación correcta, `entries.length` al final de cada ciclo es **siempre 0** (`register` mete uno, `close` lo saca). `≤ 1` es lo que pedía el Story File (`story-HU-326.md:433` y `:777`), así que **no es una desviación de la spec** y por eso no lo subo de nivel. Pero tiene una consecuencia medida: **M16 deja el test 14 en verde**. Lo verifiqué en mi corrida — M16 mata 12, 18 y 21, no 14, porque con el `retain` invertido la serie por ciclo es exactamente `1,1,1,…`.

**Repro:** aplicar M16 y correr sólo el 14 → pasa.
**Impacto:** ninguno hoy (12 y 18 cubren la propiedad). Lo reporto para que quede escrito que el 14 prueba *"el cupo dejó de ser monótono"* y **no** *"close saca la entrada correcta"*. **Sugerencia:** `at.most(0)` lo haría autosuficiente sin costo. Decisión del equipo; también es legítimo dejarlo y anotar el alcance en el comentario del test.

---

### MNR-4 — Dos archivos de proceso fuera del Scope IN, y el índice quedó desactualizado
**Categoría:** Scope Drift
**Archivo:línea:** commit `a546384`; `doc/sdd/_INDEX.md:27`

`a546384` (el commit de W0, "los dos tests en rojo") también commitea `.nexus/project-context.md` (+150) y `doc/sdd/_INDEX.md` (+46). Ninguno de los dos figura en la tabla Scope IN (`work-item.md:238-252`), que sólo autoriza `doc/sdd/003-…/`. Son artefactos de proceso, sin impacto de código, y `CLAUDE.md` de hecho exige que las HUs vivan en `_INDEX.md` — por eso es MENOR y no bloqueante.

Lo concreto: `doc/sdd/_INDEX.md:27` sigue diciendo que WKH-326 está en **"F1 — in progress"** con el `work-item.md` como único artefacto, cuando la rama tiene W0..W5 completas y siete artefactos más. Un revisor que entre por el índice se lleva el estado equivocado. Lo cierra `nexus-docs` en DONE, pero conviene que el Dev sepa que quedó así.
**Repro:** `git show --stat a546384`; `sed -n '27p' doc/sdd/_INDEX.md`.

---

### MNR-5 — 1,1 MB de log de DEBUG commiteados para exhibir dos líneas
**Categoría:** Scope Drift / higiene
**Archivo:línea:** `doc/sdd/003-…/w0-red.txt` (1.135.878 bytes, 7.744 líneas)

La evidencia de CD-10 que importa son dos líneas (`43 passing, 2 failing` y el `EscrowIndexFull` del ciclo 33, en `:4286` y `:7719-7737`). El resto es `DEBUG solana_runtime::message_processor::stable_log` de tres suites completas. Es el artefacto más pesado del repo y va a un repo que revisa un mentor externo.
**Repro:** `ls -la doc/sdd/003-…/w0-red.txt`; `grep -c "stable_log" w0-red.txt`.
**Sugerencia:** filtrar como se hizo con los `w4/M*-summary.txt` (que están perfectos: 6-16 líneas cada uno) y dejar el crudo fuera de git, o guardarlo con las líneas de DEBUG quitadas. Backlog, no bloquea.

---

## Fix-pack sugerido, en orden

1. **BLQ-BAJO-1** — `README.md:29,30,761` y `doc/mutation-run.md:108`: 43 → 54.
2. **MNR-1** — `idl-hash.md:41`: reemplazar el `strings` por un repro que ejecute.
3. **MNR-2** — nota de una línea en `README.md:32` (sin escribir el hash, para no violar CD-17).
4. **MNR-3 / MNR-4 / MNR-5** — a criterio del equipo; ninguno bloquea DONE.

**Nada de esto toca `programs/escrow/src/lib.rs`.** El programa, tal como está, resistió todo lo que le tiré.
