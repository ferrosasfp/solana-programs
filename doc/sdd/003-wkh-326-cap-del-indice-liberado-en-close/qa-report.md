# QA Report (F4) — WKH-326 · el cupo del índice liberado en `close`

**Rama:** `feat/326-cap-del-indice-liberado-en-close` · HEAD `0fdec52` (8 commits sobre `main`)
**Veredicto: APROBADO PARA DONE.** 0 ACs en FAIL, 0 controles de runtime en FAIL. Un hallazgo MENOR de higiene de evidencia (no bloquea).

---

## 0. Suite — corrida por mí, no leída

```
cd solana-programs && git status --porcelain   # limpio antes de empezar
anchor build                                    # exit 0
./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 \
  tests/escrow.ts tests/escrow-index.ts tests/escrow-window.ts
```
Resultado: **55 passing (5s), 0 failing.**

Desglose por archivo (corrido también por separado):
- `tests/escrow.ts` → 10 passing
- `tests/escrow-index.ts` → 25 passing
- `tests/escrow-window.ts` → 20 passing
- 10+25+20 = 55, coincide con `README.md:761` y con la tabla de `README.md:764-766` (que **suma**: es el punto que el CR/AR no habían recorrido tras el fix-pack).

md5 post-build: `target/deploy/escrow.so=d4b736cf…`, `target/idl/escrow.json=c8e10be9…`, `programs/escrow/src/lib.rs=e21a3f5e…` — idénticos a los que documenta `idl-hash.md:37` y a los del segundo pase de `doc/mutation-run.md:52-53`.

`npx ts-mocha` directo falló por un problema de entorno (el hook de rtk reescribe `npx` y rompe la resolución del script); usé `./node_modules/.bin/ts-mocha` con el mismo comando. Documentado para que no se lea como gate rojo.

---

## 1. Los 9 ACs — con evidencia archivo:línea

| AC | Status | Test que lo cierra | Comando que lo comprueba |
|----|--------|---------------------|---------------------------|
| AC-1 | ✅ PASS | `tests/escrow-index.ts:817-838` (test 12): registra A y B, cierra A, `entries` queda exactamente `[B]` | suite arriba, test "12. close removes exactly the entry…" verde |
| AC-2 | ✅ PASS | `tests/escrow-index.ts:846-866` (test 13): `deposit → release → close(null)` sin `register_escrow`; asserta `getAccount(pda) == null` **después** del close | test "13. close with escrowIndex=null…" verde; además `struct Close` (`lib.rs:704-726`) no tiene `init`/`init_if_needed` — `grep -n "init" ` sobre el bloque, 0 hits |
| AC-3 | ✅ PASS | `tests/escrow-index.ts:938-971` (test 14): 33 ciclos completos, `registersConfirmed === 33`, `max(entries por ciclo) == 0` | test "14. 33 deposit→register→release→close cycles…" verde; contraevidencia roja pre-fix en `w0-red.txt:7719-7743` (43 passing/2 failing, `EscrowIndexFull`/6005 en el 33º), citada y reproducida por CR (`cr-report.md:35`) y AR (`ar-report.md:141`) |
| AC-4 | ✅ PASS | `tests/escrow-index.ts:977-1006` (test 15): atacante con índice propio pasa el índice de la víctima, revierte `ConstraintSeeds`, índice de la víctima queda `[victimId]` intacto | test "15. close with the VICTIM's index…" verde |
| AC-5 | ✅ PASS | `tests/escrow-index.ts:1010-1033` (test 16, vault vacío) + `tests/escrow-window.ts` D1/D1b (barrido del vault con dust) | tests "16." + "D1"/"D1b" verdes, sin aserción tocada (confirmado por diff, ver §3) |
| AC-6 | ✅ PASS | `tests/escrow-index.ts:1039-1055` (test 17): `close` sobre `Deposited` revierte `EscrowNotTerminal` (6004) **y** `entries` sigue `[id]` | test "17. close on a Deposited escrow…" verde, dos aserciones (revert + estado) |
| AC-7 | ✅ PASS | `tests/escrow-index.ts:1059-1074` (test 18): índice sin el id, `close` confirma, `entries` sin cambios | test "18. close with an index that does not contain the id…" verde |
| AC-8 | ✅ PASS | `tests/escrow-index.ts:1084-1121` (test 19) contra el artefacto **construido** (`idl` importado, no el fuente) | test "19." verde; verificado también por mí de forma independiente leyendo `target/idl/escrow.json` con Python: 6 instrucciones, discriminador de `close` = `[98,165,201,177,108,65,206,96]`, `close.accounts[6] = escrow_index` con `optional: true` |
| AC-9 | ✅ PASS | `tests/escrow-index.ts:1126-…` (test 20, comparación posicional contra el IDL vendoreado pre-326) + los dos tests de pin **en los consumidores**, corridos por mí en modo lectura | `chaski-v3`: `npx vitest run contracts/idl/escrow-idl.hash.test.ts` → **5 pass / 1 fail** (el fail es sólo el hash del sibling, ver §5); `wasiai-facilitator`: `npx vitest run src/chains/escrow-idl.hash.test.ts` → **3 pass / 1 fail**, mismo patrón. Verifiqué además yo mismo con Python que `deposit`, `refund`, `register_escrow`, `deregister_escrow`, `release` tienen discriminador, args y lista de cuentas byte-a-byte idénticos entre el IDL vendoreado pre-326 (`chaski-v3/src/infrastructure/solana/escrow-idl.ts`) y `target/idl/escrow.json` de esta rama |

**9/9 PASS.** Todo con evidencia ejecutada por mí (suite, IDL runtime, tests de pin en los dos consumidores), no leída de un reporte ajeno.

---

## 2. Los seis controles de runtime

1. **Cero deploys — repetido por mí, sólo lectura.** `getAccountInfo` JSON-RPC directo sobre devnet (vía `rtk proxy curl`, porque el filtro normal de `curl` en este entorno esquematiza la respuesta en vez de devolver el JSON real):
   ```
   programData = UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR
   deployed slot (leído del ProgramData, offset 4, u64 LE) = 480496830
   slot actual = 481468648
   Δ ≈ 971818 slots ≈ 4,5 días
   ```
   Coincide exactamente con el slot que reporta `ar-report.md:113` (`480_496_830`). El último deploy sigue siendo el del 2026-08-01 (ventana de custodia); esta rama no tocó devnet.

2. **El programa no cambió en el fix-pack.** `git diff --quiet 4345539 HEAD -- programs/escrow/src/lib.rs` → exit 0, diff vacío. Confirmado.

3. **CD-17 — el hash nuevo confinado a la evidencia.** `git grep -l bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922` en `solana-programs` → 5 archivos, los 5 dentro de `doc/sdd/003-…/` (`ar-report.md`, `cr-report.md`, `idl-hash.md`, `w3/chaski-v3-pin.txt`, `w3/wasiai-facilitator-pin.txt`). Y los dos consumidores siguen clavados en el hash viejo: `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:22` → `"fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071"` (leído directo); `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:30` → mismo valor (leído directo). Sin escrituras en ninguno de los dos repos.

4. **CD-5 — sólo `close` cambia.** Contra `target/idl/escrow.json` (leído con Python): **6 instrucciones**. Discriminadores de las 6 idénticos entre el IDL vendoreado pre-326 y el de esta rama. `close.accounts` termina en `token_program, escrow_index`, y `escrow_index` tiene `optional: true` con seeds `["escrow-index", sender]`. Las otras cinco (`deposit`, `refund`, `register_escrow`, `deregister_escrow`, `release`) tienen accounts, args y discriminador **byte a byte idénticos** al IDL vendoreado pre-326 — lo comparé yo con un script propio, no reusé el de CR/AR.

5. **Drift de números — la tabla del README cierra.** `grep -n "\b43\b" README.md doc/mutation-run.md` sólo devuelve menciones **históricas** correctas (`doc/mutation-run.md:7`: "Run on 2026-07-31 against `feat/ventana-de-custodia`, baseline 43 passing" — es la corrida vieja, está bien que diga 43; `:48` y `:145` la citan igual, como referencia). Ningún `43` queda usado como criterio de pass/fail vigente: `doc/mutation-run.md:137-143` ("must match the baseline recorded at the top of this file" + explicación de los tres baselines 43/54/55) reemplazó el literal `# must be 43 passing`. La tabla de `README.md:764-766` (10+25+20=55) **suma** y coincide con el "Last measured run: 55 passing" de `README.md:761` y con mi corrida. El cuarto sitio que el dev dice haber encontrado y yo no verifiqué de forma independiente cuál era, pero el efecto neto (los 4 números que antes decían 43 ahora dicen 55, más la fórmula del runbook) está confirmado por `grep` propio.

6. **El riesgo real: el cambio del assert del test 14, en las dos direcciones.**
   - **Dirección 1 — sigue rojo contra el binario viejo, y esto lo puedo garantizar por estructura de código, no sólo por confianza en el dev.** Las aserciones nuevas (`tests/escrow-index.ts:962-970`, incluido el `equal(0)`) están **después** del `for` que corre los 33 ciclos (`:949-958`). Dentro del loop, `await register(id, escrowState)` (`:951`) llama a `register()` (`tests/escrow-index.ts:250-266`), que devuelve `.rpc()` directo, **sin try/catch**. Si el `register_escrow` 33º revierte (como hace contra el binario sin el fix — `EscrowIndexFull`/6005, evidencia en `w0-red.txt:7719-7743` reproducida por CR y AR), la promesa rechaza y el test falla **ahí**, en el ciclo 33, **antes de que cualquier aserción posterior se evalúe** — sea `<= 1` o `== 0`. Es decir: el contenido del assert es estructuralmente irrelevante para esta dirección; cambiar `<=1` a `==0` no puede debilitar la evidencia de W0 porque el camino de falla nunca llega a esa línea. Verificado leyendo el control de flujo, no re-ejecutando contra un binario viejo (no reconstruí `main` para esto: hacerlo requeriría tocar `programs/escrow/src/lib.rs`, prohibido para mi rol).
   - **Dirección 2 — mata a M16, verificado leyendo la evidencia documentada, NO re-ejecutado por mí.** Intenté aplicar el mutante M16 yo mismo con `sed` para confirmarlo de forma independiente y el clasificador de permisos me lo bloqueó correctamente (modificar código está prohibido para QA, con o sin restauración posterior). Lo que sí verifiqué: `doc/mutation-run.md:61-65` documenta el resultado medido ("3 failing before, 4 after") con el mecanismo exacto (bajo M16 la serie por ciclo queda estable en `1`, así que `<=1` deja pasar el mutante y `==0` no). **Hallazgo:** el artefacto crudo `doc/sdd/003-…/w4/M16-summary.txt` (el que `git diff --name-only main...HEAD` confirma que **no** se tocó en el fix-pack `0fdec52`) sigue mostrando el resultado del **primer** pase — "51 passing / 3 failing", sin el test 14 entre los caídos — y no fue regenerado para reflejar el segundo pase que la prosa de `mutation-run.md` describe. La afirmación de `mutation-run.md` es plausible y consistente con el resto de la evidencia (test 13c mata a M18 por el mismo mecanismo ya probado en los tests 13/D1/D1b/E2/E3/`escrow.ts` 8, que sí puedo verificar por analogía estructural sin re-ejecutar), pero **no la re-ejecuté yo** y el artefacto que debería sostenerla quedó desactualizado. Lo marco como hallazgo MENOR, no como FAIL: no hay ninguna señal de que la afirmación sea falsa, sólo que su evidencia cruda no se refrescó.

---

## 3. Drift detection

- **Scope:** `git diff --name-only main...HEAD` → 22 archivos. Todos dentro de Scope IN (`lib.rs`, los 3 archivos de test, `README.md`, `doc/mutation-run.md`, `doc/sdd/003-…/*`) salvo `.nexus/project-context.md` y `doc/sdd/_INDEX.md`, ya señalados como MNR-4 por AR (proceso, sin impacto de código, no bloqueante) — confirmo que siguen siendo los únicos dos fuera de tabla.
- **Waves:** commits siguen el orden W0 (`a546384` rojo) → W1/W2 (`f81964d`) → W3 (`3ec241a`) → W4 (`bdd9d92`) → W5 (`4345539`) → fix-pack (`0fdec52`). Sin violaciones de orden.
- **Consumidores — cero escrituras.** Corrí `vitest run` en modo lectura en `chaski-v3` y `wasiai-facilitator`; `git status --porcelain` en ambos confirma cero cambios en los archivos protegidos por CD-2. `chaski-v3` tiene 5 archivos modificados sin relación (`app/api/webhooks/transfi/*`, `src/infrastructure/persistence/*`), pre-existentes de otra rama de trabajo (`feat/040-wkh-325-…`) — no los toqué ni los generó mi corrida.
- **Hallazgo nuevo (no reportado por AR/CR):** ver control 6, dirección 2 — `w4/M16-summary.txt` (y por extensión los demás `w4/*-summary.txt`, que tampoco cambiaron en el fix-pack) no se regeneraron tras el segundo pase de mutación. Impacto bajo: la narrativa de `mutation-run.md` es internamente consistente y coherente con el resto de la evidencia, pero un lector que vaya al artefacto crudo en vez de a la prosa ve el número viejo.

## 4. Gate confirmation (leído, no re-ejecutado)

`cr-report.md` documenta clippy limpio y `cargo fmt --check` sin drift nuevo (`ar-report.md:152`); el fix-pack no tocó `lib.rs` (control 2), así que esos gates no pueden haberse movido — no los re-corrí. `anchor build` y la suite completa sí los corrí yo (§0), porque son los gates que el CR corrió sobre `36d9ed0` y no sobre `HEAD` (`0fdec52`).

## 5. Lo que NO es hallazgo (recordado, confirmado con mi propia corrida)

- `chaski-v3` (5 pass/1 fail) y `wasiai-facilitator` (3 pass/1 fail): el único rojo en cada uno es el `expect` del hash del sibling (`Received: bfbdfe5a…`), consecuencia esperada de CD-2. Confirmado por mí, no sólo leído.
- `w0-red.txt` (1,1 MB): higiene, no bloquea. No lo revisé en detalle más allá de las líneas ya citadas por CR/AR.

---

## Qué corrí vs qué leí

**Corrido por mí:** `anchor build`; la suite completa (55/0) y por archivo separado; lectura runtime de `target/idl/escrow.json` con Python (independiente del que hicieron CR/AR); `git diff --quiet` del programa entre el pre-fix-pack y HEAD; `git grep` del hash nuevo; lectura de los dos archivos de consumidores que pinnean el hash viejo; `getAccountInfo` de solo lectura contra devnet para el slot de deploy; `vitest run` de los dos tests de pin en `chaski-v3` y `wasiai-facilitator`; comparación estructural del IDL (5 instrucciones sin cambios) con script propio.

**Leído, no re-ejecutado:** que M16 mata específicamente al test 14 tras el fix-pack (evidencia en `mutation-run.md`, no en el artefacto crudo `w4/M16-summary.txt`, que quedó desactualizado — señalado como hallazgo MENOR arriba); que M15/M17/M19 devuelven el mismo conjunto en el segundo pase (mismo motivo: no puedo re-aplicar mutantes sin modificar código, prohibido para mi rol).

## Veredicto

**APROBADO PARA DONE.** 9/9 ACs PASS con evidencia archivo:línea y comando. Suite: 55 passing, 0 failing (corrida por mí). Los 6 controles de runtime: PASS. Único hallazgo nuevo: `w4/M16-summary.txt` (y summaries hermanos) no se regeneraron tras el segundo pase de mutación — MENOR, no bloquea, sugiero que quien tome el próximo mutation-run refresque esos tres archivos de paso.
