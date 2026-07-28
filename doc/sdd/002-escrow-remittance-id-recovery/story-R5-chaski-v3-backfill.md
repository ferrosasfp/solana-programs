# Story File — R5 · Backfill del índice para escrows pre-upgrade (OPCIONAL / diferible)

> **REPO: `chaski-v3`** (`/home/ferdev/.openclaw/workspace/chaski-v3`)
> SDD: `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` (§4.4 "sirve de backfill", §5 paso R5)
> HU: **HU-SOL-20** · Fecha: 2026-07-28 · Wave de release: **R5 (última)**
> Branch sugerida: `feat/hu-sol-20-r5-index-backfill`
> **Estado recomendado por el Architect: DIFERIR.** Leé §1.1 antes de asignarlo. Si el founder decide
> hacerlo, el story está completo y ejecutable tal cual.

---

## 0. Prerequisitos y orden

### Qué tiene que estar mergeado **Y DEPLOYADO** antes

| Prerequisito | Estado | Por qué |
|---|---|---|
| **R0** (este repo) | mergeado + flag `SETTLEMENT_LEDGER_ENABLED=true` en Preview | el backfill **lee** los `remittanceId` del store durable. Sin él no hay de dónde sacar los candidatos |
| **R1** (`solana-programs`) | **DEPLOYADO** en devnet | `register_escrow` tiene que existir on-chain |
| **R2b** (este repo) | mergeado | el IDL vendoreado tiene que tener `register_escrow` |
| **R4** (este repo) | mergeado, flag ON y verificado | el backfill reusa la derivación del índice y la lectura de `EscrowIndex` de R4 |
| R2a / R3 (facilitator) | mergeados/deployados | orden del release (aunque el backfill **no pasa por CR-1**, ver §1.2) |

### Daño concreto del orden inverso (copiado del SDD §5)

- **R5 antes de R1** ⇒ `InvalidInstructionData`: el programa viejo no conoce el discriminador ⇒ la tx
  del backfill **falla entera**. No hay pérdida de fondos, pero el usuario ve un error crudo en una
  pantalla de "recuperar mis fondos", que es el peor lugar posible para un error crudo.
- **R5 antes de R0** ⇒ no hay filas en `remittance_settlements` ⇒ el backfill **no tiene candidatos** y
  parece "no hay nada que recuperar" cuando en realidad la fuente está apagada. Falso negativo, la
  peor clase de bug en un flujo de recuperación.
- **R5 antes de R4** ⇒ duplicás la derivación del PDA del índice y la decodificación de `EscrowIndex` en
  dos lugares, que es exactamente el patrón que ya rompió la paridad de `remittanceIdToBytes16` entre
  repos (documentado como AH-9/TF1).
- **R5 sin filtrar por estado on-chain** ⇒ ver §4.1: revierte con `EscrowNotDeposited` y el usuario ve
  un fallo por cada escrow ya cerrado.

---

## 1. Goal, y la evaluación honesta de si vale la pena

Los escrows depositados **antes** del upgrade no aparecen en el índice on-chain: nadie llamó
`register_escrow` por ellos. Como `EscrowState` **no cambió** (por diseño, SDD §4.2), un
`register_escrow` sobre un escrow pre-upgrade **funciona igual** siempre que se conozca su id16. Y el
id16 se puede reconstruir: `id16 = sha256(utf8(remittanceId))[0..16]`, y el `remittanceId` está en
`remittance_settlements` (eso es R0). Este story convierte esas filas de BD en entradas durables
on-chain.

### 1.1 Por qué el Architect recomienda DIFERIRLO

El valor marginal es chico y hay que decirlo antes de gastar un ciclo de dev:

- **Un escrow pre-upgrade cuyo `remittanceId` está en el store ya es 100% operable hoy**: con R0, el
  cliente lo resuelve del store y ejerce `refund`. El backfill **no desbloquea nada nuevo**; solo
  agrega una **segunda** copia de la llave (on-chain) por si la primera (Postgres) se pierde.
- **No rescata el caso que motivó la HU.** El escrow `BmHDdjKL…` (10 USDC en devnet) **no tiene** su
  `remittanceId` en ningún lado. `EscrowState` nunca guardó el dato y las 4 instrucciones lo exigen
  como argumento para re-derivar seeds. **AC-7/CD-2: PROHIBIDO prometer o implementar un rescate para
  esos fondos.** Este story **no** los recupera y no debe insinuar que lo hace.
- **Exige que el usuario tenga SOL** (§1.2), y la premisa del diseño es que no lo tiene.
- El universo de escrows afectados es finito y decreciente: son los que se depositaron antes del
  upgrade y siguen abiertos. En devnet, con ciclos de vida de minutos u horas, tiende a cero solo.

⇒ **Recomendación: diferir R5 hasta que exista un caso concreto** (un sender real con un escrow
pre-upgrade abierto y con SOL). Si aparece, este story se ejecuta tal cual.

### 1.2 La restricción dura: el backfill **no puede ser gasless**

CR-1 (`wasiai-facilitator/src/methods/solana-sponsor/cr1.ts`) solo co-firma transacciones cuyo
`businessIx[0]` sea el **`deposit`** (Check 4, discriminador pineado). Una tx que contiene **solo**
`register_escrow` es rechazada. Y R3 no cambia eso: su allowlist es `deposit` + `register_escrow`
**atado a ese mismo deposit**.

Por lo tanto la tx del backfill lleva **`feePayer = sender`** y la firma y broadcastea el sender,
igual que el `refund` (patrón `src/infrastructure/solana-wallet.ts:218-227`). El sender paga el fee
**y** el rent del índice (≈0,00477 SOL, una sola vez).

**PROHIBIDO "arreglar" esto extendiendo CR-1 para aceptar un `register_escrow` suelto.** Sería una
operación pagada por el sponsor y **no atada a ningún depósito** ⇒ un atacante podría spamear txs
sponsoreadas para drenar el presupuesto de fees del facilitator. Está **fuera de scope** de esta HU y
requeriría su propio SDD y su propio AR.

---

## 2. Acceptance Criteria

- **AC-R5-1**: WHEN el sender tiene escrows pre-upgrade **abiertos** cuyo `remittanceId` está en el
  store durable, THEN el sistema SHALL permitirle registrarlos en su `EscrowIndex` on-chain.
- **AC-R5-2**: IF un candidato del store **no** está `Deposited` on-chain (cerrado, liberado,
  refundeado o inexistente), THEN el sistema SHALL **omitirlo sin intentar** la transacción.
- **AC-R5-3**: IF un candidato **ya está** en `EscrowIndex.entries`, THEN el sistema SHALL omitirlo
  (no gastar un fee en un no-op).
- **AC-R5-4** (**AC-7/CD-2**): el sistema SHALL NO prometer ni intentar recuperar escrows cuyo
  `remittanceId` no exista en ninguna fuente. **Sin excepciones y sin copy que lo insinúe.**
- **AC-R5-5** (**AC-5/CD-10**): la tx del backfill la firma **solo el sender**, con
  `feePayer = sender`. Ninguna `authority` participa.

---

## 3. Scope IN — archivos exactos

| # | Archivo | Acción | Qué hacer |
|---|---------|--------|-----------|
| 1 | `src/infrastructure/solana-wallet.ts` | Modificar | Agregar `backfillEscrowIndex(candidateRemittanceIds: string[], sender?)`. **Reusa** `remittanceIdToBytes16` (`:61-63`), la derivación de `escrow_state` (`:99-102`), la derivación del índice y la decodificación de `EscrowIndex` (de R4). |
| 2 | `src/application/ports.ts` | Modificar | Agregar `backfill(input: { sender: string })` al port `SolanaEscrowRecoveryGateway` (creado en R4). |
| 3 | `src/infrastructure/refund/solana-escrow-recovery-gateway.ts` | Modificar | Implementar la delegación de `backfill`: obtiene los candidatos vía el resolver de R0 y llama al adapter. |
| 4 | `src/presentation/flow.tsx` | Modificar | Un botón secundario dentro del `RecoverEscrowPanel` de R4: "Buscar escrows anteriores". Copy fijo, sin PII. |
| 5 | `src/infrastructure/solana-wallet.backfill.test.ts` | **Crear** | Tests T-R5-1..7 (§5). |

### Fuera de scope (PROHIBIDO)

- **Tocar `cr1.ts` o cualquier cosa del facilitator** (§1.2).
- Tocar el programa Anchor, el IDL vendoreado o su hash.
- Cualquier camino que prometa recuperar el escrow `BmHDdjKL…` (**AC-7/CD-2**).
- Un job/cron server-side que haga el backfill "por" el usuario: **no puede**, la tx la firma el
  sender con su wallet. Nada de custodiar llaves para esto.
- `chaski-v3/m5-keys/` ⇒ **no se abre**.

---

## 4. Especificación

```ts
async backfillEscrowIndex(
  candidateRemittanceIds: string[],
  sender?: string,
): Promise<{ registered: string[]; skipped: Array<{ id16Hex: string; reason: "not_deposited" | "already_indexed" | "not_found" }> }>
```

Pasos, en orden (el filtrado va **antes** de cualquier firma):

1. `senderB58 = sender ?? await this.getAddress()`; sin address ⇒ `wallet_not_connected`.
2. Acotar a los primeros **20** candidatos (el store ya los devuelve ordenados por `created_at` desc).
3. Derivar el id16 de cada uno con `remittanceIdToBytes16`. **Deduplicar por id16** (dos
   `remittanceId` distintos no colisionan en la práctica, pero el store puede tener filas repetidas).
4. Leer `EscrowIndex` del sender (1 `getAccountInfo`). Los id16 ya presentes ⇒ `skipped:
   already_indexed` (**AC-R5-3**).
5. Derivar `["escrow", sender, id16]` de los restantes y **un solo** `getMultipleAccounts`.
   Cuenta ausente ⇒ `skipped: not_found`. Presente pero `status !== "Deposited"` ⇒
   `skipped: not_deposited` (**AC-R5-2**).
6. Para los que sobreviven: construir **una** ix `register_escrow` por candidato
   (`.accounts({ sender, escrowState, escrowIndex })`, **sin** remaining accounts), y agruparlas en
   **una sola** transacción con `feePayer = senderPk` — hasta un máximo de **4 ix por tx** y un
   chequeo de que la tx serializada queda **< 1232 bytes** (límite de tx legacy). Más candidatos ⇒
   varias txs secuenciales.
7. Firmar con `solanaWalletBridge.signTransaction` y broadcastear con
   `connection.sendRawTransaction` (patrón `:223-227`).
8. Devolver `registered` (los `remittanceId` efectivamente registrados) y `skipped` con su razón.

### 4.1 Por qué el filtrado del paso 5 es obligatorio y no una optimización

`register_escrow` tiene `constraint = escrow_state.status == EscrowStatus::Deposited @
ErrorCode::EscrowNotDeposited`, y `Account<EscrowState>` sobre una cuenta cerrada da
`AccountNotInitialized` (**3012**). Sin el filtro previo, **cada** escrow ya liberado o cerrado del
historial del sender produce una tx que **revierte**: el usuario paga el fee, no consigue nada y ve un
error. En una pantalla de recuperación de fondos eso es inaceptable. El filtro convierte N txs
fallidas en 0 txs.

### 4.2 Nada de "reintentar hasta que pase"

Si una tx del backfill falla, se reporta en `skipped` con su enum y **no se reintenta en loop**. Un
retry ciego sobre una tx firmada gasta fee del usuario. El botón lo puede volver a apretar él.

---

## 5. Tests — con criterio de MUTACIÓN

| # | Test | AC | Debe dar |
|---|------|----|----------|
| T-R5-1 | 3 candidatos: 1 `Deposited`, 1 `Released`, 1 inexistente ⇒ **una sola** tx, con **una sola** ix, y `skipped` con `not_deposited` + `not_found` | **AC-R5-2** | — |
| T-R5-2 | Un candidato ya presente en `EscrowIndex.entries` ⇒ `already_indexed` y **cero** txs (`sendRawTransaction` no se llama) | **AC-R5-3** | — |
| T-R5-3 | `tx.feePayer === senderPk` y el facilitator **no aparece** en ninguna cuenta de ninguna ix | **AC-R5-5 / CD-10** | — |
| T-R5-4 | Cada ix tiene **exactamente 4** cuentas, en el orden `[sender, escrow_state, escrow_index, system_program]`, sin remaining | contrato del programa | — |
| T-R5-5 | 6 candidatos válidos ⇒ **2** txs (4 + 2), y cada una serializa a **< 1232 bytes** | límite legacy | — |
| T-R5-6 | Candidatos duplicados (mismo `remittanceId` dos veces) ⇒ **una sola** entrada intentada | idempotencia | — |
| T-R5-7 | Un `remittanceId` que no corresponde a ningún escrow del sender ⇒ `not_found`, **sin** tx | AC-R5-2 | — |

### 5.1 ⚠️ Un test cuyo doble ignora los argumentos es un test vacuo

Igual que en R4, y acá es más peligroso porque el doble decide si se firma o no una tx que **cuesta
plata**:

- **`getMultipleAccounts` tiene que indexar por pubkey.** Si tu doble devuelve un array fijo sin mirar
  las pubkeys que recibe, T-R5-1 no prueba que estés derivando bien los PDAs, y una mutación del seed
  no pondría rojo nada. Forma obligatoria: `Map<base58, account|null>` + aserción de que el doble
  **recibió** los PDAs esperados (`expect(mock.calls[0][0].map(p=>p.toBase58())).toEqual([...])`).
- **`getAccountInfo` del índice tiene que devolver bytes reales de `EscrowIndex`**, no un objeto
  inventado: si devolvés `{ entries: [...] }` en vez de un `Buffer` codificado, no estás probando la
  decodificación borsh y T-R5-2 puede pasar con el decode roto. Codificá los bytes en el test
  (helper propio: 8 disc + 32 + 1 + 1 + u32-LE de la longitud + 16·N).
- **`signTransaction` tiene que devolver LA MISMA tx** (`vi.fn(async (tx) => tx)`) y las aserciones se
  hacen sobre `mock.calls[0][0]`, no sobre algo que el doble fabricó.
- **`sendRawTransaction` con `toHaveBeenCalledTimes(0)` es la aserción central de T-R5-2 y T-R5-7.** Un
  test que solo mira el valor de retorno no detecta que se gastó un fee.

Esta semana cazamos un caso donde **3669 tests pasaban con un guard de seguridad borrado** porque el
doble aprobaba desde arriba sin mirar los argumentos.

### 5.2 Mutaciones obligatorias

| Mutación | Qué mutar | Test que DEBE ponerse rojo |
|---|---|---|
| M1 | Borrar el filtro `status === "Deposited"` (paso 5) | T-R5-1 |
| M2 | Borrar el chequeo contra `EscrowIndex.entries` (paso 4) | T-R5-2 |
| M3 | `tx.feePayer = facilitatorPk` | T-R5-3 (**y es violación de CD-10**) |
| M4 | Agregar una cuenta remaining a la ix | T-R5-4 |
| M5 | Subir el batch de 4 a 20 ix por tx | T-R5-5 (se pasa de 1232 bytes) |
| M6 | Borrar la deduplicación por id16 | T-R5-6 |

> ⚠️ **`git diff` no ve archivos sin trackear.** El archivo de tests es **nuevo**: si lo mutás antes
> del `git add`, `git diff` sale **vacío** y parece que la mutación no se aplicó. Verificá con
> `sha256sum src/infrastructure/solana-wallet.backfill.test.ts` antes, después y al revertir.

---

## 6. Constraint Directives

### OBLIGATORIO
- **CD-10 / AC-5**: `feePayer = sender`, firma solo el sender. Ninguna `authority`.
- **CD-2 / AC-7**: **PROHIBIDO** prometer o intentar un rescate de escrows sin `remittanceId`. El copy
  de la UI **no** puede sugerir que se recupera "cualquier" escrow perdido.
- **CD-15**: program id desde `escrowIdl.address`.
- Filtrado on-chain **antes** de firmar (§4.1).
- Reusar los helpers existentes (`remittanceIdToBytes16`, derivaciones de PDA, decodificación de
  `EscrowIndex` de R4). **PROHIBIDO duplicar la derivación**: la paridad byte-a-byte del hash entre
  repos ya se rompió una vez (AH-9/TF1).
- Errores como enums estables, copy fijo, sin PII.

### PROHIBIDO
- **NO** tocar `cr1.ts` ni pedir que el facilitator sponsoree el backfill (§1.2).
- **NO** reintentar txs en loop (§4.2).
- **NO** procesar más de 20 candidatos por invocación ni más de 4 ix por tx.
- **NO** custodiar llaves ni hacer el backfill server-side.
- **NO** git destructivo. **NO** abrir `m5-keys/`. **NO** agregar dependencias.

---

## 7. Waves

### Wave -1 — Environment Gate
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm run qa 2>&1 | tail -8                                  # baseline verde — ANOTAR conteo
grep -n "listRecoverableEscrows\|refundEscrowById16" src/infrastructure/solana-wallet.ts   # ⇒ R4 mergeado
grep -n "listRemittanceIdsBySender" src/application/ports.ts                               # ⇒ R0 mergeado
grep -c "register_escrow" src/infrastructure/solana/escrow-idl.ts                           # >0 ⇒ R2b mergeado
```
Si falta cualquiera ⇒ **PARAR**. Y confirmá con el orquestador que **R1 está deployado** en devnet.

### Wave 0
- [ ] W0.1 `ports.ts`: `backfill` en el port de recuperación.
- [ ] W0.2 `solana-wallet.ts`: `backfillEscrowIndex` (§4).
- [ ] **Verificación**: typecheck verde; los tests de R0/R4 verdes **sin editarlos**.

### Wave 1
- [ ] W1.1 gateway: delegación de `backfill` (candidatos desde el resolver de R0).
- [ ] W1.2 `flow.tsx`: botón secundario en el panel de R4.
- [ ] **Verificación**: typecheck + lint verdes; UI EVM/demo sin cambios.

### Wave 2
- [ ] W2.1 T-R5-1..7 con los dobles honestos de §5.1.
- [ ] W2.2 Correr M1..M6 (§5.2), verificando el rojo con `sha256sum`.
- [ ] **Verificación**: `npm run qa` verde; conteo ≥ baseline + 7.

### Wave 3
- [ ] W3.1 Reportar: cuántos candidatos reales existen hoy en `remittance_settlements` para senders
      Solana (una lectura, sin escribir), resultado de M1..M6, y confirmación explícita de que **el
      escrow `BmHDdjKL…` no está y no puede estar** en el alcance.

---

## 8. Definition of Done

1. `npm run qa` verde; conteo ≥ baseline + 7.
2. Cero txs para candidatos no-`Deposited`, inexistentes o ya indexados (T-R5-1/2/7 con
   `sendRawTransaction` en 0 llamadas).
3. `feePayer = sender` en toda tx del backfill; el facilitator no aparece en ninguna cuenta.
4. 4 cuentas exactas por ix, sin remaining; batches < 1232 bytes.
5. Las 6 mutaciones pusieron rojo lo declarado.
6. El copy de la UI **no promete** rescatar escrows sin `remittanceId` (AC-7/CD-2).
7. `cr1.ts` y el resto del facilitator **intactos**.

---

## 9. Escalation Rule

Si algo no está acá → **PARÁS y preguntás al Architect**.

Escalá si:
- Aparece la necesidad de que el facilitator pague el backfill ⇒ **eso requiere otro SDD y otro AR**
  (§1.2): es una operación sponsoreada no atada a un depósito, o sea un vector de drenaje del
  presupuesto de fees.
- Un candidato del store no matchea ningún `escrow_state` del sender ⇒ puede ser drift de
  `sender_address` en la BD; reportalo, **no** "arregles" datos.
- Alguien pide que el backfill recupere el escrow `BmHDdjKL…` ⇒ **es imposible y está prohibido
  prometerlo** (AC-7/CD-2): `EscrowState` nunca guardó el `remittance_id` ni su hash, y las 4
  instrucciones lo exigen como argumento para re-derivar seeds. Ese dato no existe en ningún lado.

---

*Story File generado por NexusAgil — F2.5 · nexus-architect · HU-SOL-20 · R5/7 · **OPCIONAL, recomendación: diferir***
