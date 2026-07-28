# Story File — R2a · Re-vendoreo del IDL + re-pin del hash canónico (facilitator)

> **REPO: `wasiai-facilitator`** (`/home/ferdev/.openclaw/workspace/wasiai-facilitator`)
> SDD: `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` (§4.10 DT-9, §5 paso R2, gate G5)
> HU: **HU-SOL-20** · Fecha: 2026-07-28 · Wave de release: **R2a**
> Branch sugerida: `feat/hu-sol-20-r2a-escrow-idl-repin`

---

## 0. Prerequisitos y orden

### Qué tiene que estar mergeado ANTES

- **R1** (`solana-programs`, `story-R1-solana-programs-escrow-index.md`) **completo y buildeado**.
  Este story necesita el artefacto `solana-programs/target/idl/escrow.json` **ya regenerado** con las
  2 instrucciones nuevas y la cuenta `EscrowIndex`.
- R0 ya mergeado (no es dependencia técnica, es el orden del release).

### Daño concreto si se hace al revés (copiado del SDD §5)

> **R2 antes de R1** ⇒ el hash pineado no corresponde a ningún IDL real ⇒ **CI rojo en 2 repos** sin
> ninguna ganancia.

Concretamente: si re-pineás el hash antes de que `anchor build` haya corrido en `solana-programs`,
el test AC-2 (que compara el IDL vendoreado contra la constante) y el test AC-3 (que compara contra
el sibling en disco) apuntan a **tres** valores distintos y **ningún** commit puede quedar verde
hasta que llegue R1. Es CI rojo autoinfligido en dos repos a la vez.

Y al revés: **apenas R1 corra `anchor build`, este repo se pone rojo solo, sin que nadie lo haya
tocado.** Eso es **esperado y documentado** (SDD §4.10), no es una regresión: el test AC-3 compara
contra el sibling `../solana-programs/target/idl/escrow.json`, que en este workspace **existe**
(verificado). R2a es lo que cierra ese rojo, y por eso va **inmediatamente** después de R1, en la
misma ventana.

### Qué habilita

**R3** (extensión de CR-1) es el siguiente story de este mismo repo. Se despacha después, en serie
(un escritor por repo).

---

## 1. Goal

El programa gana 2 instrucciones y 1 tipo de cuenta ⇒ el IDL cambia ⇒ el hash canónico cambia ⇒ el
lock de contrato de este repo se pone rojo. Este story re-vendorea el IDL y re-pinea el hash, **sin
cambiar una sola línea de lógica de runtime**.

Dato importante para no sobre-actuar: este repo **no necesita** las instrucciones nuevas en runtime.
Su único uso del IDL es decodificar la cuenta `EscrowState`
(`src/chains/solana-escrow.ts:164` → `new BorshAccountsCoder(escrowIdl)`), y `EscrowState`
**no cambió**. El re-vendoreo es para mantener la paridad del hash con los otros dos IDL del
ecosistema, no porque haga falta funcionalmente.

---

## 2. Acceptance Criteria

- **AC-R2a-1**: El IDL vendoreado en este repo canonicaliza al mismo SHA-256 que
  `solana-programs/target/idl/escrow.json` post-R1.
- **AC-R2a-2**: `escrowIdl.address` sigue siendo `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`
  (upgrade in-place: el program id **no** cambia).
- **AC-R2a-3** (no-regresión, es lo importante): la decodificación de `EscrowState` sigue funcionando
  idéntica ⇒ `src/__tests__/unit/solana-escrow.read.test.ts` verde **sin editarlo**.
- **AC-6 del SDD** (no-regresión): ninguna lectura o validación existente cambia de comportamiento.

---

## 3. Scope IN — archivos exactos (verificados contra disco el 2026-07-28)

| # | Archivo | Acción | Qué hacer |
|---|---------|--------|-----------|
| 1 | `src/chains/escrow-idl.ts` (406 líneas) | Modificar | Re-vendorear: reemplazar el objeto `escrowIdl` (`:17` → final) por la traducción del `escrow.json` post-R1. **Conservar íntegro el header de comentarios `:1-16`** (el `eslint-disable no-secrets`, la nota histórica del id muerto `BBQ9…79WA` y el comentario AH-12 del discriminador de `EscrowState`). |
| 2 | `src/chains/escrow-idl.hash.test.ts` (36 líneas) | Modificar | Línea **21**: `ESCROW_IDL_SHA256` ⇒ el hash nuevo. **Nada más** en el archivo. |

### Fuera de scope (PROHIBIDO)

- `src/methods/solana-sponsor/cr1.ts` y `deposit-shape.ts` ⇒ **eso es R3**, story aparte con su
  propio AR. Si los tocás acá, contaminás la revisión del núcleo anti-drenaje.
- `src/chains/solana-escrow.ts` — no requiere cambio alguno.
- `src/infra/env.ts` (los caps de CU/fee) ⇒ R3.
- Cualquier archivo de `chaski-v3` o `solana-programs`. **Lectura sí, escritura no.**
- **PROHIBIDO** escribir en `solana-programs` (el sibling se **lee**, jamás se escribe — ya está
  documentado así en `src/chains/escrow-idl.hash.test.ts:11`).

---

## 4. Cómo se calcula el hash — y las dos formas de calcularlo mal

El algoritmo está en `src/chains/canonical-hash.ts` (31 líneas): JSON canónico con **claves
ordenadas recursivamente** + SHA-256 hex. Es idéntico al de `chaski-v3/contracts/idl/canonical-hash.ts`.

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
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

1. **`sha256sum escrow.json` NO sirve.** Hashea los bytes del archivo, no el JSON canónico: el
   indentado y el orden de claves cambian el resultado.
2. **Un script de Python NO sirve.** `json.dumps` escapa los no-ASCII como `\uXXXX` y
   `JSON.stringify` de Node **no**; el IDL tiene `docs` con acentos (viene de los doc-comments en
   español del `lib.rs`). Probado: el mismo archivo da un hash distinto en Python que en Node. Usá
   Node (o directamente `canonicalSha256` del repo).

**Punto de partida verificado (pre-R1):** ese comando devuelve hoy
`aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71`, que es exactamente el valor
pineado en `escrow-idl.hash.test.ts:21`. O sea: **el lock está verde hoy**, y va a estar rojo cuando
llegues (porque R1 buildeó). Si al empezar este story el comando ya devuelve ese valor viejo,
**PARÁ**: significa que R1 no buildeó y estás por pinear un hash que no corresponde a nada.

### 4.1 El re-vendoreo tiene que dar el MISMO hash que el JSON

El test AC-2 (`:24-26`) compara `canonicalSha256(escrowIdl)` (el objeto TS) contra la constante, y
AC-3 (`:29-35`) compara el JSON del sibling contra la misma constante. **Los dos tienen que dar el
mismo número**, y eso solo pasa si la traducción JSON→TS es estructuralmente exacta: mismas claves,
mismos valores, mismos tipos. El orden de las claves **no** importa (el algoritmo las ordena), el
`as const` **no** importa (es solo tipos), pero **una clave omitida o un número convertido a string
sí rompe**.

Forma recomendada de traducir (determinística, sin edición a mano):
```bash
node -e "
const fs=require('fs');
const idl=JSON.parse(fs.readFileSync('../solana-programs/target/idl/escrow.json','utf8'));
fs.writeFileSync('/tmp/idl-body.txt','export const escrowIdl = '+JSON.stringify(idl,null,2)+' as const;\n');
"
```
…y después pegar ese cuerpo debajo del header `:1-16`, y correr `npm run format` (prettier lo pasa a
comillas simples y al estilo del repo, sin alterar la estructura).

---

## 5. Tests

| # | Test | AC | Archivo | Cómo |
|---|------|----|---------|------|
| T-R2a-1 | `canonicalSha256(escrowIdl) === ESCROW_IDL_SHA256` | AC-R2a-1 | `src/chains/escrow-idl.hash.test.ts:24-26` | **ya existe**, solo tiene que quedar verde |
| T-R2a-2 | El sibling canonicaliza al mismo hash | AC-R2a-1 | `ibid.:29-35` | **ya existe** |
| T-R2a-3 | `escrowIdl.address === 'DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x'` | AC-R2a-2 | `ibid.` (agregar 1 `it`) | aserción directa sobre `escrowIdl.address` |
| T-R2a-4 | `EscrowState` sigue decodificando igual | AC-R2a-3 | `src/__tests__/unit/solana-escrow.read.test.ts` | **verde sin editarlo** |
| T-R2a-5 | El IDL contiene las 6 instrucciones y `register_escrow` tiene el discriminador reportado por R1 | trazabilidad | `ibid. escrow-idl.hash.test.ts` (agregar 1 `it`) | ver §5.1 |

### 5.1 ⚠️ El test que se salta solo — la trampa a NO copiar en T-R2a-5

`escrow-idl.hash.test.ts:29` usa `(existsSync(SIBLING) ? it : it.skip)`. Ese patrón es correcto para
AC-3 (el repo puede desplegarse sin el sibling) **pero es exactamente el mecanismo por el que un test
desaparece en silencio en vez de fallar.** T-R2a-5 asertea sobre el IDL **vendoreado** (que está en
este repo, siempre presente) ⇒ **PROHIBIDO** condicionarlo con `existsSync`/`it.skip`:

```ts
it('el IDL vendoreado expone las 6 instrucciones y el discriminador pineado de register_escrow', () => {
  const names = (escrowIdl.instructions as ReadonlyArray<{ name: string }>).map((i) => i.name).sort();
  expect(names).toEqual(['close','deposit','deregister_escrow','refund','register_escrow','release']);
  const reg = (escrowIdl.instructions as ReadonlyArray<{ name: string; discriminator: number[] }>)
    .find((i) => i.name === 'register_escrow');
  expect(reg?.discriminator).toEqual([/* el valor REPORTADO por R1, leído del IDL */]);
});
```

> Y una comprobación de honestidad para T-R2a-2: después de dejar todo verde, corré
> `npm run test -- escrow-idl.hash` y **verificá en la salida que AC-3 dice `✓`, no `↓ skipped`**. Un
> "todo verde" con AC-3 saltado no prueba paridad con la fuente de verdad.

### 5.2 Mutaciones obligatorias

| Mutación | Qué mutar | Test que DEBE ponerse rojo |
|---|---|---|
| M1 | Cambiar un byte del array `discriminator` de `deposit` en el IDL vendoreado | T-R2a-1 (el hash cambia) |
| M2 | Cambiar el último dígito de `ESCROW_IDL_SHA256` (`:21`) | T-R2a-1 **y** T-R2a-2 |
| M3 | Borrar la instrucción `deregister_escrow` del IDL vendoreado | T-R2a-1 y T-R2a-5 |

> ⚠️ **`git diff` no ve archivos sin trackear.** Acá los 2 archivos existen y están trackeados, así
> que `git diff` sí funciona. Pero si generás el cuerpo del IDL en un archivo temporal nuevo,
> ese temporal **no** aparece en el diff: no lo uses como fuente de verdad de "ya lo cambié". Verificá
> con `sha256sum src/chains/escrow-idl.ts`.

---

## 6. Constraint Directives

### OBLIGATORIO
- El `address` del IDL es la **única** fuente del program id (CD-15). No lo edites a mano ni copies un
  literal de otro lado: viene del JSON generado por `anchor build`.
- Conservar el header de comentarios `escrow-idl.ts:1-16` **íntegro**, incluida la nota histórica del
  id muerto `BBQ9…79WA` (si se pierde, alguien va a resucitar ese id: ya pasó).
- `npm run qa` (typecheck + lint + format:check + test) verde. El re-vendoreo tiene que pasar
  prettier y el `eslint no-secrets` (de ahí el disable del header).
- Fuente de verdad del IDL: `solana-programs/target/idl/escrow.json`, **leído**, nunca escrito.

### PROHIBIDO
- **NO** tocar `cr1.ts`, `deposit-shape.ts` ni `env.ts` ⇒ eso es R3.
- **NO** tocar `src/chains/solana-escrow.ts`.
- **NO** editar `src/__tests__/unit/solana-escrow.read.test.ts` para "que pase". Si se pone rojo, el
  re-vendoreo está mal (o `EscrowState` cambió, que sería una violación de CD-7 en R1) ⇒ **PARAR y
  escalar**.
- **NO** relajar el test del hash (por ejemplo comparando solo `address`, o volviéndolo `it.skip`).
- **NO** cambiar el program id. Es un upgrade in-place.
- **NO** git destructivo. **NO** abrir `chaski-v3/m5-keys/`.
- **NO** agregar dependencias.

---

## 7. Waves

### Wave -1 — Environment Gate
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
npm run test 2>&1 | tail -5     # ANOTAR el conteo; el lock del IDL debería estar ROJO (esperado)
ls ../solana-programs/target/idl/escrow.json
node -e "const d=require('../solana-programs/target/idl/escrow.json'); console.log(d.instructions.map(i=>i.name).sort(), d.accounts.map(a=>a.name), d.address)"
```
Debe listar **6** instrucciones y las cuentas `EscrowState` + `EscrowIndex`. Si lista 4 ⇒ **R1 no
buildeó** ⇒ **PARAR** y reportar: pinear ahora sería pinear un hash del pasado.

### Wave 0
- [ ] W0.1 Calcular el hash nuevo con node (§4). Anotarlo.
- [ ] W0.2 Re-vendorear `src/chains/escrow-idl.ts` (header intacto).
- [ ] W0.3 `escrow-idl.hash.test.ts:21` ⇒ hash nuevo.
- [ ] W0.4 Agregar T-R2a-3 y T-R2a-5.
- [ ] **Verificación**: `npm run qa` verde, con AC-3 en `✓` (no skipped), y `solana-escrow.read.test.ts`
      verde **sin haberlo editado**.

### Wave 1
- [ ] W1.1 Correr M1..M3 (§5.2): mutar → test → anotar el rojo → revertir → `sha256sum`.
- [ ] W1.2 Reportar al orquestador: el hash nuevo **exacto** (R2b necesita ese mismo valor) y el
      resultado de las mutaciones.

---

## 8. Definition of Done

1. `npm run qa` verde. Conteo de tests ≥ baseline + 2.
2. El hash pineado == `canonicalSha256` del sibling post-R1 == `canonicalSha256(escrowIdl)`.
3. AC-3 corrió (`✓`), no saltado.
4. `solana-escrow.read.test.ts` verde sin ediciones.
5. `escrowIdl.address` sin cambios.
6. Las 3 mutaciones pusieron rojo lo declarado.
7. Diff limitado a **2 archivos**. `cr1.ts` y `deposit-shape.ts` intactos (`git diff --stat` lo prueba).
8. El hash nuevo reportado al orquestador para R2b.

---

## 9. Escalation Rule

Si algo no está acá → **PARÁS y preguntás al Architect**.

Escalá si:
- El sibling tiene 4 instrucciones (R1 no buildeó).
- `canonicalSha256(escrowIdl) !== canonicalSha256(sibling)` después de re-vendorear ⇒ la traducción
  JSON→TS perdió algo. No "ajustes" la constante para que cierre uno de los dos: eso rompe el lock.
- `solana-escrow.read.test.ts` se pone rojo ⇒ posible violación de CD-7 en R1 (`EscrowState` cambió).
  **Es BLOQUEANTE**, no un test a arreglar.

---

*Story File generado por NexusAgil — F2.5 · nexus-architect · HU-SOL-20 · R2a/7*
