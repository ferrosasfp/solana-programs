# Story File — WKH-343: el depósito acepta un destinatario que no puede recibir el token

> SDD: `doc/sdd/004-wkh-343-deposito-destinatario-sin-cuenta-token/sdd.md` (SPEC_APPROVED 2026-08-10)
> Fecha: 2026-08-10
> Branch: `feat/004-wkh-343-deposito-destinatario-sin-cuenta-token`
> Worktree: `/home/ferdev/.openclaw/workspace/wt-wkh343`
> Árbol base: `main` @ `8fca47294f6cd8e7ecefd330e278e63078957e26`
> Repo: `solana-programs` (programa Anchor `escrow`, devnet)

---

## 0. Leé esto primero (3 minutos, y te ahorra dos rondas)

**Vos leés SOLO este documento.** Si algo no está acá, **PARÁ y escalá al Architect**. No inventes,
no asumas, no "mejores" lo de al lado.

Cinco reglas que gobiernan todo lo que escribas en esta HU:

1. **Todo número medido va con su slot o su commit en la misma línea.** Si escribís "hay N escrows"
   sin slot, está mal. Sin excepción.
2. **Nunca escribas "elimina", "cierra" o "ya no puede pasar" sin nombrar el mutante de UNA línea que
   restauraría el comportamiento viejo.** Si podés nombrarlo, la frase no puede decir "elimina":
   decí qué **acota** y qué **reinicia** ese límite. §11 tiene la lista para esta HU.
3. **Verificá los `archivo:línea` con `python3` o Read, NUNCA con `cat -n`.** El proxy de este
   entorno corrompe la salida redirigida y ya corrió cuatro citas de otro architect esta noche. En
   §12 hay un verificador listo para copiar.
4. **Distinguí MEDIDO de DERIVADO.** Hay dos afirmaciones centrales de esta HU que son derivadas
   (§1.3 y §9.4). No las escribas como observadas hasta que un test las mida.
5. **`git status --porcelain` completo para probar "no toqué X".** Nunca con `| head` ni `| wc -l`:
   el wrapper colapsa la salida y se lee "limpio" sobre un árbol sucio.

---

## 1. Goal — qué construís y por qué

La instrucción `deposit` graba un `beneficiary: Pubkey` **sin verificar que exista su cuenta de token
para el mint del escrow** (`programs/escrow/src/lib.rs:138`, `:167`). Después `release` **sí** la
exige y **no** la crea (`lib.rs:614-619`: la cuenta está declarada con `associated_token::` y sin
`init`). Resultado: un depósito puede entrar y quedar sin ningún camino de entrega.

Construís el guard que falta: **`deposit` pasa a exigir la MISMA cuenta que `release` va a exigir**,
así que un depósito que no se va a poder liquidar se rechaza antes de mover un solo token.

### 1.1 El dato que gobierna el diseño (medido, no supuesto)

Medido contra devnet el 2026-08-10, sólo lectura:

- **Slot `482578481`:** 10 cuentas `EscrowState`. Las **10** comparten el mismo beneficiario
  `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` y la misma authority
  `9rphjeRUekSbVpDZhzN9roQQmn6yndodRVfiBvyEAGAV`.
- **Slot `482578601`:** ese beneficiario tiene **1** token account para nuestro mint de prueba
  `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q`, con **12.500.000 raw** — que es exactamente la suma
  de los 3 escrows `Released` (500.000 + 2.000.000 + 10.000.000). Y **0** token accounts para el mint
  de Circle `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- **Slot `482579152`:** los 4 escrows que estaban trabados (sobre el mint de Circle) tenían
  **exactamente una transacción cada uno, el `Deposit`**, en los slots 481455889 / 481983586 /
  482045575 / 482396033. Cuatro depósitos en cinco días, el último el 2026-08-09.

⇒ **El beneficiario NO es inválido: cobró tres veces.** Lo que falla es la relación entre el mint del
depósito y las cuentas que ese beneficiario tiene abiertas.

### 1.2 ⚠️ Lo que este dato NO prueba, y no lo comprimas

**El mint y el sender co-varían perfectamente**: las 6 filas del mint nuestro son del sender
`8tJVcM2Jeh…` y las 4 del mint de Circle son del sender `4AvAjtPg1…`. Con n=10 y esa confusión, **los
datos NO separan "es el mint" de "es qué build de cliente hizo el depósito"**.

> **No escribas "está medido que el problema es el mint".** No lo está. Lo que está medido es que el
> **beneficiario** no puede explicarlo, porque es byte a byte el mismo en las 10 filas, incluidas las
> 3 que cobraron.

Esta distinción se comprime sola a "es el mint" en cada resumen que alguien escriba. **Tiene que
sobrevivir a esta HU.**

### 1.3 ⚠️ El `AccountNotInitialized (3012)` es DERIVADO, no observado

Vas a leer en varios lados que "`release` explota con `AccountNotInitialized (3012)`". **Nunca se
observó en cadena**: los 4 escrows tenían una sola tx cada uno y ninguna era un `release` (§1.1).

La derivación es sólida — `lib.rs:614-619` (la cuenta se exige y no se crea) +
`anchor-lang` 1.1.2 `src/accounts/account.rs:313-316` (una cuenta inexistente da `AccountNotInitialized`)
+ la medición de que la cuenta no existe — **pero hasta que T15 corra, escribilo como derivado.**
**T15 es el test que lo vuelve medido.**

---

## 2. Acceptance Criteria (copiados del SDD aprobado — QA los verifica en F4)

- **AC-1:** IF el beneficiario grabado en un `deposit` no tiene, al momento en que correspondería
  `release`, una cuenta de token asociada para el mint del escrow, THEN el sistema SHALL garantizar
  que la entrega no dependa de una devolución manual del sender como único camino.
- **AC-2:** WHEN se corre `anchor test --skip-build --skip-deploy --skip-local-validator`, el sistema
  SHALL mantener los tests vigentes en verde, **sin ninguno saltado ni desactivado**.
- **AC-3:** WHERE `scripts/list-live-escrows.py` describe qué instrucción puede vaciar un escrow
  bloqueante, el sistema SHALL reflejar que, tras el deploy de WKH-326 (slot `481495859`,
  2026-08-05), `release` sobre esos escrows revierte, y SHALL retirar la recomendación de liberarlos
  apoyada en el supuesto vencido.
- **AC-4:** WHEN una afirmación de este repo describe un saldo, una cuenta, un estado on-chain o qué
  binario está desplegado, el sistema SHALL acompañarla de la fecha **y el slot** en que se midió, o
  SHALL derivarla de un script en vez de escribirse a mano.
- **AC-5:** IF esta HU modifica `programs/escrow/src/lib.rs`, THEN el sistema SHALL actualizar la
  fila "Source vs deployed" de `README.md:25` para que deje de afirmar que coinciden byte a byte,
  **sin implicar que se hizo un deploy** mientras el deploy no se haya hecho.
- **AC-6:** WHILE la medición de cuántos escrows comparten destinatario siga sin cerrarse, el sistema
  SHALL dejar constancia de que la opción elegida fue validada contra ese dato antes de
  implementarse. **Ya cumplido en el SDD §3.7** — no tenés que hacer nada, sólo no romperlo.

---

## 3. Las tres decisiones que ya están tomadas, y por qué NO las revises

Están cerradas. Se escriben acá para que ninguna revisión futura las "simplifique".

### 3.1 ⛔ NO uses `init_if_needed` sobre `beneficiary_ata`. Nunca. En ninguna instrucción

Es la opción que va a parecer más simple y es la peor de todas. El argumento decisivo:

> Con `init_if_needed`, los 4 depósitos trabados se habrían **liberado** en su momento. El estado
> habría pasado a `Released`, que es **terminal** (`lib.rs:451-453`). Y `refund` exige
> `status == Deposited` (`lib.rs:246-249`). Así que los 4 refunds que el founder ejecutó el
> 2026-08-10 (slots `482579398`, `482579872`, `482579957`, `482580179`, los cuatro `err: None`)
> **habrían revertido con `EscrowNotDeposited` (6002)**.
>
> **`init_if_needed` no arregla el defecto: le saca la salida.**

Y además: habría creado una ATA del USDC de Circle en un beneficiario sin provisioning para ese
token, completando un pago del activo equivocado de forma irreversible. Está prohibido por **CD-8**.

### 3.2 ⛔ NO claves el mint en el programa (`address = <const>` sobre `mint`)

Suena a "arreglar la causa raíz" y no previene nada:

- Los 4 depósitos trabados estaban **sobre el mint de Circle**. Si el mint pretendido es el de
  Circle, clavarlo **los habría aceptado a los 4** — poder preventivo cero.
- Si el mint pretendido es el nuestro, clavarlo los rechaza **y también rechaza el token que el
  producto quiere usar**.

⇒ Clavar el mint **o no previene, o rompe el producto**. El invariante que se violó no es
`mint == X`: es **"el mint es consistente con un beneficiario que puede recibirlo"**. Eso es
**relacional**, y una constante global no lo expresa.

Además: `lib.rs:530-546` documenta por qué el mint no está clavado, y `lib.rs:536-540` escribe la
condición exacta que daría vuelta esa decisión — un barrido que tome depósitos por buenos sin
co-firma. **Ese barrido no existe.** Validar el mint aguas arriba vive en `wasiai-facilitator`, que
está **fuera de scope** (CD-7).

### 3.3 ✅ La cuenta va AL FINAL de la struct, después de `system_program`

Rompe la convención de "los programas van últimos" **a propósito**, y el motivo es el orden de
despliegue. Leído del generador de Anchor:

- `anchor-syn` 1.1.2 `src/codegen/accounts/try_accounts.rs:48,64` — el único error de conteo que
  Anchor genera es por cuentas **de menos** (`AccountNotEnoughKeys`).
- `anchor-lang` 1.1.2 `src/context.rs:68` — las cuentas de sobra van a `remaining_accounts`.

| Posición de `beneficiary_ata` | Cliente nuevo + programa viejo | Cliente viejo + programa nuevo |
|---|---|---|
| Insertada después de `sender_ata` | **Falla**: el programa viejo lee la cuenta 6 como `token_program` | Falla (cuenta de menos) |
| **Al final** ✅ | **Funciona**: le queda en `remaining_accounts` y `Deposit` no las mira | Falla (cuenta de menos) |

⇒ Al final, el orden **cliente primero, programa después** no tiene ventana de falla.

---

## 4. Files to Modify/Create

⚠️ **Esta tabla es el Scope IN completo.** Tocar cualquier otro archivo requiere escalar.

| # | Archivo | Acción | Qué hacer | Wave | Exemplar |
|---|---|---|---|---|---|
| 1 | `tests/escrow.ts` | Modificar | 6 tests nuevos (T10..T15) + 3 helpers parametrizados + 1 helper nuevo | W1 | E-3, E-4 |
| 2 | `programs/escrow/src/lib.rs` | Modificar | La cuenta `beneficiary_ata` en `Deposit` + `#[instruction(...)]` + 2 doc comments | W2 | E-1, E-2 |
| 3 | `tests/escrow-index.ts` | Modificar | **Sólo si W2.3 lo exige**: agregar `beneficiaryAta` a 2 builders de `deposit` | W2 | §7.4 |
| 4 | `tests/escrow-window.ts` | Modificar | **Sólo si W2.3 lo exige**: agregar `beneficiaryAta` a 1 builder de `deposit` | W2 | §7.4 |
| 5 | `scripts/list-live-escrows.py` | Modificar | Chequeo nuevo de la ATA del beneficiario + sacar el eje "antes/después del upgrade" + `--markdown` | W3 | E-5 |
| 6 | `SECURITY.md` | Modificar | `:91-92` (el mint) — **prioridad 1 de W4** — y `:99-105` (AC-5) y `:106` (el literal 55) | W4 | — |
| 7 | `README.md` | Modificar | 7 sitios de prosa + el literal `55` en 3 sitios | W4 | — |
| 8 | `doc/publish-idl-onchain.md` | Modificar | `:43-51` ("Current state, as read from devnet") | W4 | — |
| 9 | `.nexus/project-context.md` | Modificar | `:63` (cita rota a `README.md:769`) y `:145` (literal `55`) | W4 | — |
| 10 | `doc/mutation-run.md` | Modificar | Sección nueva M20..M24 + la cuarta baseline | W5 | E-6 |
| 11 | `doc/sdd/004-.../idl-hash.md` | **Crear** | El sha256 canónico nuevo y por qué vive sólo acá | W0.3 | `doc/sdd/003-.../idl-hash.md` |
| 12 | `doc/sdd/004-.../runbook-deploy.md` | **Crear** | El upgrade paso por paso, con su gate. **Se escribe, NO se ejecuta** | W4 | `README.md:966-1000` |
| 13 | `doc/sdd/004-.../w0-baseline.txt`, `w0-spike-form-a.txt`, `w1-red.txt`, `w3-output.txt`, `w5/M*-summary.txt` | **Crear** | Evidencia cruda, cada una con la cabecera de §10 | W0,W1,W3,W5 | `doc/sdd/003-.../w4/` |

---

## 5. Exemplars (fragmentos reales, verificados con Read el 2026-08-10 contra `8fca472`)

### E-1 — La cuenta que tenés que copiar: `Release.beneficiary_ata`
**Archivo:** `programs/escrow/src/lib.rs:614-619`

```rust
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = beneficiary
    )]
    pub beneficiary_ata: Account<'info, TokenAccount>,
```

**Patrón clave, y la parte que importa:** `associated_token::` (no `token::`), **sin `init`**. Ésta es
literalmente la cuenta que `release` exige. Si `deposit` valida **otra cosa**, el guard no predice
nada y el AC-1 no se cumple.

**El contraste que tenés que ver, en el mismo archivo** — `Deposit.sender_ata`,
`programs/escrow/src/lib.rs:571-576`:

```rust
    #[account(
        mut,
        token::mint = mint,
        token::authority = sender
    )]
    pub sender_ata: Account<'info, TokenAccount>,
```

Ese usa `token::` — acepta **cualquier** token account del sender con ese mint, no necesariamente la
ATA canónica. **NO copies este patrón para `beneficiary_ata`** (CD-6): aceptaría depósitos que
`release` después rechazaría. Es el mutante M23 de §11.

### E-2 — Cómo se comenta un cambio en este archivo
**Archivo:** `programs/escrow/src/lib.rs:386-410` (bloque `//` sobre `MAX_ENTRIES`)

**Patrón clave:** los `///` y `//!` **viajan al IDL** y le mueven el sha256 canónico; los `//` no.
Cuando el repo quiso corregir un doc comment sin mover el hash, escribió un bloque `//` adyacente en
vez de editar el `///`. Fijate la estructura: qué dice de más, qué cambió, y **qué sigue en pie con
un input concreto que lo refutaría**.

En esta HU el hash **se mueve igual** (agregás una cuenta), así que la regla es distinta y está en
§7.2: corregís el doc comment que **esta HU** vuelve falso, y ninguno más.

### E-3 — El test de revert
**Archivo:** `tests/escrow.ts:326-351` (test 2)

```ts
  it("2. release signed by a non-authority reverts (ConstraintHasOne); vault untouched", async () => {
    const id = rid(2);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);

    await expectRevert(
      program.methods
        .release(Array.from(id))
        .accountsPartial({ /* ... */ })
        .signers([attacker])
        .rpc(),
      "ConstraintHasOne"
    );

    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
  });
```

**Patrón clave:** (1) el código de Anchor se pinnea **por nombre**, nunca "tira algo"; (2) después
del revert se asertea que **el estado no se movió** (el vault sigue con su saldo). Los dos tienen que
estar en cada test nuevo.

El helper, `tests/escrow.ts:218-239`, tiene doble vía a propósito: `AnchorError` si llega tipado, y
si no, busca la subcadena en `e.logs` + `e.transactionMessage` + `e.message`. **En bankrun no todo
error llega como `AnchorError`** — por eso el fallback existe y por eso tu helper nuevo también lo
necesita (§7.3).

### E-4 — Los helpers del fixture, y por qué están parametrizados así
**Archivo:** `tests/escrow.ts:79-104` (`createMint6`) y `tests/escrow-index.ts:198-200` (`ataOf`)

```ts
  // tests/escrow.ts:79 — YA recibe la authority por parámetro: se puede llamar dos veces
  async function createMint6(mintAuthority: PublicKey): Promise<PublicKey> { /* ... */ }

  // tests/escrow-index.ts:198-200 — el patrón de derivación parametrizada por dueño
  function ataOf(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }
```

**Patrón clave:** `createMint6` ya sirve tal cual para el segundo mint. En cambio `createAta`
(`tests/escrow.ts:106`), `mintTo` (`:124`) y `pdas` (`:146`) **cierran sobre el `mint` de módulo** y
hay que parametrizarlos — con un argumento **opcional al final** (§7.3), para que los 10 call sites
vigentes queden byte a byte iguales.

### E-5 — El script, y de dónde sale la lectura RPC que vas a reusar
**Archivo:** `scripts/list-live-escrows.py:69-83` (`rpc()`) y `:92` (el slot)

```python
def rpc(url: str, method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    req = urllib.request.Request(url, data=body.encode(),
        headers={"Content-Type": "application/json", "User-Agent": "list-live-escrows/1"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.load(resp)
    if "error" in payload:
        raise SystemExit("RPC error from {}: {}".format(url, payload["error"]))
    return payload["result"]

# :92 — el slot, que es lo que hace fechable todo lo que imprime
    return ts, "cluster clock at slot {}".format(slot)
```

**Patrón clave:** **stdlib solamente** (`urllib`, `json`, `struct`, `base64`), sin dependencias, sin
keypair, sin firma. Tu chequeo nuevo usa el mismo `rpc()` con
`getTokenAccountsByOwner`. No agregues `requests`, no agregues `solana-py`.

### E-6 — La tabla de mutantes
**Archivo:** `doc/mutation-run.md:16-38` (M1..M19)

```
| # | Mutant | Result | Tests that died |
|---|--------|--------|-----------------|
| M1 | `release`: status guard deleted | KILLED | `escrow.ts` 5; `escrow-window.ts` C1, C4 |
```

**Patrón clave:** una línea por mutante, y **los tests que murieron por nombre**. Un guard sin
mutante no cuenta como probado en este repo. Y el protocolo (`doc/mutation-run.md:48-52` + `:59`):
md5 de referencia **antes**, y después de restaurar **rebuildear y comparar los tres md5**, nunca
suponerlos.

---

## 6. Anti-Hallucination Checklist (específico de esta HU)

Marcá cada una **antes** de escribir la línea correspondiente. Si alguna falla, **PARÁ y escalá**.

| # | Verificación | Cómo | Si falla |
|---|---|---|---|
| 1 | `Release.beneficiary_ata` está en `lib.rs:614-619` y usa `associated_token::` sin `init` | verificador de §12 | Escalá: el exemplar se movió |
| 2 | `Deposit` NO tiene hoy ninguna cuenta del beneficiario | Read `lib.rs:512-581` | Escalá: alguien ya lo cambió |
| 3 | `Deposit.sender_ata` usa `token::` (no `associated_token::`), en `lib.rs:571-576` | verificador de §12 | Escalá |
| 4 | El enum `ErrorCode` termina en `ReleaseWindowClosed` = 6008 | Read `lib.rs:479-506` | Escalá: los códigos son posicionales, insertar renumera |
| 5 | `EscrowState` tiene **exactamente** 8 campos y el canario de 154 bytes existe | Read `lib.rs:436-447` + `tests/escrow.ts:283-290` | **PARÁ**: tocar el layout rompe toda cuenta viva |
| 6 | `EscrowStatus` tiene **exactamente 3** variantes | Read `lib.rs:449-461` | **PARÁ** |
| 7 | Los 3 md5 de `target/` coinciden con `doc/mutation-run.md:59` **antes** de tocar nada | W0.1 | Rebuildeá antes de seguir (trampa 1) |
| 8 | El canonicalizador de IDL reproduce `bfbdfe5a…` sobre el IDL **sin tocar** | W0.3 | **PARÁ**: si no reproduce un valor conocido, su salida sobre el IDL nuevo no vale nada |
| 9 | No agregaste ninguna dependencia (ni en `Cargo.toml` ni en `package.json` ni en el script) | `git diff` de esos 3 archivos | Revertí |
| 10 | Cada test nuevo pinnea el **nombre** del código de Anchor, no el número | Read tus tests | Corregí (CD-11) |
| 11 | Ningún `it.skip`, `describe.skip`, ni `existsSync + it.skip` | grep en `tests/` | **PARÁ** (CD-15, AC-2) |
| 12 | No escribiste en `chaski-v3`, `wasiai-facilitator`, `wasiai-a2a`, `wasiai-remittance-agents` | `git -C <repo> status --porcelain` **completo** | **PARÁ** (CD-7) |
| 13 | No abriste, listaste ni referenciaste `m5-keys/` | tu propio historial | **PARÁ** (CD-2) |
| 14 | Todo `archivo:línea` que escribas fue verificado con el script de §12 | §12 | Corregí antes de entregar |
| 15 | Ningún número on-chain sin su slot en la misma línea | grep de tu diff | Corregí (CD-5) |

---

## 7. Qué hacer, en detalle

### 7.1 W0 — el gate serial (ANTES de tocar nada)

**W0.1 — baseline.** El worktree **no tiene `target/`**:

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/ferdev/.openclaw/workspace/wt-wkh343
npm ci
anchor build
md5sum target/deploy/escrow.so target/idl/escrow.json programs/escrow/src/lib.rs
anchor test --skip-build --skip-deploy --skip-local-validator
```

Referencia a reproducir (de `doc/mutation-run.md:59`, corrida de WKH-326 sobre el commit `0fdec52`):

| Artefacto | md5 esperado |
|---|---|
| `target/deploy/escrow.so` | `d4b736cf6b9e15421e7cb1d75f3d8e0d` |
| `target/idl/escrow.json` | `c8e10be9a38bd96b4f0e2ebb422c0c28` |
| `programs/escrow/src/lib.rs` | `e21a3f5e7d06ed83869d6a780c6bbe20` |

Suite esperada: **55 passing, 0 failing**. Guardá todo en `w0-baseline.txt` con la cabecera de §10.

⚠️ `anchor build` va a **generar** `target/deploy/escrow-keypair.json` porque el worktree no lo tiene.
**Ese archivo NO es la llave del programa** (el id sale de `declare_id!` en `lib.rs:62` y de
`Anchor.toml:15,18`). No lo uses para nada, no lo commitees, no lo menciones como candidato a llave de
deploy (CD-9).

**W0.2 — SPIKE, y es el que decide la forma del cambio.**

Pregunta: **¿`associated_token::authority = <arg de instrucción>` compila en Anchor 1.1.2?**

Razón para creer que sí (leído del generador, **no probado**):
`anchor-syn` 1.1.2 `src/codegen/accounts/constraints.rs:1311` emite
`let wallet_address = #wallet_address.key();`, y `anchor-lang` 1.1.2 `src/lib.rs:545` tiene
`impl Key for Pubkey`. Los args de `#[instruction(...)]` están en scope dentro de `try_accounts` — el
propio archivo ya lo usa para `remittance_id` en las seeds (`lib.rs:553`).

Hacé el cambio mínimo (sólo la cuenta y el `#[instruction(...)]`), `anchor build`, y **guardá la
salida del compilador compile o no** en `w0-spike-form-a.txt`. Después **restaurá y rebuildeá**,
comparando los 3 md5 contra W0.1 (CD-10).

- **Compila** → **Forma A** (§7.2). 1 cuenta nueva, 0 códigos de error nuevos.
- **No compila** → **Forma B** (§7.2). 2 cuentas nuevas, 1 código de error nuevo. Copiá el error del
  compilador al archivo antes de decidir.

**W0.3 — el hash del IDL.**

**Primero el control, después el dato** (auto-blindaje de WKH-326: un snippet de python devolvía
`447a05a7…` en vez de `fb64c937…` porque `json.dumps` escapa lo no-ASCII con `ensure_ascii=True`, y
los `docs` del IDL tienen acentos y un `⚠️`):

1. Corré el canonicalizador sobre el IDL **sin tocar**. Tiene que devolver
   `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`.
2. **Si devuelve otra cosa, PARÁ.** El algoritmo bueno es el de
   `chaski-v3/contracts/idl/canonical-hash.ts`, **leído** (CD-7: no lo importes, no lo copies al
   repo, no escribas en ese repo).
3. Recién entonces medí el hash del IDL nuevo, el bloque `pda` que Anchor emite para
   `beneficiary_ata`, y el orden final de cuentas de `deposit`.
4. Escribilo **sólo** en `doc/sdd/004-.../idl-hash.md`. **No** al README, **no** a
   `publish-idl-onchain.md`, **no** a ningún consumidor (CD-4).

**Qué esperar del hash:** se mueve **por construcción**, porque agregás una cuenta. Medido sobre
`target/idl/escrow.json` (md5 `c8e10be9…`): los `constraint =` **no** aparecen en el IDL, pero las
cuentas nuevas y los `address =` **sí**. No hay forma de hacer este cambio sin mover el hash.

**Consecuencia esperada y correcta:** `chaski-v3` y `wasiai-facilitator` pinnean `bfbdfe5a…`, así que
**cada uno va a tener 1 test rojo**. Eso es el resultado esperado, **no un pendiente tuyo**, y no se
arregla desde acá (CD-7). Es el mismo patrón que WKH-326.

**Criterio de salida de W0:** la forma está decidida con la salida del compilador **en un archivo**, y
el canonicalizador reprodujo un valor conocido.

---

### 7.2 W2 — el programa (`programs/escrow/src/lib.rs`)

> W2 va **después** de W1. Los tests rojos primero.

#### Forma A (preferida)

```rust
#[derive(Accounts)]
#[instruction(remittance_id: [u8; 16], beneficiary: Pubkey)]   // <- `beneficiary` es NUEVO acá
pub struct Deposit<'info> {
    // sender, mint, escrow_state, vault, sender_ata,
    // token_program, associated_token_program, system_program:  SIN CAMBIOS

    // AL FINAL DE LA LISTA A PROPOSITO, despues de system_program, rompiendo la convencion de
    // "los programas van ultimos". El motivo es el ORDEN DE DESPLIEGUE: Anchor solo falla por
    // cuentas de MENOS (anchor-syn 1.1.2 codegen/accounts/try_accounts.rs:48,64) y las de sobra
    // van a remaining_accounts (anchor-lang 1.1.2 src/context.rs:68), asi que una cuenta agregada
    // AL FINAL la ignora el binario viejo y un cliente actualizado puede desplegarse ANTES que el
    // programa, sin ventana en la que los depositos fallen. Insertarla en el medio rompe eso: el
    // binario viejo leeria esta cuenta como su `token_program`.
    //
    // Que valida, y que NO: valida que en el instante del DEPOSITO exista la ATA canonica del
    // beneficiario para este mint, que es exactamente la cuenta que `release` va a exigir
    // (ver Release.beneficiary_ata en este mismo archivo). NO garantiza que siga existiendo en el
    // instante del release: el beneficiario puede cerrarla despues (SPL CloseAccount, la firma su
    // dueño). O sea que ACOTA el caso "nunca existio" y deja abierto "existia y se cerro". El test
    // 15 de tests/escrow.ts ejerce ese caso a proposito para que el limite quede ejecutable.
    #[account(
        associated_token::mint = mint,
        associated_token::authority = beneficiary
    )]
    pub beneficiary_ata: Account<'info, TokenAccount>,
}
```

**Sin `mut`**: en `deposit` no se le transfiere nada, sólo se comprueba. Menos privilegio, y obliga a
que alguien agregue el `mut` a mano si algún día quiere mandarle tokens desde acá.

#### Forma B (sólo si W0.2 falló)

Quitá `beneficiary` del `#[instruction(...)]`, declará **dos** cuentas al final —
`beneficiary: SystemAccount<'info>` (espejo de `Release.beneficiary`, `lib.rs:592`) y
`beneficiary_ata` con `associated_token::authority = beneficiary` — y cruzá la cuenta contra el arg
**en el cuerpo del handler**:

```rust
require_keys_eq!(ctx.accounts.beneficiary.key(), beneficiary, ErrorCode::BeneficiaryMismatch);
```

`BeneficiaryMismatch` va **apendizado al final** del enum (código **6009**), nunca insertado en el
medio: los códigos de Anchor son posicionales desde 6000 y el propio archivo lo explica en
`lib.rs:494-499`.

⚠️ **El cruce contra el arg NO es opcional en la forma B.** Sin él, un cliente que mande el arg X y la
cuenta Y grabaría `escrow.beneficiary = X` (`lib.rs:167`) y validaría la ATA de Y. Eso no sería un
guard: sería un guard que mira al lado. Es el mutante M24.

#### Los errores que va a emitir (y por qué NO agregás un código nuevo en la forma A)

| Caso | Error de Anchor |
|---|---|
| La ATA del beneficiario **no existe** | `AccountNotInitialized` (3012) |
| Existe pero no es la ATA canónica de (beneficiary, mint) | `ConstraintAssociated` |
| Existe, es token account, pero de otro dueño | `ConstraintTokenOwner` |
| Existe pero es de otro mint | `ConstraintAssociated` |

Los tres últimos se pinnean **por nombre**, nunca por número (CD-11): los códigos de constraint de
Anchor no son parte del contrato de este repo; los de `ErrorCode` sí.

**Por qué no hace falta un `ErrorCode` nuevo:** medido en `anchor-syn` 1.1.2
`codegen/accounts/try_accounts.rs:87`, cada campo envuelve su error con
`.with_account_name(<nombre del campo>)`; y medido en
`node_modules/@coral-xyz/anchor/dist/cjs/error.js:113,132-139`, el cliente parsea el log
`AnchorError caused by account: <nombre>. Error Code: …` y expone ese nombre en `error.origin`
**como string**. O sea que el 3012 de `beneficiary_ata` es distinguible del de `sender_ata` **por el
nombre**, aunque el número sea el mismo.

⚠️ Escribí eso con precisión: **acota la ambigüedad, no la elimina.** Quien sólo mire
`errorCode.code` sigue viendo `3012` a secas. El mutante que restaura la ambigüedad completa es
cambiar el tipo del campo a `UncheckedAccount<'info>` (M22): desaparecen el 3012 **y** el nombre.

#### Los doc comments: cuál corregís y cuál NO

El hash del IDL se mueve igual, así que la ventana está abierta. Aun así:

| Doc comment | ¿Se corrige? | Por qué |
|---|---|---|
| `lib.rs:530-546` (el `///` de `Deposit.mint`) | **SÍ** | Dice que un co-firmante off-chain rechaza mints inesperados. No existe (lo dice el bloque `//` de `:518-529`). Esta HU toca esta struct y le agrega un guard relacional: dejarlo publicaría en el IDL un párrafo falso **por dos motivos** y que además contradice al guard nuevo |
| `lib.rs:16-19` y `:27-28` (el `//!` del módulo) | **PARCIAL** | Agregá la exigencia nueva a la tabla de instrucciones y al párrafo de `:27-28`, **porque esta HU la introduce**. **NO toques** "clamped" de `:30-32`: es de otra HU y ya tiene su `//` al lado |
| `lib.rs:411-413` (`MAX_ENTRIES`) | **NO** | Ajeno a esta HU, ya tiene su bloque `//` (`:386-410`), y medido: **no hay sección `constants` en este IDL**, así que ese `///` nunca llega al IDL |

**Regla, textual:** *corregís el doc comment que **esta HU** vuelve falso; el que ya era falso antes
sigue con su `//` adyacente.* Y en `README.md:31`, en W4, anotá que la ventana no se usó para los
otros dos y por qué — **no borres ese párrafo**.

#### ⚠️ W2.3 — El paso que te va a sorprender: hay CUATRO builders de `deposit`

Al agregar la cuenta, los tests existentes pueden romperse. Medido en el árbol `8fca472`, hay
**cuatro** lugares que construyen la instrucción `deposit`, en **tres** archivos:

| Archivo | Línea | Qué es |
|---|---|---|
| `tests/escrow.ts` | 165 | helper `deposit(...)` |
| `tests/escrow-index.ts` | 202 | helper `deposit(...)` |
| `tests/escrow-index.ts` | 779 | builder **inline** dentro del test 11 (el que mide compute) |
| `tests/escrow-window.ts` | 179 | helper `deposit(...)` |

Los tres archivos **ya** declaran `beneficiaryAta` como variable de módulo
(`tests/escrow.ts:51`, `escrow-index.ts:67`, `escrow-window.ts:65`) y la crean en su `beforeEach`, así
que el arreglo es **una línea por builder**.

**Procedimiento, y el resultado hay que REGISTRARLO:**

1. Corré la suite después del cambio al programa.
2. **Si pasa sin tocar nada** → `[features] resolution = true` de `Anchor.toml:7` + el bloque `pda`
   del IDL alcanzaron para que el cliente derive la cuenta sola. **Registralo en `idl-hash.md`.**
3. **Si falla por cuenta faltante** → agregá `beneficiaryAta,` al `accountsPartial` de los **4**
   builders. Los tests que llaman a esos helpers quedan **idénticos** (CD-14).

⚠️ **Registrá cuál de las dos ramas ocurrió, textualmente.** No es un detalle de test: es **el mismo
dato que decide si `chaski-v3` necesita un cambio de código o solamente re-pinnear el IDL** (§9.2).
Sale gratis acá y a ellos les ahorra una investigación.

⚠️ El test 11 de `escrow-index.ts:773` **mide compute**. Su número va a cambiar. Tiene un
`CU_REGRESSION_GUARD = 300_000` (`escrow-index.ts:47`) así que no se rompe, pero el valor reportado se
mueve — y por CD-18 el delta se reporta **con su mecanismo** (ver §8).

**Verificación al terminar W2:** `anchor build` + suite → **61 passing, 0 failing**.

---

### 7.3 W1 — los tests, en rojo primero (`tests/escrow.ts`)

> W1 va **antes** de W2. Contra el programa **sin cambiar**, T10..T13 tienen que **FALLAR**. Ésa es la
> evidencia de que los tests miran algo. Guardá la corrida en `w1-red.txt`.

#### Helpers a agregar (sin cambiar ningún call site actual — CD-14)

```ts
// createMint6 YA sirve (tests/escrow.ts:79): se llama dos veces, sin tocarlo.

// Estos tres cierran hoy sobre el `mint` de módulo. Parámetro OPCIONAL AL FINAL, para que los
// 10 call sites vigentes queden byte a byte iguales.
async function createAta(owner: PublicKey, mintOverride: PublicKey = mint): Promise<PublicKey>
async function mintTo(dest: PublicKey, amount: bigint, mintOverride: PublicKey = mint)
function pdas(rid: Uint8Array, mintOverride: PublicKey = mint)

// HELPER NUEVO. NO modifiques `expectRevert` (tests/escrow.ts:218-239): se agrega al lado.
async function expectRevertOnAccount(p: Promise<any>, code: string, accountName: string) {
  // 1) mismo pin del código que expectRevert
  // 2) además: e.error.origin === accountName
  //    con FALLBACK a que los logs contengan `AnchorError caused by account: ${accountName}`
  //    (en bankrun no todo error llega como AnchorError — por eso expectRevert ya tiene doble vía)
}
```

⚠️ `error.origin` es un **string**, no un objeto. Medido en
`node_modules/@coral-xyz/anchor/dist/cjs/error.js:132-139`: el cliente hace `const origin =
accountName`. Escribir `e.error.origin.accountName` no funciona.

#### Los 6 tests

| # | Test | Qué cubre | Estado esperado **en W1** |
|---|---|---|---|
| **T10** | `deposit` cuyo beneficiario NO tiene ATA para el mint revierte con `AccountNotInitialized` y `error.origin === "beneficiary_ata"`. Aserta además que **`escrow_state` no existe**, **`vault` no existe** y el saldo de `sender_ata` quedó igual | El caso medido (§1.1). Es el **AC-1** | **FALLA** (el depósito pasa) |
| **T11** | `deposit` pasando una ATA del beneficiario **de otro mint** revierte, con el nombre del código pinneado | La confusión de mints, del lado del destino | **FALLA** |
| **T12** | `deposit` pasando una token account del mint correcto pero **de otro dueño** revierte | Que el guard mire al beneficiario y no a cualquiera. Mata M21 | **FALLA** |
| **T13** | **Regresión del incidente**, extremo a extremo: beneficiario con ATA sólo en el mint A → `deposit` sobre el mint B **revierte** → se crea la ATA del beneficiario para B → **el mismo** `deposit` entra → un `release` dentro del deadline paga el monto exacto | La HU entera con la forma del incidente, **y** demuestra que el remedio es UNA transacción | **FALLA** en la primera mitad |
| **T14** | Happy path con **una cuenta extra al final** de la lista → pasa | El mecanismo del que depende el orden de despliegue (§3.3), y el que hace que el `reference` de `chaski-v3` no estorbe (§9.2) | **PASA** |
| **T15** | El beneficiario **cierra** su ATA después de un `deposit` válido → `release` revierte con `AccountNotInitialized` sobre `beneficiary_ata` | El **límite** de la solución (§1.3 y §11). Vuelve **MEDIDO** el 3012 que hoy es derivado | **PASA** |

⚠️ **T13 tiene dos mitades y la primera tiene que fallar en W1.** No pongas un assert dentro de un
loop ni antes de tiempo que aborte el test antes de llegar a la parte que la HU tiene que exhibir. Es
la entrada 1 del auto-blindaje de WKH-326: un assert por iteración abortaba en el ciclo 2 y el test
nunca mostraba el error que decía mostrar.

⚠️ **T15 no es un test de más: es el test de honestidad.** Existe para que nadie escriba que el
arreglo "elimina" el problema. Si lo borrás, la prosa de la HU deja de ser falsable.

⚠️ Los mints de los tests son **sintéticos de 6 decimales**. No se puede mintear el USDC real de
Circle en bankrun (`tests/escrow-index.ts:29` ya lo dice). Reproducís la **forma** del incidente (dos
mints, ATA en uno solo), no sus direcciones.

⚠️ Si repetís una tx de forma idéntica, avanzá el slot: **bankrun deduplica por firma** y el retry
"pasa" sin ejecutarse. Usá el patrón de `bumpSlot()` (`tests/escrow-index.ts:350-353`).

**Baseline nueva: 61 passing, 0 failing** (55 + 6). Ninguno saltado.

---

### 7.4 W3 — el script (`scripts/list-live-escrows.py`)

Cuatro cambios, en orden de importancia:

1. **Chequeo nuevo: ¿el beneficiario puede recibir?** Por cada escrow, `getTokenAccountsByOwner(
   beneficiary, {mint})` con el `rpc()` que ya existe (E-5). Salida por escrow:
   - `beneficiary can receive: yes (<ata>, balance <n>)`
   - `beneficiary can receive: NO — beneficiary has NO token account for this mint; release cannot be built`

   **Es la pieza más valiosa de la HU**: funciona contra el binario **ya desplegado**, sin ningún
   upgrade, y es el verificador de la mitad 2 del gate de §9.1.

2. **Sacá el eje "antes/después del upgrade".** El docstring (`:5-17`) y el bloque de cierre
   (`:198-212`) están escritos para el instante previo al deploy de WKH-326, que ocurrió en el slot
   `481495859` el 2026-08-05. Hoy `release` sobre un escrow vencido revierte.
   - `:170` — el verdicto pasa a ser derivable **sólo de lo que el script leyó**:
     `REFUND-ONLY: the release window closed at <iso(deadline)>; the only exit is a refund signed by <sender>`
   - `:206-207` — **borrá** "Each of these can be released by its authority RIGHT NOW": recomienda una
     operación de dinero que revierte. Reemplazalo por la instrucción de refund, nombrando al sender.

3. **Todo lo que imprime lleva el slot.** Ya lo tiene en el header (`:92`, `:150`); repetilo en el
   bloque de cierre, para que un pegado **parcial** de la salida siga trayendo su slot.

4. **`--markdown`**: la misma info como tabla markdown, con encabezado
   `measured <iso> at slot <N> against <cluster>`. Es lo que W4 usa para **generar** dos párrafos del
   README en vez de escribirlos.

**Mantené el nombre `--exit-nonzero-if-blocking`.** Verificado por barrido sobre `.yml`, `.sh`, `.md`
y `.json`: no hay consumidor programático, sólo prosa (`README.md:143`, `:974`, `:999`) y un
comentario en `scripts/deploy-devnet.sh:115`. Documentá que el nombre es histórico.

⚠️ **No escribas que `--markdown` "hace que el README no envejezca".** Es falso. El "mutante" que
restaura el comportamiento viejo es *que nadie corra el comando*. Lo que sí hace: baja el costo de
refrescar a un comando y garantiza que cada línea refrescada traiga su slot. Lo que reinicia el
límite: cualquier actividad en devnet — medido, 4 filas cambiaron de estado entre los slots
`482578481` y `482583139` **dentro de una misma sesión**.

**Verificación de W3:** corré el script contra devnet (sólo lectura) y comprobá que (i) ningún renglón
menciona un upgrade, (ii) el chequeo de la ATA imprime `NO` para el mint de Circle, (iii) la salida
trae su slot. Guardala en `w3-output.txt`.

---

### 7.5 W4 — prosa y runbook (después de W3)

#### Prioridad 1: `SECURITY.md:91-92`

```
- **Devnet only.** There is no mainnet deployment. The mint used in testing is one
  we control. **No real money is at risk right now.**
```

**"one we control" es falso para el 100% del saldo que este programa custodió.** Ese saldo estuvo en
el mint de Circle `4zMMC9srt…`, cuya mint authority (`GrNg1XM2…`) y **freeze authority**
(`CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT`) **no son nuestras** — medido al slot `482578725`.

Es la primera cosa que lee quien quiere reportar una vulnerabilidad, y `README.md:26` y `:540-546` ya
corrigieron ese mismo hecho hace días mientras `SECURITY.md` no se enteró. **Va primero en W4.**

#### Los 8 sitios de prosa

| # | Sitio | Texto a encontrar | Qué tiene que pasar |
|---|---|---|---|
| P1 | `SECURITY.md:91` | "The mint used in testing is one" | Arriba. **Prioridad 1** |
| P2 | `README.md:26` | "the two escrows still holding funds" | Al slot `482583139` **no hay ninguno**: 0 en `Deposited`. Con fecha **y slot** |
| P3 | `README.md:143` | "Run today it exits 1 again" | Hoy sale 0 (slot `482583139`). Medición fechada, o derivada del script |
| P4 | `README.md:541` | "2026-08-05 the only two escrows" | Fueron 4 y 40 unidades, ahora 0. **Tiene fecha y envejeció igual**: hace falta el slot **y** una oración que no lea como propiedad vigente |
| P5 | `README.md:615` | "One escrow on devnet is in the on-chain half" | `4VopXGzB…` está **ausente** (slot `482578944`) y su historia completa es Deposit (481178461) → Refund (481455632) → Close (482045751). El ejemplo pasa a **histórico y fechado** |
| P6 | `README.md:722` | "Which one the escrow actually holds" | Eran 8 cuentas, son 10; eran 2 en Circle, son 0 en `Deposited`. Las 4 direcciones que nombra están ausentes. **Mejor candidato a generarse con `--markdown`** |
| P7 | `README.md:978` | "still possible until the upgrade lands" | Ese upgrade aterrizó (slot `481495859`). Y es **el runbook que el deploy de esta HU va a seguir**: dejarlo hace que el propio deploy se apoye en un supuesto vencido |
| P8 | `doc/publish-idl-onchain.md:43`, `:48` | "Current state, as read from devnet" / "Exists?" | Dice `Exists? **No.**`; medido al slot `482579471` la cuenta `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC` **existe**, owner `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, 5292 bytes. Y `:51` publica `fb64c937…` cuando el vigente es `bfbdfe5a…` |

#### AC-5 — dos sitios, y ojo con el tiempo verbal

- `README.md:25` ("Source vs deployed | **They agree.**")
- `SECURITY.md:99` ("The source and the chain agree today")

Los dos tienen que decir que el árbol **diverge a propósito** de lo desplegado, y que el deploy es un
paso posterior **con su gate**. ⛔ **PROHIBIDO escribir o insinuar que ya se desplegó** mientras no se
haya desplegado (CD-23).

⛔ **NO toques `SOURCE_REPRODUCES_CHAIN` en `.github/workflows/verified-build.yml`.** Con `lib.rs`
cambiado y sin deploy, el rebuild **va a** diferir de devnet y el job se va a poner rojo. **Eso es
correcto**: el fuente dejó de reproducir la cadena. Moverla es parte del ciclo de deploy, no de W4.

#### El literal `55`, que W1 deja viejo en 8 sitios a la vez

`README.md:29,30,772` · `doc/mutation-run.md:56,58,157` · `.nexus/project-context.md:63,145` ·
`SECURITY.md:106`.

**No lo actualices 8 veces. Reducilo a 3** (auto-blindaje de WKH-326, entrada 5: un criterio escrito
como literal envejeció y terminó acusando a quien había restaurado bien):

- `README.md:29,30,772` — **mantienen el número**. Es la tabla de portada y el renglón de la corrida
  medida: ahí el número es el contenido.
- `SECURITY.md:106` y `.nexus/project-context.md:145` — describen la suite **sin cifra**, apuntando al
  renglón del README.
- `.nexus/project-context.md:63` — hoy cita `(README.md:769)` y **ya está corrido**: el texto está en
  `:772`. Cambialo por el **título de la sección**. Un ancla no se desplaza cuando alguien edita 3
  líneas más arriba.
- `doc/mutation-run.md:56,58,157` — **NO se tocan**: son baselines **históricas** (43/54/55) y
  reescribirlas borraría el "antes". Agregá la nueva como cuarta entrada.

⚠️ Escribí el resultado con honestidad: de 8 sitios manuales pasás a **3**. **No digas que "deja de
estar disperso"**: el mutante que restaura la dispersión es volver a escribir el literal en
cualquiera de los otros 5, y lo que reinicia el límite es agregar o quitar un test.

#### `runbook-deploy.md` — **se escribe, NO se ejecuta**

Creá `doc/sdd/004-.../runbook-deploy.md` con los pasos de §9. **⛔ No corras ninguno.**

#### ⚠️ Paso final obligatorio de W4

Volvé a correr el verificador de §12 sobre **todas** las citas del README, `SECURITY.md`,
`project-context.md` y los artefactos de la HU. Las ediciones de W4 **desplazan** líneas y los
barridos normales miran lo que escribiste, no lo que corriste. Ya pasó cuatro veces en este
ecosistema, y una de ellas fue en `project-context.md:63`, que es una de las que arreglás acá.

---

### 7.6 W5 — mutantes (`doc/mutation-run.md`)

Uno a la vez, con el protocolo de `doc/mutation-run.md:48-52` y `:59`: md5 de referencia antes, y
después de restaurar **rebuildear y comparar los tres md5**, nunca suponerlos.

| # | Mutante (UNA línea) | Qué restaura | Tests que tienen que morir |
|---|---|---|---|
| M20 | Borrar el campo `beneficiary_ata` de `Deposit` | El comportamiento exacto de hoy: el depósito acepta un beneficiario que no puede recibir | T10, T11, T12, T13 |
| M21 | `associated_token::authority = beneficiary` → `= sender` | Un guard que mira al **remitente**: pasaría cualquier depósito en que el sender tenga ATA, o sea todos | T12, T13 |
| M22 | `Account<'info, TokenAccount>` → `UncheckedAccount<'info>` | Desaparece la exigencia de que exista, y con ella el 3012 **y** el nombre de cuenta | T10, T13 |
| M23 | `associated_token::mint/authority` → `token::mint/authority` | Acepta cualquier token account del beneficiario, incluida una que **no** es la ATA canónica que `release` exige | T11, T13 |
| M24 | (forma B) Borrar el `require_keys_eq!` del cuerpo | El guard valida la ATA de una cuenta y graba **otro** beneficiario | el test específico de la forma B |

Capturas crudas en `doc/sdd/004-.../w5/M*-summary.txt`, cada una con la cabecera de §10.

---

## 8. Cómo reportar el compute (CD-18) — y no es un `min..max`

El CU de `deposit` **no es una constante**. Medido en las 4 transacciones **reales** de devnet
(slots 481455889 / 481983586 / 482045575 / 482396033): **32.475 / 33.975 / 35.475 / 38.475 CU**.

Los cuatro son **≡ 975 (mod 1500)**. Los pasos de 1.500 son iteraciones de búsqueda de bump canónico
— el mismo mecanismo que `.nexus/project-context.md:88-91` documenta desde los tests (52.826..79.826
CU en 28 corridas). El `refund` da **13.363 / 14.863** ⇒ **≡ 1363 (mod 1500)**.

⇒ **Reportá el delta de la cuenta nueva como un cambio del residuo módulo 1500, no como un rango de N
corridas.** Un `min..max` de lo observado presentado como cota es exactamente el error de la entrada 4
del auto-blindaje de WKH-326: tres samples se convirtieron en una "cota" que la corrida siguiente
tumbó con un valor 5x mayor.

Referencia útil: el cliente declara **120.000 CU**, y el peor depósito real medido fue 38.475. Hay
margen de sobra; no hace falta que toques nada del lado del cliente (y no podrías, CD-7).

---

## 9. El upgrade (W6) — **se planifica acá, NO lo ejecutás**

El founder autorizó el upgrade a **devnet**. Sigue prohibido mainnet (CD-20).

⛔ **Vos NO corrés W6.** Escribís el runbook (§7.5) y parás. W6 se ejecuta cuando su gate esté
satisfecho, y el gate depende de **otro repo**.

### 9.1 El GATE, y no es opcional

> **W6 no corre hasta que (i) `chaski-v3` mande `beneficiary_ata` en su `deposit`, y (ii) el
> beneficiario en uso tenga ATA para el mint en uso.**

| Mitad | Por qué | Cómo se verifica |
|---|---|---|
| El cliente manda la cuenta | Si no, el programa nuevo lee otra cosa como `beneficiary_ata` y **todo depósito falla** (§9.2). Como la cuenta va al final, **cliente-primero no tiene ventana de falla** (§3.3) | `simulateTransaction` con `sigVerify: false` contra devnet, y un depósito real de `chaski-v3` antes del deploy |
| El beneficiario tiene ATA | Si no, el programa nuevo **rechaza el 100% de los depósitos**. Medido al slot `482578601`: hoy **NO la tiene** para el mint de Circle | El chequeo nuevo de W3: `beneficiary can receive: yes` |

**Las dos salidas posibles, y el Story File NO elige:**

- **A** — Se abre la HU de `chaski-v3` primero; cuando aterriza, W6 corre. Sin ventana de falla.
- **B** — El founder acepta explícitamente una interrupción de depósitos y W6 corre antes.

⛔ **Ni vos ni este documento eligen B.** Es decisión del founder. Si alguien corre W6 sin el gate, el
resultado medible es que **ningún depósito entra**.

### 9.2 ⚠️ R11 — el riesgo más silencioso de esta HU. **Es un paso obligatorio, no una nota al pie**

Medido leyendo `chaski-v3/src/infrastructure/solana-wallet.ts:410-417` (**sólo lectura**): el cliente
real arma el depósito con `.accounts({sender, mint, escrowState, vault, senderAta})` **y**
`.remainingAccounts([{ pubkey: reference, ... }])` — un pubkey de referencia estilo Solana Pay que el
programa nunca lee.

O sea: **la última cuenta de la transacción de hoy no es `system_program`, es `reference`.**

Tres consecuencias, y las tres van escritas en el runbook y en el handoff:

1. **El orden cliente-primero sigue siendo seguro.** El cliente nuevo emite
   `[…8 declaradas…, beneficiary_ata, reference]`; el programa viejo consume 8 y deja las **dos** en
   `remaining_accounts`, que no mira. Funciona.
2. **El modo de falla del cliente viejo es ENGAÑOSO, y hay que documentarlo antes de que alguien lo
   debuguee.** El cliente viejo emite `[…8…, reference]`; el programa nuevo lee **`reference` como
   `beneficiary_ata`** y, al ser un pubkey sin cuenta, tira `AccountNotInitialized` **nombrando
   `beneficiary_ata`**. La causa real es "el cliente no se actualizó" y el error apunta a otra cosa.
3. **`reference` se corre del índice 8 al 9.** **NO está verificado** si algo del lado de `chaski-v3`
   o de un explorador lo lee **por posición fija** en vez de por barrido de `accountKeys`. Si alguien
   lo lee posicionalmente, **el arreglo rompe el camino de pago en silencio**.

**Tu obligación concreta:** escribí los tres puntos en `runbook-deploy.md` bajo un título propio, y
dejá el punto 3 como **verificación obligatoria del handoff a `chaski-v3`**, marcado como
**NO VERIFICADO**. ⛔ No lo asumas resuelto y ⛔ no entres a `chaski-v3` a arreglarlo (CD-7).

### 9.3 Precondiciones ya medidas (no las remidas, sí las citás)

| Precondición | Estado |
|---|---|
| **Upgrade authority** | `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`, leída de la cadena con `scripts/onchain-hash.py`. Programdata `UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR`. Último deploy: slot `481495859` |
| **Hashes del binario vigente** | artifact-sha256 `59ec1098cd64d04cab1063fd837e84a70c7962741a3c14932d249cab28b328ef` / verify-hash `455e4e36fa7c63be568d470a89f7eded9aff5806b198340936a578810be09291` |
| **Espacio en programdata** | 412.568 bytes usables, artefacto actual 274.800 ⇒ **137.768 bytes de margen** (medido 2026-08-10) |
| **Toolchain de este host** | rustc **1.89.0** dentro del checkout, Agave **3.1.10**, anchor **1.1.2** — los tres coinciden con `rust-toolchain.toml`, `Cargo.toml:20` y `Anchor.toml:4` |
| **Path del keypair** | **NO está en el repo, y eso es correcto.** Las 4 menciones son placeholders (`README.md:930-931`, `scripts/deploy-devnet.sh:62-63`, `doc/publish-idl-onchain.md:64,171`) y `~/.config/solana/id.json` **no existe**. Lo provee el founder |

⚠️ **El margen de 137.768 bytes NO significa "el upgrade no necesita más rent": eso es DERIVADO.** El
binario nuevo todavía no existe. Se vuelve medido cuando W6.1 corra
`scripts/programdata-capacity.py` contra el artefacto **nuevo**. El número a no superar es **412.568**.
**Si no entra, el upgrade NO se ejecuta**: se reporta el faltante en bytes y el rent que costaría
(referencia de la ampliación anterior: +150.000 bytes ⇒ 1,044 SOL, irreversible). **CD-21: se reporta,
no se paga.**

⚠️ Precisión sobre el toolchain, porque ya costó una ronda: **lo que no compila el binario es el pin
de rustc del host, no `anchor build`.** `anchor build` **sí** produce el artefacto desplegable; el que
elige al compilador real es `[workspace.metadata.cli] solana` de `Cargo.toml:20` (`README.md:805-827`,
medido el 2026-08-06: dos canales distintos del host produjeron el mismo `verify-hash 455e4e36…`).

### 9.4 Lo que el upgrade NO hace, y **no lo escribas al revés**

- **No recupera nada.** Los 40.000.000 raw volvieron por `refund` el 2026-08-10 (slots
  `482579398`..`482580179`; la ATA del sender pasó de 10.000.000 a 50.000.000 raw, slot `482583245`).
  **El arreglo previene; nunca recuperó nada.**
- **No arregla depósitos ya hechos.** El guard aplica a `deposit`, o sea a lo que venga.
- **No valida el mint.** Eso vive en `wasiai-facilitator` (§3.2), otro repo.
- **No recupera el alquiler.** `refund` no cierra cuentas: quedaron 8 cuentas vivas con
  **16.008.000 lamports = 0,016008 SOL** (4 × 1.962.720 del `EscrowState` + 4 × 2.039.280 del vault,
  medido al slot `482583245`). Se recuperan con `close`, que ya existe y funcionó en cadena (slot
  `482045751`). **Es residuo declarado, alcance de WKH-327, NO trabajo tuyo.**

---

## 10. Cabecera obligatoria de todo `.txt` de evidencia

Auto-blindaje de WKH-326, entrada 6: la evidencia cruda quedó de una pasada y la prosa de otra, y lo
cazó QA. Cada `.txt` que generes arranca con:

```
# wave:       W<N>.<M>
# pasada:     <1 | 2 | ...>
# fecha:      2026-08-10T<hh:mm>Z
# commit:     <git rev-parse HEAD>
# lib.rs md5: <md5sum programs/escrow/src/lib.rs>
# baseline:   <N> passing, <M> failing
# discriminador: passing + failing = <N+M>   <- se deriva del propio contenido, sin creerle a esta cabecera
```

El discriminador importa: tiene que poder distinguir pasadas **sin creerle a la cabecera**. En
WKH-326 fue `passing + failing` = 54 (pasada 1) vs 55 (pasada 2). Acá: **55** antes de W1, **61**
después.

---

## 11. La lista de límites: qué NO podés escribir, y con qué mutante

Antes de entregar, revisá tu prosa contra esta tabla. Si escribiste algo de la columna izquierda,
corregilo.

| ⛔ No escribas | ✅ Escribí | Mutante de una línea | Qué reinicia el límite |
|---|---|---|---|
| "el depósito ya no puede quedar sin salida" | "si el `deposit` entró, el `release` no falla **por esta causa**" | M20 / M23 | El beneficiario cerrando su ATA **después** del depósito (T15). Acota "nunca existió", deja abierto "existía y se cerró" |
| "el 3012 ya no es ambiguo" | "`error.origin` lo desambigua; el **número** sigue siendo 3012 para todos" | M22 | Un consumidor que sólo mire `errorCode.code` |
| "no hay ventana de falla en el despliegue" | "el orden **cliente-primero** no tiene ventana; el otro orden sí" | Mover `beneficiary_ata` una posición hacia arriba | Un cliente que arme la lista por posición fija (R11, §9.2) |
| "`--markdown` hace que el README no envejezca" | "baja el costo de refrescar a un comando y cada línea refrescada trae su slot" | **Ninguno: la frase es falsa.** El "mutante" es que nadie corra el comando | Cualquier actividad en devnet (medido: 4 filas en una sesión) |
| "el literal 55 deja de estar disperso" | "pasa de 8 sitios manuales a 3" | Volver a escribirlo en cualquiera de los 5 que se sacan | Agregar o quitar un test |
| "el upgrade no necesita más rent" | "**DERIVADO**: 137.768 bytes de margen contra el artefacto **viejo**; W6.1 lo mide contra el nuevo" | Ninguno de código: es una derivación | Cualquier cosa que haga crecer el binario. El número a no superar es 412.568 |
| "el arreglo destraba / recupera los fondos" | "**previene**. Los 40 volvieron por `refund`, y el arreglo no tuvo nada que ver" | Ninguno: es un hecho pasado, medido | Nada |
| "está medido que el problema es el mint" | "está medido que el **beneficiario** no lo explica; mint y sender co-varían y n=10 no los separa" | Ninguno: es una limitación del dato | Un depósito del sender `8tJVcM2Jeh…` sobre el mint de Circle, o al revés. **Ahí sí se separan** |
| "`release` explota con 3012" (como observado) | "**DERIVADO**: nunca aterrizó un `release` sobre esos 4. T15 lo vuelve medido" | Ninguno hasta que T15 corra | Que T15 corra: ahí pasa a MEDIDO |

---

## 12. Verificador de citas (copiá y corré antes de entregar)

⛔ **Nunca con `cat -n`.** El proxy de este entorno corrompe la salida redirigida con exit 0.

```python
# python3 - <<'PY'   (desde /home/ferdev/.openclaw/workspace/wt-wkh343)
C = [   # (archivo, línea, subcadena que TIENE que estar en esa línea)
 ("programs/escrow/src/lib.rs", 138, "beneficiary: Pubkey,"),
 ("programs/escrow/src/lib.rs", 167, "escrow.beneficiary = beneficiary;"),
 ("programs/escrow/src/lib.rs", 208, "unix_timestamp < ctx.accounts.escrow_state.deadline"),
 ("programs/escrow/src/lib.rs", 247, "status == EscrowStatus::Deposited"),
 ("programs/escrow/src/lib.rs", 514, "pub struct Deposit<'info>"),
 ("programs/escrow/src/lib.rs", 518, "CORRECCION 2026-08-04"),
 ("programs/escrow/src/lib.rs", 530, "Acepta CUALQUIER mint"),
 ("programs/escrow/src/lib.rs", 553, 'seeds = [b"escrow", sender.key().as_ref(), remittance_id.as_ref()]'),
 ("programs/escrow/src/lib.rs", 573, "token::mint = mint"),
 ("programs/escrow/src/lib.rs", 576, "pub sender_ata"),
 ("programs/escrow/src/lib.rs", 580, "pub system_program: Program<'info, System>,"),
 ("programs/escrow/src/lib.rs", 592, "pub beneficiary: SystemAccount<'info>,"),
 ("programs/escrow/src/lib.rs", 616, "associated_token::mint = mint"),
 ("programs/escrow/src/lib.rs", 617, "associated_token::authority = beneficiary"),
 ("programs/escrow/src/lib.rs", 619, "pub beneficiary_ata: Account<'info, TokenAccount>,"),
 ("tests/escrow.ts", 79,  "async function createMint6"),
 ("tests/escrow.ts", 106, "async function createAta"),
 ("tests/escrow.ts", 124, "async function mintTo"),
 ("tests/escrow.ts", 146, "function pdas"),
 ("tests/escrow.ts", 165, "async function deposit"),
 ("tests/escrow.ts", 218, "async function expectRevert"),
 ("tests/escrow.ts", 283, "CANARY"),
 ("tests/escrow.ts", 326, "2. release signed by a non-authority"),
 ("tests/escrow-index.ts", 29,  "NOT Circle USDC devnet"),
 ("tests/escrow-index.ts", 198, "function ataOf"),
 ("tests/escrow-index.ts", 202, "async function deposit"),
 ("tests/escrow-index.ts", 350, "async function bumpSlot"),
 ("tests/escrow-index.ts", 779, ".deposit("),
 ("tests/escrow-window.ts", 179, "async function deposit"),
 ("scripts/list-live-escrows.py", 92,  "cluster clock at slot"),
 ("scripts/list-live-escrows.py", 170, "BLOCKING: releasable today"),
 ("scripts/list-live-escrows.py", 206, "released by its authority RIGHT NOW"),
 ("README.md", 25,  "Source vs deployed"),
 ("README.md", 26,  "Money at risk"),
 ("README.md", 143, "Run today it exits 1 again"),
 ("README.md", 541, "2026-08-05 the only two escrows"),
 ("README.md", 615, "One escrow on devnet is in the on-chain half"),
 ("README.md", 722, "Which one the escrow actually holds"),
 ("README.md", 772, "Last measured run"),
 ("README.md", 978, "still possible until the upgrade lands"),
 ("SECURITY.md", 91,  "The mint used in testing is one"),
 ("SECURITY.md", 99,  "The source and the chain agree today"),
 ("SECURITY.md", 106, "55 tests, behaviour driven"),
 ("doc/publish-idl-onchain.md", 43, "Current state, as read from devnet"),
 ("doc/publish-idl-onchain.md", 48, "Exists?"),
 (".nexus/project-context.md", 63,  "README.md:769"),
 (".nexus/project-context.md", 145, "las 55 pruebas"),
 ("doc/mutation-run.md", 59, "d4b736cf6b9e15421e7cb1d75f3d8e0d"),
 ("Anchor.toml", 7,  "resolution = true"),
 ("Cargo.toml",  20, 'solana = "3.1.10"'),
]
bad = 0
for f, n, exp in C:
    L = open(f, errors="ignore").read().split("\n")
    got = L[n-1] if n-1 < len(L) else "<EOF>"
    if exp not in got:
        bad += 1
        print(f"ROTA {f}:{n}\n  esperaba {exp!r}\n  encontro {got.strip()[:110]!r}")
print(f"{len(C)-bad}/{len(C)} OK")
# PY
```

**Las 50 estaban OK contra `8fca472` el 2026-08-10.** Volvé a correrlo **después de W4**: tus propias
ediciones desplazan líneas.

Y las 6 afirmaciones sobre Anchor de este documento se verifican **leyendo**, no corriendo:

```
anchor-syn  1.1.2  src/codegen/accounts/constraints.rs:1269-1324   qué chequea associated_token::
anchor-syn  1.1.2  src/codegen/accounts/constraints.rs:1311        usa #wallet_address.key()
anchor-syn  1.1.2  src/codegen/accounts/try_accounts.rs:48,64,87   cuentas de menos / with_account_name
anchor-lang 1.1.2  src/lib.rs:541-545                              impl Key for Pubkey
anchor-lang 1.1.2  src/accounts/account.rs:313-318                 de dónde sale AccountNotInitialized
anchor-lang 1.1.2  src/context.rs:68                               las de sobra van a remaining_accounts
node_modules/@coral-xyz/anchor/dist/cjs/error.js:113,132-139       origin es un STRING
```

Raíz de los crates: `/home/ferdev/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`

---

## 13. Constraint Directives

### OBLIGATORIO

- **CD-3** — La opción elegida está respaldada por la medición (SDD §3.7). No la revises.
- **CD-5** — Toda afirmación sobre saldo, cuenta o estado on-chain lleva **fecha y slot en la misma
  línea**. Una fecha sin slot no alcanza, y una oración con fecha escrita como propiedad vigente
  tampoco.
- **CD-6** — `Deposit.beneficiary_ata` valida **exactamente lo mismo** que `Release.beneficiary_ata`:
  `associated_token::mint` + `associated_token::authority`.
- **CD-10** — `anchor build` y los 3 md5 **antes** de tocar nada. Después de cada mutante, restaurar
  **Y rebuildear**, comparando los 3 md5 contra la referencia.
- **CD-11** — Cada test de revert pinnea el **nombre** del código de Anchor. Nunca el número para los
  códigos de constraint (los de `ErrorCode` sí son contrato). Cuando el punto sea *qué cuenta* falló,
  asertá además `error.origin` o la línea `AnchorError caused by account: <nombre>`.
- **CD-16** — Cada `.txt` de evidencia con la cabecera de §10.
- **CD-17** — `git status --porcelain` **completo** para probar "no toqué X", más `ls -l` de los
  archivos concretos que serían la violación. Nunca con `| head` ni `| wc -l`.
- **CD-18** — El compute se reporta con su **mecanismo** (residuo mod 1500), nunca como `min..max`.
- **CD-23** — Entre W2 y el deploy, `README.md:25` y `SECURITY.md:99` dicen que el árbol **diverge**.

### PROHIBIDO

- **CD-1** — ⛔ Ejecutar el deploy. Se planifica (§9), no se corre. ⛔ Mover fondos por iniciativa
  propia: los refunds los hizo el founder y los `close` del alquiler no son de esta HU.
- **CD-2** — ⛔ Abrir, listar o citar `m5-keys/`, **incluso para buscar el keypair de la upgrade
  authority**. Si tu conclusión es que sólo puede venir de ahí, **escribilo como pregunta al founder y
  seguí**.
- **CD-4** — ⛔ Escribir el hash nuevo del IDL fuera de `doc/sdd/004-.../idl-hash.md`. ⛔ Re-pinnearlo
  en ningún consumidor.
- **CD-7** — ⛔ Escribir en `chaski-v3`, `wasiai-facilitator`, `wasiai-a2a`,
  `wasiai-remittance-agents`. Leerlos para medir impacto sí. Sus tests de hash van a quedar rojos y
  **es el resultado esperado**.
- **CD-8** — ⛔ `init` o `init_if_needed` sobre `beneficiary_ata`, en cualquier instrucción (§3.1).
- **CD-9** — ⛔ Tratar el `target/deploy/escrow-keypair.json` generado en el worktree como la llave del
  programa.
- **CD-12** — ⛔ Cambiar la firma de `deposit` (los 5 args). ⛔ Tocar el layout de `EscrowState`: hay
  8 cuentas vivas en cadena cuyo alquiler depende de que sigan deserializando.
- **CD-13** — ⛔ Agregar un `ErrorCode` en la forma A. En la forma B, sólo `BeneficiaryMismatch`
  **apendizado al final** (6009).
- **CD-14** — ⛔ Modificar los helpers de tests de forma que cambie algún call site actual. Parámetro
  **opcional al final**.
- **CD-15** — ⛔ `it.skip`, `describe.skip`, `existsSync + it.skip`.
- **CD-19** — ⛔ `cargo fmt` sobre el programa. El árbol no pasa `--check` hoy y no está enforced.
- **CD-20** — ⛔ Cualquier operación contra mainnet.
- **CD-21** — ⛔ Ampliar el `programdata`. Si no entra, se **reporta**, no se paga.
- **CD-22** — ⛔ Ejecutar W6 sin el gate de §9.1, y ⛔ declararlo cumplido sin la salida del script que
  lo demuestre.
- ⛔ Agregar dependencias. **Ninguna.** Ni en `Cargo.toml`, ni en `package.json`, ni en el script (que
  es stdlib puro).
- ⛔ "Mejorar" código adyacente, refactorizar lo que no está en §4, o corregir doc comments que esta
  HU no vuelve falsos.

---

## 14. Orden de ejecución

```
W0 (gate serial)          →  W1 ─┐
  W0.1 baseline              (tests EN ROJO)
  W0.2 spike forma A/B                     ├→  W2 (el programa)  →  W5 (mutantes)  →  [W6: NO lo corrés]
  W0.3 hash del IDL       →  W3 ─┘             + W2.3: los 4 builders
                             (script)
                                 └→ W4 (prosa, DESPUÉS de W3)
```

| Wave | Verificación al completar |
|---|---|
| W0 | 3 md5 = referencia · suite **55 passing, 0 failing** · forma decidida con salida del compilador en archivo · canonicalizador reprodujo `bfbdfe5a…` |
| W1 | T10..T13 **FALLAN**, T14/T15 pasan · `w1-red.txt` con cabecera |
| W2 | `anchor build` + suite **61 passing, 0 failing** · registrado si hizo falta tocar los 4 builders |
| W3 | Script sin mención al upgrade · chequeo de ATA imprime `NO` para Circle · salida con slot |
| W4 | Verificador de §12 en verde **de nuevo** · `SECURITY.md:91-92` corregido primero · runbook escrito y no ejecutado |
| W5 | M20..M24 KILLED con los tests nombrados · 3 md5 restaurados · capturas con cabecera |

---

## 15. Done Definition

- [ ] W0..W5 completas. **W6 NO ejecutada** (§9).
- [ ] `anchor test --skip-build --skip-deploy --skip-local-validator` → **61 passing, 0 failing**,
      ninguno saltado (AC-2).
- [ ] `cargo clippy --all-targets -- -D warnings` en verde.
- [ ] `w1-red.txt` demuestra que T10..T13 fallaban **antes** del cambio.
- [ ] M20..M24 en `doc/mutation-run.md`, cada uno KILLED, con los tests **nombrados**, y los 3 md5
      restaurados y **verificados** (no supuestos).
- [ ] El verificador de §12 pasa **después** de W4.
- [ ] Ningún número on-chain sin slot en la misma línea (AC-4).
- [ ] `SECURITY.md:91-92` corregido (prioridad 1) y `README.md:25` + `SECURITY.md:99` dicen que el
      árbol **diverge**, sin insinuar que se desplegó (AC-5, CD-23).
- [ ] Tu prosa pasa la tabla de §11: ningún "elimina" sin su mutante nombrado.
- [ ] La distinción de §1.2 (mint vs sender co-varían, n=10 no los separa) **sobrevive** en todo lo
      que escribas.
- [ ] R11 (§9.2) está en el runbook con título propio y marcado **NO VERIFICADO**.
- [ ] `git -C chaski-v3 status --porcelain` y `git -C wasiai-facilitator status --porcelain` no
      muestran cambios tuyos (verificado por **diff**, no por mtime).
- [ ] `m5-keys/` sin abrir, sin listar, sin citar.
- [ ] Auto-blindaje escrito en `doc/sdd/004-.../auto-blindaje.md` con cada error que cometas y cómo lo
      corregiste. **No es opcional**: es lo que la HU siguiente va a leer.

---

## 16. Escalation Rule

> **Si algo no está en este Story File, PARÁ y preguntá al Architect.** No inventes, no asumas, no
> improvises.

Escalá **siempre** en estos casos:

1. Un exemplar no está donde dice (§12 en rojo antes de empezar).
2. `EscrowState` o `EscrowStatus` no tienen la forma del checklist §6 puntos 5-6.
3. Los 3 md5 de W0.1 no coinciden con la referencia.
4. El canonicalizador no reproduce `bfbdfe5a…` sobre el IDL sin tocar.
5. La forma A **y** la forma B fallan al compilar.
6. Un test de §7.3 no puede escribirse sin tocar un archivo fuera de §4.
7. Alguien te pide correr W6, o desplegar, o mover fondos.
8. Encontrás que hace falta tocar `chaski-v3` o `wasiai-facilitator` para que algo funcione.
9. Descubrís que la respuesta a algo está en `m5-keys/`.
10. Encontrás una afirmación sobre la cadena que no podés fechar con un slot.

---

*Story File generado en F2.5 por nexus-architect. Árbol base
`8fca47294f6cd8e7ecefd330e278e63078957e26`. Mediciones on-chain del 2026-08-10, slots
`482578481`..`482583313`, devnet, sólo lectura. Las 50 citas de §12 verificadas con `python3` contra
ese árbol.*
