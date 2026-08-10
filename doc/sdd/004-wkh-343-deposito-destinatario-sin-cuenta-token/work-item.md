# Work Item — WKH-343 — El depósito acepta un destinatario que no puede recibir el token, y el repo habla de la cadena en presente

## Resumen
`deposit` graba un `beneficiary: Pubkey` sin verificar que exista su cuenta de token para el mint
del escrow (`programs/escrow/src/lib.rs:135-183`); `release` sí la exige pero no la crea
(`lib.rs:614-619`, ya documentado como límite conocido en `README.md:655-657`). Cuando el
destinatario asignado por el proveedor de pago no tiene esa cuenta, el depósito queda
entregable-imposible y sin más salida que el `refund` del sender. En paralelo, cuatro afirmaciones
del repo hablan de la cadena en presente sin fecha/slot, y una (`scripts/list-live-escrows.py:170,198`)
recomienda una operación de dinero apoyada en un supuesto que ya venció.

## Sizing
- SDD_MODE: full (toca el money-path; decisión de diseño con tres opciones sin cerrar)
- Estimación: L
- Branch sugerido: feat/004-wkh-343-deposito-destinatario-sin-cuenta-token

## Mediciones — bloque 1 (gobiernan el diseño)

**Nota de alcance de esta sesión de F1: no tuve herramienta de ejecución (Bash/RPC) disponible, sólo
Read/Glob sobre el árbol de trabajo. Las tres preguntas que exigen consultar devnet EN VIVO no las
pude correr yo. Lo de abajo separa qué está MEDIDO (con fecha/slot, leído del repo) de qué está
DERIVADO (razonamiento sobre código/docs) de qué queda sin determinar.**

1. **¿Los 4 escrows comparten destinatario?** NO MEDIDO en esta sesión — requiere
   `python3 scripts/list-live-escrows.py --url devnet` (lectura RPC, sin firmar). MEDIDO y fechado
   en el repo (`README.md:722-731`, 2026-08-05): a esa fecha había sólo DOS `EscrowState`
   `Deposited` sobre el mint de Circle (`4VopXGzB...` 10 unidades, `4YpeqyZX...` 5 unidades), ambos
   depositados por el mismo sender `4AvAjtPg1aPwJQRvjnY1U9BHbC46rwVc5BY6FuhqUA7P`. Si hoy son
   cuatro, dos se depositaron después del 2026-08-05 y esa README quedó vieja (ver AC-4).

2. **¿De dónde sale la dirección del destinatario?** No encontré en este repo (`README.md`,
   `doc/publish-idl-onchain.md`, `programs/escrow/src/lib.rs`) ninguna mención a TransFi ni a cómo
   se asigna `beneficiary`. NO DETERMINABLE desde este repo.

3. **¿Hipótesis de mint equivocado?** DERIVADO, a favor: `lib.rs:518-529` documenta (fechado
   2026-08-04) que el co-firmante off-chain que debería rechazar un mint inesperado **nunca compara
   el mint contra `SOLANA_USDC_MINT`**; el programa acepta cualquier mint sin filtro on-chain
   (`mint: Account<'info, Mint>` sin `address =` en `Deposit`, `lib.rs:547`). `README.md:715-720`
   documenta dos mints de devnet fáciles de confundir: el propio (`8yRX3fZ2...`, sin freeze
   authority) y el de Circle (`4zMMC9srt...`, con freeze authority ajena) — y los depósitos reales
   de hoy están en el mint de Circle (`README.md:726`). Si el destinatario sólo abrió su ATA para el
   mint propio y el depósito real llegó en el de Circle, "destinatario sin cuenta de token" es
   consecuencia de un mint equivocado, no de un destinatario inválido en sí. NO VERIFICADO
   end-to-end (requeriría leer las 4 `EscrowState` en vivo), pero es la lectura que mejor explica el
   dato dado (`Dr37oH97...` tiene ATA para `8yRX3fZ2` y no para `4zMMC9srt`).

**Qué habilita esto:** si la hipótesis 3 se confirma, (c) — validar/fijar el mint correcto — es la
opción más barata, pero no reemplaza el caso general: aun con el mint correcto, nada impide que un
destinatario real (asignado por el proveedor) jamás tenga ATA para NINGÚN mint aceptado. El AC-1 no
elige (a)/(b)/(c); ver Missing Inputs.

## Acceptance Criteria (EARS)

- AC-1: IF el beneficiario grabado en un `deposit` no tiene, al momento en que correspondería
  `release`, una cuenta de token asociada para el mint del escrow, THEN el sistema SHALL garantizar
  que la entrega no dependa de una devolución manual del sender como único camino. La solución
  concreta (rechazar en el depósito, crear la cuenta, o validar el mint) se decide en F2 con las
  mediciones 1 y 3 de arriba resueltas, no en esta HU.
- AC-2: WHEN se corre la suite existente (`anchor test --skip-build --skip-deploy --skip-local-validator`),
  el sistema SHALL mantener los 55 tests vigentes en verde, sin ninguno saltado ni desactivado.
- AC-3: WHERE `scripts/list-live-escrows.py` describe qué instrucción puede vaciar un escrow
  bloqueante, el sistema SHALL reflejar que, tras el deploy de WKH-326 (slot `481495859`,
  2026-08-05), `release` sobre esos escrows revierte, y SHALL retirar la recomendación de liberarlos
  apoyada en el supuesto vencido (`list-live-escrows.py:170,198`).
- AC-4: WHEN una afirmación de este repo describe un saldo, una cuenta, un estado on-chain o qué
  binario está desplegado, el sistema SHALL acompañarla de la fecha y el slot en que se midió, o
  SHALL derivarla de un script en vez de escribirse a mano — aplicado como mínimo a los 4 casos
  medidos (`README.md:615-622`, `doc/publish-idl-onchain.md:47-51`, `README.md:27` y `:143`,
  `list-live-escrows.py:170,198`).
- AC-5: IF esta HU modifica `programs/escrow/src/lib.rs`, THEN el sistema SHALL actualizar la fila
  "Source vs deployed" de `README.md:25` para que deje de afirmar que coinciden byte a byte, sin
  implicar que se hizo un deploy (fuera de scope, ver CD-1).
- AC-6: WHILE la medición 1 del bloque de arriba (cuántos escrows comparten destinatario) siga sin
  cerrarse, el sistema SHALL dejar constancia en el SDD de que la opción elegida en F2 fue validada
  contra ese dato antes de implementarse, no antes.

## Scope IN
- `programs/escrow/src/lib.rs` — instrucción `deposit` (y `Deposit` context); posible ajuste a
  `release`/`Release` según la opción elegida en F2
- `README.md:615-622, 27, 143, 722-731` (fechas/estado)
- `doc/publish-idl-onchain.md:47-51` (estado real del manual on-chain, ya contradicho por sus
  propias líneas 140-146)
- `scripts/list-live-escrows.py:170,198` (retirar la recomendación de liberar apoyada en el supuesto
  vencido)
- Barrido de un quinto caso de prosa en presente sin fecha: revisado `README.md` líneas 1-450 y
  600-810 en esta sesión, no encontré uno adicional ahí. No revisé 450-600 ni el resto del repo
  (`SECURITY.md`, `doc/decisions/`, `doc/mutation-run.md`) — queda abierto para quien continúe.

## Scope OUT
- Desplegar o actualizar el programa on-chain (`anchor deploy` / `anchor upgrade`) — CD-1
- Ejecutar cualquier transacción que mueva fondos, incluida la devolución de los 45 USDC — CD-1
- Tocar `m5-keys/` — CD-2
- Cambios en `wasiai-facilitator` (el co-firmante off-chain), aunque `lib.rs:518-529` lo señale como
  causa raíz candidata de la hipótesis 3 — es otro repo
- Determinar de dónde sale la dirección del destinatario (TransFi) — depende de otro sistema

## Decisiones técnicas (DT-N)
- DT-1: El AC-1 fija el criterio ("ningún depósito puede quedar sin salida no-manual") y no la
  opción de diseño (a/b/c), porque elegir sin la medición 1 puede bloquear el producto entero — así
  viene indicado en el brief y el analyst no tiene el dato para decidir.
- DT-2: La corrección de prosa (AC-3, AC-4) va en la misma HU y no en una separada, porque uno de
  los cuatro casos (`list-live-escrows.py`) es operativo, no cosmético: recomienda una operación de
  dinero sobre un supuesto vencido.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO desplegar o actualizar el programa, y PROHIBIDO ejecutar cualquier transacción que
  mueva fondos (incluida la devolución de los 45 USDC) en el marco de esta HU.
- CD-2: PROHIBIDO abrir, listar o citar `m5-keys/`.
- CD-3: OBLIGATORIO que la opción de diseño elegida en F2 (a/b/c) esté respaldada por la medición 1
  (destinatarios compartidos o distintos), no asumida.
- CD-4: OBLIGATORIO que ningún cambio a `lib.rs` que mueva el sha256 canónico del IDL se despliegue
  ni se re-pinnee en esta HU (mismo patrón que WKH-326: cambiar sólo con `//`, nunca `///`/`//!`,
  cuando la corrección caiga sobre un doc comment que viaja al IDL).
- CD-5: PROHIBIDO escribir en el repo una afirmación sobre saldo/cuenta/estado on-chain sin fecha y
  slot en la misma línea (AC-4).

## Missing Inputs
- [BLOQUEANTE para F2] Medición 1: ¿los 4 escrows trabados comparten destinatario? Requiere
  `python3 scripts/list-live-escrows.py --url devnet` (lectura RPC, sin firmar) — no ejecutado en
  esta sesión por falta de herramienta de ejecución.
- [BLOQUEANTE para F2] Medición 3 confirmatoria: leer las 4 `EscrowState` en vivo (mint +
  beneficiary) para confirmar o descartar la hipótesis de mint equivocado antes de elegir (a)/(b)/(c).
- [NEEDS CLARIFICATION] Medición 2: origen de la dirección del destinatario (¿la asigna TransFi?
  ¿dónde se valida hoy, si se valida?) — no determinable desde este repo.
- [NEEDS CLARIFICATION] Qué hacer con los 45 USDC ya trabados hoy. Esta HU no los mueve (CD-1); el
  AC-1 es sobre depósitos futuros. Si el founder quiere una devolución manual de esos 4, es una
  acción separada y explícita, fuera de esta HU.

## Análisis de paralelismo
- No bloquea ni es bloqueada por WKH-326 (ya DONE y desplegada, 2026-08-05). Puede ir en paralelo
  con cualquier HU que no toque `programs/escrow/src/lib.rs` ni los archivos de Scope IN.
- Si la medición 1 confirma un único destinatario repetido, esta HU se reduce a un caso puntual
  (posible mala configuración de una orden del proveedor) más el fix de prosa; si confirma 4
  destinatarios distintos, el fix de diseño (a/b/c) se vuelve prerequisito de cualquier plan de
  producción para este programa.
- Bloquea: cualquier plan de ir a mainnet con este programa (el AC-1 sin resolver es un defecto de
  money-path, no cosmético).
