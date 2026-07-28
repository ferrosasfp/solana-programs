# Story File — R2b · Re-vendoreo del IDL + re-pin del hash canónico (chaski)

> **REPO: `chaski-v3`** (`/home/ferdev/.openclaw/workspace/chaski-v3`)
> SDD: `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` (§4.10 DT-9, §5 paso R2, gate G5)
> HU: **HU-SOL-20** · Fecha: 2026-07-28 · Wave de release: **R2b**
> Branch sugerida: `feat/hu-sol-20-r2b-escrow-idl-repin`

---

## 0. Prerequisitos y orden

### Qué tiene que estar mergeado ANTES

- **R1** (`solana-programs`) **completo y buildeado**: este story necesita
  `solana-programs/target/idl/escrow.json` ya regenerado con `register_escrow`, `deregister_escrow` y
  la cuenta `EscrowIndex`.
- **R0** (este mismo repo) mergeado — es el paso anterior del release y el escritor de este repo va en
  serie.
- **R2a** (`wasiai-facilitator`) idealmente ya hecho, porque te da el **hash exacto** ya validado. Si
  no está, calculalo vos con §4: tiene que dar el mismo número.

### Daño concreto si se hace al revés (copiado del SDD §5)

> **R2 antes de R1** ⇒ el hash pineado no corresponde a ningún IDL real ⇒ **CI rojo en 2 repos** sin
> ninguna ganancia.

Y en este repo hay un daño extra, propio: **R4 no puede existir sin R2b.** El cliente construye las
instrucciones con `new anchor.Program(escrowIdl, …)` (`src/infrastructure/solana-wallet.ts:114`); si
el IDL vendoreado no tiene `register_escrow`, `program.methods.registerEscrow` **no existe** y R4 no
compila ni corre. R2b es el habilitador técnico de R4, no solo un fix de CI.

Al revés también hay daño: **si R4 se hace sin que R1 esté deployado on-chain**, el programa viejo no
conoce el discriminador ⇒ `InvalidInstructionData` ⇒ **la tx entera falla ⇒ no hay depósito**.

### Qué habilita

**R4** (emitir `register_escrow` + UI de recuperación), siguiente story de este repo.

---

## 1. Goal

Re-vendorear el IDL del escrow y re-pinear su hash canónico en los **3** lugares de este repo, sin
tocar una línea de lógica. A diferencia del facilitator, acá el re-vendoreo **es funcionalmente
necesario**: es la única forma de que el cliente pueda construir la ix `register_escrow` en R4.

---

## 2. Acceptance Criteria

- **AC-R2b-1**: El IDL vendoreado canonicaliza al mismo SHA-256 que
  `solana-programs/target/idl/escrow.json` post-R1, y ese valor es **idéntico** al pineado en
  `wasiai-facilitator` (R2a).
- **AC-R2b-2**: `escrowIdl.address` sigue siendo `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`.
- **AC-R2b-3** (no-regresión crítica): el `deposit` y el `refund` que ya funcionan siguen
  construyéndose **igual**: mismo discriminador, mismas 8 cuentas posicionales + el `reference` como
  remaining. ⇒ `src/infrastructure/solana-wallet.refund.test.ts` y
  `src/infrastructure/solana-wallet.test.ts` verdes **sin editarlos**.
- **AC-R2b-4**: El IDL expone `register_escrow` con las 4 cuentas en el orden fijado por R1
  (`sender`, `escrow_state`, `escrow_index`, `system_program`).

---

## 3. Scope IN — archivos exactos (verificados contra disco el 2026-07-28)

| # | Archivo | Acción | Qué hacer |
|---|---------|--------|-----------|
| 1 | `src/infrastructure/solana/escrow-idl.ts` (397 líneas) | Modificar | Re-vendorear: reemplazar el objeto `escrowIdl` (`:8` → final) por la traducción del `escrow.json` post-R1. **Conservar íntegro el header `:1-7`** (dice que es una COPIA que se copia y no se edita, CD-5, y que el `address` es la única fuente del program id). |
| 2 | `contracts/idl/escrow-idl.hash.test.ts` (23 líneas) | Modificar | Línea **9**: `ESCROW_IDL_SHA256` ⇒ el hash nuevo. Agregar los 2 `it` nuevos de §5. |
| 3 | `contracts/CONTRACT-VERSIONS.md` (61 líneas) | Modificar | Línea **53** (el bloque de código bajo `## ESCROW_IDL_SHA256`, `:51-54`) ⇒ el hash nuevo. Agregar una línea de bitácora: re-pin por **HU-SOL-20** (SDD `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` §4.10), motivo: +2 instrucciones +1 account type. |

> El documento `:60-61` dice literalmente "**Re-pinneo SOLO con SDD explícito**, jamás por drift
> silencioso". Este story **es** ese SDD explícito: citalo en la bitácora para que quede el rastro.

### Fuera de scope (PROHIBIDO)

- `src/infrastructure/solana-wallet.ts` ⇒ construir la ix `register_escrow` es **R4**. Acá el IDL se
  re-vendorea pero **nadie lo usa todavía**.
- El endpoint / port / ledger de R0 (ya mergeados; no los toques).
- `app/api/settle/solana-sponsor/route.ts` ⇒ R4.
- `wasiai-facilitator` ⇒ R2a/R3, otro repo.
- **PROHIBIDO escribir en `solana-programs`**: el sibling se **lee**, jamás se escribe (ya está
  documentado así en `contracts/idl/escrow-idl.hash.test.ts:20`).
- `chaski-v3/m5-keys/` ⇒ **no se abre**.

---

## 4. Cómo se calcula el hash — y las dos formas de calcularlo mal

Algoritmo: `contracts/idl/canonical-hash.ts:7-25` — JSON canónico con **claves ordenadas
recursivamente** + SHA-256 hex. Idéntico al del facilitator.

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
node -e "
const {createHash}=require('crypto'); const fs=require('fs');
function cj(v){ if(Array.isArray(v)) return '['+v.map(cj).join(',')+']';
  if(v!==null&&typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+cj(v[k])).join(',')+'}';
  return JSON.stringify(v); }
const p='../solana-programs/target/idl/escrow.json';
console.log(createHash('sha256').update(cj(JSON.parse(fs.readFileSync(p,'utf8'))),'utf8').digest('hex'));
"
```

**Las dos formas de equivocarse, verificadas en vivo:**

1. **`sha256sum escrow.json` NO sirve**: hashea bytes, no JSON canónico.
2. **Python NO sirve**: `json.dumps` escapa los no-ASCII como `\uXXXX` y `JSON.stringify` no; el IDL
   tiene `docs` con acentos (vienen de los doc-comments en español de `lib.rs`). Probado: mismo
   archivo, hash distinto. Usá Node.

**Punto de partida verificado (pre-R1):** ese comando devuelve hoy
`aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71`, el valor pineado en los 3
lugares. Si al empezar el story **sigue** devolviendo ese valor ⇒ **R1 no buildeó** ⇒ **PARÁ**.

### 4.1 El re-vendoreo tiene que dar el MISMO hash que el JSON

El test AC-2 (`escrow-idl.hash.test.ts:13-15`) compara el **objeto TS** contra la constante; AC-3
(`:19-22`) compara el **JSON del sibling** contra la misma constante. Los dos tienen que coincidir, y
eso solo pasa si la traducción JSON→TS es estructuralmente exacta. El orden de claves no importa (el
algoritmo ordena); una clave omitida o un número vuelto string **sí** rompe.

Traducción determinística (no editar a mano):
```bash
node -e "
const fs=require('fs');
const idl=JSON.parse(fs.readFileSync('../solana-programs/target/idl/escrow.json','utf8'));
fs.writeFileSync('/tmp/idl-body.ts','export const escrowIdl = '+JSON.stringify(idl,null,2)+' as const;\n');
"
```
…pegar el cuerpo debajo del header `:1-7`. **No hay archivo de config de prettier en este repo**
(verificado), así que el formato lo tiene que respetar el `npm run lint` (`next lint`) y `tsc`. El
`as const` final es obligatorio: hoy está (`:397`) y varios consumidores castean desde ese tipo.

---

## 5. Tests

| # | Test | AC | Archivo | Cómo |
|---|------|----|---------|------|
| T-R2b-1 | `canonicalSha256(escrowIdl) === ESCROW_IDL_SHA256` | AC-R2b-1 | `contracts/idl/escrow-idl.hash.test.ts:13-15` | **ya existe**, tiene que quedar verde |
| T-R2b-2 | El sibling canonicaliza al mismo hash | AC-R2b-1 | `ibid.:19-22` | **ya existe** |
| T-R2b-3 | `escrowIdl.address === 'DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x'` | AC-R2b-2 | `ibid.` (+1 `it`) | aserción directa |
| T-R2b-4 | El IDL tiene las 6 instrucciones; `deposit` conserva discriminador `[242,35,198,137,82,225,242,182]` **y sus 8 cuentas en el mismo orden**; `register_escrow` tiene el discriminador reportado por R1 y sus 4 cuentas `[sender, escrow_state, escrow_index, system_program]` | AC-R2b-3 / AC-R2b-4 | `ibid.` (+1 `it`) | ver §5.1 |
| T-R2b-5 | `EscrowState` sigue decodificando igual (`BorshAccountsCoder`) | AC-R2b-3 | `src/infrastructure/solana-wallet.refund.test.ts` | **verde sin editarlo** |
| T-R2b-6 | La ix `deposit` se sigue construyendo igual | AC-R2b-3 | `src/infrastructure/solana-wallet.test.ts` | **verde sin editarlo** |

### 5.1 ⚠️ Un test cuyo doble/fuente aprueba desde arriba es un test vacuo

Dos trampas concretas acá:

1. **`it.skip` silencioso.** `escrow-idl.hash.test.ts:19` usa `(existsSync(SIBLING) ? it : it.skip)`.
   Es correcto para AC-3, **pero** es el mecanismo por el que un test desaparece sin fallar. Después
   de dejar todo verde, corré `npx vitest run contracts/idl` y **verificá en la salida que AC-3 dice
   `✓` y no `↓ skipped`**. Un "todo verde" con AC-3 saltado no prueba paridad con la fuente de verdad.
   T-R2b-3 y T-R2b-4 asertean sobre el IDL **vendoreado** (siempre presente) ⇒ **PROHIBIDO**
   condicionarlos con `existsSync`.
2. **Asertar solo el nombre de la cuenta.** T-R2b-4 tiene que asertar el **orden exacto** de las
   cuentas, no que "existan":
   ```ts
   const ix = (escrowIdl.instructions as ReadonlyArray<{ name: string; discriminator: number[]; accounts: ReadonlyArray<{ name: string }> }>);
   const dep = ix.find((i) => i.name === 'deposit');
   expect(dep?.discriminator).toEqual([242,35,198,137,82,225,242,182]);
   expect(dep?.accounts.map((a) => a.name)).toEqual(
     ['sender','mint','escrow_state','vault','sender_ata','token_program','associated_token_program','system_program'],
   );
   const reg = ix.find((i) => i.name === 'register_escrow');
   expect(reg?.discriminator).toEqual([/* valor REPORTADO por R1 */]);
   expect(reg?.accounts.map((a) => a.name)).toEqual(['sender','escrow_state','escrow_index','system_program']);
   ```
   Ese orden es lo que R3 va a pinear en CR-1 **por posición**. Si acá cambia y nadie lo nota, CR-1
   rechaza la tx en producción y **el depósito no se broadcastea**.

### 5.2 Mutaciones obligatorias

| Mutación | Qué mutar | Test que DEBE ponerse rojo |
|---|---|---|
| M1 | Cambiar un byte del `discriminator` de `deposit` en el IDL vendoreado | T-R2b-1 **y** T-R2b-4 |
| M2 | Cambiar el último dígito de `ESCROW_IDL_SHA256` (`:9`) | T-R2b-1 y T-R2b-2 |
| M3 | Intercambiar dos cuentas de `register_escrow` en el IDL vendoreado | T-R2b-1 y T-R2b-4 |
| M4 | Borrar la clave `address` del objeto | T-R2b-1 y T-R2b-3 |

> ⚠️ **`git diff` no ve archivos sin trackear.** Los 3 archivos de este story existen y están
> trackeados. Pero el archivo temporal donde generás el cuerpo del IDL **no** aparece en el diff: no
> lo uses como prueba de "ya lo cambié". Verificá con
> `sha256sum src/infrastructure/solana/escrow-idl.ts` antes y después de cada mutación, y al revertir.

---

## 6. Constraint Directives

### OBLIGATORIO
- El `address` del IDL es la **única** fuente del program id (CD-15): `solana-wallet.ts:90,173` ya lo
  leen de ahí. No introduzcas un literal.
- Conservar el header `escrow-idl.ts:1-7` íntegro.
- Actualizar el hash en **los 3 lugares** (IDL vendoreado ⇒ implícito, test `:9`, y
  `CONTRACT-VERSIONS.md:53`). Si dejás uno viejo, el drift vuelve por la puerta de atrás.
- `npm run qa` verde (typecheck + typecheck:scripts + tests).
- Fuente de verdad: `solana-programs/target/idl/escrow.json`, **leído**, nunca escrito.

### PROHIBIDO
- **NO** tocar `src/infrastructure/solana-wallet.ts` ⇒ eso es R4.
- **NO** editar `solana-wallet.test.ts` ni `solana-wallet.refund.test.ts` para "que pasen". Si se
  ponen rojos, el re-vendoreo está mal o `EscrowState`/`deposit` cambiaron (violación de CD-7/CD-8 en
  R1) ⇒ **PARAR y escalar**. Es BLOQUEANTE, no un test a ajustar.
- **NO** relajar el lock del hash (ni volverlo `it.skip`, ni comparar solo `address`).
- **NO** cambiar el program id (upgrade in-place).
- **NO** git destructivo. **NO** abrir `m5-keys/`. **NO** agregar dependencias.

---

## 7. Waves

### Wave -1 — Environment Gate
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm run test 2>&1 | tail -5     # ANOTAR el conteo; el lock del IDL debería estar ROJO (esperado)
ls ../solana-programs/target/idl/escrow.json
node -e "const d=require('../solana-programs/target/idl/escrow.json'); console.log(d.instructions.map(i=>i.name).sort(), d.accounts.map(a=>a.name), d.address)"
```
Debe listar **6** instrucciones y `[EscrowState, EscrowIndex]`. Si lista 4 ⇒ **R1 no buildeó** ⇒
**PARAR**.

### Wave 0
- [ ] W0.1 Calcular el hash (§4) y **compararlo con el reportado por R2a**. Si difieren ⇒ **PARAR**:
      uno de los dos repos vendoreó mal.
- [ ] W0.2 Re-vendorear `src/infrastructure/solana/escrow-idl.ts` (header intacto, `as const` final).
- [ ] W0.3 `contracts/idl/escrow-idl.hash.test.ts:9` ⇒ hash nuevo.
- [ ] W0.4 `contracts/CONTRACT-VERSIONS.md:53` ⇒ hash nuevo + bitácora del re-pin.
- [ ] W0.5 Agregar T-R2b-3 y T-R2b-4.
- [ ] **Verificación**: `npm run qa` verde, AC-3 en `✓` (no skipped), y los 2 tests de
      `solana-wallet*` verdes **sin ediciones**.

### Wave 1
- [ ] W1.1 Correr M1..M4 (§5.2).
- [ ] W1.2 Reportar: hash final, confirmación de paridad con R2a, resultado de las mutaciones, y los
      **4 nombres de cuenta de `register_escrow` en orden** (R3 los necesita para pinear CR-1 por
      posición).

---

## 8. Definition of Done

1. `npm run qa` verde; conteo de tests ≥ baseline + 2.
2. Un único hash en los 3 lugares == `canonicalSha256(sibling)` == el pineado en `wasiai-facilitator`.
3. AC-3 corrió (`✓`), no saltado.
4. `solana-wallet.test.ts` y `solana-wallet.refund.test.ts` verdes sin ediciones.
5. `escrowIdl.address` sin cambios; el IDL expone `register_escrow` con sus 4 cuentas en orden.
6. Las 4 mutaciones pusieron rojo lo declarado.
7. Diff limitado a **3 archivos** (`git diff --stat` lo prueba). `solana-wallet.ts` intacto.

---

## 9. Escalation Rule

Si algo no está acá → **PARÁS y preguntás al Architect**.

Escalá si:
- El hash no coincide con el de R2a.
- El sibling tiene 4 instrucciones.
- Cualquier test de `solana-wallet*` se pone rojo (posible violación de CD-7/CD-8 en R1 ⇒ BLOQUEANTE).
- El orden de cuentas de `deposit` en el IDL nuevo **no** es el de T-R2b-4 ⇒ CD-8 violado en R1 ⇒
  **BLOQUEANTE**: rompería CR-1 y con eso el money-path entero.

---

*Story File generado por NexusAgil — F2.5 · nexus-architect · HU-SOL-20 · R2b/7*
