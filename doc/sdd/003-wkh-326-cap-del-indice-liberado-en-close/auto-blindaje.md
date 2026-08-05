# Auto-Blindaje — WKH-326

Errores cometidos durante F3 y cómo se corrigieron. Cada entrada existe para que la próxima HU no
los repita.

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
