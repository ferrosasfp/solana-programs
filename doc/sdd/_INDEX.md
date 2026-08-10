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
| **004** | **WKH-343** | **El depósito acepta un destinatario que no puede recibir el token, y el repo habla de la cadena en presente** | **in progress (F1 hecho, esperando `HU_APPROVED`)** | [`work-item.md`](004-wkh-343-deposito-destinatario-sin-cuenta-token/work-item.md) |

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
dos hashes del binario (`59ec1098…` con el relleno de la cuenta, `455e4e36…` sin él) están en
`.github/workflows/verified-build.yml` y en el README. Detalle y verificación en
[`idl-hash.md`](003-wkh-326-cap-del-indice-liberado-en-close/idl-hash.md), sección de cierre.

## WKH-343 — resumen de una línea

`deposit` no verifica que el `beneficiary` tenga cuenta de token para el mint del escrow, y `release`
la exige sin poder crearla (`README.md:655-657` ya lo documentaba como límite conocido); F1 mide que
esto puede ser síntoma de un mint equivocado (`lib.rs:518-529`: el co-firmante off-chain nunca valida
el mint) y NO de un destinatario inválido en sí — sin confirmar en vivo, ver Missing Inputs del
work-item. En paralelo, `scripts/list-live-escrows.py:170,198` recomienda liberar escrows bloqueados
apoyado en que el upgrade de WKH-326 "todavía no pasó"; ya pasó, y hoy ese camino revierte. Work-item
en F1, tres mediciones RPC pendientes (sin herramienta de ejecución disponible en esta sesión),
esperando `HU_APPROVED`.

## Contexto del proyecto

`.nexus/project-context.md` — stack, comandos, trampas conocidas del repo y consumidores del IDL.
