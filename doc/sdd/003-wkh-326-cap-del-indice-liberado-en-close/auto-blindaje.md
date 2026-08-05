# Auto-Blindaje — WKH-326

Errores cometidos durante F3 y cómo se corrigieron. Cada entrada existe para que la próxima HU no
los repita.

### [2026-08-05 13:52] Wave 0 — el assert por ciclo del test 14 tapaba el error que W0 tiene que mostrar

- **Error**: el pseudocódigo del Story File pone `assert entries.length <= 1` *dentro* del loop de 33
  ciclos. Escrito así, contra el binario de hoy el test aborta en el **ciclo 1** (el índice acumula:
  `[A]`, `[A,B]`, …) y nunca llega al `register_escrow` número 33. La evidencia roja de CD-10 habría
  sido una AssertionError de longitud, no el `EscrowIndexFull` / 6005 que la HU necesita registrar.
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
