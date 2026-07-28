# Work Item — [WKH-TBD / HU-SOL-20?] Camino de recuperación cuando se pierde el `remittanceId` del escrow

> **Numeración provisional.** `_INDEX.md` de `solana-programs` solo tiene la fila 001
> (`WKH-215/HU-SOL-12`). Los repos hermanos (`chaski-v3`, `wasiai-facilitator`) ya usan
> `HU-SOL-4` hasta `HU-SOL-13`, y HU-SOL-12 reserva explícitamente `HU-SOL-14` (gasless) y
> `HU-SOL-19` (auditoría externa). El próximo número libre local es `HU-SOL-20`, pero el
> `WKH-NN` real vive en el índice global (`wasiai-a2a` / backlog), que este agente no tiene
> autorización para escribir. **El orquestador debe confirmar el WKH-NN real antes de F2.**

## Resumen

El PDA `escrow_state` se deriva `["escrow", sender, sha256(utf8(remittanceId)).slice(0,16)]`.
El `remittanceId` (string) es la única llave que permite reconstruir esos 16 bytes de seed.
Si se pierde, la cuenta sigue existiendo con fondos, pero **ninguna parte** (sender,
`authority`/facilitator, ni WasiAI) puede volver a derivar la dirección del PDA para
operarla — ni siquiera `refund`, que es trustless por diseño, es invocable sin ese dato.
Verificado en la práctica: 10 USDC de prueba atrapados en devnet en el escrow
`BmHDdjKL…` por exactamente este motivo. Decisión de producto ya tomada por el founder:
recuperación **on-chain** (opción B), sin reemplazar — sino complementar — la mitigación
off-chain (persistir el `remittanceId` de forma durable antes del deposit), que se estima
Wave 0 de este esfuerzo por ser barata y desplegable ya.

## Grounding (F0) — leído código real, no supuesto

### Programa Anchor (`solana-programs/programs/escrow/src/lib.rs`)

- **Program id vivo**: `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` — confirmado en 3
  fuentes independientes y consistentes entre sí: `declare_id!(...)` en `lib.rs:5`,
  `target/idl/escrow.json:2` (`address`), y el comentario explícito en
  `wasiai-facilitator/src/chains/escrow-idl.ts:9-13` que documenta que un id anterior
  (`BBQ9…79WA`) **nunca se deployó y su keypair se perdió** — id muerto, no reusable.
  Ninguno de estos tres valores es un literal que yo haya copiado sin cruzar: los tres
  coinciden.
- **Instrucciones**: `deposit` (init `escrow_state` + ATA `vault` + transferencia inicial,
  firma el `sender`), `release` (transfiere vault→`beneficiary_ata` fijo, firma
  `authority`, constraints `has_one` declarativos — `lib.rs:237-275`), `refund`
  (transfiere vault→`sender_ata`, firma el propio `sender`, exige
  `Clock::get()?.unix_timestamp >= deadline` — `lib.rs:279-310`), `close` (cierra el vault
  y la cuenta `escrow_state`, solo en estado terminal, `close = sender` — `lib.rs:314-339`).
- **Derivación del PDA — el hallazgo central**: las seeds son
  `[b"escrow", sender.key().as_ref(), remittance_id.as_ref()]` (`lib.rs:210`, `:250`,
  `:287`, `:322`), donde `remittance_id: [u8; 16]` es un **argumento de la instrucción**
  (`#[instruction(remittance_id: [u8; 16])]`), NO algo que el programa calcule. El
  programa **nunca hashea nada** — recibe los 16 bytes ya hechos y los usa literal como
  seed. El hasheo (`sha256(utf8(remittanceId)).slice(0,16)`) ocurre **enteramente off-chain**,
  y está duplicado en dos lugares que deben coincidir byte a byte (documentado como AH-9/TF1
  en ambos repos):
  - Cliente: `chaski-v3/src/infrastructure/solana-wallet.ts:61-63`
    (`remittanceIdToBytes16`, usa `@noble/hashes/sha256`, browser-safe).
  - Facilitator: `wasiai-facilitator/src/chains/solana-escrow.ts:95-97`
    (`remittanceIdToBytes16`, usa `node:crypto`).
  Un cambio de derivación en uno sin el otro rompe la paridad y el `refund`/`release` deja
  de encontrar la cuenta correcta — cualquier solución que toque la derivación es
  necesariamente cross-repo (3 repos).
- **Hallazgo técnico no obvio (clave para descartar rutas ingenuas)**: `EscrowState`
  (`lib.rs:158-167`) **no persiste** el `remittance_id` ni su hash en los datos de la
  cuenta — solo guarda `sender/beneficiary/authority/mint/amount/deadline/status/bump`.
  Además, `refund`/`release`/`close` exigen `remittance_id: [u8;16]` como **argumento**
  de la transacción para que Anchor re-derive y verifique las seeds (`seeds = [...,
  remittance_id.as_ref()], bump = escrow_state.bump`). Consecuencia: **incluso si
  encontrás la dirección del PDA por otro medio** (p. ej. enumerando cuentas), **no podés
  invocar ninguna instrucción sobre ella** en el programa actual, porque ninguna
  instrucción acepta la pubkey del `escrow_state` directamente — todas re-derivan a partir
  del argumento de 16 bytes que ya no tenés. Esto es lo que confirma, con evidencia de
  código y no de suposición, que **un programa nuevo no puede rescatar los fondos ya
  atrapados**: el dato que falta no está escondido en ningún lado, on-chain u off-chain —
  simplemente no se guardó nunca.
- **Estado del deploy**: devnet únicamente (`Anchor.toml` + Scope OUT de HU-SOL-12: "Deploy
  a mainnet — fuera de esta HU"). La upgrade authority del programa **sigue siendo una sola
  keypair** — la migración a multisig/timelock (CD-7 de HU-SOL-12) está diferida a
  HU-SOL-19 y **no se hizo todavía**. Esto es relevante como gate de esta HU (ver más abajo):
  hoy el programa SÍ es upgradeable in-place por quien tenga esa keypair, que es también la
  vía por la que se desplegaría cualquier fix.

### Cliente (`chaski-v3`) — dónde vive (y dónde se pierde) el `remittanceId`

- `chaski-v3/src/infrastructure/persistence.ts` (`LocalRepo`, `:1-80`): el repositorio de
  remesas del cliente persiste en **`window.localStorage`** (clave `chaski.remittances.v1`)
  en el browser, e in-memory (`Map`, se pierde al recargar) en SSR. Es la causa raíz
  concreta de "se pierde el identificador": borrar datos del navegador, cambiar de
  dispositivo, modo incógnito, o un fallo de SSR sin fallback a localStorage pierden el
  `remittanceId` sin que exista hoy ningún respaldo server-side consultado por el flujo de
  refund.
- `chaski-v3/src/infrastructure/solana-wallet.ts` (`refundEscrow`, `:160-228`): el refund
  es 100% client-driven — recibe `remittanceId` como **parámetro directo** de la función
  (`refundEscrow(remittanceId: string, sender?: string)`), re-deriva el PDA
  (`remittanceIdToBytes16` + `findProgramAddressSync`, `:176-180`), lee el estado on-chain
  como fuente autoritativa, y firma/broadcastea con `feePayer = sender` (CD-10: nunca el
  facilitator). **No hay ningún fallback que busque el `remittanceId` en un store
  server-side** si el caller no lo tiene — si `localStorage` lo perdió, este código no
  tiene de dónde más sacarlo.
- **Mitigación off-chain YA existe parcialmente, pero incompleta**: hay una tabla server-side
  `remittance_settlements` (`chaski-v3/src/infrastructure/persistence/supabase-settlement-ledger.ts:22-52`)
  con columnas `remittance_id` + `sender_address`, escrita server-side (bypassa RLS,
  ownership app-layer vía `sender_address`). PERO: (a) está gateada por el flag
  `SETTLEMENT_LEDGER_ENABLED` (opt-in, estado en devnet **[NEEDS CLARIFICATION]**); (b) no
  quedó verificado en este grounding EN QUÉ MOMENTO del flujo se escribe esa fila respecto
  al `deposit` (si es post-settlement, no cubre el caso de un `deposit` confirmado on-chain
  pero cuyo settlement downstream nunca corrió); y (c) el código de `refundEscrow` leído
  arriba **no la consulta** — aunque la fila existiera, hoy nada la conecta al flujo de
  recuperación del cliente. Es una pieza reusable para Wave 0, no una solución ya cerrada.

### Facilitator (`wasiai-facilitator`) — lado `authority`/lectura

- `src/chains/solana-escrow.ts` (`readEscrowState`, `:147-190`): lee y decodifica la cuenta
  `EscrowState` on-chain vía `BorshAccountsCoder` con el IDL pineado, y deriva el PDA con
  la misma fórmula que el cliente (`deriveEscrowStatePda`, `:103-113`) — **también** recibe
  `remittanceId` como parámetro de entrada, no lo descubre por sí mismo.
- El facilitator solo actúa como `authority` para `release` (nunca para `refund`, que es
  CD-10/exclusivo del `sender`). No tiene hoy ningún mecanismo de enumeración de escrows
  por `sender` — solo puede leer una cuenta si ya conoce (o le pasan) el `remittanceId`.

## Sizing

- SDD_MODE: full
- Estimación: **L** (probablemente XL si F2 decide un cambio de derivación — toca 3 repos,
  el programa Anchor, y requiere AR obligatorio por ser money-path)
- Branch sugerido: `feat/002-escrow-remittance-id-recovery`
- Modo: **QUALITY** — no hay duda razonable de lo contrario. Toca custodia de fondos
  (USDC), cambia potencialmente el layout/derivación del programa que ya está deployado en
  devnet con fondos reales de prueba atrapados, y cualquier cambio de derivación exige
  compatibilidad cross-repo (solana-programs + chaski-v3 + wasiai-facilitator) validada con
  AR antes de mergear, igual que HU-SOL-12.

## Espacio de soluciones on-chain (enumerado, NO elegido — decisión de F2)

1. **Índice/registro on-chain por remitente** (p. ej. PDA `["escrow-index", sender]` que
   lista o cuenta los `escrow_state` del sender). ¿Requiere reemplazar el programa? Es un
   upgrade in-place de `deposit` (agrega una cuenta a escribir), no un programa nuevo.
   ¿Rompe escrows existentes? No los rompe, pero **no los cubre**: solo los `deposit`
   posteriores al upgrade escriben al índice — los ya depositados (como `BmHDdjKL…`) siguen
   sin ser enumerables por este mecanismo. ¿Cambia quién puede mover fondos de otro? No —
   solo agrega enumerabilidad, no autoridad nueva. Costo: rent adicional por index account,
   y define un tamaño fijo (cap de escrows por sender) o `realloc` dinámico.

2. **Derivación distinta sin secreto recordable** — p. ej. contador/nonce por remitente en
   vez de `sha256(remittanceId)` (seeds `["escrow", sender, nonce_le_bytes]`, nonce
   incremental leído de una cuenta contador). Enumerable por fuerza bruta acotada (`0..N`)
   sin necesitar ningún dato off-chain. ¿Requiere reemplazar el programa? Upgrade in-place,
   pero cambia la **firma** de `deposit` (nuevo argumento/cuenta) — breaking change de IDL
   para todo caller nuevo. ¿Rompe escrows existentes? Los viejos (seed = hash del
   remittanceId) coexisten pero bajo un esquema de derivación distinto al nuevo — el
   cliente necesitaría lógica dual (derivar old-style vs new-style) si quiere seguir
   operando escrows viejos cuyo `remittanceId` SÍ se conserva. ¿Cambia quién puede mover
   fondos de otro? No. Efecto colateral: rompe el vínculo directo `remittanceId` de negocio
   (TransFi/chaski) ↔ seed — habría que mantener un mapeo remittanceId↔nonce off-chain de
   todos modos (no elimina la necesidad de persistencia off-chain, solo cambia qué se
   pierde si esa persistencia falla: con nonce, se pierde la ETIQUETA de negocio, pero NO
   el acceso a los fondos, porque el nonce siempre es enumerable).

3. **Instrucción de recuperación con autoridad** (p. ej. `authority`/árbitro fuerza un
   `refund`/`close` sobre una cuenta cuyo `remittance_id` se perdió). Superficie de ataque:
   si la autoridad puede actuar SOLA, es funcionalmente equivalente a que la `authority`
   controle los fondos de cualquier sender que "diga" haber perdido su id — viola
   exactamente el principio que HU-SOL-12 blindó (CD-3/AC-1: `release` siempre a un destino
   fijo, ninguna cuenta variable controlada por operador). Una variante más segura exige
   **co-firma del `sender`** (prueba de propiedad de la wallet original, p. ej. vía
   proof-of-possession, patrón ya usado en `chaski-v3/src/infrastructure/auth/pop-*` para
   Solana) — pero el `sender` co-firmando una transacción que referencia la cuenta YA
   requiere conocer su dirección, así que esta opción **no resuelve el problema de
   direccionamiento por sí sola**: necesita combinarse con la opción 1, 2 o 5 para primero
   ENCONTRAR el PDA. ¿Requiere reemplazar el programa? Sí, nueva instrucción. ¿Rompe
   escrows existentes? No los rompe, pero por el hallazgo de `EscrowState` (no guarda
   remittance_id/hash), **tampoco puede rescatar los ya atrapados** — solo aplicaría a
   escrows depositados después del upgrade, con el nuevo mecanismo de hallazgo de PDA ya
   activo.

4. **Guardar el `remittance_id` (o su hash de 16 bytes) en los datos de `EscrowState`**.
   Por sí sola esta opción NO resuelve nada: el problema no es "no puedo leer el id de la
   cuenta", es "no puedo encontrar la DIRECCIÓN de la cuenta para poder leerla" — un PDA
   se deriva ANTES de poder consultarlo on-chain. Es un complemento útil combinado con la
   opción 5 (enumeración): si el dato vive en la cuenta, una vez que enumerás por `sender`
   podés recuperar el `remittance_id` de negocio (la etiqueta), aunque para operar la
   cuenta igual haría falta que la opción elegida (1/2/3) ya no dependa de volver a pasar
   ese valor como argumento de instrucción.

5. **Enumeración off-chain vía `getProgramAccounts` filtrando por `sender`** (memcmp sobre
   el campo `sender` en los datos de `EscrowState`, que SÍ está en el layout actual —
   `lib.rs:159`). Ventaja sobre las demás: funciona **sin ningún cambio de programa**, y
   sobre escrows YA depositados (incluido `BmHDdjKL…`), porque lee el estado ACTUAL de la
   cuenta en el índice de cuentas del validador — no depende de logs de transacciones
   históricas, así que la poda de historia del RPC público (que sí afectaría reconstruir la
   firma/tx de `deposit`) **no es la limitación real** acá. Las limitaciones reales son
   otras dos, verificadas contra el código: (a) la mayoría de RPCs públicos deshabilitan o
   rate-limitan agresivamente `getProgramAccounts` por ser un full-scan costoso — hace
   falta un RPC dedicado/pago para que esto sea confiable en producción, no el RPC público
   que usa hoy el cliente (`resolveSolanaRpcUrlPublic`, `solana-wallet.ts:112`); y (b), la
   limitación DURA confirmada en el hallazgo de arriba: **encontrar la dirección no alcanza
   para operarla** — `refund`/`release`/`close` en el programa actual exigen el argumento
   `remittance_id: [u8;16]` que la enumeración NO te devuelve (ese valor no está en los
   datos de la cuenta). Por eso esta opción, para ser útil, necesita combinarse con un
   cambio de programa (opción 3 con una instrucción que NO re-derive seeds desde ese
   argumento, sino que acepte la pubkey del `escrow_state` directamente) — es decir, la
   enumeración resuelve "encontrar" pero no "operar" sin tocar el programa.

## Acceptance Criteria (EARS)

- **AC-1 (mitigación off-chain, Wave 0)**: WHEN un `deposit` es autorizado por el cliente,
  the system SHALL persistir el `remittanceId` de forma durable en un store server-side
  (no solo `localStorage` del browser), indexado por la dirección del `sender`, ANTES de
  que el cliente firme/broadcastee la transacción de `deposit`.

- **AC-2 (mitigación off-chain, Wave 0 — refund debe usar el store)**: WHEN el flujo de
  `refund` no recibe un `remittanceId` explícito del caller (p. ej. tras pérdida de
  `localStorage`), the system SHALL intentar resolverlo desde el store server-side de AC-1
  usando la dirección conectada del `sender` como clave, antes de fallar.

- **AC-3 (recuperación on-chain — enumerabilidad, Wave 1+)**: WHEN un `sender` conectado no
  posee el `remittanceId` de un escrow propio (ni en cliente ni en el store de AC-1), the
  system SHALL proveer un mecanismo que permita descubrir la dirección de TODOS los
  `escrow_state` de ese `sender` sin requerir el `remittanceId` original.

- **AC-4 (recuperación on-chain — operabilidad, Wave 1+)**: WHEN un `escrow_state` es
  descubierto mediante el mecanismo de AC-3 sobre un escrow depositado DESPUÉS del upgrade
  de esta HU, the system SHALL permitir que su `sender` invoque `refund` (o equivalente)
  sobre esa cuenta sin necesitar reconstruir el `remittance_id` original de 16 bytes como
  argumento de instrucción.

- **AC-5 (anti-custodia unilateral)**: IF cualquier mecanismo de recuperación permite a la
  `authority`/árbitro mover o redirigir fondos de un escrow, THEN the system SHALL exigir
  también la firma (o prueba de posesión criptográfica equivalente) del `sender` original
  — PROHIBIDO que la `authority` sola pueda liberar o redirigir fondos sin consentimiento
  del `sender` (mismo principio que CD-3/AC-1 de HU-SOL-12).

- **AC-6 (compatibilidad con escrows existentes)**: WHILE existan `escrow_state` deployados
  bajo el esquema de derivación ACTUAL (seeds = hash del `remittanceId`) cuyo
  `remittanceId` SÍ se conserve, the system SHALL seguir permitiendo `release`/`refund`/
  `close` sobre ellos exactamente como hoy, sin exigir migración ni romper su operación.

- **AC-7 (límite explícito — no rescate retroactivo)**: IF un escrow fue depositado ANTES
  del upgrade de esta HU Y su `remittanceId` está irrecuperablemente perdido (ni en
  cliente, ni en el store de AC-1, ni en ningún registro de negocio), THEN the system
  SHALL NO prometer ni implementar un camino que rescate esos fondos — se documenta como
  pérdida permanente, consistente con el hallazgo de F0 (el dato no está guardado en
  ningún lado on-chain).

## Scope IN

- Diseño (F2) y comparación explícita de las 5 opciones enumeradas arriba, con
  recomendación fundamentada del Architect.
- Wave 0 — mitigación off-chain: persistencia durable server-side del `remittanceId`
  indexada por `sender`, consultable por el flujo de `refund` de `chaski-v3` (toca
  `chaski-v3` y potencialmente `wasiai-facilitator`; el código en sí NO se escribe en este
  work-item de `solana-programs`, pero el diseño cross-repo se coordina en F2).
- Wave 1+ — mecanismo(s) on-chain elegido(s) en F2: cambios al programa Anchor
  (`programs/escrow/src/lib.rs`), deploy como upgrade in-place del program id
  `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` en **devnet** (mainnet sigue gateado por
  auditoría externa, HU-SOL-19).
- Actualización coordinada de `chaski-v3` (cliente) y `wasiai-facilitator` (lectura/
  `authority`) para mantener paridad de derivación/IDL con el programa actualizado.
- Tests que cubran: (a) escrows pre-upgrade siguen operables (AC-6), (b) el nuevo mecanismo
  de recuperación funciona end-to-end sobre un escrow post-upgrade con id "perdido"
  simulado, (c) el guard anti-custodia-unilateral (AC-5).

## Scope OUT

- **Rescate de los fondos ya atrapados bajo el esquema de derivación actual** (p. ej. el
  escrow `BmHDdjKL…` en devnet con 10 USDC de prueba). Confirmado imposible por el
  grounding de F0: `EscrowState` no persiste el `remittance_id` ni su hash, y las
  instrucciones actuales exigen ese valor como argumento — ni un programa nuevo, ni
  enumeración, ni ningún mecanismo puede reconstruir un dato que nunca se guardó. Nadie
  debe esperar que esta HU recupere esa plata específica.
- Deploy a mainnet (gate = auditoría externa — política ya fijada en HU-SOL-12/CD-5, no se
  re-litiga acá).
- Migración de la upgrade authority a multisig/timelock (HU-SOL-19, ya diferido).
- Dispute/arbiter genérico (`lockForDispute`/`resolveDispute` del análogo EVM) — sigue
  fuera de scope, igual que en HU-SOL-12.
- Integración de gasless/relayer (HU-SOL-14).
- Cualquier UI/UX de "recuperar mi remesa" en `chaski-v3` más allá de lo estrictamente
  necesario para ejercer el mecanismo elegido — el diseño visual/flujo de producto es F2,
  no se prescribe acá.

## Constraint Directives (CD-N) — aplican sin importar qué opción elija F2

- **CD-1**: PROHIBIDO que cualquier instrucción de recuperación permita a la `authority`
  mover o redirigir fondos SIN la firma (o prueba de posesión equivalente) del `sender`
  original (AC-5). Cualquier diseño que viole esto se marca BLOQUEANTE en AR.
- **CD-2**: PROHIBIDO prometer o intentar implementar un camino de rescate para escrows ya
  depositados bajo el esquema de derivación actual (AC-7) — el Architect debe documentar
  explícitamente en el SDD por qué es imposible, citando el hallazgo de F0 (dato no
  persistido en ningún lado).
- **CD-3**: OBLIGATORIO que cualquier cambio de derivación o de firma de `deposit` se
  documente como cross-repo desde el día 1 del SDD — mínimo `solana-programs` +
  `chaski-v3` + `wasiai-facilitator` en la misma ventana de deploy, con un plan explícito
  de orden de despliegue (programa primero, o flag de compatibilidad dual mientras los
  clientes se actualizan).
- **CD-4**: OBLIGATORIO que los escrows depositados ANTES del upgrade sigan siendo
  operables exactamente como hoy (AC-6) — PROHIBIDO cualquier diseño que exija migrar o
  re-depositar fondos ya en custodia para poder seguir usándolos.
- **CD-5**: PROHIBIDO deployar a mainnet en esta HU — devnet only, mismo gate que
  HU-SOL-12/CD-5.
- **CD-6**: OBLIGATORIO que AR (Adversarial Review) sea obligatorio antes de mergear
  cualquier cambio al programa Anchor de esta HU — money-path, mismo criterio que
  HU-SOL-12.

## Missing Inputs

- **[NEEDS CLARIFICATION — bloqueante para F2, decisión de founder]**: de las opciones 1/2
  (índice on-chain vs. contador/nonce sin secreto), ¿hay preferencia de UX? Un índice
  enumerable habilita una pantalla "ver todos mis escrows"; un esquema de nonce cambia la
  firma de `deposit` y exige lógica dual permanente en el cliente para escrows viejos. La
  elección técnica final es del Architect en F2, pero el founder puede tener una
  preferencia de producto que la condicione.
- **[NEEDS CLARIFICATION]**: la mitigación off-chain de Wave 0 (persistir `remittanceId`
  server-side antes de firmar el `deposit`) — ¿debe vivir en `chaski-v3` (ligada a la
  sesión/wallet del usuario de Chaski específicamente) o en `wasiai-facilitator` (ligada al
  `authority`/operador, reusable por cualquier cliente futuro que integre este escrow, no
  solo Chaski)? Afecta qué repo hace el trabajo de Wave 0 y con qué modelo de
  autenticación/ownership.
- **[NEEDS CLARIFICATION]**: estado real del flag `SETTLEMENT_LEDGER_ENABLED` en devnet
  hoy (¿está ON? ¿en qué punto exacto del flujo se escribe la fila `remittance_settlements`
  respecto al `deposit`?) — necesario para que el Architect sepa si Wave 0 parte de cero o
  puede extender infraestructura ya existente. Ninguna fuente leída en este grounding
  confirma el valor del flag en el entorno real (no hay `.env` de devnet en el alcance de
  lectura de este agente).
- **[bloqueante — orquestador]**: número `WKH-NN` real de esta HU (ver nota al inicio del
  documento) — el orquestador debe asignarlo desde el índice global antes de F2.

## Análisis de paralelismo

- **No bloquea** HU-SOL-13 (integración chaski↔escrow, ya DONE/WKH-216) ni HU-SOL-14
  (gasless) — ninguna de las dos toca la derivación del PDA.
- **Bloquea potencialmente** HU-SOL-19 (auditoría externa + upgrade authority a
  multisig/timelock): si esta HU cambia la firma de `deposit` o agrega instrucciones, es
  más eficiente que la auditoría externa cubra el programa YA con el mecanismo de
  recuperación incluido, en vez de auditar dos veces. Recomendación para el orquestador:
  secuenciar esta HU ANTES de HU-SOL-19, no en paralelo.
- **Puede correr en paralelo** con cualquier trabajo de UI/producto de `chaski-v3` que no
  toque el flujo de `deposit`/`refund` (p. ej. historial, KYC, otros corredores).
- **Cross-repo por naturaleza**: cualquier Wave 1+ que cambie la derivación requiere
  coordinación de merge/deploy entre `solana-programs`, `chaski-v3` y `wasiai-facilitator`
  — no es paralelizable de forma ingenua entre esos tres repos, el orden de deploy importa
  (CD-3).
