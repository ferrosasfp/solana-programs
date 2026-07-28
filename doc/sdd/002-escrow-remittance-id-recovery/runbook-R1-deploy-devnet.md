# Runbook R1 — upgrade in-place del programa `escrow` en devnet (HU-SOL-20)

> **F3 NO EJECUTA ESTE RUNBOOK.** El paso 2 (deploy) es el gate **G1** del SDD §10 y lo ejecuta el
> **founder**. F3 (nexus-dev) escribió el código, buildeó y testeó local; **cero** transacciones
> on-chain (CD-19, CD-5: devnet only, nunca mainnet).

- **Program id (NO cambia — upgrade in-place)**: `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`
- **Qué agrega este upgrade**: 2 instrucciones (`register_escrow`, `deregister_escrow`) + 1 cuenta
  nueva (`EscrowIndex`) + 1 error nuevo (`EscrowIndexFull` = 6005).
- **Qué NO toca**: `EscrowState`, `deposit`, `release`, `refund`, `close`. Los 4 discriminadores y
  las 4 listas de cuentas viejas son **idénticos** (se verifica en el **paso 0**, antes de deployar).

## Orden obligatorio de los pasos

```
0 (rebuild + verificación del artefacto)  →  1 (tamaño)  →  2 (deploy, gate G1)  →  3 (post-check)  →  5 (R2a/R2b/R3)
                                                                                      └─ 4 (rollback) solo si 3 falla
```

El orden **no es cosmético**:

| Orden | Por qué no se puede invertir |
|---|---|
| 0 antes que todo | El paso 2 deploya el binario que hay en `target/deploy/`. `anchor deploy` **no compila** (no tiene `--skip-build`, a diferencia de `anchor test`): ships lo que encuentra. Verificar el artefacto **después** del deploy no sirve de nada. |
| 0 antes de 1 | El tamaño que hay que comparar contra el `Data Length` on-chain es el del `.so` **reconstruido**, no el del que estaba en disco. |
| 1 antes de 2 | Si el binario no entra en el espacio asignado, el deploy puede fallar a mitad de la ventana. |
| pre-flight de 2 antes de 2 | Si la wallet local no es la upgrade authority, el deploy falla **después** de haber escrito el buffer y quemado SOL. |
| 3 después de 2 | Es el único paso que mira la **cadena**; el paso 0 ya cubrió los archivos locales. |
| R1 antes de R3/R4 | Un `register_escrow` contra el programa viejo tumba la tx entera (`InvalidInstructionData`). SDD §5. |

---

## ⛔ 0. Rebuild desde HEAD limpio + verificación del ARTEFACTO (OBLIGATORIO)

### Por qué existe este paso

**Incidente real (2026-07-27):** para probar que el canario de los 154 bytes funciona, se mutó
`EscrowState` agregándole un `pub _pad: u8`, se corrió `anchor build`, se confirmó el test rojo y se
**restauró `lib.rs`** — pero **nunca se recompiló**. `target/` quedó con el `.so`, el IDL y los tipos
del **mutante**, y `git status` estaba limpio porque `target/` está gitignoreado. Correr este runbook
en ese estado deployaba el programa mutante y **ladrillaba todos los escrows vivos**
(`AccountDidNotDeserialize` 3003 en `release`/`refund`/`close` de cualquier cuenta de 154 bytes ya
existente): exactamente el desastre que el canario existe para prevenir, causado por verificar el
canario.

Conclusión, y es la razón de ser de este paso: **el fuente limpio no prueba nada sobre el binario.**
Lo que se deploya es el artefacto. El artefacto es lo que hay que verificar.

**No borres este paso.** No es burocracia: es el único punto del runbook que separa "el código está
bien" de "el binario que estoy por deployar está bien".

### 0.1 El árbol tiene que estar limpio y en el commit que se pretende deployar

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export REPO="${REPO:-$HOME/.openclaw/workspace/solana-programs}"
cd "$REPO"

git status --porcelain          # DEBE salir VACÍO (target/ y node_modules/ están gitignoreados)
git rev-parse HEAD              # anotá este sha: es el commit que se deploya
git rev-parse HEAD:programs     # DEBE ser 014b53676ffc91b9ecab1edc0b0bb3ad8e59eaae
```

**ABORTAR si:**

- `git status --porcelain` imprime **cualquier cosa** ⇒ hay fuente no commiteado. No se deploya un
  binario de un fuente que no está en la historia: si después hay que rollbackear o auditar, no
  existe el commit al que volver.
- `git rev-parse HEAD:programs` **no** es `014b53676ffc91b9ecab1edc0b0bb3ad8e59eaae` ⇒ el fuente de
  `programs/` no es el que produjo los artefactos de referencia de este runbook. Ese es el hash del
  **árbol `programs/`**, no del commit: no cambia cuando se commitean docs (es idéntico en `a04bdc0`
  y en `00fef7f`), y cambia apenas se toca una línea de `programs/`. Si difiere, o estás en otro
  commit, o alguien tocó el programa: **paralo y revisá el diff**, no rebuildees a ciegas.

### 0.2 Rebuild forzado (esto es lo que descontamina `target/`)

El punto es **recompilar siempre**, sin razonar si hace falta: en el incidente no hubo un build que
saliera mal, hubo un build que **no se corrió**.

El `touch` está para que el rebuild no dependa de cómo se restauró el fuente. `anchor build` es
incremental y cargo fingerprintea por mtime: normalmente, restaurar el archivo lo deja con mtime
nueva y el rebuild se dispara solo. Pero si el fuente se restauró de una forma que le deja una mtime
**más vieja** que el artefacto (`cp -p` de un backup, extraer un tar, ciertos editores), cargo lo
considera al día y no relinkea nada. `touch` elimina esa duda y regenera los **tres** artefactos
(`.so`, IDL, tipos TS). Cuesta 2 segundos; equivocarse cuesta un programa ladrillado.

```bash
cd "$REPO"
touch programs/escrow/src/lib.rs
anchor build
```

> `touch` no modifica el contenido del archivo (solo la mtime) ⇒ `git status` sigue limpio.
> **No uses `anchor clean` / `cargo clean`**: borran `target/` y el runbook no verificó si preservan
> `target/deploy/escrow-keypair.json`. Perder ese keypair es el antecedente `BBQ9…79WA` de este mismo
> repo (`README.md:18-23`). El `touch` alcanza y no toca nada más.

### 0.3 Verificar el ARTEFACTO (no el fuente)

**a) Hash canónico del IDL** — tiene que dar exactamente
`4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b`:

```bash
cd "$REPO"
node -e '
const fs = require("fs"), c = require("crypto");
const sort = (v) => Array.isArray(v) ? v.map(sort)
  : (v && typeof v === "object") ? Object.keys(v).sort().reduce((a,k)=>(a[k]=sort(v[k]),a),{})
  : v;
const idl = JSON.parse(fs.readFileSync("target/idl/escrow.json","utf8"));
console.log(c.createHash("sha256").update(JSON.stringify(sort(idl))).digest("hex"));
'
```

> ⚠️ **Este hash NO se calcula con `sha256sum` ni con Python.** Es SHA-256 sobre JSON canónico
> (claves ordenadas recursivamente) serializado con `JSON.stringify` de **Node**, sin indentación.
> Ese es el `canonicalSha256` que los dos repos hermanos pinean
> (`wasiai-facilitator/src/chains/canonical-hash.ts`, `chaski-v3/contracts/idl/canonical-hash.ts`,
> según `story-R1-solana-programs-escrow-index.md:542-548`) y el que R2a/R2b tienen que re-pinear.
> El one-liner de arriba no copia esos archivos (viven en otros repos): reproduce el algoritmo y
> **coincide exactamente** con el valor esperado, que es la única prueba que importa.
> - `sha256sum target/idl/escrow.json` da `350f53a4…`: es el hash del **archivo** (formato y orden de
>   claves incluidos), sirve como sello local pero **no** es el valor pineado.
> - Python **tampoco**: `json.dumps` escapa los no-ASCII como `\uXXXX` y `JSON.stringify` no. El IDL
>   tiene `docs` con acentos ⇒ `json.dumps(..., sort_keys=True, separators=(',',':'))` da
>   `a8d6adc4…` en lugar de `4bcc34a9…`. (Medido en esta build: solo coincide si le pasás
>   `ensure_ascii=False`, que nadie se acuerda de pasar. Usá Node.)

**b) `EscrowState` tiene exactamente sus 8 campos y ni uno más** — este es el guard del incidente:

```bash
cd "$REPO"
node -e '
const idl = require("./target/idl/escrow.json");
const exp = ["sender","beneficiary","authority","mint","amount","deadline","status","bump"];
const got = idl.types.find((x) => x.name === "EscrowState").type.fields.map((f) => f.name);
console.log("EscrowState fields:", JSON.stringify(got));
if (JSON.stringify(got) !== JSON.stringify(exp)) {
  console.error("ABORT: EscrowState cambio -> NO DEPLOYAR (ladrilla los escrows vivos)");
  process.exit(1);
}
const disc = idl.accounts.find((a) => a.name === "EscrowState").discriminator;
if (JSON.stringify(disc) !== JSON.stringify([19,90,148,111,55,130,229,108])) {
  console.error("ABORT: discriminador de EscrowState cambio -> NO DEPLOYAR");
  process.exit(1);
}
console.log("OK: EscrowState = 8 campos exactos, discriminador intacto");
'
```

Tiene que imprimir `OK: …` y salir con código 0. Si sale 1, **el deploy se cancela acá**: agregar o
quitar un campo de `EscrowState` **no** cambia su discriminador (se hashea solo el nombre del
struct), así que el discriminador solo no te protege — el conteo de campos sí.

**c) El `.so`**:

```bash
cd "$REPO"
stat -c%s target/deploy/escrow.so                       # 262568
nm -D --defined-only target/deploy/escrow.so            # EXACTAMENTE 2: T custom_panic, T entrypoint
nm -D -u target/deploy/escrow.so | awk '{print $2}' | sort | tr '\n' ' '
# esperado (12 syscalls, ni uno más):
# abort sol_create_program_address sol_get_clock_sysvar sol_get_rent_sysvar sol_invoke_signed_rust
# sol_log_ sol_log_pubkey sol_memcpy_ sol_memmove_ sol_memset_ sol_panic_ sol_try_find_program_address

# el .so tiene que contener el código NUEVO (guard contra deployar un .so viejo/stale)
for s in escrow-index RegisterEscrow DeregisterEscrow; do
  if strings -a target/deploy/escrow.so | grep -qF -- "$s"; then
    echo "OK      $s presente en el .so"
  else
    echo "ABORT   falta '$s' en el .so -> es un binario pre-HU-SOL-20"
  fi
done
```

Cualquier línea `ABORT` (o un conteo de símbolos distinto) ⇒ **no deployes**. El loop no corta solo:
leé las tres líneas.

> **Honestidad sobre qué NO detecta esto:** los nombres de **campo** de los structs no viven en el
> `.so` (verificado en esta build: `strings` no encuentra `EscrowState`, ni `deadline`, ni `_pad`).
> Es decir: **no podés cazar el mutante grepeando el `.so`.** Sí aparecen los nombres de los
> *Contexts* (`RegisterEscrow`, …) y las seeds (`escrow-index`), que es lo que chequea el loop de
> arriba. El chequeo del layout contra el binario real es el 0.4.

### 0.4 El canario, corrido contra el `.so` que se va a deployar

Esto es lo decisivo. `solana-bankrun` (`startAnchor`) carga **`target/deploy/escrow.so`** — el mismo
archivo del paso 2 — así que T1a (`escrow_state` de exactamente 154 bytes) es una aserción sobre el
**artefacto**, no sobre el fuente. `--skip-build` es a propósito: garantiza que se testea el binario
ya construido en 0.2 y no uno re-linkeado en el medio.

```bash
cd "$REPO"
anchor test --skip-build --skip-deploy --skip-local-validator 2>&1 \
  | grep -Ev '^\[20' | grep -E '1a\. CANARY|1b\.|4a\.|passing|failing'
```

Esperado (23 tests, cero rojos):

```
✔ 1b. a hand-built 154-byte legacy escrow_state is still refundable by the new program (AC-6)
✔ 4a. IDL: exactly 6 instructions, and neither new instruction takes an `authority` account (AC-5/CD-1)
✔ 1a. CANARY: a deposit produces an escrow_state of EXACTLY 154 bytes (AC-6/CD-7)
23 passing
```

El `grep -Ev '^\[20'` está para tirar el log DEBUG del runtime, que son ~1000 líneas. Si querés el
detalle de un fallo, corré el comando sin el pipe.

**Si T1a está rojo: NO DEPLOYES.** Un T1a rojo significa que el `.so` en disco allocó un
`escrow_state` de un tamaño distinto de 154 ⇒ ese binario ladrilla los escrows vivos.

### 0.5 Sellar el artefacto (para que lo que se testeó sea lo que se deploya)

Entre 0.4 y el deploy pueden pasar horas. Sellá el binario y re-verificá el sello **justo antes** de
correr el paso 2:

```bash
export BK="$HOME/escrow-rollback"; mkdir -p "$BK"
# OJO: path ABSOLUTO a propósito. `sha256sum` guarda en el archivo el path tal como se lo pasás;
# si le pasás uno relativo, el `-c` de abajo solo funciona desde $REPO.
sha256sum "$REPO/target/deploy/escrow.so" | tee "$BK/escrow-NEW.so.sha256"
# esperado en esta build: dc0ba21a5a620ef5dd1546c2c9e86eb6d00f9ca438e97bb4e2a5fa09819a8960

# ...inmediatamente antes del paso 2, desde cualquier cwd:
sha256sum -c "$BK/escrow-NEW.so.sha256"     # tiene que decir "OK"
```

El sello va en `$HOME`, **no en `/tmp`**: si la ventana de deploy cruza un reboot, `/tmp` se limpia y
te quedás sin con qué comparar. El archivo guarda el path absoluto del `.so`, así que el `-c` funciona
desde cualquier cwd.

Si el sello **falla**, alguien rebuildeó o mutó el `.so` desde que lo testeaste ⇒ volvé a 0.2.

### ⚠️ Aviso a quien vaya a mutar `EscrowState` en el futuro

Mutar `EscrowState` (o cualquier cosa de `programs/`) para verificar que el canario T1a realmente
falla es una práctica **buena y recomendada**. Lo que la hace peligrosa es el final:

1. `git status` limpio **no** significa `target/` limpio: `target/` está gitignoreado, y ahí viven el
   `.so`, el IDL y los tipos que se deployan y que consumen los repos hermanos.
2. Restaurar el fuente **no** descontamina `target/`. Verificar el `sha256sum` del **fuente**
   tampoco: prueba lo único que no hace falta probar.
3. Después de revertir la mutación, **rebuildeá siempre** (`touch programs/escrow/src/lib.rs &&
   anchor build`) y re-verificá el **artefacto** con el paso 0.3 completo. No es opcional y no
   depende de si "vas a deployar hoy": el próximo que corra este runbook o `anchor deploy` hereda tu
   `target/`.

---

## Artefactos de esta build (referencia)

| Artefacto | Valor |
|---|---|
| `programs/` — tree hash del fuente que los produjo | `014b53676ffc91b9ecab1edc0b0bb3ad8e59eaae` |
| `target/deploy/escrow.so` — tamaño | **262 568 bytes** |
| `target/deploy/escrow.so` — sha256 | `dc0ba21a5a620ef5dd1546c2c9e86eb6d00f9ca438e97bb4e2a5fa09819a8960` |
| `target/idl/escrow.json` — sha256 (archivo) | `350f53a44aa8a2ee2afa44bb3a203408225fee65fcba35cc773d749e0ee07bc7` |
| `target/idl/escrow.json` — **canonicalSha256** (el que se pinea) | `4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b` |

Los 4 valores se midieron tres veces sobre ese mismo tree hash, en esta máquina y con este toolchain
(`anchor-cli 1.1.2`, `solana-cli 3.1.10`, `node v22.22.0`): sobre los artefactos que ya estaban en
disco, después de un `anchor build` incremental, y después de un rebuild **forzado** con `touch` (que
regeneró los tres artefactos — mtime posterior confirmada). Las tres mediciones dieron **byte a byte
idéntico**.

> ⚠️ Eso vale **en esta máquina**. Los builds de Rust no son bit-a-bit reproducibles entre entornos:
> si buildeás en otra máquina o con otro toolchain, el sha256 y el tamaño del `.so` pueden cambiar
> legítimamente. En ese caso el sello de 0.5 sigue siendo válido (es tu propia build), y el que manda
> como criterio de aceptación es **0.3.b + 0.4**, no el hash del `.so`.
>
> El `canonicalSha256` del IDL, en cambio, **sí** es determinístico dado el fuente (se genera del
> AST, no del linker): si ese cambia, cambió el contrato.

**Dato heredado de la build anterior (medido por F3, NO re-verificado en esta pasada):** el `.so`
pre-HU-SOL-20 pesaba 229 624 bytes (⇒ +32 944), y su `canonicalSha256` era
`aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71` — el valor que hoy sigue pineado
en `wasiai-facilitator` y `chaski-v3` y que R2a/R2b tienen que reemplazar.

---

## 1. Pre-check de tamaño (footgun real: el `.so` creció ~33 KB)

Si el binario nuevo no entra en el espacio ya asignado al programa, el deploy puede **fallar a mitad
de la ventana**. Chequealo **antes** de deployar.

```bash
cd "$REPO"
SO_BYTES=$(stat -c%s target/deploy/escrow.so); echo "so=$SO_BYTES"    # 262568 en esta build

# tamaño ASIGNADO on-chain hoy (campo "Data Length" del programData)
solana program show --url devnet DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

> Todos los comandos `solana` de este runbook que **tocan la red** llevan `--url devnet`
> **explícito** a propósito (el runbook anterior dependía de un `solana config set` hecho una vez en
> el paso 1). La config global de `solana` es estado mutable de la máquina: cualquier otra
> herramienta, script o sesión pudo haberla cambiado entre el paso 1 y el paso 4, y un rollback
> apuntado al cluster equivocado es un incidente, no un typo.

Decisión (comparando contra `$SO_BYTES`, no contra el literal):

- `Data Length` **≥ $SO_BYTES** ⇒ no hace falta nada, seguí al paso 2.
- `Data Length` **< $SO_BYTES** ⇒ extender **antes** de deployar. Pedí margen para futuras HUs
  (R5 y siguientes), no lo justo:

```bash
# <bytes> = cuántos bytes ADICIONALES agregar (NO el total). Sintaxis: extend <PROGRAM_ID> <ADDITIONAL_BYTES>.
# Ej.: si Data Length = 240000 y SO_BYTES = 262568, faltan 22568 ⇒ pedir 65536 deja headroom.
solana program extend --url devnet DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x <bytes>
```

> **Nota de F3 (hipótesis, NO verificada on-chain):** `solana program deploy` suele asignar
> ~2× el tamaño del `.so` original, lo que daría ~459 KB y haría innecesario el `extend`.
> **No lo asumas** — F3 no consultó la cadena por diseño; leé el `Data Length` real.

> **Dato del CLI local (verificado en el `--help`, NO en la cadena):** `solana program deploy` de
> `solana-cli 3.1.10` **auto-extiende por defecto** (existe `--no-auto-extend` para desactivarlo) y
> su `--max-len` por defecto es "the length of the original deployed program". O sea: el `extend`
> manual probablemente sea innecesario con este CLI. Aun así el pre-check no se saltea: el
> auto-extend consume SOL adicional y puede fallar por fondos, y **no está verificado** si
> `anchor deploy` le pasa o no `--no-auto-extend` al `solana program deploy` subyacente.

Antecedente del repo: el id anterior `BBQ9…79WA` **nunca se deployó y su keypair se perdió**
(`README.md:18-23`). **El deploy de este programa no se improvisa.**

---

## 2. Deploy — GATE HUMANO (G1)

⛔ **Este paso lo corre el founder, no un agente.** Pre-requisito: paso 0 completo y **verde**.

### 2.a Pre-flight (todo esto ANTES del deploy, no después)

```bash
export REPO="${REPO:-$HOME/.openclaw/workspace/solana-programs}"
export BK="$HOME/escrow-rollback"
cd "$REPO"                                   # OBLIGATORIO: scripts/deploy-devnet.sh no hace `cd`, y
                                             # `anchor` tiene que correr dentro del workspace Anchor
                                             # (el que tiene Anchor.toml) o no encuentra el programa.
sha256sum -c "$BK/escrow-NEW.so.sha256"      # el sello de 0.5 tiene que decir OK

# la wallet que va a firmar el upgrade tiene que SER la upgrade authority del programa
solana address                               # esperado: 4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH
solana balance --url devnet                  # tiene que alcanzar para el buffer + (posible) extend
```

`solana address` no lleva `--url` porque no toca la red: imprime la pubkey de la keypair configurada
en `~/.config/solana/cli/config.yml`. Ojo con esto: `Anchor.toml:22` declara
`[provider].wallet = "~/.config/solana/id.json"`, que es el default del CLI pero **no es lo mismo**
que el `keypair_path` de tu `config.yml` si alguna vez lo cambiaste. Si difieren, `solana address` te
muestra una wallet y `anchor deploy` firma con otra. Verificá las dos antes de deployar.

Si `solana address` no es la upgrade authority esperada, **no corras el deploy**: falla igual, pero
recién después de haber escrito el buffer y quemado SOL.

### 2.b Backup del binario actual (el rollback del paso 4 depende de esto)

```bash
export BK="$HOME/escrow-rollback"; mkdir -p "$BK"
test -e "$BK/escrow-PREV.so" && echo "OJO: ya existe un backup, movelo antes de sobreescribirlo"
solana program dump --url devnet DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x "$BK/escrow-PREV.so"
sha256sum "$BK/escrow-PREV.so" | tee "$BK/escrow-PREV.so.sha256"
ls -l "$BK"
```

> - **No uses `/tmp` para esto.** `/tmp` se limpia en el reboot; si el rollback hace falta dos días
>   después, el binario al que volver no existe más.
> - ⛔ **Nunca corras este `dump` DESPUÉS del deploy.** Sobreescribiría `escrow-PREV.so` con el
>   binario **nuevo** y el punto de retorno se pierde para siempre. Si vas a hacer un segundo
>   upgrade más adelante, movete el backup viejo a otro nombre primero.
> - El archivo dumpeado suele traer el **padding** del espacio asignado on-chain ⇒ puede pesar más
>   que el `.so` original. Es esperado, no lo "arregles" truncándolo. *(No verificado on-chain en
>   esta pasada.)*

### 2.c Deploy (upgrade **in-place**, mismo program id, misma upgrade authority)

```bash
cd "$REPO"
./scripts/deploy-devnet.sh
```

> **Qué hace realmente el script** (`scripts/deploy-devnet.sh`): `solana config set --url devnet` +
> `anchor deploy --provider.cluster devnet`. Tres cosas que el runbook anterior no decía:
> 1. **Muta la config global** de `solana` (la deja en devnet). Tenelo en cuenta si después corrés
>    algún `solana` sin `--url`.
> 2. `anchor deploy` de `anchor-cli 1.1.2` **sube también el IDL on-chain por defecto** (existe
>    `--no-idl` para evitarlo; verificado en el `--help`). O sea: el `target/idl/escrow.json`
>    contaminado también se publica ⇒ otra razón por la que 0.3.a/0.3.b son bloqueantes. Esa subida
>    es una tx aparte del upgrade del programa: **puede fallar sola** y dejarte el programa nuevo con
>    el IDL viejo on-chain. Si pasa, es recuperable (`anchor idl upgrade`) y **no** afecta a los
>    fondos. *(El comportamiento del `--help` está verificado; la subida en devnet no se ejecutó.)*
> 3. `anchor deploy` **no compila**. Deploya el `target/deploy/escrow.so` que ya está en disco. Por
>    eso existe el paso 0.

---

## 3. Post-check (esto sí mira la CADENA)

```bash
# sigue executable, mismo programData, misma upgrade authority, Data Length >= $SO_BYTES
solana program show --url devnet DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

Upgrade authority esperada: `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` (EOA fee-payer de
devnet; CD-7 / HU-SOL-19 la migran antes de mainnet).

Si el script subió el IDL, el IDL on-chain se compara así:

```bash
cd "$REPO"
anchor idl fetch --provider.cluster devnet DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  > /tmp/escrow-onchain-idl.json
node -e '
const fs = require("fs"), c = require("crypto");
const sort = (v) => Array.isArray(v) ? v.map(sort)
  : (v && typeof v === "object") ? Object.keys(v).sort().reduce((a,k)=>(a[k]=sort(v[k]),a),{})
  : v;
for (const p of ["target/idl/escrow.json", "/tmp/escrow-onchain-idl.json"]) {
  const h = c.createHash("sha256").update(JSON.stringify(sort(JSON.parse(fs.readFileSync(p,"utf8"))))).digest("hex");
  console.log(h, p);
}
'
```

Los dos hashes deberían dar `4bcc34a9…` (el canónico ordena claves, así que un re-serializado del
`fetch` no debería moverlo). ⚠️ **Este bloque entero es el menos verificado del runbook**: la sintaxis
de `anchor idl fetch [OPTIONS] <PROGRAM_ID>` está confirmada en el `--help` del CLI local, pero la
**ejecución no se probó** (requiere RPC de devnet y que la cuenta de IDL exista on-chain), y por lo
tanto tampoco se probó que el hash del IDL fetcheado coincida. Tratalo como diagnóstico, no como
criterio de aceptación. Si `fetch` devuelve vacío o error, lo más probable es que el IDL nunca se haya
subido: no es una regresión del programa y se resuelve con `anchor idl init` / `anchor idl upgrade`.

La verificación **del contenido del IDL local** (6 instrucciones, discriminadores viejos intactos,
`EscrowIndexFull` = 6005) es parte del **paso 0**, no de acá: post-deploy, inspeccionar el archivo
local ya no te dice nada sobre lo que se deployó. Por completitud, el detalle esperado del IDL local:

```bash
cd "$REPO"
python3 - <<'EOF'
import json; d=json.load(open('target/idl/escrow.json'))
print(sorted(i['name'] for i in d['instructions']))
print({i['name']: i['discriminator'] for i in d['instructions']})
print([a['name'] for a in d['accounts']], [(e['code'],e['name']) for e in d['errors']])
EOF
```

*(Python acá es legítimo: es una inspección, no el cálculo del hash canónico. Ver el aviso de 0.3.a.)*

Debe imprimir exactamente:

- 6 instrucciones: `close, deposit, deregister_escrow, refund, register_escrow, release`
- **sin cambios** (regresión BLOQUEANTE si difieren):
  - `deposit`  = `[242, 35, 198, 137, 82, 225, 242, 182]`
  - `release`  = `[253, 249, 15, 206, 28, 127, 193, 241]`
  - `refund`   = `[2, 96, 183, 251, 63, 208, 46, 46]`
  - `close`    = `[98, 165, 201, 177, 108, 65, 206, 96]`
- nuevas:
  - `register_escrow`   = `[200, 17, 194, 170, 224, 144, 127, 166]`
  - `deregister_escrow` = `[226, 232, 192, 96, 102, 196, 211, 162]`
- cuentas: `['EscrowIndex', 'EscrowState']` (en ese orden en el IDL buildeado)
  (`EscrowState` disc = `[19, 90, 148, 111, 55, 130, 229, 108]`, **sin cambios**;
  `EscrowIndex` disc = `[55, 105, 102, 30, 12, 158, 174, 239]`)
- errores `6000..6005`, con `EscrowIndexFull` = **6005** y los 5 anteriores en su código original.

### Smoke on-chain (opcional, después del gate)

Los escrows **pre-upgrade cuyo `remittanceId` se conserve** deben seguir operando igual (AC-6, sin
migración). El equivalente determinístico ya está cubierto local por los tests `1a`, `1b` y los 9
originales. Si querés confirmarlo en devnet, usá un escrow de prueba propio: **no** toques el
escrow `BmHDdjKL…` (Scope OUT, AC-7 — su `remittanceId` nunca se guardó y **no se va a rescatar**).

---

## 4. Rollback

El upgrade es in-place, así que el rollback es un redeploy del `.so` anterior con la misma upgrade
authority:

```bash
export BK="$HOME/escrow-rollback"
sha256sum -c "$BK/escrow-PREV.so.sha256"     # confirmar que la copia está intacta (funciona desde cualquier cwd)
solana program deploy \
  --url devnet \
  --program-id DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  "$BK/escrow-PREV.so"
```

`--program-id` acepta la pubkey en base58 para **upgrades** (para deploys iniciales tiene que ser un
signer); la upgrade authority por defecto es la keypair configurada, así que `solana address` tiene
que seguir siendo `4wPhH4d…`. *(Sintaxis verificada en el `--help` del CLI local; el rollback no se
ejecutó.)*

Notas:

- El rollback **no** borra las cuentas `EscrowIndex` que se hayan creado mientras el programa nuevo
  estuvo vivo: quedan como cuentas huérfanas del programa (sin fondos, solo rent del `sender`). El
  programa viejo simplemente no las conoce. No hay pérdida de fondos.
- El rollback **no** revierte el IDL on-chain: `solana program deploy` no toca la cuenta de IDL (eso
  lo hace `anchor`). Si el paso 2 subió el IDL nuevo, después de rollbackear el programa el IDL
  on-chain queda **adelantado** respecto al binario. Los clientes que pinean el IDL vendoreado (R2a/
  R2b) no se enteran; el que resuelva el IDL desde la cadena, sí.
- Un `register_escrow` emitido **contra el programa viejo** falla con `InvalidInstructionData` y
  tumba la tx entera. Por eso el orden R1 → R3/R4 no es negociable (SDD §5): el cliente no debe
  emitir la instrucción nueva antes de que exista on-chain.
- `EscrowState` no cambió, así que ni el upgrade ni el rollback afectan a los escrows existentes.

---

## 5. Después del deploy

- **R2a / R2b**: re-pinear el `canonicalSha256` del IDL a
  `4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b` en `chaski-v3` y
  `wasiai-facilitator`. Hasta que eso pase, el test de hash de esos repos queda **rojo a propósito**
  (esperado, no es una regresión).
- **R3**: pinear el discriminador de `register_escrow`
  (`[200, 17, 194, 170, 224, 144, 127, 166]`) en el facilitator.
  Dato medido por F3 (T11) para dimensionar el compute budget de la tx atómica
  `deposit + register_escrow`: **52 826 – 79 826 CU** en 28 corridas (no es una constante: varía en
  pasos de 1 500 CU según el bump canónico de los PDAs). Dimensionar contra el peor caso + headroom,
  nunca contra una sola muestra.

---

## Anexo — qué de este runbook está verificado y qué no

Verificado ejecutándolo (2026-07-28, en este repo, sin tocar la cadena):

| Comando / afirmación | Evidencia |
|---|---|
| `git status --porcelain` vacío en HEAD limpio | salida vacía |
| `git rev-parse HEAD:programs` = `014b5367…` e idéntico en `a04bdc0` y `00fef7f` | corrido en los dos commits |
| `touch programs/escrow/src/lib.rs && anchor build` regenera `.so` + IDL + tipos | mtime de los 3 artefactos posterior al `touch`; contenido byte-idéntico |
| El `.so`/IDL rebuildeados son byte-idénticos entre builds (esta máquina) | 2 rebuilds forzados ⇒ mismo `dc0ba21a…` / `350f53a4…` |
| El one-liner de Node da `4bcc34a997396d…12b` | corrido |
| Python `json.dumps(sort_keys=True, separators)` da `a8d6adc4…` ≠ el canónico | corrido (coincide solo con `ensure_ascii=False`) |
| El guard de los 8 campos pasa con el IDL real **y aborta con exit 1** si se le agrega `_pad` | corrido contra una copia mutada del IDL en `/tmp` |
| Los 6 discriminadores, el orden `['EscrowIndex','EscrowState']` y los errores `6000..6005` del paso 3 | leídos del IDL buildeado, uno por uno: coinciden con lo que dice este runbook |
| `nm -D --defined-only` = 2 símbolos; 12 undefined | corrido |
| Los nombres de campo (`_pad`, `deadline`, `EscrowState`) **no** están en el `.so`; `RegisterEscrow`/`DeregisterEscrow`/`escrow-index` **sí** | `strings -a` |
| `anchor test --skip-build --skip-deploy --skip-local-validator` ⇒ **23 passing**, T1a/T1b/T4a verdes | corrido |
| `anchor deploy` no tiene `--skip-build` (no compila) y sube el IDL por defecto; `anchor test` sí tiene `--skip-build` | `--help` de `anchor-cli 1.1.2` |
| Sintaxis de `solana program extend <ID> <ADDITIONAL_BYTES>`, `show`, `dump`, `deploy --program-id` (pubkey para upgrades), `--no-auto-extend` | `--help` de `solana-cli 3.1.10` |
| Sintaxis de `anchor idl fetch <PROGRAM_ID> --provider.cluster` y existencia de `anchor idl upgrade` | `--help` de `anchor-cli 1.1.2` |
| `strings`, `nm`, `sha256sum`, `stat`, `node` presentes en la máquina | `which` |
| `sha256sum -c <archivo-con-path-absoluto>` funciona desde cualquier cwd y falla si el archivo cambió | corrido |

**NO verificado** (requiere RPC de devnet, la keypair del founder, o un deploy — y este runbook no
ejecuta ninguna de las tres cosas):

- Cualquier `solana program show|dump|extend|deploy` contra devnet, incluido el nombre exacto del
  campo `Data Length` en la salida y el `Data Length` real de hoy.
- Que `solana address` sea `4wPhH4d…` y que esa sea la upgrade authority on-chain.
- Que el `dump` traiga padding, y el rollback en general.
- `anchor idl fetch` y la existencia de la cuenta de IDL on-chain.
- Si `anchor deploy` le pasa `--no-auto-extend` al `solana program deploy` subyacente.
- Los datos heredados de la build anterior: `.so` de 229 624 bytes y `canonicalSha256`
  `aa53c03f…` (medidos por F3, no reproducibles sin buildear el commit anterior — lo que volvería a
  contaminar `target/`).
