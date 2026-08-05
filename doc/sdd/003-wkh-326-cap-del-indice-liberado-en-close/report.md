# Report — HU [WKH-326] El tope de 32 del índice de escrows deja de crecer para siempre

**Rama:** `feat/326-cap-del-indice-liberado-en-close` · HEAD `c8b3f7d` (10 commits sobre `main`)
**Veredicto final: DONE, sin desplegar.** QA aprobó (9/9 ACs PASS). AR aprobó tras fix-pack (0
BLOQUEANTES). CR aprobó con MENORes (0 BLOQUEANTES, 7 MENORes, todos cerrados en el fix-pack salvo
uno de higiene registrado como backlog).

---

## Resumen ejecutivo

`close` ahora saca del índice la entrada del escrow que cierra, así que el cupo de 32 deja de crecer
de por vida: antes eran 32 depósitos **en toda la vida del remitente**, ahora son 32 **abiertos a la
vez**, que es lo que su nombre siempre dijo. Entregado como código + 55 tests (43 de base + 12 de
esta HU) + IDL regenerado, en una rama local. **Sin merge, sin push, sin deploy.**

---

## Pipeline ejecutado

- F0/F1: `work-item.md` — el defecto verificado línea por línea contra `lib.rs`, los cuatro caminos
  evaluados, camino (a) elegido y justificado, 9 ACs EARS con su refutación explícita.
- F2: `sdd.md` — resolvió el missing input bloqueante de F1 (si Anchor 1.1.2 emite cuentas opcionales
  de forma que `@coral-xyz/anchor` 0.30.1 las sepa omitir) con una prueba, no con una cita.
- F2.5: `story-HU-326.md` — pseudocódigo wave por wave, incluido el snippet de hash en Python que
  luego demostró no reproducir el hash de `main` (ver Auto-Blindaje).
- F3: implementación en 6 waves (W0 rojo → W1/W2 fix + adversariales → W3 no-regresión de interfaz →
  W4 mutación → W5 documentación), 9 commits, `programs/escrow/src/lib.rs` (+76/-6 líneas de código,
  el resto comentarios), 3 archivos de test.
- AR: **RECHAZADO en la primera pasada** — 1 BLOQUEANTE-BAJO (números de test count desactualizados
  en README/runbook, uno de ellos era el criterio de pass/fail del protocolo de restauración de
  mutantes) + 5 MENORes. El programa on-chain no cedió a ningún ataque.
- CR: **APROBADO con MENORes** — 0 BLOQUEANTES, 7 MENORes, todos de precisión de prosa y de registro.
- Fix-pack (`0fdec52`): cerró el bloqueante de AR y los MENORes de mayor valor de AR+CR. El programa
  no se tocó (`lib.rs` byte a byte igual, md5 idéntico). Suite pasó de 54 a 55 (un test nuevo, 13c).
- Fix adicional (`9c4c088`): resolvió el hallazgo MENOR que encontró el propio QA (ver abajo) sobre
  la evidencia cruda de mutación desactualizada.
- F4 (QA): **APROBADO PARA DONE.** 9/9 ACs con evidencia archivo:línea, corrida por el QA mismo (no
  leída de un reporte ajeno). 1 hallazgo MENOR nuevo, resuelto por el dev antes de este cierre.
- DONE (este reporte): consolidación, `_INDEX.md` corregido, `qa-report.md` commiteado.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `tests/escrow-index.ts:817-838` (test 12): registra A y B, cierra A, `entries` queda exactamente `[B]` |
| AC-2 | PASS | `tests/escrow-index.ts:846-866` (test 13): `deposit → release → close(null)` sin `register_escrow` nunca; confirma y la PDA del índice sigue sin existir. Es el camino que corre hoy en producción (`chaski-v3` sólo arma `deposit`) |
| AC-3 | PASS | `tests/escrow-index.ts:938-971` (test 14): 33 ciclos completos, `register_escrow` 33º confirma, `entries` queda en 0 al final de cada ciclo (`equal(0)`, ajustado en el fix-pack — ver Auto-Blindaje). Contraevidencia roja pre-fix registrada en `w0-red.txt:7719-7743` (`EscrowIndexFull`/6005 en el ciclo 33), reproducida de forma independiente por CR y por AR |
| AC-4 | PASS | `tests/escrow-index.ts:977-1006` (test 15): atacante con índice propio pasa el índice de la víctima, revierte `ConstraintSeeds`, los dos índices quedan intactos. Reforzado por la sonda P7 del AR |
| AC-5 | PASS | `tests/escrow-index.ts:1010-1033` (test 16) + `tests/escrow-window.ts` D1/D1b (barrido del vault), sin una aserción tocada — confirmado por diff de CR (`git diff main..HEAD -- tests/escrow-window.ts` = sólo una coma agregada) |
| AC-6 | PASS | `tests/escrow-index.ts:1039-1055` (test 17): `close` sobre `Deposited` revierte `EscrowNotTerminal` (6004) **y** `entries` sigue `[id]`, dos aserciones |
| AC-7 | PASS | `tests/escrow-index.ts:1059-1074` (test 18): índice sin el id, `close` confirma, `entries` sin cambios |
| AC-8 | PASS | `tests/escrow-index.ts:1084-1121` (test 19) contra el artefacto **construido**: 6 instrucciones, discriminador de `close` = `[98,165,201,177,108,65,206,96]`, `close.accounts[6] = escrow_index` opcional. Verificado por QA de forma independiente con Python |
| AC-9 | PASS | `tests/escrow-index.ts:1126-…` (test 20) + los dos tests de pin corridos **en modo lectura** en los consumidores: `chaski-v3` 5 pass/1 fail, `wasiai-facilitator` 3 pass/1 fail — el único rojo en cada uno es el hash del sibling, esperado (ver sección IDL) |

**9/9 PASS**, con evidencia archivo:línea corrida por AR, CR y QA de forma independiente (no una
copiándole a la otra).

---

## Hallazgos finales

- **BLOQUEANTES:** 1 detectado por AR en la primera pasada (números de test count 43→54 obsoletos en
  README y runbook de mutación, uno de ellos usado como criterio de pass/fail). **Resuelto** en el
  fix-pack `0fdec52`. 0 BLOQUEANTES abiertos hoy.
- **MENORES:** AR reportó 5 (1 sobre una refutación que no ejecuta, 1 sobre una afirmación del README
  que dejaría de ser cierta al mergear, 1 sobre un umbral de test más flojo que el invariante, 1 sobre
  `_INDEX.md` contradictorio, 1 de higiene sobre un log de 1,1 MB). CR reportó 7 (parcialmente
  solapados con los de AR, más 2 sobre el registro de mutación y 1 sobre un `console.log` que mide
  ruido). De ese conjunto: **6 se cerraron** en el fix-pack (números 43→54, la nota de sincronía
  IDL↔cadena, la refutación del `.so` reemplazada por un repro que ejecuta, la atribución de causa de
  muerte de M18, el umbral del test 14 apretado a `equal(0)`, y el footgun sin test cubierto con el
  test 13c nuevo). **1 se resolvió después del F4**, a partir de un hallazgo del propio QA (ver
  abajo). **1 queda como deuda de higiene, no bloqueante**: el log de debug de 1,1 MB en `w0-red.txt`
  (`AR: MNR-5`) — backlog, sin ticket propio todavía. El de `_INDEX.md` contradictorio (AR MNR-4 / CR
  MNR-6) lo cierra este mismo reporte.

---

## Auto-Blindaje consolidado

Copiado íntegro de `auto-blindaje.md`, sin omitir entradas.

### [2026-08-05 13:52] Wave 0 — el assert por ciclo del test 14 tapaba el error que W0 tiene que mostrar

- **Error**: el pseudocódigo del Story File pone `assert entries.length <= 1` *dentro* del loop de 33
  ciclos. Escrito así, contra el binario de hoy el test aborta en el **ciclo 2** y nunca llega al
  `register_escrow` número 33. (El ciclo 1 pasa: el índice acumula `[A]`, y `1 <= 1` es verdadero;
  recién en el ciclo 2 vale `[A,B]` y `2 <= 1` falla. Ese `[A,B]` — el índice con dos entradas
  después de un `close` — está en `w0-red.txt:7726-7731`, ahí reportado por el test 12.)
  La evidencia roja de CD-10 habría sido una AssertionError de longitud, no el `EscrowIndexFull` /
  6005 que la HU necesita registrar.
- **Causa raíz**: el mismo test tiene que cumplir dos cosas que se pisan — verificar una propiedad
  *por ciclo* y llegar hasta el ciclo 33 para exhibir el error real.
- **Fix**: se mide la longitud al final de cada ciclo y se guarda en un array; la aserción corre
  **después** del loop, sobre el máximo, e imprime la serie completa en el mensaje. Contra el binario
  viejo el loop llega al ciclo 33 y muere con 6005 (queda en `w0-red.txt`); contra el binario nuevo
  el máximo es 0.
- **Aplicar en**: cualquier test que quiera probar "esto ya no explota después de N repeticiones" y
  a la vez asertar algo por iteración. Si la aserción por iteración es más estricta que el estado
  previo al fix, va después del loop o el test nunca muestra el bug que dice mostrar.

### [2026-08-05 14:12] Wave 5 — el snippet de python del Story File no reproduce el hash de `main`

- **Error**: casi registro como hash final el número que devolvía el snippet de python de W5.5
  (`hashlib.sha256(json.dumps(d, sort_keys=True, separators=(',',':')))`).
- **Causa raíz**: `json.dumps` escapa lo no-ASCII por defecto (`ensure_ascii=True`) y los `docs` del
  IDL tienen acentos y un `⚠️`, así que canonicaliza distinto que el `JSON.stringify` de los dos
  consumidores. Sobre el IDL de `main` ese snippet da `447a05a7…` y no `fb64c937…`.
- **Fix**: el propio Story File trae el control ("si no reproduce `fb64c937…` no es la
  canonicalización correcta"). Se corrió el control primero, dio distinto, y se pasó al algoritmo de
  `chaski-v3/contracts/idl/canonical-hash.ts` en modo lectura, que sobre `main` sí devuelve
  `fb64c937…`. El hash nuevo es `bfbdfe5a…`, y los dos consumidores llegaron al mismo número por su
  cuenta en W3.
- **Aplicar en**: cualquier hash, firma o checksum que se vaya a comparar entre dos lenguajes. Correr
  siempre el algoritmo nuevo sobre una entrada de valor **conocido** antes de creerle su salida sobre
  la entrada nueva. Un hash que no sé reproducir sobre algo viejo no es evidencia de nada sobre algo
  nuevo.

### [2026-08-05 14:15] Wave 5 — `git status --short | head -5` mostró "ok" sobre un árbol sucio

- **Error**: para probar que no escribí en `chaski-v3` (CD-2) corrí `git status --short | head -5`
  antes y después de correr sus tests, y las dos veces leí "ok ✓". Recién el conteo con `wc -l`
  mostró que ese repo tenía **8 archivos modificados**.
- **Causa raíz**: el wrapper `rtk` reescribe `git status` y su salida colapsada se lee como "limpio"
  cuando se la pasa por `head`. El chequeo que yo creía que era de CD-2 no estaba mirando nada.
- **Fix**: `git status --porcelain` completo, sin pipe a `head`, más `ls -l` de los tres archivos que
  sí serían una violación (`contracts/idl/escrow-idl.hash.test.ts`,
  `src/infrastructure/solana/escrow-idl.ts`, `contracts/CONTRACT-VERSIONS.md`). Los tres tienen
  mtime del 1 y del 4 de agosto, anteriores a esta sesión, y ninguno aparece en el status. Los 8
  sucios son de otra línea de trabajo (ledger/webhook/settle), ajena a esta HU.
- **Aplicar en**: cualquier verificación de "no toqué X". El comando tiene que poder mostrar el caso
  malo. Si nunca lo vi fallar, no sé si sabe fallar — y acá además el chequeo global de "repo limpio"
  no sirve en un workspace compartido: hay que nombrar los archivos concretos.

### [2026-08-05 18:40] Fix-pack — puse un rango medido como si fuera una cota, y la corrida siguiente lo tumbó

- **Error**: arreglando el `console.log` del test 21 (F6), lo etiqueté con los tres samples que
  tenía: "ranged -2047..+3953 over 3 runs". La corrida inmediatamente posterior, contra el **mismo**
  binario, imprimió **+18953**. O sea que la etiqueta que acababa de escribir para dejar de mentir
  sobre ese número ya mentía sobre él.
- **Causa raíz**: tres samples de una variable cuyo mecanismo es "diferencia entre dos búsquedas de
  bump" no acotan nada. Cada escrow puede necesitar hasta 255 iteraciones, así que el rango posible
  es de decenas de miles de CU y tres muestras no lo tocan ni de lejos. Confundí "lo que vi" con "lo
  que puede pasar", que es el mismo error de fondo que la etiqueta pretendía corregir.
- **Fix**: la etiqueta pasó a describir el **mecanismo**, no el rango: los cuatro samples
  (-2047, +2453, +3953, +18953) son todos congruentes con **953 módulo 1_500**, que es exactamente
  la forma de "un costo marginal real de ~953 CU más un número entero de iteraciones de bump". Eso
  sí es falsable con un sample nuevo, y explica por qué puede salir negativo.
- **Aplicar en**: cualquier número medido que se documente. Si no sé el mecanismo que lo genera, N
  samples son N samples y no una cota. Escribir la congruencia / la fórmula, o escribir "no acotado",
  pero nunca `min..max` de lo observado presentado como si fuera el rango.

### [2026-08-05 18:55] Fix-pack — un criterio de restauración escrito como literal envejece y acusa al que restauró bien

- **Error**: `doc/mutation-run.md` decía `# must be 43 passing` como criterio para saber si la
  restauración post-mutante salió bien, en un archivo cuyo propio encabezado ya registraba una
  segunda baseline de 54 sesenta y siete líneas más arriba. El archivo se contradecía consigo mismo.
- **Causa raíz**: el criterio se escribió como el valor de una corrida en vez de como una referencia
  a la baseline de la rama. Cualquier HU que agregue un test lo rompe, y el modo de falla es el peor
  posible: el que restaura BIEN ve un número distinto al literal y concluye que restauró mal — que es
  justo el error que ese archivo documenta haber cometido dos veces.
- **Fix**: el criterio ahora dice "must match the baseline recorded at the top of this file", con un
  párrafo que lista las tres baselines (43 / 54 / 55) y manda a tomarla de una corrida limpia si el
  árbol se movió. Además el fix-pack agregó una tercera baseline (55), así que el literal habría
  quedado mal por segunda vez en la misma semana.
- **Aplicar en**: todo criterio de pass/fail escrito en prosa. Si el criterio es un número que el
  repo ya guarda en otro lado, referenciar ese lado. Un número duplicado es un número que se va a
  desincronizar.

### [2026-08-05 19:20] Fix-pack — re-corrí los mutantes, actualicé el relato y dejé la evidencia cruda vieja sin etiquetar

- **Error**: el fix-pack re-corrió los cinco mutantes contra el árbol nuevo y actualizó la tabla y la
  prosa de `doc/mutation-run.md` con la segunda pasada. Los cinco `w4/M*-summary.txt`, que son la
  captura cruda, quedaron de la **primera**. `M16-summary.txt` muestra 3 failing **sin el test 14**;
  el texto dice 4 **con** el 14. Lo cazó el QA.
- **Causa raíz**: traté "actualizar la documentación" como si fuera sólo la prosa. La evidencia cruda
  es documentación también, y es la que consulta el que **desconfía** de la prosa — así que el
  desalineado pega justo donde más duele. Además la primera pasada y la segunda son ambas válidas y
  ninguna estaba mal: lo que faltaba no era re-correr nada, era decir a qué corrida pertenece cada
  archivo.
- **Fix**: cabecera en los cinco `w4/*.txt` con la pasada, la baseline (54), el commit del fuente
  (`bdd9d92`, lib.rs md5 `2e56fb6a…`) y el estado de los tests de ese momento (el 14 con
  `at.most(1)`, sin 13c); en M16 y M18 una línea extra que nombra la diferencia concreta con la
  segunda pasada. `mutation-run.md` ahora dice explícitamente que los `w4/` son de la pasada 1 y que
  la pasada 2 no tiene capturas crudas. Y va un discriminador que no depende de creerle a ninguna
  cabecera: **`passing + failing` = 54 en una captura de la pasada 1 y 55 en una de la pasada 2** —
  se verificó sobre los cinco archivos antes de escribir la cabecera, con un `assert`, no a ojo.
- **Aplicar en**: cualquier medición que se repita. Los artefactos crudos de la corrida vieja no se
  borran ni se pisan (perderías el "antes"), pero desde el momento en que existe una segunda corrida
  **cada archivo tiene que decir de cuál es**, y conviene que exista un campo del propio artefacto
  que lo delate sin leer la etiqueta. Un `_INDEX` o un nombre de carpeta con la fecha no alcanza: el
  que abre el `.txt` suelto no lo ve.

---

## Lo que NO arregla — sin esconderlo

Si el remitente nunca llama `close`, el cupo **tampoco se libera**. Lo que cambia es que deja de
haber un cupo que sólo puede crecer: pasa a existir un camino que lo baja, ese camino le paga al
sender por usarlo (~0,004 SOL de rent recuperado, ver WKH-327), y `deregister_escrow` sigue como
salida manual para entradas cuyo `EscrowState` ya se cerró antes de este cambio. No confundir "el
problema tiene solución" con "el problema se resuelve solo" (`work-item.md:98-102`, verificado por CR
en §1.1 y §1.4 del `cr-report.md`: ninguna frase, en ningún archivo, afirma que el cupo ya no se
puede llenar).

---

## Estado de despliegue — lo más importante de este reporte

**NO DESPLEGADO.** La entrega es código + tests + IDL regenerado, en la rama
`feat/326-cap-del-indice-liberado-en-close`, local. **Sin merge y sin push.** El deploy es
irreversible y lo autoriza el founder aparte (CD-1).

- El hash del IDL **se movió**, de `fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071`
  (el publicado, el que pinnean hoy los dos consumidores) a
  `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922` (el de esta rama, `idl-hash.md`).
  El número nuevo vive **sólo** en `doc/sdd/003-…/idl-hash.md` (y en la evidencia de AR/CR/QA). **No
  se re-pinneó a nadie**, a propósito (CD-2, CD-17): `git grep` del hash nuevo en todo el repo
  devuelve exclusivamente archivos dentro de `doc/sdd/003-…/`.
- Por eso `chaski-v3` (`contracts/idl/escrow-idl.hash.test.ts`) y `wasiai-facilitator`
  (`src/chains/escrow-idl.hash.test.ts`) tienen **1 test rojo cada uno**, el que hashea el artefacto
  hermano y lo compara contra el hash publicado (`Expected fb64c937… / Received bfbdfe5a…`). **Es
  esperado y está registrado en `w3/chaski-v3-pin.txt` y `w3/wasiai-facilitator-pin.txt`**, commiteados
  en rojo a propósito. Se cierra en la HU de deploy, que tiene que hacer, en este orden: republicar el
  IDL en cadena → actualizar los dos IDL vendoreados → re-pinnear las dos constantes → actualizar
  `CONTRACT-VERSIONS.md`.
- **Recomendación registrada** (`work-item.md`, sección "Agrupamiento"): el deploy de esta HU **se
  agrupa con la HU de eventos**, NO con la del congelamiento del reembolso durante el pago
  (`PayoutPending`), que está bloqueada por trabajo previo en los dos consumidores (el `coder.decode`
  de `chaski-v3` en el camino de refund no tiene `try`/`catch` hoy, así que un status byte nuevo
  rompería la recuperación de fondos desde el producto).

---

## La verificación, con los números reales

**55 tests** (43 de la línea de base pre-HU + 12 de esta HU: los tests 12-21 más el 13c agregado en
el fix-pack), 0 failing, corridos por el QA de forma independiente. **5 mutantes** aplicados de
verdad contra el `retain` nuevo (M15-M19) y **todos muertos** (KILLED), con protocolo de md5 antes/
restauración/después en cada aplicación (documentado en `doc/mutation-run.md`, verificado
independientemente por AR para M16 y M19). El test del ciclo de 33 (AC-3) se registró **en rojo
contra el binario viejo** (`EscrowIndexFull`/6005 en el ciclo 33, `w0-red.txt:7719-7743`) antes de
escribir el fix, cumpliendo CD-10. El QA corrió la suite él mismo y validó los 9 criterios con
evidencia archivo:línea, no leyó reportes de otros roles para los ACs.

---

## Lo que NO se pudo verificar

- **Nadie ajeno al proyecto reprodujo nada.** AR, CR y QA son los tres roles de este mismo pipeline;
  ningún tercero externo (ni siquiera David, el mentor Solana LATAM Labs mencionado en el work-item)
  corrió la suite todavía.
- **El QA no pudo re-ejecutar un mutante de forma independiente.** El clasificador de permisos se lo
  bloqueó, correctamente, porque modificar código no es su rol (`qa-report.md`, control 6, dirección
  2). Esa dirección (que M16 mata específicamente al test 14 tras el fix-pack) la dio por buena
  **leyendo** el registro de `doc/mutation-run.md`, no reproduciéndola.
- **Que no haya cuentas de índice vivas en devnet viene del README** (`README.md:104-105`, citado en
  el work-item como missing input), **no se comprobó contra la cadena** — prohibido tocarla en esta
  HU (CD-1). Es insumo de la HU de deploy: si al momento de desplegar ya existieran índices vivos, hay
  que decidir si se limpian con `deregister_escrow` antes.

---

## Lo que apareció y es ajeno a esta HU

El entorno de desarrollo compila con **rustc 1.97.1**, mientras el repo pinnea **1.89.0** en
`rust-toolchain.toml` (`sdd.md:674-677`, `story-HU-326.md:841`). No contaminó nada medido en esta HU:
el artefacto salió byte-idéntico entre las corridas verificadas por AR/CR/QA. Pero el desvío existe,
y es exactamente lo que el workflow `verified-build.yml` está para atrapar. **No se investigó** si
`rust-toolchain.toml` se está respetando o ignorando en este entorno. Queda reportado, sin abrir
ticket propio todavía.

---

## Lo que los revisores encontraron y vale contar

- **El AR verificó contra la cadena** que no hubo despliegue, leyendo el slot del último `ProgramData`
  vía JSON-RPC de solo lectura: `deployed slot = 480_496_830` (2026-08-01, la ventana de custodia) vs
  `slot actual ≈ 481_464_170`, Δ ≈ 4,5 días. El QA reprodujo el mismo número de forma independiente
  (`qa-report.md`, control de runtime 1).
- **El AR escribió siete sondas adversariales propias** (`tests/zz-ar-probe.ts`, P1-P7: cuenta del
  mismo programa con discriminador ajeno, cuenta de otro programa, índice lleno con y sin el id,
  índice vacío, cliente legacy de 6 cuentas, atacante con índice propio pasando el de la víctima) y
  las borró tras la corrida (árbol verificado limpio). **Ninguna** logró mutar o filtrar el índice de
  otro sender.
- **Un test aceptaba un umbral una unidad más flojo que el invariante** (test 14: `≤ 1` donde el valor
  correcto bajo la implementación correcta es siempre `0`), y esa unidad de más dejaba pasar el
  mutante M16 (con el `retain` invertido, la serie por ciclo queda estable en `1`, así que `≤ 1`
  seguía en verde). Se apretó a `equal(0)` en el fix-pack, **verificado en las dos direcciones**:
  contra `main` el test sigue rojo con `EscrowIndexFull`/6005 en el ciclo 33, y con M16 aplicado pasa
  de verde a rojo.
- **Una etiqueta escrita para dejar de mentir sobre un número ya mentía en la corrida siguiente.** El
  `console.log` del test 21 se etiquetó con "ranged -2047..+3953 over 3 runs"; la corrida
  inmediatamente posterior dio +18953. Se reescribió describiendo el **mecanismo** (congruente con
  953 módulo 1500: costo marginal fijo más un número entero de iteraciones de búsqueda de bump) en
  vez del rango observado.
- **Los artefactos crudos de mutación** (`w4/M*-summary.txt`) eran de la primera pasada mientras la
  prosa de `mutation-run.md` describía una segunda (baseline 54 vs 55, con y sin el test 13c). Se
  etiquetaron los cinco, con cabecera que dice pasada/baseline/commit/md5, y con un discriminador que
  no depende de creerle a la etiqueta: `passing + failing` suma 54 en una captura de la primera pasada
  y 55 en una de la segunda. Este hallazgo lo cazó el QA (control 6, dirección 2, del `qa-report.md`)
  y se resolvió en el commit `9c4c088`, después del F4.

---

## Archivos modificados

10 commits sobre `main`, 24 archivos, +11.770/-70 líneas (el grueso es documentación de proceso y el
log crudo de W0).

**Código del programa:**
- `programs/escrow/src/lib.rs` (+76/-6): `struct Close` suma `escrow_index: Option<Account<EscrowIndex>>`
  con `///` (única excepción a CD-6); el handler agrega el `retain` que saca la entrada; se reescriben
  los comentarios que describían el defecto como vigente.

**Tests:**
- `tests/escrow-index.ts` (+519/-…): tests 12-21 nuevos (más 13c agregado en el fix-pack); helpers de
  `close` actualizados para la cuenta opcional.
- `tests/escrow-window.ts`, `tests/escrow.ts`: firmas de helpers actualizadas, cero aserciones
  tocadas (confirmado por diff, verificado por AR y CR).

**Documentación del producto:**
- `README.md` (+111/-…): Known limitations reescrito, invariantes 9 y 11 actualizadas, tabla de
  Instructions, sección de recuperación, y en el fix-pack: números de test count 43→54/55 y nota de
  que el IDL construido va por delante del publicado.
- `doc/mutation-run.md` (+90/-…): tabla de mutantes M15-M19, criterio de restauración corregido a
  referencia de baseline en vez de literal.

**Artefactos de proceso de la HU** (`doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/`):
`work-item.md`, `sdd.md`, `story-HU-326.md`, `ar-report.md`, `cr-report.md`, `qa-report.md`,
`auto-blindaje.md`, `idl-hash.md`, `w0-red.txt` (evidencia roja de CD-10), `w3/*-pin.txt` (evidencia
de los tests de pin corridos en rojo en los dos consumidores), `w4/M*-summary.txt` (capturas crudas
de mutación, etiquetadas por pasada).

**Fuera de Scope IN pero de proceso** (señalado MENOR por AR/CR, sin impacto de código):
`.nexus/project-context.md`, `doc/sdd/_INDEX.md` (corregido en este cierre).

---

## Decisiones diferidas a backlog

- **WKH-327** (camino cliente para llamar `close` y recuperar el rent) — bloqueada por esta HU hasta
  ahora; queda desbloqueada. Debe construirse contra la lista de cuentas **post-326** y decidir cuándo
  pasar `escrow_index` con la regla que el work-item deja escrita: pasarla si la PDA existe, omitirla
  si no.
- **HU de deploy** — republica el IDL, actualiza los dos IDL vendoreados, re-pinnea las dos constantes
  de hash, actualiza `CONTRACT-VERSIONS.md`. Recomendado agruparla con la HU de eventos, no con la del
  congelamiento del reembolso.
- **HU de eventos** — sin identificador formal todavía; el work-item la referencia sólo por
  descripción.
- **HU de congelamiento del reembolso** (`PayoutPending`) — bloqueada por trabajo previo en
  `chaski-v3` (el decode de `refundEscrow` necesita manejar el estado nuevo sin tirar) y en
  `wasiai-facilitator` (`verifyVault` necesita decidir qué significa `PayoutPending` para un release).
- **Backlog sin ticket:** limpiar `w0-red.txt` (1,1 MB de log de debug para exhibir 2 líneas, AR
  MNR-5) y el drift de `rustc` 1.97.1 vs 1.89.0 pinneado (ajeno a esta HU, ver arriba).

---

## Lecciones para próximas HUs

1. **Un assert dentro de un loop puede tapar el bug que el loop existe para exhibir.** Si la
   aserción por iteración es más estricta que el estado que produce el bug, el test aborta antes de
   llegar al punto donde el bug ocurre. Medir y guardar por iteración, asertar después del loop sobre
   el agregado.
2. **Un número medido en pocas muestras no es una cota.** Tres samples de una variable con mecanismo
   desconocido (aquí: diferencia entre dos búsquedas de bump, hasta 255 iteraciones posibles) no
   acotan nada; la corrida siguiente puede tumbar el rango. Si no se conoce el mecanismo, decir "no
   acotado" en vez de `min..max` observado.
3. **Un criterio de pass/fail escrito como literal envejece mal, y el modo de falla es el peor
   posible**: acusa al que hizo el trabajo bien. Referenciar la fuente de verdad (la baseline
   registrada en el propio archivo) en vez de duplicar el número.
4. **La evidencia cruda es documentación tanto como la prosa**, y es la que consulta quien desconfía
   del relato. Cuando se repite una medición, cada artefacto crudo tiene que decir de qué corrida es,
   con un discriminador que no dependa de creerle a la etiqueta (acá: `passing + failing` distingue
   pasada 1 de pasada 2 sin necesidad de leer ninguna cabecera).
