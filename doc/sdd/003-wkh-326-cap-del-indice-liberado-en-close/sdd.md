# SDD — [WKH-326] El tope de 32 del índice de escrows deja de crecer para siempre

Fase: F2 (NexusAgil QUALITY) · Architect · 2026-08-05
Repo: `solana-programs` · Programa: `escrow` (`DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`, devnet)
Input: `doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/work-item.md` (gate `HU_APPROVED — 2026-08-05`)

**Estado de los dos bloqueantes de F1: los dos RESUELTOS, empíricamente, con un spike compilado y
corrido. El árbol quedó restaurado byte por byte** (§2.6). Los números están en §2 y §3.

---

## 0. Cómo leer este documento

Cada afirmación de acá abajo se puede refutar con un input concreto. Donde no pude medir algo, dice
**"no se pudo verificar"** con esas palabras, y no está suavizado. Lo que dice "medido" viene de una
corrida cuya salida está transcripta.

---

## 1. Context Map — qué leí y qué saqué de cada cosa

| Archivo | Por qué lo leí | Qué extraje |
|---|---|---|
| `programs/escrow/src/lib.rs` (732 líneas, entero) | es el programa completo | `struct Close` está en `:644-687` y hoy declara 6 cuentas (`sender`, `mint`, `escrow_state`, `vault`, `sender_ata`, `token_program`); el handler `close` está en `:298-336`; el `retain` a reusar está en `:368`; el patrón `bump = <acct>.bump` ya se usa en `Release` (`:583`), `Refund` (`:620`), `Close`/`escrow_state` (`:655`) y `DeregisterEscrow` (`:728`) |
| `.nexus/project-context.md` | fuente de verdad del stack | anchor-cli 1.1.2, `@coral-xyz/anchor` 0.30.1, bankrun 0.5.0/0.4.0, rustc pinneado 1.89.0; trampa nº1 (bankrun shippea `target/deploy/`, no compila); trampa nº2 (`///` y `//!` viajan al IDL) |
| `package.json:10` | versión exacta del cliente del spike | `@coral-xyz/anchor: 0.30.1` — confirmado en runtime, el script imprimió `anchor client version: 0.30.1` |
| `tests/escrow-index.ts` (entero, 774 líneas) | exemplar de los tests del índice | helpers `indexPda`, `register`, `deregister`, `expectRevert` (pinnea el código exacto, `:328-350`), `bumpSlot` (`:309-312`), medición de CU (`:732-772`), aserción contra el IDL construido (`:521-545` según el work-item, verificada) |
| `tests/escrow.ts:499-560` | los dos call sites de `close` que hay que tocar | test 7 (`close` en `Deposited` → `EscrowNotTerminal`) y test 8 (`close` post-release), los dos con `.accountsPartial({...})` inline, sin helper |
| `tests/escrow-window.ts:270-287` | el helper `close(...)` de esa suite | un solo helper, tres call sites (`:669`, `:699`, `:715`) más `:836` y `:846` |
| `doc/mutation-run.md` (entero) | formato del registro de mutantes y el protocolo | tabla `M1..M14`; el mutante sobreviviente M12 y por qué no es un hueco; el protocolo de rebuild/restore del final ("How to repeat it") |
| `README.md:283-288, 451-475, 605-630, 985-1005` | secciones que W5 tiene que reescribir | la fila de `close` en Instructions (`:285`), invariantes 9 (`:453-459`) y 11 (`:468-473`), "The index fills up…" (`:607-623`), "no safe deployment order" (`:987-1002`) |
| `chaski-v3/contracts/idl/escrow-idl.hash.test.ts` (1-110) | qué pinnea el consumidor | `ESCROW_IDL_SHA256` en `:22`; **AC-3 en `:32-36` lee el sibling `../solana-programs/target/idl/escrow.json`** — esto importa, ver §7; AC-R2b-3/4 pinnea `deposit`/`refund`/`register_escrow` por posición y la lista de 6 nombres |
| `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts` | el otro pin | constante en `:30`, R2a pinnea 6 nombres + 6 discriminadores |
| `wasiai-facilitator/src/methods/solana-sponsor/{cr1.ts,deposit-shape.ts}` | consumidor real de la forma de las ix | CR-1 sólo acepta `deposit` (+ opcionalmente `register_escrow`) en una tx patrocinada; `close` está fuera de esa lista blanca por construcción |
| `chaski-v3/src/infrastructure/solana-wallet.ts:306-322, 540-556` | los builders reales | arma `deposit` (`:315-322`) y `refund` (`:552-555`). Nada más |

---

## 2. BLOQUEANTE 1 — RESUELTO. La cuenta opcional funciona, y trae un footgun que hay que escribir

### 2.1 Qué pregunta se contestó

> ¿Anchor 1.1.2 emite `Option<Account<'info, EscrowIndex>>` en el IDL de forma que
> `@coral-xyz/anchor` 0.30.1 sepa construir `close` **omitiéndola**?

**Respuesta: SÍ, pero sólo si el cliente pasa `escrowIndex: null` EXPLÍCITAMENTE.
Dejar la clave afuera del objeto NO omite la cuenta.** Las dos mitades están medidas.

### 2.2 El spike, dicho para que se pueda repetir

Se agregó a `struct Close` (después de `token_program`, o sea en la última posición):

```rust
#[account(
    mut,
    seeds = [b"escrow-index", sender.key().as_ref()],
    bump = escrow_index.bump
)]
pub escrow_index: Option<Account<'info, EscrowIndex>>,
```

y al final del handler `close`:

```rust
if let Some(index) = ctx.accounts.escrow_index.as_mut() {
    index.entries.retain(|e| *e != remittance_id);
}
```

Después: `anchor build`, inspección de `target/idl/escrow.json`, un script de cliente con
`@coral-xyz/anchor` 0.30.1, y una suite bankrun de 8 casos. **Todo se revirtió** (§2.6).

**Línea de base primero, para que el spike signifique algo:** `anchor build` sobre el árbol sin
tocar produjo un `target/idl/escrow.json` y un `target/deploy/escrow.so` **md5-idénticos** a los que
ya estaban en disco, y su sha256 canónico dio
`fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071`, exactamente la constante
pinneada por los dos consumidores. O sea: el build es reproducible acá y todo cambio de hash que
aparezca abajo es del cambio, no del entorno.

### 2.3 Lo que Anchor 1.1.2 emite en el IDL — fragmento real

```json
{
  "name": "escrow_index",
  "writable": true,
  "optional": true,
  "pda": {
    "seeds": [
      { "kind": "const", "value": [101,115,99,114,111,119,45,105,110,100,101,120] },
      { "kind": "account", "path": "sender" }
    ]
  }
}
```

(`[101,115,...]` es `"escrow-index"` en ASCII.)

Y el resto del IDL, medido sobre el artefacto construido:

```
close accounts order: sender | mint | escrow_state | vault | sender_ata | token_program | escrow_index(opt)
close disc: [98,165,201,177,108,65,206,96]        <- IDÉNTICO al actual
n instructions: 6  (close,deposit,deregister_escrow,refund,register_escrow,release)
sha256 canónico del IDL del spike: cedfddd46bdc77669b4a46fc2636e9c345995fac9bf554b0929bc40b7ad7e1ea
```

El discriminador de `close` **no se movió**: Anchor hashea el nombre de la instrucción, no su lista
de cuentas. Eso confirma la predicción del work-item con el artefacto en la mano, no con una cita.

### 2.4 Lo que el cliente 0.30.1 hace con eso — salida real del script

`node spike-client.cjs` (`@coral-xyz/anchor` 0.30.1, IDL del spike, sólo `.instruction()`):

```
anchor client version: 0.30.1
escrow_index PDA: Ci5akmx3PvX1w1xvZ19eoeEVscWV1YASGy2eWpbzLhtm
PROGRAM_ID:       DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x

--- FORMA 1: close CON escrow_index (pasada explícita) ---
  n keys: 7
  [6] Ci5akmx3PvX1w1xvZ19eoeEVscWV1YASGy2eWpbzLhtm writable   <== escrow_index PDA

--- FORMA 2a: close con escrowIndex: null ---
  n keys: 7
  [6] DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x            <== PROGRAM_ID (cuenta omitida)

--- FORMA 2b: close con escrowIndex AUSENTE del objeto ---
  n keys: 7
  [6] Ci5akmx3PvX1w1xvZ19eoeEVscWV1YASGy2eWpbzLhtm writable   <== escrow_index PDA  (!!)

--- FORMA 3: .accounts() sin escrowIndex (el shape loose que usa chaski-v3) ---
  n keys: 7
  [6] Ci5akmx3PvX1w1xvZ19eoeEVscWV1YASGy2eWpbzLhtm writable   <== escrow_index PDA  (!!)
```

Las cuatro formas emiten los mismos 8+16 bytes de data (`62a5c9b16c41ce60` + el id16), o sea que el
argumento no cambia.

**Lectura, y es el hallazgo que este SDD existe para dejar escrito:** como el IDL declara las seeds
de la PDA, el resolvedor del cliente 0.30.1 **la calcula y la mete** cuando la clave no está en el
objeto. "No pasar la cuenta" y "pasar `null`" son dos cosas distintas, y sólo la segunda omite.

### 2.5 Qué hace el programa con cada forma — runtime, bankrun

8 casos, todos verdes contra el binario del spike (`ts-mocha tests/zz-spike-wkh326.ts`):

```
  SPIKE WKH-326 (temporal)
   [S1] CU close CON indice = 24223
    ✔ S1 (AC-1): close CON el indice saca exactamente esa entrada y deja el resto en orden
   [S2] CU close SIN indice (null) = 17183
    ✔ S2 (AC-2): close con escrowIndex=null y SIN indice creado nunca -> confirma y NO crea la cuenta
   [S3] key[6] = EJrrQkj9S92ZkGmLxmAxDanJsv2jmQUdfaXt7945JYPF (programId=DR5Go..., indexPda=EJrrQ...)
   [revert] esperado=AccountNotInitialized visto=AccountNotInitialized
    ✔ S3 (FOOTGUN): close con la cuenta OMITIDA del objeto, sin indice en cadena
   [revert] esperado=ConstraintSeeds visto=ConstraintSeeds
    ✔ S4 (AC-4): close pasando el indice de la VICTIMA revierte y no toca ese indice
   [revert] esperado=EscrowNotTerminal visto=EscrowNotTerminal
    ✔ S5 (AC-6): close con estado Deposited revierte EscrowNotTerminal y NO toca el indice
    ✔ S6 (AC-7): close con un indice que NO contiene el id confirma y deja entries igual
   [S7] ciclo 8: entries=0 / 16: entries=0 / 24: entries=0 / 32: entries=0 / 33: entries=0
    ✔ S7 (AC-3): el ciclo deposit->register->release->close 33 veces con el MISMO sender (487ms)
   [S8] CU close CON indice = 19643 | SIN indice(null) = 15690 | delta = 3953
    ✔ S8 (CU): close CON indice vs SIN indice, misma corrida

  8 passing (1s)
```

Los 9 ACs del work-item quedan cubiertos por construcción en su forma de runtime: **S7 es AC-3
corriendo verde con el fix puesto**, que es lo que hacía falta para saber que el camino elegido
efectivamente resuelve el bug (W0 va a mostrar el mismo test en rojo contra el binario de hoy).

Lo que S3 mide y es lo que hay que llevarse: un cliente que "no pasa" el índice cuando el índice
**no existe** recibe `AccountNotInitialized` (3012). El `key[6]` impreso es la PDA del índice, no el
program id. El footgun es real y observable, no teórico.

### 2.6 Restauración del árbol — verificada, no prometida

Se borraron `tests/zz-spike-wkh326.ts` y `tests/zz-spike-cu-wkh326.ts`, se restauró
`programs/escrow/src/lib.rs` desde una copia previa al spike, y se corrió `anchor build`. Los cuatro
md5 volvieron a su valor pre-spike:

| Archivo | md5 antes del spike | md5 después de restaurar |
|---|---|---|
| `programs/escrow/src/lib.rs` | `286226f7f787ca648595dbde42f7c7aa` | `286226f7f787ca648595dbde42f7c7aa` |
| `target/idl/escrow.json` | `037c5c5ffd80a21e0a758896acc805a3` | `037c5c5ffd80a21e0a758896acc805a3` |
| `target/deploy/escrow.so` | `f4be35f7ee11bdb48c0a576a43b4972f` | `f4be35f7ee11bdb48c0a576a43b4972f` |
| `target/types/escrow.ts` | `7c736aaa3303f4b85971b36ac3355277` | `7c736aaa3303f4b85971b36ac3355277` |

sha256 canónico del IDL: de vuelta en `fb64c937…`. `git status --short` muestra sólo `?? .nexus/` y
`?? doc/sdd/`, que ya estaban antes. La suite completa: **43 passing**, el número documentado.
El spike se hizo en `main` y **no dejó nada**.

---

## 3. BLOQUEANTE 2 — RESUELTO con el número. `bump = escrow_index.bump`

### 3.1 Las dos opciones compilan

Se construyeron las dos y las dos pasan los 8 casos de §2.5, **incluido S4 (`ConstraintSeeds`)**.
`bump = escrow_index.bump` **sí** funciona sobre un `Option<Account<...>>` en Anchor 1.1.2: el macro
genera la validación dentro de la rama `Some`. La duda de F1 ("con `Option` no se puede usar
`bump = escrow_index.bump` de la misma manera") queda refutada por el compilador.

**Las dos producen el MISMO sha256 canónico de IDL** (`cedfddd4…`): la estrategia del bump no viaja
al IDL. Elegir una u otra no le cambia nada a los consumidores.

### 3.2 La medición, con las mismas direcciones en las dos variantes

El problema de medir esto es la trampa nº7 del repo: el CU no es una constante, se mueve con los
bumps canónicos, que dependen de los keypairs aleatorios. Así que la medición usa **keypairs
deterministas** (`Keypair.fromSeed`), de modo que las dos variantes ven **exactamente las mismas
direcciones y los mismos bumps**. 16 senders, `close` con índice, mismo escrow:

| sender | bump del índice | A: `bump` (re-derivar) | B: `bump = escrow_index.bump` | A − B |
|---|---|---|---|---|
| 0 | 250 | 30.154 | 22.674 | **+7.480** |
| 1 | 255 | 19.623 | 19.643 | −20 |
| 2 | 255 | 25.640 | 25.660 | −20 |
| 3 | 252 | 25.623 | 21.143 | **+4.480** |
| 4 | 254 | 21.123 | 19.643 | **+1.480** |
| 5 | 255 | 21.140 | 21.160 | −20 |
| 6 | 255 | 28.623 | 28.643 | −20 |
| 7 | 255 | 28.623 | 28.643 | −20 |
| 8 | 253 | 25.623 | 22.643 | **+2.980** |
| 9 | 254 | 24.123 | 22.643 | **+1.480** |
| 10 | 253 | 22.623 | 19.643 | **+2.980** |
| 11 | 255 | 21.123 | 21.143 | −20 |
| 12 | 255 | 25.623 | 25.643 | −20 |
| 13 | 254 | 27.123 | 25.643 | **+1.480** |
| 14 | 255 | 21.123 | 21.143 | −20 |
| 15 | 255 | 24.123 | 24.143 | −20 |

**No es una nube de puntos: es una fórmula, y los 16 la cumplen exactamente.**

```
A − B  =  (255 − bump_del_índice) × 1.500  −  20
```

Verificable en cada fila: bump 255 → −20; 254 → 1.480; 253 → 2.980; 252 → 4.480; 250 → 7.480.
El mecanismo es el que el propio repo ya documenta (`tests/escrow-index.ts:725-731`): cada paso por
debajo de 255 es una iteración extra de sha256 dentro de `find_program_address`, y cuesta 1.500 CU.
Los 20 CU fijos son lo que la variante B paga por leer `escrow_index.bump` del estado deserializado.

**Esto no es "repetí y me dio parecido": es la medición del MECANISMO.** Si mañana alguien ve un
delta que no cumple la fórmula, la explicación de acá es falsa y hay que volver.

### 3.3 La decisión

**Se elige B: `bump = escrow_index.bump`.** Tres razones independientes, en ese orden:

1. **El número.** B paga 20 CU fijos y ahorra hasta 7.480 CU en el caso peor observado. A tiene un
   costo que depende de una lotería (el bump canónico del sender) y por lo tanto un techo que hay
   que dimensionar contra el peor caso, no contra la muestra.
2. **La previsibilidad.** Con B, el costo del índice en `close` es constante respecto del bump. Con
   A, un mismo cliente contra el mismo programa consume distinto según qué sender sea. Un
   presupuesto de compute que dependa del sender es un presupuesto que alguien va a dimensionar mal.
3. **La consistencia con el archivo.** Las otras cuatro cuentas sembradas del programa ya usan
   `bump = <acct>.bump`: `Release` (`lib.rs:583`), `Refund` (`:620`), `Close`/`escrow_state`
   (`:655`) y `DeregisterEscrow` (`:728`). Usar `bump` a secas acá sería la única excepción del
   archivo, y una excepción sin motivo es una pregunta que el próximo lector tiene que re-derivar.

**Por qué B es seguro, y dónde se rompería:** leer el bump de la cuenta que se está validando suena
a que uno se cree lo que le pasan. No lo es, y el motivo es específico de este programa: Anchor
calcula `create_program_address(["escrow-index", sender.key()], bump_guardado)` y lo compara contra
la dirección pasada, y la única instrucción que puede **crear** un `EscrowIndex` es
`register_escrow`, que usa `bump` canónico con `init_if_needed` (`lib.rs:708-714`). O sea: no existe
ni puede existir un `EscrowIndex` propiedad de este programa en una dirección no canónica, así que
no hay ninguna cuenta con la que armar el ataque. Es exactamente el mismo razonamiento que ya
sostiene `bump = escrow_index.bump` en `DeregisterEscrow` desde HU-SOL-20.
**Lo que lo daría vuelta:** el día que alguna instrucción cree un `EscrowIndex` con un bump que no
sea el canónico. Si eso pasa, esta decisión hay que revisarla.
Y el guard de ownership sigue siendo el mismo: las seeds incluyen `sender.key()`, que es el
`Signer`. S4 lo comprueba en runtime bajo las **dos** variantes: pasar el índice de la víctima
revierte con `ConstraintSeeds` y el índice de la víctima queda igual.

### 3.4 El costo total de `close`, para que nadie lo suponga

Sobre los mismos 16 senders, variante B:

- `close` **con** índice: 19.643 … 28.643 CU (spread 9.000, 9 valores distintos)
- `close` **sin** índice (`null`): 15.690 … 24.690 CU (spread 9.000, 6 valores distintos)

El spread de 9.000 aparece en las **dos** columnas por igual: es el ruido de los bumps del
`escrow_state` y de la ATA del vault, no del índice.

**Lo que este dato NO dice, y hay que decirlo:** el "delta por sender" que imprimió el spike
(953…6.970 CU) compara dos escrows **distintos**, con bumps distintos, así que **no es** el costo
marginal del índice — es una cota sucia. El costo marginal limpio no quedó aislado en esta fase.
**No se pudo verificar** con la precisión de la tabla de §3.2, y por eso no se afirma un número.

Lo que sí es accionable y sí está medido: el **peor `close` observado** en 32 mediciones es
**30.154 CU** (variante A) y **28.643 CU** (variante B), contra el límite por defecto de 200.000 CU
de una transacción. `close` va en su propia transacción y nadie la empaqueta con otra cosa. El
compute no es una restricción acá, y ahora está medido en vez de supuesto.

---

## 4. El grep de consumidores — mandato de F1, re-corrido. Salida cruda

F1 no tuvo shell y no pudo. Acá está, con la salida sin editar.

### 4.1 Todo builder de Anchor en los cuatro repos consumidores

```
$ grep -rn --include=*.ts --include=*.tsx --include=*.js --include=*.mjs --include=*.py -E '\.methods\b' \
    chaski-v3/src chaski-v3/contracts chaski-v3/scripts wasiai-facilitator/src wasiai-a2a/src \
    wasiai-remittance-agents | grep -v node_modules

chaski-v3/src/infrastructure/solana-wallet.ts:306:    const methods = program.methods as unknown as {
chaski-v3/src/infrastructure/solana-wallet.ts:545:    const methods = program.methods as unknown as {
chaski-v3/scripts/smoke-solana-e2e.ts:416:  const methods = program.methods as unknown as {
wasiai-facilitator/src/core/supported.ts:191:  const methods: readonly string[] = Array.from(new Set(chains.flatMap((c) => c.methods)));
wasiai-facilitator/src/routes/supported.ts:64:        methods: response.methods,
wasiai-facilitator/src/chains/types.ts:95: * breaks integrators that branch on `chains[].methods`. Pinned verbatim by
wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:253:    expect(Array.isArray(body.methods)).toBe(true);
wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:265:    expect(Array.isArray(chains[0]!.methods)).toBe(true);
wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:347:    expect(body.methods).toEqual(['eip3009']);
wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:567:    expect(solana?.methods).toEqual([SPL_TOKEN_TRANSFER_FINALIZED]);
wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:568:    expect(solana?.methods).not.toContain('eip3009');
wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:582:    expect([...body.methods].sort()).toEqual(['eip3009', SPL_TOKEN_TRANSFER_FINALIZED]);
wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:583:    expect(body.methods.length).toBe(2);
wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:600:      expect(entry.methods).toEqual(['eip3009']);
wasiai-facilitator/src/__tests__/unit/routes.openapi.test.ts:219:    expect(props.methods!.type).toBe('array');
wasiai-facilitator/src/__tests__/unit/routes.openapi.test.ts:228:    expect(chainProps.methods!.type).toBe('array');
wasiai-facilitator/src/__tests__/unit/routes.openapi.test.ts:372:    ).methods!.description as string | undefined;
wasiai-facilitator/src/__tests__/unit/routes.openapi.test.ts:402:    ).methods!.description as string | undefined;
wasiai-facilitator/src/__tests__/unit/routes.openapi.test.ts:408:    ).methods!.description as string | undefined;
wasiai-facilitator/src/__tests__/unit/chains/solana-adapter.test.ts:462:      expect(entry?.methods).toEqual([SPL_TOKEN_TRANSFER_FINALIZED]);
wasiai-facilitator/src/__tests__/unit/chains/solana-adapter.test.ts:465:      expect(response.methods).toEqual([SPL_TOKEN_TRANSFER_FINALIZED]);
wasiai-a2a/src/routes/capabilities.inbound-chains.test.ts:233:    expect(body.methods).toEqual([]);
```

Todo lo del facilitator y de `wasiai-a2a` en esa lista es el campo `methods` de su API de
`/supported` (una lista de strings de esquemas de pago), **no** el namespace `.methods` de Anchor.
Los únicos tres `program.methods` de Anchor son los tres de `chaski-v3`, y los tres se leyeron:

- `chaski-v3/src/infrastructure/solana-wallet.ts:306-322` → construye **`deposit`**.
- `chaski-v3/src/infrastructure/solana-wallet.ts:545-556` → construye **`refund`**.
- `chaski-v3/scripts/smoke-solana-e2e.ts:416-430` → construye **`deposit`**.

### 4.2 `close` / `registerEscrow` / `deregisterEscrow` por nombre

El grep amplio de `close`/`closeEscrow`/`close_escrow` sobre los cuatro repos devuelve 306 KB de
ruido (`res.on('close')`, `reply.raw.on('close')`, "fail-closed" en prosa, etc.). Filtrado a lo que
toca al programa escrow, lo que queda es:

```
chaski-v3/src/infrastructure/solana/escrow-idl.ts:18:      "name": "close",           <- IDL vendoreado
chaski-v3/src/infrastructure/settlement/solana-deposit-beneficiary.test.ts:123:
      const close = idl.instructions.find((i) => i.name === "close");   <- lee el IDL, no construye
chaski-v3/contracts/idl/escrow-idl.hash.test.ts:54:      "close",                    <- pin de nombres
wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:52:      'close',                <- pin de nombres
wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:76:
      expect(ixs.find((i) => i.name === 'close')?.discriminator).toEqual([...])       <- pin de disc
wasiai-facilitator/src/chains/escrow-idl.ts:27:      name: 'close',                  <- IDL vendoreado
```

Y para `register_escrow` / `deregister_escrow` (33 hits, todos leídos): IDL vendoreado, tests de pin,
prosa de docs, y la lista blanca de CR-1 del facilitator
(`src/methods/solana-sponsor/{cr1.ts:142,329, deposit-shape.ts:114-126}`) que **pinnea las 4 cuentas
de `register_escrow` por posición** para decidir si patrocina una tx atómica. Ningún builder.

### 4.3 Veredicto — DT-1 SIGUE EN PIE

**Ningún consumidor construye `close`. Ni uno.** Lo que existe es: el IDL vendoreado (que lo declara
porque declara las 6), tests que pinnean su nombre y su discriminador, y un test que lo busca por
nombre para leerlo. Ninguno arma una `TransactionInstruction` de `close`.

Por lo tanto **DT-1 no hay que revisarlo**: agregarle una cuenta a `close` sigue siendo una
restricción hacia adelante y no un corte en vivo. Lo que el README afirma en `:999-1002` sobre el
grep del 2026-08-01 se sostiene al 2026-08-05.

**Y una consecuencia que conviene dejar dicha:** el pin del facilitator (`escrow-idl.hash.test.ts:76`)
compara el **discriminador** de `close`, no su lista de cuentas. Como el discriminador no se mueve
(§2.3), ese `expect` va a seguir verde. El único `expect` del facilitator que se pone rojo es el de
la constante del hash. Lo mismo del lado de `chaski-v3`.

---

## 5. Decisiones técnicas

### 5.1 Heredadas del work-item, sin cambios

`DT-1` (camino (a), `close` saca la entrada), `DT-3` (mismo `retain` que `deregister_escrow`),
`DT-4` (`deregister_escrow` no se toca), `DT-5` (`MAX_ENTRIES` se queda en 32), `DT-6`
(implementa sola, deploy agrupado con eventos), `DT-7` (los tres doc comments falsos no se corrigen
acá), `DT-8` (el test de la fuga se ve rojo antes del fix).

`DT-2` se **confirma con evidencia** y se le agrega la mitad que faltaba: ver DT-9.

### 5.2 Nuevas de F2

- **DT-9 — La cuenta es `Option<Account<'info, EscrowIndex>>`, y el contrato con el cliente es
  `null`, no "ausente".**
  DT-2 queda confirmado empíricamente (§2.3, §2.4, §2.5): Anchor 1.1.2 emite `"optional": true` y el
  cliente 0.30.1 construye las dos formas. **La alternativa `UncheckedAccount` + deserialización
  manual queda DESCARTADA** y no hay que especificarla: no hace falta, y cambiarla por eso sería
  perder los guards declarativos (discriminador, owner, seeds, `mut`) que Anchor ya aplica y que S4
  y S3 muestran funcionando.
  **La otra mitad, que es nueva y es lo que este SDD aporta:** omitir la cuenta se escribe
  `escrowIndex: null`. Dejar la clave afuera **no omite nada** — el resolvedor del cliente calcula la
  PDA desde las seeds del IDL y la pasa igual (FORMA 2b y FORMA 3 de §2.4). Si esa PDA no existe en
  cadena, la tx revierte con `AccountNotInitialized` (3012). Esto **no** es un defecto del diseño: es
  el precio de que el IDL publique las seeds, que es lo que le permite a cualquier cliente derivar la
  PDA sin conocerla. Pero es una trampa que hay que dejar escrita en tres lugares (el comentario de
  la cuenta, el README y las tres condiciones de WKH-327), porque el que la pise va a ver un error
  que no menciona la palabra "opcional".

- **DT-10 — El bump se lee de la cuenta: `bump = escrow_index.bump`.** Argumento completo y la
  fórmula medida en §3.3. Se descarta re-derivar (`bump` a secas).

- **DT-11 — La cuenta va en la ÚLTIMA posición del `struct Close`, después de `token_program`.**
  Dos motivos. (i) Las seis cuentas actuales conservan su índice posicional exacto (0..5). El spike
  midió las dos ubicaciones: puesta antes de `token_program`, `token_program` se corre del índice 5
  al 6; puesta al final, nada se mueve. Ningún test pinnea `close` por posición hoy
  (`chaski-v3/contracts/idl/escrow-idl.hash.test.ts:45-95` pinnea `deposit`, `refund` y
  `register_escrow`, no `close`), así que esto no arregla un rojo — arregla el rojo del día que
  alguien lo pinnee. (ii) Es la convención de Anchor para cuentas opcionales, y una cuenta opcional
  en el medio de la lista es la que más fácil se desalinea.

- **DT-12 — La cuenta nueva se documenta con `///`. Excepción a CD-6, declarada acá como la propia
  CD-6 exige.**
  El work-item deja esta decisión a F2 y ésta es la decisión: **sí, `///`**. Tres razones:
  1. **El costo ya está pago.** CD-6 existe para que el hash no se mueva por prosa. Acá el hash se
     mueve igual, por la cuenta. El `///` no agrega un movimiento: viaja en el mismo.
  2. **Hay precedente exacto, y está verificado en el artefacto.** La última cuenta que se le agregó
     a `close` (`sender_ata`, la ventana de custodia) lleva `///` (`lib.rs:674-678`) y ese texto
     **está** en el IDL construido de hoy como `accounts[4].docs`. Comprobado imprimiendo el
     `docs` de las 7 cuentas de `close`: la única que tiene es `sender_ata`. Hacer distinto acá
     dejaría dos cuentas nuevas de la misma instrucción documentadas de dos formas distintas.
  3. **El lector que la necesita está del otro lado del IDL.** Lo que hay que decir ("es opcional; se
     omite pasando `null`, no dejándola afuera; omitirla cuando el índice existe deja la entrada
     colgada") le sirve a quien escriba WKH-327 leyendo el IDL vendoreado, no a quien lea el `.rs`.
     Un `//` no le llega.

  **Lo que esta decisión obliga:** el `///` es **sólo** para la cuenta `escrow_index` nueva. Todo
  otro comentario nuevo de esta HU (el bloque de `lib.rs:377-396`, el de `:411-412`, cualquier nota
  en el handler) sigue en `//`, sin excepción. CD-6 sigue vigente para todo lo demás.

- **DT-13 — El `retain` va en el cuerpo del handler, después del cierre del vault, envuelto en
  `if let Some(...)`.** No se pone antes: el orden dentro del cuerpo es indistinto para la
  atomicidad (una tx que revierte no escribe nada), pero ponerlo al final deja el bloque de CPIs
  existente sin tocar y por lo tanto el diff de W1 es legible. Los constraints del Context —incluido
  `is_terminal()`— corren **antes** de todo el cuerpo, que es lo que hace verdadero AC-6; S5 lo
  comprueba (`EscrowNotTerminal` y el índice intacto).

- **DT-14 — Los helpers de test de las tres suites pasan `escrowIndex: null` por defecto.**
  Radio de impacto **medido** (§6.2): 7 tests existentes se ponen rojos con `AccountNotInitialized`
  si no se los toca. El helper toma un parámetro opcional para el caso que sí lo pasa. Esto no es
  cosmética: si el default fuera "pasar la PDA", el caso más común de producción (sender sin índice)
  dejaría de estar cubierto, que es justo lo que AC-2 protege.

---

## 6. Constraint Directives

### 6.1 Heredados del work-item — vigentes, sin cambios

`CD-1` (PROHIBIDO DESPLEGAR: `anchor deploy`, `solana program deploy|extend|write-buffer`,
`anchor idl init|upgrade|publish`, `scripts/deploy-devnet.sh`, y cualquier tx de escritura contra
devnet), `CD-2` (PROHIBIDO escribir en `chaski-v3/`, `wasiai-facilitator/`, `wasiai-a2a/`,
`wasiai-remittance-agents/`; en particular re-pinnear `ESCROW_IDL_SHA256`), `CD-3`
(`MIN_/MAX_CUSTODY_SECS` intocables), `CD-4` (`EscrowStatus` y el orden de `ErrorCode`),
`CD-5` (sólo `close` cambia), `CD-6` (comentarios nuevos en `//` — con la excepción única de DT-12,
declarada), `CD-7` (no subir `MAX_ENTRIES`), `CD-8` (mutantes obligatorios), `CD-9` (nada de
`m5-keys/`, secretos ni git destructivo), `CD-10` (AC-3 en rojo primero), `CD-11` (`anchor build`
antes de cada corrida), `CD-12` (nada de `cargo fmt`).

### 6.2 Nuevos de F2

- **CD-13 — PROHIBIDO agregar `init_if_needed` o `init` a la cuenta `escrow_index` de `Close`.**
  Ya estaba argumentado en DT-2 (le cobraría al sender 4.774.560 lamports para devolverle 4.002.000);
  se sube a directiva porque es el error que un `AccountNotInitialized` en un test invita a cometer.
  Detección: `grep -n "init" ` en el bloque de `Close`. Si aparece, es BLOQUEANTE en AR.

- **CD-14 — PROHIBIDO omitir el parámetro del índice pasando la clave afuera del objeto.**
  En todo test y todo ejemplo de esta HU, "sin índice" se escribe `escrowIndex: null`, explícito.
  Un `.accountsPartial({...})` que simplemente no menciona `escrowIndex` **está pasando la PDA**
  (§2.4). Un test de AC-2 escrito así probaría lo contrario de lo que dice probar.
  Detección: cualquier llamada a `.close(` cuyo objeto de cuentas no contenga la clave `escrowIndex`.

- **CD-15 — OBLIGATORIO que la cuenta `escrow_index` vaya última en `struct Close`** (DT-11).
  Detección: en `target/idl/escrow.json`, `close.accounts[5].name === "token_program"` y
  `close.accounts[6].name === "escrow_index"`.

- **CD-16 — PROHIBIDO tocar el `retain` de `deregister_escrow` (`lib.rs:368`) y su Context.**
  DT-4 lo dice; se vuelve directiva porque el `retain` nuevo es una copia del viejo y "unificar los
  dos en un helper" es la refactorización que un revisor va a proponer. No se hace en esta HU: la
  simetría entre los dos es lo que hace que un mutante que rompe uno no toque al otro, y por lo tanto
  lo que hace que el plan de mutación de §9 signifique algo.

- **CD-17 — PROHIBIDO afirmar el sha256 nuevo del IDL en cualquier archivo que no sea la evidencia
  de esta HU.** El hash del spike (`cedfddd4…`) **no** es el hash final: el fuente final va a llevar
  el `///` de DT-12 y los comentarios de W5, y `cedfddd4…` se midió sin ellos. W5 registra el hash
  que salga del build final, y nada más que eso.

- **CD-18 — Aprendizaje histórico (Auto-Blindaje). No se pudo aplicar: no hay datos.**
  `doc/sdd/_INDEX.md` lista 003 (ésta, en curso) y dos entradas históricas (001, 002) cuyas carpetas
  **no están en el árbol** — `ls doc/sdd/` devuelve sólo `003-…`. Por lo tanto no existe ningún
  `auto-blindaje.md` que leer y **no hay patrón de error recurrente que heredar**. Lo más cercano que
  sí existe y sí se aplicó es `doc/mutation-run.md:9-15`, que documenta el error que este repo cometió
  **dos veces** (correr la suite contra un binario que no corresponde al fuente) — de ahí viene CD-11
  y de ahí viene que este SDD haya verificado los md5 de restauración en §2.6 en vez de prometerla.

---

## 7. Exemplars verificados

Todos confirmados con `Read` sobre el archivo, en este orden de fase. Ninguno es de memoria.

| Qué copiar | Dónde está | Qué tiene que salir de ahí |
|---|---|---|
| Cuenta de índice sembrada + `bump` de la cuenta | `programs/escrow/src/lib.rs:725-730` (`DeregisterEscrow`) | la forma exacta `seeds = [b"escrow-index", sender.key().as_ref()], bump = escrow_index.bump` |
| El `retain` | `programs/escrow/src/lib.rs:368` | `entries.retain(\|e\| *e != remittance_id)` — misma expresión, sin variantes |
| Cuenta nueva de `close` documentada con `///` | `programs/escrow/src/lib.rs:674-684` (`sender_ata`) | el precedente de DT-12, verificado además en el IDL construido |
| Helper `close` de una suite | `tests/escrow-window.ts:270-287` | el que hay que extender con el parámetro del índice |
| `close` inline sin helper | `tests/escrow.ts:504-517` y `:541-554` | los dos call sites de esa suite |
| `expectRevert` que pinnea el código exacto | `tests/escrow-index.ts:328-350` | AC-4 y AC-6 tienen que usar éste, no un "tira algo" |
| Derivación de la PDA del índice | `tests/escrow-index.ts:176-182` (`indexPda`) | la usan AC-1, AC-3, AC-4, AC-6, AC-7 |
| Aserción contra el IDL **construido** | `tests/escrow-index.ts:27` (import directo, sin `existsSync`) y el test 4a | AC-8 se escribe así |
| Medición de CU | `tests/escrow-index.ts:732-772` (T11) y su nota `:725-731` | el test de CU de `close`, incluida la advertencia de que el número no es constante |
| `bumpSlot()` para txs de forma idéntica | `tests/escrow-index.ts:309-312` | AC-3 hace 33 ciclos; si dos txs quedaran idénticas, bankrun las deduplica |
| Formato de la tabla de mutantes | `doc/mutation-run.md:17-31` y "How to repeat it" (final del archivo) | W4 apendiza con ese formato y ese protocolo |

**Verificado y hay que decirlo:** `AC-3` del test de hash de `chaski-v3`
(`contracts/idl/escrow-idl.hash.test.ts:32-36`) lee
`path.resolve(process.cwd(), "../solana-programs/target/idl/escrow.json")`. En este workspace
`solana-programs` **es** hermano de `chaski-v3`, así que ese test **no** se salta: va a leer el IDL
nuevo y ponerse rojo en cuanto W1 buildee. Es esperado (el work-item lo lista) y **no se arregla acá**
(CD-2). Lo que importa es que no sorprenda a nadie en W3.

---

## 8. Waves

Las del work-item, con dos ajustes justificados: se mueve la medición de CU de W2 a W3 (ya no es una
incógnita, es un test con guarda de regresión) y W1 absorbe la actualización de los helpers de test,
porque sin eso la suite queda con 7 rojos que no son del fix y W2 arrancaría sobre ruido.

| Wave | Qué | Archivos | Sale con |
|---|---|---|---|
| **W0** | Los tests en ROJO primero, contra el binario de HOY. El ciclo de 33 (AC-3) y la fuga básica register→release→close (AC-1). Se registra la salida roja literal, con el código de error. **No se toca `lib.rs`.** | `tests/escrow-index.ts` | Evidencia de CD-10 |
| **W1** | `struct Close` suma `escrow_index` opcional **al final** (DT-9/DT-10/DT-11/DT-12); el handler hace el `retain` (DT-13). `anchor build`. Se actualizan los helpers de `close` de las tres suites a `escrowIndex: null` por defecto (DT-14). | `programs/escrow/src/lib.rs:298-336`, `:644-687`; `tests/escrow.ts:504-517,541-554`; `tests/escrow-window.ts:270-287` | AC-1, AC-2, AC-3 pasan a verde; los 7 rojos de §6.2 vuelven a verde |
| **W2** | Adversariales: índice de la víctima (AC-4), estado no terminal (AC-6), id ausente (AC-7), sin índice nunca creado (AC-2), tokens sin moverse (AC-5), y el test del **footgun** de CD-14. | `tests/escrow-index.ts` | AC-2, AC-4, AC-5, AC-6, AC-7 |
| **W3** | No-regresión de interfaz: aserción contra el IDL **construido** (AC-8, incluidos los 6 discriminadores y `close.accounts[6].name`), medición de CU de `close` con guarda de regresión, y corrida **en modo lectura** de los tests de pin de los dos consumidores (AC-9). | `tests/escrow-index.ts`; lectura de `chaski-v3/`, `wasiai-facilitator/` | AC-8, AC-9, CD-15 |
| **W4** | Mutación: 5 mutantes contra el `retain` nuevo y contra el guard de seeds; se registra qué test mata a cada uno. Rebuild y restauración del artefacto, con verificación de md5 (CD-11). | `doc/mutation-run.md` | CD-8 |
| **W5** | Documentación: `README.md` (Known limitations `:607-623`, invariantes 9 `:453-459` y 11 `:468-473`, tabla de Instructions `:285`, sección de recuperación `:244-276`, "no safe deployment order" `:987-1002`) y los comentarios `//` de `lib.rs:377-396` y `:411-412`, que hoy describen el defecto. Registrar el sha256 nuevo **sin re-pinnear a nadie** (CD-17). | `README.md`, `programs/escrow/src/lib.rs` | Entregable final |

Secuenciales. **W0 no se puede saltar** y no se puede escribir después: es lo único que distingue
"arreglé el bug" de "escribí un test que pasa".

### 8.1 El radio de impacto de W1, medido

Con el fix puesto y **sin** tocar los helpers, la suite quedó en **36 passing, 7 failing**:

```
1) escrow.ts        — 7. close while Deposited reverts (EscrowNotTerminal) — AC-8
2) escrow.ts        — 8. close after release returns rent + vault to sender ... (anti-revival)
3) escrow-window.ts — D1.  dust donated to the vault after the release ...
4) escrow-window.ts — D1b. the same holds after a refund ...
5) escrow-window.ts — D2.  a LIVE escrow cannot be closed ...
6) escrow-window.ts — E2.  an account already sitting on chain as Released is still closable
7) escrow-window.ts — E3.  an account already sitting on chain as Refunded is still closable too
```

Seis de los siete fallan con
`AnchorError caused by account: escrow_index. Error Code: AccountNotInitialized. Error Number: 3012`.
El séptimo (D2) falla distinto y es el más informativo:

```
AssertionError: expected 'AccountNotInitialized' to equal 'EscrowNotTerminal'
   at expectRevert (tests/escrow-window.ts:318:43)
```

D2 seguía reventando, pero **por el motivo equivocado**. Si `expectRevert` de esta suite no pinneara
el código exacto, D2 habría quedado **verde con el guard enmascarado**. Es la convención del repo
(`.nexus/project-context.md`, "todo test de revert pinnea el código exacto") atrapando exactamente el
caso para el que existe, y vale la pena que el Dev lo sepa antes de tocar nada.

Ninguno de los 7 es un defecto del diseño: los 7 se arreglan pasando `escrowIndex: null` (DT-14).
Ningún test de `deposit`, `release`, `refund`, `register_escrow` ni `deregister_escrow` se movió, lo
que es la comprobación de runtime de CD-5.

---

## 9. Plan de tests — al menos uno por AC, con archivo y forma de refutación

`escrow-index.ts` es el archivo por defecto de todo lo nuevo: es donde vive el índice y donde están
los helpers (`indexPda`, `expectRevert`, `bumpSlot`). Numeración sugerida: los tests nuevos siguen
después del 11 actual.

| AC | Test | Archivo | Qué asserta, y con qué input se refuta |
|---|---|---|---|
| **AC-1** | `12. close saca exactamente la entrada del escrow que cierra y deja el resto en orden` | `tests/escrow-index.ts` | registrar A y B en ese orden, releasear A, cerrar A con el índice. `entries` tiene que quedar **exactamente `[B]`**. Falla si queda `[A,B]`, `[]` o `[B,A]`. Comprobado en el spike (S1) |
| **AC-2** | `13. close sin índice: escrowIndex=null, la tx confirma y NO se crea la cuenta` | `tests/escrow-index.ts` | `deposit → release → close(escrowIndex: null)` **sin llamar nunca a `register_escrow`**. Dos aserciones: la tx confirma, y `getAccount(indexPda(sender))` sigue `null` después. Falla con 3012 si la cuenta fuese obligatoria; falla también si la cuenta existe después (habría cobrado 4.774.560 lamports). Spike: S2 |
| **AC-2 (bis, CD-14)** | `13b. omitir la clave NO omite la cuenta: el cliente resuelve la PDA y la tx revierte 3012` | `tests/escrow-index.ts` | armar `close` **sin** la clave `escrowIndex`, asertar que `ix.keys[6]` **es la PDA del índice y no el program id**, y que la tx revierte con `AccountNotInitialized`. Es el único test que documenta el footgun de DT-9 de forma ejecutable; sin él la regla vive sólo en prosa. Spike: S3 |
| **AC-3** | `14. 33 ciclos deposit→register→release→close con el MISMO sender` | `tests/escrow-index.ts` | 33 ciclos completos; el `register_escrow` nº 33 tiene que confirmar y `entries.length ≤ 1` al final de **cada** ciclo. **Este test se escribe en W0 y se registra en ROJO** contra el binario actual (hoy revienta con `EscrowIndexFull`/6005 en el 33º). Ojo con `bumpSlot()`: los ids son distintos por ciclo, así que las firmas difieren, pero si el Dev reusa un id tiene que avanzar el slot. Spike: S7, verde con el fix |
| **AC-4** | `15. close con el índice de la VÍCTIMA revierte ConstraintSeeds y no lo toca` | `tests/escrow-index.ts` | el atacante cierra un escrow **propio** y terminal pasando la PDA de índice del sender. Tiene que revertir con `ConstraintSeeds` exacto (vía `expectRevert`, no "tira algo") **y** el índice de la víctima tiene que quedar idéntico entrada por entrada. Espejo de 4c. Spike: S4 |
| **AC-5** | los D1/D1b de `escrow-window.ts` quedan **sin tocar una aserción**, sólo el helper | `tests/escrow-window.ts` | con N unidades en el vault al momento del `close`, `sender_ata` crece exactamente N, el beneficiary no se mueve, el vault queda cerrado. La regla: en W1 se cambia **la lista de cuentas del helper y nada más**. Si alguien necesita relajar una aserción de D1/D1b, eso es un hallazgo, no un ajuste |
| **AC-5 (bis)** | `16. close con índice no mueve ni un token de más` | `tests/escrow-index.ts` | mismo escenario que AC-1 pero midiendo los cuatro balances (vault A, vault B, senderAta, beneficiaryAta) antes y después. Espejo de lo que ya hace el test 7 para `deregister_escrow` (`:640-654`) |
| **AC-6** | `17. close en estado Deposited revierte EscrowNotTerminal y el índice queda intacto` | `tests/escrow-index.ts` | `deposit → register_escrow → close(con índice)` antes del deadline. **Dos** aserciones obligatorias: código `EscrowNotTerminal` (6004) **y** `entries === [id]` después. La segunda es la que detecta que alguien mueva el `retain` a un lugar donde corra antes del constraint. Spike: S5 |
| **AC-7** | `18. close con un índice que no contiene el id confirma y deja entries igual` | `tests/escrow-index.ts` | `deposit(A) → deposit(B) → register(B) → release(A) → close(A, índice)`. La tx tiene que **confirmar** (no revertir) y `entries` seguir `[B]`. Si revierte, es una regresión respecto de la idempotencia que `retain` ya garantiza. Spike: S6 |
| **AC-8** | `19. el IDL construido declara 6 instrucciones, los 6 discriminadores de siempre, y escrow_index en close` | `tests/escrow-index.ts` | contra `target/idl/escrow.json` importado directo (nunca contra el fuente, nunca con `existsSync`): (i) `instructions.length === 6` y los 6 nombres; (ii) los 6 discriminadores, con `close` en `[98,165,201,177,108,65,206,96]`; (iii) `close.accounts.map(a=>a.name)` termina en `token_program, escrow_index` (CD-15) y ese último tiene `optional === true`. Falla si aparece una 7ª instrucción |
| **AC-9** | `20. las otras 5 instrucciones conservan cuentas, args y discriminador` | `tests/escrow-index.ts` | pin local por posición de `deposit` (8 cuentas), `release` (8), `refund` (7), `register_escrow` (4), `deregister_escrow` (2), con sus discriminadores. **Pinnearlo acá y no sólo en los consumidores**: hoy AC-9 depende de correr tests de otros dos repos, y un test que necesita otro repo montado es un test que se salta solo el día que no lo esté |
| **AC-9 (bis)** | corrida en modo LECTURA de los dos tests de pin de los consumidores | `chaski-v3/contracts/idl/escrow-idl.hash.test.ts`, `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts` | **se corren, no se editan** (CD-2). Resultado esperado y ya predicho: rojo **sólo** en el `expect` de la constante del hash (y en `chaski-v3` también su AC-3 sibling, §7); verde en todos los pins de listas de cuentas y de discriminadores. Cualquier otro rojo es un hallazgo |
| **CU** | `21. computeUnitsConsumed de close, con índice y sin índice` | `tests/escrow-index.ts` | reporta los dos números por consola y asserta `< CU_REGRESSION_GUARD` (300.000, la constante que ya existe en `:47`). **Tiene que llevar el mismo tipo de nota que T11 (`:725-731`): el número NO es constante**, se mueve 1.500 CU por paso del bump canónico. Referencia de F2: peor observado 28.643 CU en 16 senders |

**Regla que atraviesa todos:** cada test de revert usa el `expectRevert` de `:328-350`, que pinnea el
código exacto. §8.1 muestra por qué: D2 seguía reventando por el motivo equivocado y sólo el pin del
código lo delató.

---

## 10. Plan de mutación (CD-8)

Formato y protocolo: los de `doc/mutation-run.md`. Numeración a partir de **M15**. El protocolo del
final de ese archivo es obligatorio y no negociable: romper → `anchor build` → suite → restaurar →
**`anchor build` otra vez** → suite (tiene que volver al baseline). Este repo ya se comió dos veces
saltarse el segundo build (`doc/mutation-run.md:9-15`). Recomendación de F2, aprendida en §2.6:
guardar el md5 de `target/deploy/escrow.so` y de `target/idl/escrow.json` antes de empezar y
**verificar que vuelven** al final, en vez de asumirlo.

| # | Mutante | Qué rompe | Test que lo tiene que matar |
|---|---|---|---|
| **M15** | `close`: el `retain` borrado (cuerpo del `if let Some` vacío) | el fix entero: vuelve el bug original | AC-1 (`12`, `entries` queda `[A,B]` en vez de `[B]`) **y** AC-3 (`14`, el 33º vuelve a `EscrowIndexFull`) |
| **M16** | `close`: `retain(\|e\| *e != remittance_id)` → `retain(\|e\| *e == remittance_id)` | **borra la entrada equivocada**: conserva sólo la que había que sacar | AC-1 (`entries` queda `[A]` en vez de `[B]`) |
| **M17** | `close`: el `retain` → `entries.clear()` | borra TODAS las entradas del sender, no la del escrow que cierra | AC-1 (`entries` queda `[]` en vez de `[B]`) **y** AC-7 (`18`, el índice de B se vacía) |
| **M18** | `close`: `if let Some(index) = …` → `let index = ctx.accounts.escrow_index.as_mut().unwrap()` | rompe la opcionalidad: panic cuando la cuenta se omite | AC-2 (`13`, `deposit→release→close(null)` deja de confirmar) |
| **M19** | `Close`: se le sacan `seeds` y `bump` a la cuenta `escrow_index` | mata el guard de ownership: el atacante puede pasar el índice de cualquiera | AC-4 (`15`, deja de revertir con `ConstraintSeeds` y el índice de la víctima se modifica) |

**M16 y M19 son los dos que importan de verdad**, y por motivos opuestos: M16 es el bug silencioso
(la tx confirma, la contabilidad queda mal) y M19 es el agujero de seguridad (la tx confirma, la
contabilidad de otro queda mal). Un test que sólo mire "el close confirmó" no mata a ninguno de los
dos. Por eso AC-1 y AC-4 aserten el **contenido** de `entries` y no sólo el éxito.

**Advertencia sobre mutantes equivalentes**, con el precedente de M12 en el mismo archivo: si un
mutante propuesto sobrevive, hay que decidir si es un hueco de cobertura o si es una expresión
equivalente, y **escribirlo con el argumento**. Registrar un `SURVIVED` sin explicación es peor que
no correrlo, porque parece cobertura.

---

## 11. Riesgos y lo que NO se pudo verificar

Escrito para que se pueda comprobar, no para cubrirme.

1. **El sha256 final del IDL no está medido, y no puede estarlo en F2.** El del spike es
   `cedfddd46bdc77669b4a46fc2636e9c345995fac9bf554b0929bc40b7ad7e1ea`, pero se midió **sin** el `///`
   de DT-12. El texto de ese doc comment se escribe en W1 y viaja al IDL. El hash final sale de W5.
   CD-17 prohíbe afirmarlo antes. **Lo que sí está medido y no se mueve:** el discriminador de
   `close`, las 6 instrucciones, y las listas de cuentas de las otras cinco.
2. **El costo marginal exacto del índice dentro de `close` no quedó aislado** (§3.4). Lo que hay es
   una cota sucia (953…6.970 CU) que compara escrows distintos. El test 21 de W3 lo va a reportar
   sobre el binario final. No es bloqueante: el peor `close` completo observado (30.154 CU) está a
   15 % del límite por defecto de 200.000.
3. **No se corrieron las suites de `chaski-v3` ni de `wasiai-facilitator`.** La predicción de §4.3 y
   §7 (rojo sólo en el `expect` de la constante del hash y en el AC-3 sibling de `chaski-v3`) sale de
   **leer** esos tests, no de correrlos. W3 los corre y ahí se confirma o se cae. Si aparece un rojo
   en un pin de lista de cuentas o de discriminador, eso contradice §2.3 y hay que parar.
4. **No hay Auto-Blindaje histórico que heredar** (CD-18). Las carpetas 001 y 002 no están en el
   árbol. Si aparecen (en el historial de git o en otro worktree), habría que releerlas antes de AR.
5. **[TBD heredado] Las entradas ya presentes en índices vivos de devnet.** El
   work-item se apoya en `README.md:104-105` para decir que hoy no hay ninguna cuenta `EscrowIndex`
   en devnet. **No lo comprobé contra la cadena**, y no puedo: CD-1 prohíbe tocar devnet, y aunque una
   lectura no sería una escritura, la afirmación queda sin verificar en esta fase. No es bloqueante
   para esta HU (nada de lo que se entrega acá toca devnet); **es un insumo de la HU de deploy**, que
   tiene que correr `scripts/list-live-escrows.py` antes de desplegar y decidir si limpia con
   `deregister_escrow`. Dueño: la HU de deploy.
6. **[TBD heredado] Los identificadores de las otras dos HUs de la cola** (congelar el reembolso,
   emitir eventos) siguen sin darse. Se referencian por descripción y por `README.md:481-508`.
   No bloquea nada de F2.5 ni de F3: DT-6 sólo condiciona el **deploy**, que está fuera de alcance.
   Dueño: el orquestador, al abrir la HU de deploy.
7. **El `rustc` del entorno de este spike es 1.97.1, no el 1.89.0 que pinnea `rust-toolchain.toml`.**
   `anchor build` funcionó y el artefacto salió **byte-idéntico** al que ya estaba en `target/`
   (§2.2), así que para lo que se midió acá da igual. Pero el drift existe y es exactamente el tipo
   de cosa que `verified-build.yml` está para atrapar. **No se investigó** si `rust-toolchain.toml`
   se está respetando o si el archivo quedó atrás. Es ajeno a WKH-326; se reporta al humano.

**Cero `[NEEDS CLARIFICATION]` abiertos.** Los dos bloqueantes de F1 están resueltos con medición
(§2, §3), el grep está corrido y transcripto (§4), y los TBD que quedan tienen dueño y forma de
resolución.

---

## 12. Readiness Check

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 1 | Bloqueante 1 (cuenta opcional) resuelto **empíricamente** | ✅ | §2.3 fragmento real del IDL; §2.4 salida real del builder 0.30.1; §2.5 8/8 en bankrun |
| 2 | Bloqueante 2 (seeds y bump) resuelto **con el número** | ✅ | §3.2, 16 senders deterministas, fórmula `(255−bump)×1500−20` cumplida en las 16 filas |
| 3 | Grep de consumidores re-corrido, salida cruda en el SDD | ✅ | §4.1, §4.2 |
| 4 | DT-1 revisado a la luz del grep | ✅ **SIGUE EN PIE** | §4.3: cero builders de `close` en los 4 repos |
| 5 | Excepción de CD-6 decidida explícitamente | ✅ **`///` sí**, sólo para esa cuenta | DT-12, con el precedente de `sender_ata` verificado en el IDL construido |
| 6 | Al menos un test por AC, con archivo | ✅ 9/9 + 4 extra | §9 |
| 7 | Plan de mutación con mutante y matador (CD-8) | ✅ M15..M19 | §10 |
| 8 | W0 intacta y primera | ✅ | §8; AC-3 se escribe y se registra en rojo antes de tocar `lib.rs` |
| 9 | Exemplars verificados con Read, no de memoria | ✅ | §7, todos con archivo:línea |
| 10 | Radio de impacto sobre la suite existente, medido | ✅ 7 tests, listados por nombre | §8.1 |
| 11 | Ningún deploy, ninguna tx de escritura contra devnet | ✅ | sólo `anchor build` y bankrun local |
| 12 | Ningún archivo de los otros 4 repos escrito | ✅ | sólo lectura; `git status` de `solana-programs` limpio salvo `.nexus/` y `doc/sdd/` |
| 13 | Árbol restaurado tras el spike, verificado | ✅ | §2.6, 4 md5 idénticos + 43 passing |
| 14 | Cero `[NEEDS CLARIFICATION]` sin resolver | ✅ | §11: los TBD que quedan tienen dueño |
| 15 | Auto-Blindaje histórico leído | ⚠️ **no hay datos** | §6.2 CD-18: no existe `auto-blindaje.md` en el árbol |

**Veredicto: el SDD está listo para `SPEC_APPROVED`.** Las dos incógnitas que F1 dejó abiertas están
cerradas con evidencia reproducible, no con una lectura de documentación, y el camino elegido está
comprobado corriendo: el ciclo de 33 pasa en verde con el fix puesto y los 7 tests que el cambio
rompe están identificados por nombre antes de que el Dev los vea.
