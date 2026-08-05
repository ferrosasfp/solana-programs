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
| **003** | **WKH-326** | **El tope de 32 del índice de escrows deja de crecer para siempre** | **F1 — in progress** | [`003-wkh-326-cap-del-indice-liberado-en-close/work-item.md`](003-wkh-326-cap-del-indice-liberado-en-close/work-item.md) |

## WKH-326 — resumen de una línea

`close` pasa a sacar la entrada del `EscrowIndex` además de devolver el rent, con lo que
`MAX_ENTRIES = 32` deja de contar "ids registrados en toda la vida del sender" y vuelve a contar
"escrows sin cerrar". Implementado y probado, **sin desplegar** (CD-1).

- Camino elegido: **(a)**, `close` saca la entrada. Descartados (b) `release`/`refund`,
  (c) sólo el cliente, (d) subir `MAX_ENTRIES`. Argumentos en el work-item.
- Branch sugerido: `feat/326-cap-del-indice-liberado-en-close`
- Bloquea a: **WKH-327** (camino cliente para recuperar el alquiler). Con (a), WKH-327 se reduce a
  "llamar a `close`".
- Debe estar resuelta **antes** de que R4 (el cliente de `register_escrow`) llegue a producción.
- Mueve el sha256 canónico del IDL. El re-pin en `chaski-v3` y `wasiai-facilitator` queda **fuera**
  de esta HU y se hace una sola vez, en la HU de deploy.

## Contexto del proyecto

`.nexus/project-context.md` — stack, comandos, trampas conocidas del repo y consumidores del IDL.
