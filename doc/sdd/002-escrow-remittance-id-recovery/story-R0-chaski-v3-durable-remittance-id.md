# Story File — R0 · Registro durable del `remittanceId` + fallback del refund

> **REPO: `chaski-v3`** (`/home/ferdev/.openclaw/workspace/chaski-v3`)
> SDD: `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` (§4.9 DT-8, §5 paso R0, §8 Wave 0)
> HU: **HU-SOL-20** · Fecha: 2026-07-28 · Wave de release: **R0 (primera, arranca por acá)**
> Branch sugerida: `feat/hu-sol-20-r0-durable-remittance-id`
> Variante de diseño ratificada por el founder: **B1** (deposit + register en UNA tx). No afecta R0.

---

## 0. Prerequisitos y orden

### Qué tiene que estar mergeado ANTES de este story

**Nada.** R0 es el primer paso del release. No toca la cadena, no toca el programa Anchor, no toca
el facilitator, no cambia la transacción de depósito. Es el paso más seguro y el que **más protege
hoy**, así que va primero.

### Daño concreto si se hace al revés (copiado del SDD §5 — leelo, no abras otro archivo)

> **R0 último ⇒ se pierde la única protección disponible durante toda la ventana de deploy.**

Traducido a esta HU: entre R1 (upgrade del programa) y R4 (el cliente escribiendo el índice
on-chain) hay una ventana de días. Durante esa ventana, **todo escrow que se deposite y cuyo
`localStorage` se pierda queda inalcanzable**, exactamente como el escrow `BmHDdjKL…` que motivó
esta HU (10 USDC atrapados en devnet, irrecuperables para siempre). R0 es la red de contención de
esa ventana. Si R0 sale último, la ventana queda descubierta y se pueden crear escrows nuevos
irrecuperables mientras se implementa la solución al problema de los escrows irrecuperables.

### Qué habilita este story

R2b / R4 / R5 (los otros stories de `chaski-v3`) asumen R0 mergeado. **R5 (backfill) depende
directamente** de la lectura sender-scoped que se construye acá.

---

## 1. Goal

Hoy la fila durable que ata `remittanceId ↔ sender_address` **ya se escribe** en
`remittance_settlements` antes de que el cliente pueda firmar el depósito
(`app/api/payout/prepare/route.ts:295-312`), pero **nadie la lee jamás**: `refundEscrow` recibe el
`remittanceId` como parámetro y no tiene ningún fallback
(`src/infrastructure/solana-wallet.ts:160-163`). Si el browser perdió el dato (borrar datos, otro
dispositivo, incógnito), los fondos quedan inalcanzables aunque el `refund` trustless funcione
perfecto on-chain.

Este story cierra ese agujero **sin tocar la cadena**: agrega (a) una lectura sender-scoped del
ledger, (b) un endpoint autenticado con proof-of-possession que la expone, (c) el fallback en
`refundEscrow`, y (d) el encendido del flag `SETTLEMENT_LEDGER_ENABLED` en el ámbito correcto de
Vercel — porque **hoy está apagado en devnet y por lo tanto la escritura durable no está guardando
nada** (ver §7, es parte de la Definition of Done).

---

## 2. Acceptance Criteria (copiados del SDD §2.1)

- **AC-1**: WHEN un `deposit` es autorizado por el cliente, the system SHALL persistir el
  `remittanceId` de forma durable server-side (no solo `localStorage`), indexado por la address del
  `sender`, ANTES de que el cliente firme/broadcastee el `deposit`.
  *Estado: satisfecho arquitectónicamente por `prepare/route.ts:295-312` (la escritura ocurre en
  `prepare`, y el cliente no puede construir el `deposit` antes porque necesita el
  `beneficiary`/`authority` que esa misma respuesta devuelve en `:314-317`;
  `solana-wallet.ts:75-76` tira `escrow_params_missing` si faltan). **Condicionado al flag** — de ahí
  W0.4.*
- **AC-2**: WHEN el flujo de `refund` no recibe un `remittanceId` explícito del caller, the system
  SHALL intentar resolverlo desde el store de AC-1 usando la address conectada del `sender` como
  clave, antes de fallar.
- **AC-6** (aplica acá como no-regresión): WHILE existan escrows cuyo `remittanceId` se conserve, the
  system SHALL seguir permitiendo `refund` sobre ellos exactamente como hoy, sin migración.
  ⇒ **el path `refundEscrow(remittanceId)` con el id presente tiene que quedar byte-idéntico.**

---

## 3. Scope IN — archivos exactos (todos verificados contra disco el 2026-07-28)

| # | Archivo | Acción | Qué hacer |
|---|---------|--------|-----------|
| 1 | `src/application/ports.ts` (440 líneas) | Modificar | Agregar `listRemittanceIdsBySender` a la interfaz `SettlementLedger` (declarada en `:378-432`), **después de `listStale` (`:415`)**. Agregar el tipo de retorno `SenderRemittanceRef`. |
| 2 | `src/infrastructure/persistence/supabase-settlement-ledger.ts` (247 líneas) | Modificar | Implementar el método nuevo en `SupabaseSettlementLedger` (clase en `:74-235`), **después de `listStale` (`:171-183`)**. `getSettlementLedger()` (`:242-247`) **NO se toca**. |
| 3 | `src/infrastructure/rate-limit.ts` (≥215 líneas) | Modificar | Agregar `export const ESCROW_RECOVERY_RL: RouteRateLimitConfig` siguiendo el patrón de `PAYOUT_CHALLENGE_RL` (`:70-78`). IP-only. |
| 4 | `app/api/solana/escrow/remittance-ids/route.ts` | **Crear** (dir nuevo) | Endpoint POST PoP-autenticado. Contrato exacto en §5. |
| 5 | `src/infrastructure/refund/http-solana-remittance-id-resolver.ts` | **Crear** | Cliente browser del endpoint #4: pide challenge, firma con la wallet, lista los ids. |
| 6 | `src/application/ports.ts` | Modificar | Declarar el port `SolanaRemittanceIdResolver` (junto a `SolanaEscrowRefundGateway`, `:231-235`). |
| 7 | `src/infrastructure/solana-wallet.ts` (240 líneas) | Modificar | `refundEscrow` (`:160-228`): 1er parámetro pasa a **opcional**; si falta, resolver vía #5. Ctor de `SolanaWalletAdapter` (`:31-32`) acepta un resolver opcional. |
| 8 | `src/infrastructure/refund/solana-escrow-refund-gateway.ts` (19 líneas) | Modificar | `SolanaRefundCapableWallet.refundEscrow` (`:10`) y `refund(input)` (`:15-18`): `remittanceId` pasa a opcional. |
| 9 | `src/composition/container.ts` | Modificar | `:95` — inyectar el resolver en `new SolanaWalletAdapter(...)`. |
| 10 | `src/infrastructure/persistence/supabase-settlement-ledger.test.ts` | Modificar | Tests T-R0-1/2/3 (§6). |
| 11 | `app/api/solana/escrow/remittance-ids/route.test.ts` | **Crear** | Tests T-R0-4..8 (§6). |
| 12 | `src/infrastructure/solana-wallet.test.ts` | Modificar | Tests T-R0-9/10 (§6). |
| 13 | `src/infrastructure/refund/http-solana-remittance-id-resolver.test.ts` | **Crear** | Test T-R0-11 (§6). |

### Fuera de scope (PROHIBIDO tocar en este story)

- `programs/`, `Anchor.toml`, cualquier cosa en el repo `solana-programs` (otro story, otro repo).
- `src/methods/`, `src/chains/` de `wasiai-facilitator` (otro repo).
- `src/infrastructure/solana/escrow-idl.ts`, `contracts/idl/escrow-idl.hash.test.ts`,
  `contracts/CONTRACT-VERSIONS.md` → **eso es R2b**, otro story. Si los tocás acá rompés el orden.
- La construcción de la ix `deposit` (`solana-wallet.ts:110-151`) → eso es R4.
- `app/api/settle/solana-sponsor/route.ts` → eso es R4.
- `chaski-v3/m5-keys/` → **PROHIBIDO abrir**, contiene claves.
- `supabase/migrations/*` → **no hace falta ninguna migración nueva**. Ver §4.1.

---

## 4. Hallazgos verificados que cambian el diseño (leer antes de escribir código)

### 4.1 El índice de BD por `sender_address` YA EXISTE — el SDD lo dejó como `[TBD]`, acá está resuelto

`supabase/migrations/20260716T000000_create_remittance_settlements.sql:30`:

```sql
create index if not exists idx_remit_settle_owner on public.remittance_settlements (sender_address);
```

⇒ **NO crear ninguna migración nueva.** La query sender-scoped ya tiene su índice. El punto 4 de
DT-8 del SDD (§4.9) queda cerrado con esta evidencia.

### 4.2 ⚠️ TRAMPA: la columna `vm` existe pero **NUNCA se escribe** — PROHIBIDO filtrar por ella

`supabase/migrations/20260721T000000_add_vm_network_id_to_remittance_settlements.sql:6-8` agrega
`vm text not null default 'evm'` y `network_id text`. Pero el insert de
`recordOrderPrepared` (`supabase-settlement-ledger.ts:99-113`) **no escribe ni `vm` ni `network_id`**:
el parámetro `vm` de la firma se usa **solamente** como argumento de `canonicalizeAddress`
(`:106-107`). Verificado con grep: no hay una sola escritura de esas dos columnas en todo el repo.

Consecuencia dura: **toda fila tiene `vm='evm'`, incluidas las de remesas Solana.** Si la query
nueva hace `.eq('vm','solana')`, devuelve **cero filas siempre** y el fallback de AC-2 no protege
nada — y el bug es invisible en test si el doble no filtra de verdad.

**Regla de este story**: la query filtra **solo** por `sender_address`. Eso es suficiente y correcto:
el valor almacenado es `canonicalizeAddress(sender, "solana")` = base58 case-sensitive
(`src/infrastructure/address.ts:17-22`), que **nunca** puede colisionar con una address EVM
(`0x` + 40 hex lowercased, `:16`). La address ES el discriminante de VM.

> No arregles la columna `vm` en este story. Es un hallazgo real, va como follow-up documentado, no
> como scope creep de un fix de dinero.

### 4.3 El estado `'prepared'` NO está en `STALE_STATUSES` — no reuses esa constante

`supabase-settlement-ledger.ts:29-33` define `STALE_STATUSES = ['principal_in','submitted','forward_error']`.
La fila que escribe `recordOrderPrepared` nace con `status: 'prepared'` (`:109`), y la migración
`20260718T000000_add_prepared_status.sql:13-16` documenta explícitamente que `'prepared'` **no** se
agrega al índice parcial de stale. El enum completo está en `ports.ts:351-358`
(`prepared | principal_in | submitted | settled | failed | forward_error | manual_review`).

⇒ La query nueva **NO filtra por status** (devuelve todos y el status va en la respuesta). Si
filtrás por `STALE_STATUSES`, perdés justamente las filas `'prepared'`, que son **la mayoría** de las
que interesan (se escriben antes del depósito, que es el punto de AC-1).

### 4.4 El challenge PoP Solana ya existe y funciona — no lo reimplementes

`app/api/a2a/payout/challenge/route.ts:64-77` ya emite un challenge Solana
(`issueSolanaPopChallenge` + `buildSolanaPopMessage`, con `networkId` CAIP-2 resuelto server-side).
El endpoint nuevo **solo verifica**; el cliente reusa ese emisor vía `HttpPopSigner`
(`src/infrastructure/auth/http-pop-signer.ts:16-31`).

### 4.5 No hay archivo de config de vitest en `chaski-v3`

Verificado: no existe `vitest.config.*` ni `vite.config.*` en la raíz (`package.json:test = "vitest run"`).
⇒ vitest usa su glob **por defecto** (`**/*.{test,spec}.?(c|m)[jt]s?(x)`), así que un `route.test.ts`
colocado al lado del `route.ts` se levanta solo. **Verificá que el conteo total de tests subió**, no
solo que "pasó" (esto es CD-13: en WKH-227 el Architect asumió el glob de vitest sin leer el config).

---

## 5. Contrato de Integración ⚠️ BLOQUEANTE

### 5.1 Cliente (browser) → `POST /api/solana/escrow/remittance-ids`

**Request:**
```json
{
  "sender": "string — pubkey base58 del sender conectado (32 bytes)",
  "popChallenge": "string — token HMAC devuelto por POST /api/a2a/payout/challenge",
  "popSignature": "string — firma ed25519 base58 (64 bytes) del popMessage VERBATIM"
}
```

**200:**
```json
{
  "remittanceIds": [
    { "remittanceId": "string", "status": "prepared|principal_in|submitted|settled|failed|forward_error|manual_review", "createdAt": "ISO-8601" }
  ]
}
```
Orden: `created_at` descendente (más reciente primero). Límite duro server-side: **20**.

**Errores** (todos con `{ "error": "<enum estable>" }`, **sin eco del motivo** — no-oracle):

| HTTP | enum | Cuándo |
|---|---|---|
| 503 | `escrow_recovery_unavailable` | `PAYOUT_POP_SECRET` ausente (fail-closed, mirror de `prepare/route.ts:145-147`) **o** `checkRouteRateLimit(...).unavailable` (mirror de `challenge/route.ts:45-47`) |
| 429 | `escrow_recovery_rate_limited` | rate-limit excedido (header `Retry-After`, mirror `challenge/route.ts:48-53`) |
| 400 | `escrow_recovery_invalid_request` | body no-record, `sender` ausente o no base58 válido |
| 403 | `escrow_recovery_unverified` | **cualquier** falla de PoP: campos ausentes, HMAC malo, expirado, `ch.address ≠ sender`, `networkId ≠ resolveSolanaNetworkId()`, firma ed25519 inválida |
| 501 | `escrow_recovery_not_enabled` | `getSettlementLedger()` devolvió `null` (flag OFF o envs Supabase ausentes) |
| 502 | `escrow_recovery_unavailable` | la query al ledger lanzó (nunca 500 crudo, nunca eco del `error.code`) |

**Orden de guards obligatorio** (y por qué): `PAYOUT_POP_SECRET` → rate-limit → parse body →
**PoP completo (P1..P5)** → `getSettlementLedger()` → query.
El check del ledger va **después** del PoP a propósito: si fuese antes, un caller sin firmar podría
usar el 501 como oráculo del estado del flag. Mismo espíritu no-oracle que `prepare/route.ts:125-126`.

**Exemplar del bloque PoP — copiarlo casi verbatim de `app/api/payout/prepare/route.ts:143-186`**
(P1 presencia/tipo → P2 `verifySolanaPopChallenge` → P3 match de address con `canonicalizeAddress`
en try/catch → P4 binding CAIP-2 con `resolveSolanaNetworkId()` → P5 `verifySolanaPop` con
`buildSolanaPopMessage(ch)`). **SIN claim-once del nonce** (igual que prepare: el nonce se quema
recién en submit).

### 5.2 Firma del port nuevo (archivo #1)

```ts
// ports.ts — junto a SettlementRecord (:360-376)
export interface SenderRemittanceRef {
  remittanceId: string;
  status: SettlementLedgerStatus;
  createdAt: string;
}

// dentro de interface SettlementLedger (:378-432), DESPUÉS de listStale (:415):
  // HU-SOL-20/AC-2: lectura OWNER-SCOPED para recuperar los remittanceId de un sender cuando el
  // cliente los perdió. El filtro .eq('sender_address', ...) es el guard REAL (el service key
  // bypassea RLS). NUNCA devuelve PII ni value_minor.
  listRemittanceIdsBySender(input: {
    senderAddress: string;
    vm: "evm" | "solana";
    limit: number;
  }): Promise<SenderRemittanceRef[]>;
```

### 5.3 Implementación Supabase (archivo #2) — forma exacta

```ts
async listRemittanceIdsBySender(input: {
  senderAddress: string; vm: "evm" | "solana"; limit: number;
}): Promise<SenderRemittanceRef[]> {
  const { data, error } = await this.client
    .from(TABLE)
    .select("remittance_id, status, created_at")   // NUNCA value_minor (CD-12 no aplica si no se lee)
    .eq("sender_address", canonicalizeAddress(input.senderAddress, input.vm)) // ← EL GUARD
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (error) throw new Error(`ledger_list_by_sender_failed:${error.code ?? "unknown"}`);
  const rows = (data ?? []) as unknown as Array<{ remittance_id: string; status: SettlementLedgerStatus; created_at: string }>;
  return rows.map((r) => ({ remittanceId: r.remittance_id, status: r.status, createdAt: r.created_at }));
}
```

> **Trampa de test verificada**: el mock de Supabase que ya existe
> (`supabase-settlement-ledger.test.ts:23-63`, `makeClient`) encadena **solo**
> `select/upsert/update/eq/in/lt/limit/single`. **No tiene `order`.** Si no lo agregás a `Calls` y a
> la cadena, el test explota con `builder.order is not a function` y vas a creer que el bug está en tu
> query. Agregá `order` a la interfaz `Calls` y a los `builder.*` (una línea cada uno).

### 5.4 Resolver del cliente (archivo #5) — forma exacta

```ts
// src/infrastructure/refund/http-solana-remittance-id-resolver.ts
// Exemplar: src/infrastructure/auth/http-pop-signer.ts:13-32 (mismo patrón challenge→firma→POST).
import type { PopSigner, SolanaRemittanceIdResolver } from "../../application/ports";

export class HttpSolanaRemittanceIdResolver implements SolanaRemittanceIdResolver {
  constructor(private readonly pop: PopSigner) {}
  async listBySender(sender: string): Promise<string[]> {
    const proof = await this.pop.prove(sender);       // null ⇒ mecanismo PoP apagado server-side
    if (!proof) return [];                            // sin PoP no hay recuperación: lista vacía
    const res = await fetch("/api/solana/escrow/remittance-ids", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender, popChallenge: proof.challenge, popSignature: proof.signature }),
    });
    if (res.status === 501 || res.status === 403) return [];  // apagado / no verificado ⇒ sin candidatos
    if (!res.ok) throw new Error("escrow_recovery_unavailable");
    const body = (await res.json()) as { remittanceIds?: Array<{ remittanceId?: unknown }> };
    return (body.remittanceIds ?? [])
      .map((r) => (typeof r.remittanceId === "string" ? r.remittanceId : ""))
      .filter((s) => s.length > 0);
  }
}
```

Port en `ports.ts` (archivo #6), al lado de `SolanaEscrowRefundGateway` (`:231-235`):
```ts
// HU-SOL-20/AC-2: resuelve los remittanceId del sender desde el store durable server-side cuando el
// cliente los perdió (localStorage vacío / otro dispositivo). Devuelve [] si el mecanismo está
// apagado o no verificado — NUNCA lanza por "no hay nada".
export interface SolanaRemittanceIdResolver {
  listBySender(sender: string): Promise<string[]>;
}
```

### 5.5 Fallback en `refundEscrow` (archivo #7) — comportamiento exacto

Firma nueva: `async refundEscrow(remittanceId?: string, sender?: string): Promise<{ refundTx: string }>`.

Reglas, en orden:

1. `senderB58 = sender ?? await this.getAddress()`; sin address ⇒ `wallet_not_connected`
   (**byte-idéntico a hoy**, `:162-163`).
2. **Si `remittanceId` es un string no vacío ⇒ el resto del método queda BYTE-IDÉNTICO a hoy**
   (`:165-227`). Cero cambio de comportamiento en el path que ya funciona (AC-6).
3. Si falta: si no hay resolver inyectado ⇒ `throw new Error("escrow_id_unavailable")` (enum nuevo,
   fail-loud). Con resolver: `const ids = await resolver.listBySender(senderB58)`.
   - `ids.length === 0` ⇒ `throw new Error("escrow_not_found")` (**enum existente**, `:188`).
   - Si hay ids: tomar **hasta 10** (los primeros, ya vienen ordenados por `created_at` desc),
     derivar el PDA de cada uno con `remittanceIdToBytes16` + `findProgramAddressSync`
     (la MISMA derivación de `:176-180` — no la dupliques, extraé un helper privado),
     y hacer **una sola** llamada `connection.getMultipleAccounts(pdas)`.
   - Decodificar con `BorshAccountsCoder` (patrón `:189-195`) y elegir el **primero** cuyo
     `status` sea `Deposited`. Ninguno ⇒ `escrow_not_found`.
   - Con el id elegido, seguir el camino normal (lectura on-chain autoritativa incluida — **no
     saltear** los guards de `:196-199`: el estado on-chain sigue siendo la única verdad).
4. `feePayer = senderPk` **sigue siendo obligatorio** (CD-10): el facilitator NUNCA paga el refund.

Archivo #8: `SolanaRefundCapableWallet.refundEscrow(remittanceId?: string, sender?: string)` y
`refund(input: { remittanceId?: string; sender: string })`. `flow.tsx` **no se toca**: sigue pasando
el id cuando lo tiene (la UI de recuperación es R4).

---

## 6. Tests requeridos, por AC — con criterio de MUTACIÓN

> Framework: **vitest** (`npm run test`). Un test que "pasa" no prueba nada; lo que prueba es que
> **borrar el guard lo pone rojo**. Cada mutación de abajo se ejecuta, se observa el rojo, y se
> revierte. Si una mutación no pone nada rojo, el test es vacuo → escribí uno mejor.

| # | Test | AC / riesgo | Archivo |
|---|------|-------------|---------|
| T-R0-1 | `listRemittanceIdsBySender` filtra por `sender_address` **canonicalizado base58** y NO por `vm` | AC-2 / IDOR / §4.2 | `supabase-settlement-ledger.test.ts` |
| T-R0-2 | El select **no** incluye `value_minor` y sí `remittance_id, status, created_at`; ordena `created_at` desc y aplica `limit` | AC-2 / CD-12 | idem |
| T-R0-3 | `error` del builder ⇒ lanza `ledger_list_by_sender_failed:<code>` (nunca devuelve `[]` silencioso) | fail-loud | idem |
| T-R0-4 | Sin `popChallenge`/`popSignature` ⇒ **403** `escrow_recovery_unverified` y el ledger **nunca se llama** | CD-16 | `route.test.ts` (nuevo) |
| T-R0-5 | **PoP de OTRA wallet** (challenge de A, `sender` = B) ⇒ **403** y ledger no llamado | **CD-16 / IDOR** | idem |
| T-R0-6 | PoP válido ⇒ **200** y devuelve **solo** los ids del sender firmante | AC-2 / IDOR | idem |
| T-R0-7 | `PAYOUT_POP_SECRET` ausente ⇒ **503**, sin tocar el body ni el ledger | fail-closed | idem |
| T-R0-8 | `getSettlementLedger()` → `null` ⇒ **501**, y **solo después** del PoP OK | no-oracle | idem |
| T-R0-9 | `refundEscrow("rem-1")` con id presente ⇒ el resolver **NO se invoca** (`toHaveBeenCalledTimes(0)`) | **AC-6 byte-idéntico** | `solana-wallet.test.ts` |
| T-R0-10 | `refundEscrow(undefined)` con 2 candidatos (el 1º `Released`, el 2º `Deposited`) ⇒ refundea el 2º; con 0 candidatos ⇒ `escrow_not_found`; `tx.feePayer === senderPk` | **AC-2 / CD-10** | idem |
| T-R0-11 | El resolver manda `sender/popChallenge/popSignature` en el body y devuelve `[]` en 403/501 | AC-2 | `http-solana-remittance-id-resolver.test.ts` (nuevo) |

### 6.1 ⚠️ Un doble que ignora sus argumentos es un test vacuo

Esta semana cazamos un caso donde **3669 tests pasaban con un guard de seguridad borrado**: el doble
aprobaba desde arriba sin mirar los argumentos. Acá el riesgo es idéntico y hay dos capas:

**Capa mock de Supabase (T-R0-1)** — `makeClient` (`supabase-settlement-ledger.test.ts:23-63`) es un
**recorder**: encola un resultado por `from()` y **no aplica los filtros**. O sea, el resultado
devuelto es el mismo con o sin `.eq('sender_address', …)`. Por lo tanto la ÚNICA cosa que detecta la
mutación es la aserción sobre el valor **exacto** registrado:

```ts
const SENDER_SOL = new PublicKey(/* base58 real de 32 bytes */).toBase58();
expect(calls.eq).toContainEqual(["sender_address", SENDER_SOL]);   // ← esto es el test
// PROHIBIDO: expect.anything(), expect.any(String), o solo chequear calls.eq.length
```
Y asertar que **no** hay filtro por `vm` (§4.2):
```ts
expect(calls.eq.map((c) => c[0])).not.toContain("vm");
```

**Capa endpoint (T-R0-5/T-R0-6)** — acá el doble del ledger **sí tiene que filtrar de verdad**. No
uses `vi.fn().mockResolvedValue([...])`: hacé un mini-store honesto en el test:

```ts
const ROWS = [
  { sender: SENDER_A, remittanceId: "rem-A1", status: "prepared", createdAt: "..." },
  { sender: SENDER_B, remittanceId: "rem-B1", status: "prepared", createdAt: "..." },
];
const ledgerMock = {
  listRemittanceIdsBySender: vi.fn(async ({ senderAddress }: { senderAddress: string }) =>
    ROWS.filter((r) => r.sender === senderAddress).map(({ remittanceId, status, createdAt }) => ({ remittanceId, status, createdAt })),
  ),
};
// T-R0-6 asertea que la respuesta contiene rem-A1 y NO CONTIENE rem-B1.
expect(JSON.stringify(await res.json())).not.toContain("rem-B1");
```
Con ese doble, si alguien borra el `sender` del argumento o pasa `ch.address` por otro valor, el test
se pone rojo por sí solo. Patrón de mock de ruta a copiar:
`app/api/settle/principal/route.test.ts:23` (`vi.mock` del módulo del ledger) y `:477-499`.

### 6.2 Mutaciones obligatorias (ejecutar, observar el rojo, revertir)

| Mutación | Archivo:línea a mutar | Test que DEBE ponerse rojo |
|---|---|---|
| M1 | Borrar `.eq("sender_address", …)` de `listRemittanceIdsBySender` | T-R0-1 |
| M2 | Reemplazar el bloque PoP (P1..P5) del endpoint por un `// noop` | T-R0-4 **y** T-R0-5 |
| M3 | En P3, comparar `ch.address` contra sí mismo en vez de contra `sender` | T-R0-5 |
| M4 | En el handler, pasar `senderAddress: ROWS[0].sender` fijo en vez del address verificado | T-R0-5 / T-R0-6 |
| M5 | Invocar el resolver **siempre** (no solo cuando falta el id) | T-R0-9 |
| M6 | Elegir `ids[0]` sin leer el estado on-chain | T-R0-10 |

### 6.3 ⚠️ `git diff` no ve archivos sin trackear

Cuatro de los archivos de este story son **nuevos** (`route.ts`, el resolver, y 2 tests). Si mutás
un archivo nuevo y todavía no le hiciste `git add`, `git diff` sale **vacío** y parece que la
mutación no se aplicó. Verificá con hash, no con diff:

```bash
sha256sum app/api/solana/escrow/remittance-ids/route.ts   # antes de mutar
# ... mutar ...
sha256sum app/api/solana/escrow/remittance-ids/route.ts   # tiene que ser DISTINTO
```
Y al revertir, volvé a comparar contra el hash original. (Esto nos costó tiempo real esta semana.)

---

## 7. Ops — el flag, su ámbito exacto y CUÁNDO se enciende (parte de la DoD, no un "después")

### Estado verificado hoy

- `.env.example:244`: `SETTLEMENT_LEDGER_ENABLED=   # "true" para encender (default OFF = byte-idéntico, CD-2)`
- `supabase-settlement-ledger.ts:243`: `if (process.env.SETTLEMENT_LEDGER_ENABLED !== "true") return null;`
- En Vercel la variable existe **solo en el ámbito Production**. `chaski-v3` de devnet corre en
  **Preview**, donde la variable **no está presente** ⇒ `getSettlementLedger()` devuelve `null` ⇒
  **la escritura durable de `prepare` no guarda nada hoy en devnet.** (Verificado por el founder en
  el dashboard de Vercel; `.env.local:20` la tiene en `true`, pero eso es solo la máquina local.)

### Acción de ops

| Qué | Valor exacto | Ámbito exacto | Quién |
|---|---|---|---|
| `SETTLEMENT_LEDGER_ENABLED` | `true` (string, minúsculas — el check es `!== "true"`, `"TRUE"` **no** sirve) | **Vercel → Preview** del proyecto `chaski-v3` (Production ya la tiene; **no se toca**) | **el founder** (tiene el acceso; el dev NO setea envs) |

También hay que confirmar presentes en Preview: `SUPABASE_URL` (con scheme `https://`),
`SUPABASE_SERVICE_ROLE_KEY` y `PAYOUT_POP_SECRET`. Sin las dos primeras, `getSettlementLedger()`
devuelve `null` igual aunque el flag esté en `true` (`:244-245`). Sin la tercera, el endpoint nuevo
responde 503 por diseño. **El dev no lee ni escribe ningún valor de credencial**: solo reporta si
falta.

### Momento exacto en la secuencia

**El flag se enciende DESPUÉS de mergear el código de este story y DESPUÉS del deploy del Preview,
y ANTES de declarar R0 hecho.** O sea: `merge → deploy Preview → founder setea la env → redeploy /
esperar el redeploy → smoke → recién ahí R0 está DONE`.

Consecuencia de hacerlo al revés (encender el flag antes del código): la fila se empieza a escribir
pero **nadie la lee** — que es exactamente el estado de hoy y no protege nada. No es destructivo,
pero es tiempo perdido y un falso "ya está".

Consecuencia de **no** encenderlo nunca: el código de R0 es correcto y los tests pasan, pero en
devnet **AC-1 y AC-2 son inertes** — la tabla queda vacía y el fallback siempre devuelve
`escrow_not_found`. Por eso el flag es DoD y no ops opcional. (Riesgo marcado como probabilidad
**Alta** en el SDD §11.)

> Nota para F4/QA: en Vercel las env vars solo aplican a deployments **nuevos**. Setear la variable
> sin redeploy no cambia el runtime en vuelo. Pedir evidencia del deployment id posterior al cambio.

---

## 8. Constraint Directives

### OBLIGATORIO
- **CD-16 (heredado)**: el endpoint exige proof-of-possession Solana **y** filtra por `sender_address`
  en la query. Un endpoint que devuelva `remittanceId` de una address sin probar posesión es un IDOR
  ⇒ **BLOQUEANTE en AR**.
- Ownership app-layer: el cliente Supabase usa el service key y **bypassea RLS**
  (`supabase-settlement-ledger.ts:1-8`). El `.eq('sender_address', …)` es la única defensa real.
- **CD-10**: `refundEscrow` mantiene `feePayer = senderPk`. El facilitator/relayer **jamás** paga un
  refund.
- **CD-13**: leer el config real antes de asumir el runner. Ya está hecho en §4.5 (no hay
  `vitest.config`); al agregar archivos de test **verificar que el conteo total de tests subió**.
- Enums de error estables, sin eco del motivo (no-oracle), nunca un 500 crudo. Patrón:
  `prepare/route.ts` completo.
- El path `refundEscrow(remittanceId)` con id presente queda **byte-idéntico** (AC-6).

### PROHIBIDO
- **NO** filtrar la query por la columna `vm` (§4.2) ni por `STALE_STATUSES` (§4.3).
- **NO** seleccionar `value_minor` en la query nueva.
- **NO** devolver PII en la respuesta (`CD-7` del ledger: la tabla no la tiene, no la inventes).
- **NO** crear migraciones nuevas: el índice ya existe (§4.1).
- **NO** tocar `getSettlementLedger()` ni la rama EVM de nada.
- **NO** tocar los 3 archivos del IDL/hash (eso es R2b) ni la construcción de la ix `deposit` (R4).
- **NO** setear envs vos: la env la pone el founder (§7).
- **NO** abrir `chaski-v3/m5-keys/`. Si te cruzás algo que parece credencial, reportá `archivo:línea`
  **sin el valor**.
- **NO** git destructivo (`reset --hard`, `clean -fd`, `checkout --`, `stash drop/clear`,
  `branch -D`, `push --force`).
- **NO** agregar dependencias nuevas. Todo lo necesario ya está: `@solana/web3.js`, `tweetnacl`,
  `bs58`, `@coral-xyz/anchor`, `@supabase/supabase-js`, `vitest`.

---

## 9. Waves

### Wave -1 — Environment Gate (antes de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm run typecheck                     # baseline verde ANTES de tu cambio
npm run test 2>&1 | tail -5           # ANOTAR el número de tests (para CD-13)
ls src/application/ports.ts src/infrastructure/persistence/supabase-settlement-ledger.ts \
   src/infrastructure/solana-wallet.ts src/infrastructure/auth/http-pop-signer.ts \
   app/api/a2a/payout/challenge/route.ts app/api/payout/prepare/route.ts
grep -n "idx_remit_settle_owner" supabase/migrations/20260716T000000_create_remittance_settlements.sql
```
Si algo falla acá: **PARAR** y reportar. No se implementa sobre un baseline rojo.

### Wave 0 (serial) — contratos
- [ ] W0.1 `ports.ts`: `SenderRemittanceRef` + `listRemittanceIdsBySender` en `SettlementLedger` +
      port `SolanaRemittanceIdResolver`. → typecheck **rojo esperado** hasta W0.2.
- [ ] W0.2 `supabase-settlement-ledger.ts`: implementar el método (§5.3).
- [ ] **Verificación**: `npm run typecheck` verde.

### Wave 1 (paralelizable tras W0)
- [ ] W1.1 `rate-limit.ts`: `ESCROW_RECOVERY_RL`.
- [ ] W1.2 `app/api/solana/escrow/remittance-ids/route.ts` (§5.1).
- [ ] W1.3 `http-solana-remittance-id-resolver.ts` (§5.4).
- [ ] **Verificación**: typecheck verde.

### Wave 2 (depende de W1)
- [ ] W2.1 `solana-wallet.ts`: ctor con resolver opcional + fallback en `refundEscrow` (§5.5).
- [ ] W2.2 `solana-escrow-refund-gateway.ts`: `remittanceId` opcional.
- [ ] W2.3 `container.ts:95`: inyectar `new HttpSolanaRemittanceIdResolver(new HttpPopSigner(...))`.
      Cuidado: `pickWallet()`/`wallet` se resuelve en `:96` — el resolver necesita un `PopSigner` que
      a su vez necesita el wallet. Resolver el orden sin ciclos (instanciar el adapter primero y
      pasarle el resolver por setter **no**: mejor construir el `HttpPopSigner` con el propio
      `solanaWallet` justo después de `:95`, como ya hace `:134` con `new HttpPopSigner(wallet)`).
- [ ] **Verificación**: typecheck + `npm run test` verde.

### Wave 3 (tests + mutación)
- [ ] W3.1 T-R0-1..3 · W3.2 T-R0-4..8 · W3.3 T-R0-9..11
- [ ] W3.4 correr las **6 mutaciones** de §6.2, una por una, verificando el rojo con `sha256sum`
      en los archivos nuevos (§6.3), y revertir cada una.
- [ ] **Verificación**: `npm run qa` verde + conteo de tests **mayor** que el baseline de Wave -1.

### Wave 4 (cierre)
- [ ] W4.1 Reportar al orquestador: (a) el valor/ámbito exacto de la env que tiene que setear el
      founder (§7), (b) el resultado de las 6 mutaciones, (c) el follow-up de la columna `vm` (§4.2).
- [ ] **NO** hacer commits ni push si el pipeline no te lo pidió explícitamente.

---

## 10. Definition of Done

1. `npm run qa` verde (typecheck + typecheck:scripts + tests) y el conteo de tests subió.
2. Las 6 mutaciones de §6.2 se ejecutaron y **cada una puso rojo el test declarado** (evidencia:
   nombre del test + mensaje de falla).
3. `refundEscrow(remittanceId)` con id presente: **cero** cambio de comportamiento (T-R0-9 lo prueba).
4. El endpoint no responde 200 a ningún caller que no haya probado posesión de la wallet (T-R0-4/5).
5. **`SETTLEMENT_LEDGER_ENABLED=true` seteada por el founder en el ámbito Preview de Vercel, con
   redeploy posterior**, y un smoke que muestre una fila nueva en `remittance_settlements` tras un
   `prepare` Solana. **Sin esto R0 NO está DONE** (§7).
6. Ninguna migración nueva. Ningún archivo fuera de la tabla §3.

---

## 11. Escalation Rule

Si algo no está en este Story File → **PARÁS y preguntás al Architect**. No inventes, no asumas.

Escalá especialmente si:
- La columna `sender_address` de una fila Solana real **no** está en base58 canónico (rompería el
  matcheo; el insert usa `canonicalizeAddress(sender, vm)` en `:106`, pero verificalo con datos).
- El `HttpPopSigner` no sirve porque el flujo de recuperación corre sin wallet conectada.
- `container.ts` te fuerza un ciclo de dependencias que no se resuelve con lo de W2.3.
- Aparece cualquier necesidad de tocar el IDL, el programa, o el facilitator ⇒ **eso es otro story**.

---

*Story File generado por NexusAgil — F2.5 · nexus-architect · HU-SOL-20 · R0/7*
