# Índice de HUs — solana-programs

Metodología: NexusAgil, modo **QUALITY** (programa on-chain que custodia dinero).
Flujo: F0/F1 → `HU_APPROVED` → F2 → `SPEC_APPROVED` → F2.5 → F3 → AR → CR → F4 → DONE.

## Sobre la numeración

Este `_INDEX.md` se creó el 2026-08-05, junto con la primera carpeta `doc/sdd/` **presente en el
árbol de trabajo**. Los números 001 y 002 **no** están libres: hay artefactos anteriores que se
referencian desde otro repo pero cuyas carpetas no están en este árbol. La evidencia concreta:

> `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:19-21` cita
> `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md §4.10 DT-9`.

Por eso esta HU arranca en **003** y no en 001: reusar 001/002 haría que dos documentos distintos
compartan identificador y que esa referencia cruzada apunte a otra cosa.
**No verificado en esta fase:** no revisé el historial de git para confirmar si esas carpetas
existieron y se borraron, o si nunca se commitearon. La referencia desde `chaski-v3` alcanza para no
reusar los números.

## HUs

| NNN | HU | Título | Estado | Artefactos |
|-----|-----|--------|--------|------------|
| 001 | HU-SOL-?? | (histórica, carpeta ausente del árbol) | — | — |
| 002 | HU-SOL-20 | escrow remittance-id recovery (`EscrowIndex`, `register_escrow`, `deregister_escrow`) | HECHO (desplegado 2026-08-01) | carpeta ausente del árbol; referenciada desde `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:19-21` |
| 003 | WKH-326 | El tope de 32 del índice de escrows deja de crecer para siempre | DONE y DESPLEGADO en devnet el 2026-08-05, slot `481495859` | [`work-item.md`](003-wkh-326-cap-del-indice-liberado-en-close/work-item.md) · [`sdd.md`](003-wkh-326-cap-del-indice-liberado-en-close/sdd.md) · [`story-HU-326.md`](003-wkh-326-cap-del-indice-liberado-en-close/story-HU-326.md) · [`ar-report.md`](003-wkh-326-cap-del-indice-liberado-en-close/ar-report.md) · [`cr-report.md`](003-wkh-326-cap-del-indice-liberado-en-close/cr-report.md) · [`qa-report.md`](003-wkh-326-cap-del-indice-liberado-en-close/qa-report.md) · [`auto-blindaje.md`](003-wkh-326-cap-del-indice-liberado-en-close/auto-blindaje.md) · [`idl-hash.md`](003-wkh-326-cap-del-indice-liberado-en-close/idl-hash.md) · [`report.md`](003-wkh-326-cap-del-indice-liberado-en-close/report.md) |
| **004** | **WKH-343** | **El depósito acepta un destinatario que no puede recibir el token, y el repo habla de la cadena en presente** | **IMPLEMENTADA Y DESPLEGADA** en devnet el 2026-08-10, slot `482775110` | [`work-item.md`](004-wkh-343-deposito-destinatario-sin-cuenta-token/work-item.md) · [`sdd.md`](004-wkh-343-deposito-destinatario-sin-cuenta-token/sdd.md) · [`story-HU-343.md`](004-wkh-343-deposito-destinatario-sin-cuenta-token/story-HU-343.md) · [`runbook-deploy.md`](004-wkh-343-deposito-destinatario-sin-cuenta-token/runbook-deploy.md) · [`idl-hash.md`](004-wkh-343-deposito-destinatario-sin-cuenta-token/idl-hash.md) · [`auto-blindaje.md`](004-wkh-343-deposito-destinatario-sin-cuenta-token/auto-blindaje.md) · `fix-pack-*.txt` · `w0`/`w1`/`w3`/`w5` |

⚠️ **La fila 004 decía "in progress (F1 hecho, esperando `HU_APPROVED`)" y listaba un solo artefacto.**
Medido el 2026-08-15: el deploy corrió el 2026-08-10 (`scripts/onchain-hash.py` devuelve
`last deployed slot 482775110`), la carpeta tiene 13 archivos y `runbook-deploy.md` documenta el
gate como satisfecho. **Lo que NO hay en la carpeta**, y por eso no se afirma acá: `ar-report.md`,
`cr-report.md`, `qa-report.md` ni `report.md` de cierre, que la HU 003 sí tiene. `ls` de la carpeta es
la comprobación.

## WKH-326 — resumen de una línea

`close` pasa a sacar la entrada del `EscrowIndex` además de devolver el rent, con lo que
`MAX_ENTRIES = 32` deja de contar "ids registrados en toda la vida del sender" y vuelve a contar
"escrows sin cerrar". Implementado, revisado (AR, CR) y validado (QA: 9/9 ACs PASS, suite 55
passing/0 failing corrida por el propio QA) en la rama `feat/326-cap-del-indice-liberado-en-close`,
HEAD `c8b3f7d`. **Al cerrar la HU estaba sin desplegar** (CD-1): sin merge a `main`, sin
`anchor deploy`, sin tocar devnet.
Ver `003-wkh-326-cap-del-indice-liberado-en-close/report.md` para el cierre completo.

- Camino elegido: **(a)**, `close` saca la entrada. Descartados (b) `release`/`refund`,
  (c) sólo el cliente, (d) subir `MAX_ENTRIES`. Argumentos en el work-item.
- Branch: `feat/326-cap-del-indice-liberado-en-close` (local, no pusheada).
- Bloquea a: **WKH-327** (camino cliente para recuperar el alquiler). Con (a), WKH-327 se reduce a
  "llamar a `close`".
- Debe estar resuelta **antes** de que R4 (el cliente de `register_escrow`) llegue a producción.
- Mueve el sha256 canónico del IDL, a `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`
  (medido, `idl-hash.md`). Mientras duró la HU ese número vivió sólo en su carpeta (CD-17) y por eso
  los dos consumidores tuvieron 1 test rojo cada uno, esperado y registrado en `w3/`.

**Después del cierre, el 2026-08-05.** La rama se mergeó a `main` (`6b0bd67`) y se desplegó: devnet
pasó del slot `480496830` al `481495859`, firma
`UjFgwnmUviG9kRVfCNB1kcKeGQAYxsJkZpKQHycM8o6KFFJhDETfzAQyjccQbXd8TgcasN7gyHazjfWhQudjK7F`. El IDL se
republicó en `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC` por el camino del buffer, y `bfbdfe5a…`
quedó re-clavado en `chaski-v3` (`bd85dfa`) y `wasiai-facilitator` (`f9bddce`), los dos verdes. Los
dos hashes del binario de **ese** deploy (`59ec1098…` con el relleno de la cuenta, `455e4e36…` sin él)
estuvieron en `.github/workflows/verified-build.yml` y en el README hasta el deploy siguiente. Medido
el 2026-08-15: hoy el workflow pinnea `940096242e…` y `2bd31779…`, que son los del binario del
2026-08-10, y `59ec1098…` no aparece en ninguno de los dos archivos (`grep -c` en cada uno). Detalle y verificación en
[`idl-hash.md`](003-wkh-326-cap-del-indice-liberado-en-close/idl-hash.md), sección de cierre.

## WKH-343 — resumen de una línea

`deposit` no verificaba que el `beneficiary` tuviera cuenta de token para el mint del escrow, y
`release` la exige sin poder crearla (el límite está documentado en la sección "Known limitations" del
README, bajo el título **`release` requires the beneficiary's token account to already exist**).
**Resuelto y desplegado**: `deposit` ahora recibe `beneficiary_ata` como novena cuenta y la exige.

⚠️ **Este resumen quedó viejo en tres frases y ninguna la caza un diff de este repo.** Corregido el
2026-08-15:

- *"F1 mide que esto puede ser síntoma de un mint equivocado (`lib.rs:518-529`: el co-firmante
  off-chain nunca valida el mint)"* — el rango es de otra versión del archivo, y la afirmación es
  falsa: el control **existe** desde el 2026-08-04 en el co-firmante off-chain, cosa que el propio
  `///` de `mint` en `Deposit` ya dice hoy (`lib.rs:550-558`). Lo que ese control no hace es cubrir
  los depósitos que no pasan por él.
- *"`scripts/list-live-escrows.py:170,198` recomienda liberar escrows bloqueados apoyado en que el
  upgrade de WKH-326 todavía no pasó"* — el script se reescribió y esas dos líneas son hoy parte de
  la derivación de PDAs. Su propio `--help` ya declara que el nombre del flag es histórico y que ese
  upgrade aterrizó el 2026-08-05.
- *"esperando `HU_APPROVED`"* / *"tres mediciones RPC pendientes"* — la HU se implementó y se
  desplegó; las mediciones se pueden correr desde acá, `getProgramAccounts` responde contra
  `api.devnet.solana.com` (verificado 3 de 3 el 2026-08-15).

## ⚠️ Las citas `archivo:línea` dentro de las carpetas de HU están fechadas a su HU

Medido el 2026-08-15 con un barrido sobre `doc/sdd/00*`: hay **211** citas por número de línea hacia
documentos vivos del repo — 131 a `README.md`, 42 a `doc/mutation-run.md`, 17 a `SECURITY.md`, 11 a
`idl-hash.md` y 10 a `.nexus/project-context.md`.

**La mayoría ya no aterriza en su párrafo, y no porque nadie se equivocara al escribirlas.**
`README.md` pasó de ~1019 líneas cuando se abrió la carpeta 003 a 1280 hoy: cada edición del README
corre todas las citas que apuntan más abajo. Dos ejemplos medidos: `story-HU-326.md:276` cita
`README.md:607-623` para "Known limitations: el índice ya no se llena para siempre", y hoy `:607` cae
en el párrafo del barrido del vault; `work-item.md:54` cita `README.md:370`, que hoy es prosa sobre la
ventana de custodia.

**No se corrigieron a propósito**: una carpeta de HU es el registro de lo que se decidió con la
información de ese momento, y reescribir sus citas para que apunten al árbol de hoy convierte un
registro en una ficción. Lo que sí se corrigió es todo lo que un lector toma por estado **actual**:
`README.md`, `SECURITY.md`, `.nexus/project-context.md`, `doc/mutation-run.md`, este índice y el
`idl-hash.md` de la 004. Dentro de las carpetas de HU, **leé por contenido y no por número**: buscá la
frase citada con `grep`, no la línea.

## Contexto del proyecto

`.nexus/project-context.md` — stack, comandos, trampas conocidas del repo y consumidores del IDL.
