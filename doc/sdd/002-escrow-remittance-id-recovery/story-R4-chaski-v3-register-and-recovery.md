# Story File — R4 · Emitir `register_escrow` en la tx atómica + recuperación desde el índice on-chain

> **REPO: `chaski-v3`** (`/home/ferdev/.openclaw/workspace/chaski-v3`)
> SDD: `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` (§4.8 variante **B1**, §4.11, §4.12, §5 paso R4)
> HU: **HU-SOL-20** · Fecha: 2026-07-28 · Wave de release: **R4**
> Branch sugerida: `feat/hu-sol-20-r4-register-escrow-and-recovery`

---

## 0. Prerequisitos y orden — el más estricto de toda la HU

### Qué tiene que estar mergeado **Y DEPLOYADO** antes

| Prerequisito | Estado necesario | Por qué |
|---|---|---|
| **R1** (`solana-programs`) | **DEPLOYADO en devnet** (no solo mergeado) | la instrucción `register_escrow` tiene que existir on-chain |
| **R2b** (este repo) | mergeado | sin el IDL re-vendoreado, `program.methods.registerEscrow` **no existe** y esto no compila |
| **R3** (`wasiai-facilitator`) | **DEPLOYADO** (no solo mergeado) | CR-1 tiene que aceptar la tx de 2 business-ix |
| **R0** (este repo) | mergeado | orden del release; además la UI de recuperación usa el store como capa 1 |
| **R2a** (facilitator) | mergeado | paridad de hash |

### Daño concreto del orden inverso (copiado del SDD §5 — leelo acá, no abras otro archivo)

- **R4 antes de R1** ⇒ el programa viejo **no conoce el discriminador** de `register_escrow` ⇒
  **`InvalidInstructionData`** ⇒ **la transacción ENTERA falla** ⇒ **no hay depósito.** Roto y visible:
  el usuario aprieta "enviar" y nada entra en custodia.
- **R4 antes de R3** ⇒ CR-1 responde **`NOT_EXACTLY_ONE_BUSINESS_IX`** ⇒ el facilitator **no
  co-firma** ⇒ **no hay depósito.** Fail-closed (no se pierde plata) **pero el money-path Solana queda
  caído** mientras dure el desfase.
- **R2b después de R4** ⇒ ni compila (`registerEscrow` no está en el IDL vendoreado).

### El flag que convierte ese orden en algo verificable en vez de un acto de fe

Este story entrega el código **detrás de un flag apagado**:
`NEXT_PUBLIC_SOLANA_ESCROW_INDEX_ENABLED` (default **OFF**). Con el flag OFF, la tx de depósito sale
con **1 business-ix**, byte-idéntica a hoy, y funciona con cualquier versión del facilitator. El flip
a `true` lo hace el founder **después** de confirmar que R1 y R3 están deployados. Sin el flag, el
"orden de deploy" es una nota en un doc; con el flag, es un interruptor.

---

## 1. Goal

Cerrar el circuito de la HU en el cliente:

1. **Escribir el índice**: la tx que hoy lleva solo `deposit` lleva ahora `deposit` +
   `register_escrow` en **una sola transacción atómica** sponsoreada por el facilitator. Atómica y no
   best-effort a propósito: un índice que puede fallar en silencio es exactamente la clase de bug que
   creó esta HU (`localStorage` también era best-effort).
2. **Leer el índice**: el usuario que perdió el `remittanceId` deriva `["escrow-index", sender]` con
   **su sola address**, hace **un** `getAccountInfo`, obtiene los `[u8;16]` de sus escrows abiertos, y
   ejerce el `refund` que ya está probado on-chain.

Por qué B1 (una tx) y no B2 (una segunda tx pagada por el sender), decisión del founder ya tomada y
**no re-litigable**: **B2 exige que el usuario tenga SOL, y toda la premisa del diseño es que no lo
tiene** — por eso el facilitator es el fee-payer. B2 no es menos elegante: no funciona para el flujo
principal.

---

## 2. Acceptance Criteria (copiados del SDD §2.1)

- **AC-3**: WHEN un `sender` conectado no posee el `remittanceId` de un escrow propio, the system SHALL
  proveer un mecanismo que permita descubrir la dirección de TODOS los `escrow_state` abiertos de ese
  `sender` sin requerir el `remittanceId` original.
- **AC-4**: WHEN un `escrow_state` es descubierto mediante AC-3 sobre un escrow depositado DESPUÉS del
  upgrade, the system SHALL permitir que su `sender` invoque `refund` sobre esa cuenta sin necesitar
  reconstruir el `remittance_id` de 16 bytes a partir del `remittanceId` original.
  *(Refinamiento ratificado, SDD §2.2: los 16 bytes se pasan como argumento a `refund` pero se **leen
  de la cadena**, no del secreto perdido. DRIFT esperado y justificado, no un hallazgo de QA.)*
- **AC-5**: IF cualquier mecanismo de recuperación permite a la `authority`/árbitro mover o redirigir
  fondos, THEN the system SHALL exigir también la firma del `sender` original.
  ⇒ acá: el `refund` de recuperación tiene **`feePayer = sender`** y lo firma el sender. **CD-10.**
- **AC-6**: los escrows viejos siguen operables **exactamente** como hoy ⇒ con el flag OFF la tx es
  byte-idéntica, y `refundEscrow(remittanceId)` sigue funcionando igual.

---

## 3. Scope IN — archivos exactos (verificados contra disco el 2026-07-28)

| # | Archivo | Acción | Qué hacer |
|---|---------|--------|-----------|
| 1 | `src/infrastructure/chain.ts` (≥206 líneas) | Modificar | Agregar `resolveSolanaEscrowIndexEnabled(): boolean` (lee `NEXT_PUBLIC_SOLANA_ESCROW_INDEX_ENABLED === "true"`, default `false`). Patrón: los `resolveSolana*` de `:129-206`. |
| 2 | `.env.example` (249 líneas) | Modificar | Documentar la env nueva junto a `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` (`:121`), con el default OFF y la advertencia de que **no se enciende hasta que R1 y R3 estén deployados**. |
| 3 | `src/infrastructure/solana-wallet.ts` (240 líneas + lo de R0) | Modificar | (a) `authorizePrincipal` (`:67-151`): agregar la ix `register_escrow` a la **misma** `Transaction` cuando el flag está ON. (b) Extraer el core del refund y agregar `refundEscrowById16`. (c) Agregar `listRecoverableEscrows`. Detalle en §5. |
| 4 | `src/application/ports.ts` | Modificar | Declarar el port `SolanaEscrowRecoveryGateway` (§5.4), al lado de `SolanaEscrowRefundGateway` (`:231-235`). |
| 5 | `src/infrastructure/refund/solana-escrow-recovery-gateway.ts` | **Crear** | Gateway delgado sobre el adapter. Exemplar: `solana-escrow-refund-gateway.ts` (19 líneas, entero). |
| 6 | `src/composition/container.ts` | Modificar | `:144` — instanciar el gateway nuevo junto a `solanaRefund` y exponerlo en el `Container`. |
| 7 | `src/presentation/flow.tsx` (910 líneas) | Modificar | Panel mínimo de recuperación. Exemplar: `RefundAction` (`:830-865`) y el gating `isSolana` de `:744-752`. **Sin rediseño**, sin copy nuevo más allá de lo necesario. |
| 8 | `src/infrastructure/solana-wallet.test.ts` | Modificar | Tests T-R4-1..6 (§6). |
| 9 | `src/infrastructure/solana-wallet.recovery.test.ts` | **Crear** | Tests T-R4-7..11 (§6). |
| 10 | `src/infrastructure/refund/solana-escrow-recovery-gateway.test.ts` | **Crear** | Test T-R4-12. |

### Fuera de scope (PROHIBIDO)

- `app/api/settle/solana-sponsor/route.ts` — **verificado que NO necesita cambios**: forwardea
  `partialSignedTx` opaco (`:54`), no inspecciona las instrucciones. No lo toques.
- El IDL vendoreado y su hash ⇒ **fue R2b**. Si tenés que tocarlo, R2b está incompleto ⇒ PARÁ.
- `cr1.ts` / `deposit-shape.ts` del facilitator ⇒ **fue R3**, otro repo.
- El programa Anchor ⇒ R1, otro repo. **Lectura sí, escritura no.**
- El backfill de escrows pre-upgrade ⇒ **es R5**, story aparte.
- Rediseño de UI/UX de "recuperar mi remesa" más allá de lo estrictamente necesario (Scope OUT del SDD).
- `chaski-v3/m5-keys/` ⇒ **no se abre**.

---

## 4. Datos verificados que necesitás (no los busques de nuevo)

- **PDA del índice**: `["escrow-index", sender]` sobre el program id de `escrowIdl.address`.
  `findProgramAddressSync([Buffer.from("escrow-index"), senderPk.toBuffer()], programId)`.
  Es **determinístico y derivable solo con la address del sender** ⇒ un solo `getAccountInfo`, **sin**
  `getProgramAccounts` (que el RPC público que usa el cliente suele limitar,
  `resolveSolanaRpcUrlPublic`, `solana-wallet.ts:112`).
- **Layout de `EscrowIndex`**: `sender: Pubkey(32)`, `version: u8(1)`, `bump: u8(1)`,
  `entries: Vec<[u8;16]>` (4 + 16·N). Cuenta de **558 bytes fijos**. Se decodifica con
  `new anchor.BorshAccountsCoder(escrowIdl).decode("EscrowIndex", info.data)` — mismo patrón que ya se
  usa para `EscrowState` (`solana-wallet.ts:189-190`).
- **Cuentas de `register_escrow`, en orden exacto** (CR-1 valida **por posición**):
  `0 sender` (signer+writable) · `1 escrow_state` (**read-only**) · `2 escrow_index` (writable,
  non-signer) · `3 system_program`. **Exactamente 4, ninguna remaining.**
- **`escrow_state` sigue derivándose igual**: `["escrow", sender, remittanceId16]`
  (`solana-wallet.ts:99-102`). Reusalo, no lo dupliques.
- **`reference` va SOLO en la ix del `deposit`** (`:132`). Si se lo agregás a `register_escrow`, CR-1
  rechaza con `SECOND_IX_ACCOUNTS_INVALID` (exige `keys.length === 4`).
- **CR-1 exige que `ix[0]` sea el `deposit`**: si mandás `register_escrow` primero, el rechazo es
  `BAD_DISCRIMINATOR`. Orden obligatorio: `tx.add(depositIx, registerIx)`.
- **CR-1 ata la 2ª ix al depósito**: mismo `sender`, mismo `escrow_state` y **mismo `remittance_id`**
  (compara `depositData[8..24]` contra `registerData[8..24]`). Usá **el mismo** `remittanceIdBytes`
  para las dos ix; si derivás dos veces y te queda otro valor, la tx se rechaza.
- **El fee-payer sigue siendo el facilitator** (`:138`) y **no puede aparecer en ninguna ix**
  (Check 5 de CR-1). `register_escrow` no lo referencia: sus 4 cuentas son sender / PDAs / system.
- **El `payer` del rent del índice es el `sender`** (lo fija el programa, no el cliente). Rent ≈
  **0,00477 SOL**, una sola vez por sender. Contexto: cada `deposit` ya quema ≈0,004 SOL de rent que
  nunca se recupera. **CD-10: el facilitator no puede pagarlo** — CR-1 rechazaría la tx.
- **Límite de tamaño de tx legacy: 1232 bytes.** El facilitator solo acepta tx **legacy**
  (`broadcast.ts:113-115` rechaza versionadas). La ix nueva agrega ~1 cuenta + ~30 bytes: entra, pero
  hay que **medirlo** (test T-R4-6).

---

## 5. Especificación

### 5.1 `authorizePrincipal` — la ix extra (archivo #3a)

Insertar **entre** el `.instruction()` del deposit (`:126-133`) y el armado de la tx (`:135-139`):

```ts
    // HU-SOL-20/R4 (B1): register_escrow viaja en la MISMA tx que el deposit ⇒ la entrada del índice
    // es atómica con el depósito. Flag OFF ⇒ 1 sola ix ⇒ tx byte-idéntica a pre-HU (AC-6).
    const ixs: TransactionInstruction[] = [ix];
    if (resolveSolanaEscrowIndexEnabled()) {
      const [escrowIndexPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow-index"), senderPk.toBuffer()],
        programId,
      );
      const regMethods = program.methods as unknown as {
        registerEscrow: (...args: unknown[]) => {
          accounts: (a: Record<string, PublicKey>) => {
            instruction: () => Promise<TransactionInstruction>;
          };
        };
      };
      // MISMO remittanceIdBytes que el deposit: CR-1 compara los 16 bytes de las dos ix.
      // SIN .remainingAccounts(...): CR-1 exige EXACTAMENTE 4 cuentas.
      const registerIx = await regMethods
        .registerEscrow(Array.from(remittanceIdBytes))
        .accounts({ sender: senderPk, escrowState: escrowStatePda, escrowIndex: escrowIndexPda })
        .instruction();
      ixs.push(registerIx);   // ORDEN: deposit primero, register después (CR-1 valida por posición)
    }
    const tx = new Transaction().add(...ixs);
```
El resto (`feePayer = facilitator`, blockhash, partial-sign con la wallet, `serialize({
requireAllSignatures: false, verifySignatures: false })`) queda **idéntico**. **CD-SDD-1/AC-3: acá
NUNCA se broadcastea** — eso lo hace el facilitator.

### 5.2 Refactor del refund (archivo #3b) — sin cambiar comportamiento

Extraer el cuerpo de `refundEscrow` (post-R0) a un privado:

```ts
private async refundWithId16(id16: Uint8Array, senderB58: string): Promise<{ refundTx: string }>
```
que contenga **todo** lo que hoy está en `:165-227` a partir de la derivación del PDA (lectura
on-chain autoritativa incluida: `escrow_not_found` / `escrow_not_deposited` /
`refund_before_deadline`, `feePayer = senderPk`, firma y broadcast del sender).

- `refundEscrow(remittanceId?, sender?)` ⇒ resuelve el id (con el fallback de R0) y llama
  `refundWithId16(this.remittanceIdToBytes16(id), senderB58)`.
- `refundEscrowById16(id16Hex: string, sender?)` ⇒ valida que sean **32 hex chars** (16 bytes),
  convierte y llama `refundWithId16`. Enum de error si el formato es inválido:
  `escrow_id16_invalid`.

> El id16 cruza la frontera hacia la UI como **hex de 32 chars**, no como `Uint8Array`: es
> serializable, comparable y logueable sin sorpresas. La conversión vive en el adapter.

### 5.3 `listRecoverableEscrows` (archivo #3c)

```ts
async listRecoverableEscrows(sender?: string): Promise<Array<{
  id16Hex: string;        // 32 chars hex
  amountMinor: string;    // string, NUNCA number (uint64 — lección WKH-196)
  deadlineSec: number;
}>>
```
Pasos:
1. `senderB58 = sender ?? await this.getAddress()`; sin address ⇒ `wallet_not_connected`.
2. Derivar `["escrow-index", sender]`; `getAccountInfo`.
   **`null` ⇒ devolver `[]`** (mensaje "no hay escrows recuperables" en la UI, **sin excepción cruda**).
3. `coder.decode("EscrowIndex", info.data)` ⇒ `entries: number[][]`.
   `entries.length === 0` ⇒ `[]`.
4. Derivar `["escrow", sender, entry]` para cada entry y **un solo** `getMultipleAccounts`.
5. Para cada cuenta presente: `coder.decode("EscrowState", data)`; **quedarse solo con los
   `Deposited`**. Las ausentes (escrow ya cerrado) se **omiten** en silencio.
6. `amountMinor` con `String(state.amount)` (o `state.amount.toString()` del BN) — **jamás
   `.toNumber()`**: es un `u64` y `JSON.parse`/`Number` redondean arriba de 2^53. Es exactamente el bug
   WKH-196 que rompió el escrow en producción.
7. Ordenar por `deadlineSec` ascendente (el más urgente primero).

### 5.4 Port + gateway (archivos #4, #5, #6)

```ts
// ports.ts — junto a SolanaEscrowRefundGateway (:231-235)
// HU-SOL-20/AC-3/AC-4: recuperación desde el índice on-chain. El sender es el único firmante del
// refund (CD-10/AC-5): ninguna authority participa.
export interface SolanaEscrowRecoveryGateway {
  list(sender: string): Promise<Array<{ id16Hex: string; amountMinor: string; deadlineSec: number }>>;
  refundById16(input: { id16Hex: string; sender: string }): Promise<{ refundTx: string }>;
}
```
Gateway (archivo #5): copia estructural de `solana-escrow-refund-gateway.ts` — interfaz mínima
`SolanaRecoveryCapableWallet` con los 2 métodos, clase que delega, y el comentario de CD-10.

Container (`:144`): `const solanaRecovery = solanaWallet ? new SolanaEscrowRecoveryGateway(solanaWallet) : undefined;`
y exponerlo en el objeto que devuelve `buildContainer` (junto a `solanaRefund`).

### 5.5 UI mínima (archivo #7)

Un componente nuevo `RecoverEscrowPanel({ gateway, sender })`, montado **solo** si
`resolveActiveVm() === "solana"` (dentro de try/catch, patrón `:744-752`) **y** hay `gateway` **y** hay
`sender`. Comportamiento:

- Botón "Buscar mis escrows" ⇒ `gateway.list(sender)`.
- Lista vacía ⇒ texto fijo "No encontramos escrows recuperables." (**sin excepción cruda**).
- Cada ítem: monto formateado + fecha del deadline + botón "Recuperar fondos" ⇒
  `gateway.refundById16({ id16Hex, sender })`.
- Error ⇒ copy fijo, **sin PII y sin interpolar el motivo** (`CD-5` del repo: enum→copy fijo, patrón
  `:843-845`).
- **No mostrar el `id16Hex` crudo al usuario** (es ruido; y CD-17 mantiene el `remittanceId` de
  negocio fuera de la cadena, no lo reintroduzcas en la UI desde el índice).

Con VM=EVM/demo el componente **no se monta** ⇒ **ningún nodo nuevo** ⇒ UI byte-idéntica (mismo
criterio que `RefundAction`).

---

## 6. Tests — por AC, con criterio de MUTACIÓN

| # | Test | AC / riesgo | Archivo |
|---|------|-------------|---------|
| T-R4-1 | **Flag OFF** ⇒ la tx tiene **1** instrucción y es byte-idéntica a hoy (mismo discriminador, mismas 8 cuentas + 1 remaining) | **AC-6** | `solana-wallet.test.ts` |
| T-R4-2 | **Flag ON** ⇒ la tx tiene **2** ix; `ix[0]` = `deposit`, `ix[1]` = `register_escrow` **en ese orden** | AC-3 | idem |
| T-R4-3 | Flag ON ⇒ `ix[1]` tiene **exactamente 4** cuentas, con flags `[signer+writable, ro, writable, ro]` y `system_program` correcto; el `escrow_index` es el PDA `["escrow-index", sender]` | AC-3 / **CR-1** | idem |
| T-R4-4 | Flag ON ⇒ los bytes `[8..24)` de `ix[1].data` son **idénticos** a los de `ix[0].data` (binding de CR-1) | **CR-1** | idem |
| T-R4-5 | Flag ON ⇒ el `feePayer` sigue siendo el facilitator **y no aparece en ninguna de las 2 ix** (Check 5) | **CD-10** | idem |
| T-R4-6 | Flag ON ⇒ `signed.serialize({requireAllSignatures:false}).length < 1232` | límite legacy | idem |
| T-R4-7 | `listRecoverableEscrows`: índice ausente ⇒ `[]` **sin lanzar**; `entries` vacío ⇒ `[]` | §4.12 | `solana-wallet.recovery.test.ts` |
| T-R4-8 | `listRecoverableEscrows` con 3 entries: 1 `Deposited`, 1 `Released`, 1 cuenta ausente ⇒ devuelve **solo** el `Deposited` | AC-3 | idem |
| T-R4-9 | `amountMinor` de un `u64` **mayor que 2^53** se devuelve **exacto como string** | **precisión / WKH-196** | idem |
| T-R4-10 | `refundEscrowById16` refundea usando los 16 bytes **sin** hashear ningún string, y `tx.feePayer === senderPk` | **AC-4 / AC-5 / CD-10** | idem |
| T-R4-11 | `refundEscrowById16` con hex inválido (31 chars, 33 chars, no-hex) ⇒ `escrow_id16_invalid`, **sin** llamar al RPC | fail-loud | idem |
| T-R4-12 | El gateway delega en el adapter y no agrega lógica | — | `solana-escrow-recovery-gateway.test.ts` |

### 6.1 ⚠️ Un test cuyo doble ignora los argumentos es un test vacuo

Acá los dobles son el `Connection` de `@solana/web3.js` y el `solanaWalletBridge`. Dos trampas
concretas:

1. **El `getMultipleAccounts` que devuelve siempre lo mismo.** Si tu doble ignora las pubkeys que
   recibe y devuelve un array fijo, T-R4-8 no prueba que estés derivando bien los PDAs: probaría el
   orden del array del mock. Forma obligatoria: el doble **indexa por pubkey**.
   ```ts
   const byPk = new Map<string, {data: Buffer} | null>([
     [pdaDeposited.toBase58(), { data: encodeEscrowState({status:'Deposited', ...}) }],
     [pdaReleased.toBase58(),  { data: encodeEscrowState({status:'Released',  ...}) }],
     // pdaMissing NO está en el Map ⇒ el doble devuelve null para esa pubkey
   ]);
   getMultipleAccounts: vi.fn(async (pks: PublicKey[]) => ({
     value: pks.map((p) => byPk.get(p.toBase58()) ?? null),
   })),
   ```
   Y asertá **también** que el doble recibió los PDAs esperados:
   `expect(getMultipleAccounts.mock.calls[0][0].map(p=>p.toBase58())).toEqual([...])`.
   Si el doble no mira los argumentos, cambiar el seed `"escrow-index"` por cualquier cosa **no
   pondría rojo nada**.
2. **El `signTransaction` del bridge que devuelve una tx cualquiera.** Los tests que asertean sobre la
   forma de la tx (T-R4-1..6) tienen que inspeccionar **la tx que recibió el doble**, no una que el
   doble fabricó:
   ```ts
   const signTx = vi.fn(async (tx: Transaction) => tx);   // ← devuelve LA MISMA, no una nueva
   // ...
   const sent = signTx.mock.calls[0][0] as Transaction;
   expect(sent.instructions).toHaveLength(2);
   ```
   Esta semana cazamos un caso donde **3669 tests pasaban con un guard de seguridad borrado** porque
   el doble aprobaba desde arriba sin mirar los argumentos. Estas dos son la versión local de ese bug.
3. **T-R4-9 no se prueba con `expect(x).toBe(9007199254740993)`.** Ese literal ya está redondeado por
   el propio parser de JS. Comparalo contra el **string**: `expect(out[0].amountMinor).toBe("9007199254740993")`.

### 6.2 Mutaciones obligatorias (ejecutar, ver el rojo, revertir)

| Mutación | Qué mutar | Test que DEBE ponerse rojo |
|---|---|---|
| M1 | Invertir el orden: `tx.add(registerIx, depositIx)` | T-R4-2 |
| M2 | Agregar `.remainingAccounts([{pubkey: reference, ...}])` a la ix `register_escrow` | T-R4-3 |
| M3 | Derivar el `remittanceIdBytes` **de nuevo** para la 2ª ix a partir de otro string | T-R4-4 |
| M4 | Cambiar el seed `"escrow-index"` por `"escrow_index"` | T-R4-3 **y** T-R4-7/8 |
| M5 | En `listRecoverableEscrows`, no filtrar por `status === 'Deposited'` | T-R4-8 |
| M6 | Devolver `amountMinor` con `state.amount.toNumber()` | T-R4-9 |
| M7 | Poner `tx.feePayer = facilitator` en `refundWithId16` | T-R4-10 (**y sería una violación de CD-10**) |
| M8 | Ignorar el flag y agregar siempre la 2ª ix | T-R4-1 |

> ⚠️ **`git diff` no ve archivos sin trackear.** Tres archivos de este story son **nuevos** (el
> gateway y 2 tests). Si mutás uno antes del `git add`, `git diff` sale **vacío** y parece que la
> mutación no se aplicó. Verificá con `sha256sum <archivo>` antes, después y al revertir. Nos costó
> tiempo real esta semana.

---

## 7. Ops — el flag, su valor y CUÁNDO se enciende

| Qué | Valor | Ámbito | Quién | Cuándo |
|---|---|---|---|---|
| `NEXT_PUBLIC_SOLANA_ESCROW_INDEX_ENABLED` | `true` | **Vercel → Preview** de `chaski-v3` (Production **no**, sigue OFF) | **el founder** | **DESPUÉS** de confirmar que R1 está deployado en devnet **y** que R3 está deployado en el facilitator. Y con redeploy posterior. |

Consecuencia de encenderlo antes de que R3 esté deployado: **cada depósito Solana falla con
`solana_settle_rejected` (422)** — CR-1 rechaza la tx de 2 ix y el facilitator no co-firma. Fail-closed
(nadie pierde plata) pero **el money-path queda caído** hasta que se apague el flag o se deploye R3.

Consecuencia de encenderlo antes de que R1 esté deployado: la tx **sí** la firma el facilitator (CR-1
la considera válida) y **falla on-chain** con `InvalidInstructionData` ⇒ **no hay depósito**, y el
facilitator **gastó gas** en una tx que revierte. Peor que el caso anterior.

> Es una env `NEXT_PUBLIC_*`: se **inlinea en el bundle en build-time**. Cambiar la variable **exige
> redeploy**; no alcanza con setearla. Y el flip es **reversible**: apagar + redeploy vuelve a la tx
> de 1 ix, que cualquier versión del facilitator acepta.

---

## 8. Constraint Directives

### OBLIGATORIO
- **CD-10 / AC-5**: el `refund` de recuperación tiene **`feePayer = sender`** y lo firma el sender.
  **Ninguna** `authority` participa. El facilitator **jamás** paga un refund.
- **CD-15**: el program id sale de `escrowIdl.address` (`solana-wallet.ts:90,173` ya lo hacen). Cero
  literales.
- **CD-17**: el `remittanceId` de negocio **no** se guarda on-chain. En la ix nueva viajan **solo** los
  16 bytes.
- **Un solo `getAccountInfo` del PDA del índice**: **PROHIBIDO `getProgramAccounts`** (el RPC público
  lo limita).
- Montos `u64` como **string**, nunca `number` (WKH-196).
- Libs isomórficas (`@noble/hashes`, `TextEncoder`, `bs58`, el polyfill de `Buffer` de Next). **NUNCA
  `node:crypto`** en código que corre en el browser: el test-env `node` enmascara la falla del bundle
  (auto-blindaje HU-SOL-5 BLQ-MED-1, documentado en `solana-wallet.ts:158-159`).
- El orden `deposit` → `register_escrow` y las **4** cuentas exactas: CR-1 valida por posición.
- Con VM=EVM/demo: **cero** nodos nuevos en la UI y tx byte-idéntica.

### PROHIBIDO
- **NO** broadcastear el `deposit` desde el cliente (`CD-SDD-1/AC-3`): eso lo hace el facilitator.
- **NO** agregar cuentas remaining a `register_escrow`.
- **NO** encender el flag por default ni en `.env.local` comiteado.
- **NO** cambiar la ix `deposit`: mismos args, mismas 8 cuentas, mismo `reference` como remaining.
- **NO** tocar el IDL vendoreado, su hash, ni `CONTRACT-VERSIONS.md` (fue R2b).
- **NO** tocar `app/api/settle/solana-sponsor/route.ts`.
- **NO** implementar el backfill (R5).
- **NO** mostrar PII ni interpolar motivos de error en la UI.
- **NO** git destructivo. **NO** abrir `m5-keys/`. **NO** agregar dependencias.

---

## 9. Waves

### Wave -1 — Environment Gate
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm run qa 2>&1 | tail -8      # baseline VERDE (R0 y R2b mergeados) — ANOTAR el conteo de tests
node -e "const d=require('./src/infrastructure/solana/escrow-idl.ts')" 2>/dev/null; \
grep -c "register_escrow" src/infrastructure/solana/escrow-idl.ts   # >0 ⇒ R2b está mergeado
grep -n "listRemittanceIdsBySender" src/application/ports.ts        # ⇒ R0 está mergeado
```
Si `register_escrow` no está en el IDL vendoreado ⇒ **R2b falta** ⇒ **PARAR**.
Confirmá con el orquestador que **R1 y R3 están DEPLOYADOS** antes de la Wave 3 (la del flag).

### Wave 0 (serial)
- [ ] W0.1 `chain.ts`: `resolveSolanaEscrowIndexEnabled()`.
- [ ] W0.2 `.env.example`: documentar la env (default OFF + la advertencia de orden).
- [ ] W0.3 `ports.ts`: port `SolanaEscrowRecoveryGateway`.
- [ ] **Verificación**: typecheck verde.

### Wave 1 (adapter)
- [ ] W1.1 `solana-wallet.ts`: la ix extra en `authorizePrincipal`, **gateada por el flag** (§5.1).
- [ ] W1.2 `solana-wallet.ts`: extraer `refundWithId16` + `refundEscrowById16` (§5.2).
      **Verificación intermedia**: `solana-wallet.refund.test.ts` verde **sin editarlo** (el refactor
      no cambia comportamiento).
- [ ] W1.3 `solana-wallet.ts`: `listRecoverableEscrows` (§5.3).
- [ ] **Verificación**: typecheck + tests existentes verdes.

### Wave 2 (wiring + UI)
- [ ] W2.1 gateway nuevo (archivo #5) + `container.ts:144`.
- [ ] W2.2 `flow.tsx`: `RecoverEscrowPanel` (§5.5).
- [ ] **Verificación**: typecheck + `npm run lint` verde; con VM=EVM la UI no cambia.

### Wave 3 (tests + mutación)
- [ ] W3.1 T-R4-1..6 · W3.2 T-R4-7..11 · W3.3 T-R4-12.
- [ ] W3.4 Aserciones de honestidad de los dobles (§6.1) en **cada** test que use `getMultipleAccounts`
      o `signTransaction`.
- [ ] W3.5 Correr M1..M8 (§6.2), verificando el rojo, con `sha256sum` en los archivos nuevos.
- [ ] **Verificación**: `npm run qa` verde y conteo de tests ≥ baseline + 12.

### Wave 4 (cierre)
- [ ] W4.1 Reportar: nombre/valor/ámbito exacto del flag y su precondición de deploy (§7), resultado de
      M1..M8, tamaño serializado medido de la tx de 2 ix (T-R4-6), y **la confirmación explícita de que
      el flag quedó OFF en el código mergeado**.

---

## 10. Definition of Done

1. `npm run qa` verde; conteo de tests ≥ baseline + 12.
2. **Flag OFF ⇒ la tx es byte-idéntica a pre-HU** (T-R4-1) y `solana-wallet.refund.test.ts` +
   `solana-wallet.test.ts` existentes verdes **sin ediciones**.
3. Flag ON ⇒ 2 ix, en orden, con 4 cuentas exactas, `remittance_id` atado y `feePayer` = facilitator
   sin aparecer en ninguna ix (T-R4-2..5).
4. Tx serializada < 1232 bytes, con el número medido reportado.
5. Recuperación: índice ausente/vacío ⇒ `[]` sin excepción; solo `Deposited`; montos exactos como
   string; refund con `feePayer = sender`.
6. Las 8 mutaciones pusieron rojo lo declarado.
7. **El flag queda OFF en el código.** El flip es una acción del founder, posterior y reversible.
8. Ningún archivo fuera de la tabla §3.

---

## 11. Escalation Rule

Si algo no está acá → **PARÁS y preguntás al Architect**.

Escalá especialmente si:
- `program.methods.registerEscrow` no existe ⇒ R2b incompleto.
- El orden de cuentas que produce anchor **no** es `[sender, escrow_state, escrow_index, system_program]`
  ⇒ **BLOQUEANTE**: CR-1 valida por posición y rechazaría la tx en producción.
- La tx serializada se pasa de 1232 bytes.
- El refactor de `refundWithId16` pone rojo un test existente ⇒ cambiaste comportamiento.
- Aparece la tentación de mandar `register_escrow` en una **segunda** tx ⇒ **eso es B2, y está
  descartado**: exige que el usuario tenga SOL, y la premisa del diseño es que no lo tiene.
- Alguien pide encender el flag antes de que R1 y R3 estén **deployados** ⇒ escalá con el daño de §7.

---

*Story File generado por NexusAgil — F2.5 · nexus-architect · HU-SOL-20 · R4/7*
