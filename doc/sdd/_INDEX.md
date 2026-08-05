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
| **003** | **WKH-326** | **El tope de 32 del índice de escrows deja de crecer para siempre** | **DONE — sin desplegar (CD-1), cerrado 2026-08-05** | [`work-item.md`](003-wkh-326-cap-del-indice-liberado-en-close/work-item.md) · [`sdd.md`](003-wkh-326-cap-del-indice-liberado-en-close/sdd.md) · [`story-HU-326.md`](003-wkh-326-cap-del-indice-liberado-en-close/story-HU-326.md) · [`ar-report.md`](003-wkh-326-cap-del-indice-liberado-en-close/ar-report.md) · [`cr-report.md`](003-wkh-326-cap-del-indice-liberado-en-close/cr-report.md) · [`qa-report.md`](003-wkh-326-cap-del-indice-liberado-en-close/qa-report.md) · [`auto-blindaje.md`](003-wkh-326-cap-del-indice-liberado-en-close/auto-blindaje.md) · [`idl-hash.md`](003-wkh-326-cap-del-indice-liberado-en-close/idl-hash.md) · [`report.md`](003-wkh-326-cap-del-indice-liberado-en-close/report.md) |

## WKH-326 — resumen de una línea

`close` pasa a sacar la entrada del `EscrowIndex` además de devolver el rent, con lo que
`MAX_ENTRIES = 32` deja de contar "ids registrados en toda la vida del sender" y vuelve a contar
"escrows sin cerrar". Implementado, revisado (AR, CR) y validado (QA: 9/9 ACs PASS, suite 55
passing/0 failing corrida por el propio QA) en la rama `feat/326-cap-del-indice-liberado-en-close`,
HEAD `c8b3f7d`. **Sin desplegar** (CD-1): sin merge a `main`, sin `anchor deploy`, sin tocar devnet.
Ver `003-wkh-326-cap-del-indice-liberado-en-close/report.md` para el cierre completo.

- Camino elegido: **(a)**, `close` saca la entrada. Descartados (b) `release`/`refund`,
  (c) sólo el cliente, (d) subir `MAX_ENTRIES`. Argumentos en el work-item.
- Branch: `feat/326-cap-del-indice-liberado-en-close` (local, no pusheada).
- Bloquea a: **WKH-327** (camino cliente para recuperar el alquiler). Con (a), WKH-327 se reduce a
  "llamar a `close`".
- Debe estar resuelta **antes** de que R4 (el cliente de `register_escrow`) llegue a producción.
- Mueve el sha256 canónico del IDL, a `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`
  (medido, `idl-hash.md`). El número vive sólo en la carpeta de esta HU (CD-17): **no** se re-pinneó
  en `chaski-v3` ni en `wasiai-facilitator`. Por eso ambos repos tienen hoy 1 test rojo cada uno (el
  del hash del sibling), esperado y registrado en `w3/`. El re-pin se hace una sola vez, en la HU de
  deploy.

## Contexto del proyecto

`.nexus/project-context.md` — stack, comandos, trampas conocidas del repo y consumidores del IDL.
