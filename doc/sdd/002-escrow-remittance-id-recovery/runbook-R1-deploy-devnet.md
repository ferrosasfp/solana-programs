# Runbook R1 — upgrade in-place del programa `escrow` en devnet (HU-SOL-20)

> **F3 NO EJECUTA ESTE RUNBOOK.** El paso 2 (deploy) es el gate **G1** del SDD §10 y lo ejecuta el
> **founder**. F3 (nexus-dev) escribió el código, buildeó y testeó local; **cero** transacciones
> on-chain (CD-19, CD-5: devnet only, nunca mainnet).

- **Program id (NO cambia — upgrade in-place)**: `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`
- **Qué agrega este upgrade**: 2 instrucciones (`register_escrow`, `deregister_escrow`) + 1 cuenta
  nueva (`EscrowIndex`) + 1 error nuevo (`EscrowIndexFull` = 6005).
- **Qué NO toca**: `EscrowState`, `deposit`, `release`, `refund`, `close`. Los 4 discriminadores y
  las 4 listas de cuentas viejas son **idénticos** (verificado en el IDL buildeado, ver paso 3).

## Artefactos de esta build (referencia)

| Artefacto | Valor |
|---|---|
| `target/deploy/escrow.so` — tamaño | **262 568 bytes** (antes del cambio: 229 624 ⇒ **+32 944**) |
| `target/deploy/escrow.so` — sha256 | `dc0ba21a5a620ef5dd1546c2c9e86eb6d00f9ca438e97bb4e2a5fa09819a8960` |
| `target/idl/escrow.json` — sha256 (archivo) | `350f53a44aa8a2ee2afa44bb3a203408225fee65fcba35cc773d749e0ee07bc7` |
| `target/idl/escrow.json` — **canonicalSha256** | `4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b` |

> El `canonicalSha256` (JSON canónico con claves ordenadas, algoritmo de
> `chaski-v3/contracts/idl/canonical-hash.ts`) es el valor que **R2a/R2b** tienen que re-pinear.
> El anterior era `aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71`.
>
> ⚠️ Los builds de Rust no son bit-a-bit reproducibles entre entornos: si rebuildeás antes de
> deployar, **recalculá** el sha256 del `.so` y usá el de la build que realmente vas a deployar.

---

## 1. Pre-check de tamaño (footgun real: el `.so` creció ~33 KB)

Si el binario nuevo no entra en el espacio ya asignado al programa, `anchor deploy` **falla a mitad
de la ventana**. Chequealo **antes** de deployar.

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /home/ferdev/.openclaw/workspace/solana-programs
solana config set --url devnet

# tamaño ASIGNADO on-chain hoy (campo "Data Length" del programData)
solana program show DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x

# tamaño del binario NUEVO
ls -l target/deploy/escrow.so     # esperado: 262568 bytes
```

Decisión:

- Si `Data Length` **≥ 262 568** ⇒ no hace falta nada, seguí al paso 2.
- Si `Data Length` **< 262 568** ⇒ extender **antes** de deployar. Pedí margen para futuras HUs
  (R5 y siguientes), no lo justo:

```bash
# <bytes> = cuántos bytes ADICIONALES agregar (no el total).
# Ej.: si Data Length = 240000, faltan 22568 ⇒ pedir 65536 deja headroom.
solana program extend DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x <bytes>
```

> **Nota de F3 (hipótesis, NO verificada on-chain):** `solana program deploy` suele asignar
> ~2× el tamaño del `.so` original, lo que daría ~459 KB y haría innecesario el `extend`.
> **No lo asumas** — F3 no consultó la cadena por diseño; leé el `Data Length` real.

Antecedente del repo: el id anterior `BBQ9…79WA` **nunca se deployó y su keypair se perdió**
(`README.md:18-23`). **El deploy de este programa no se improvisa.**

---

## 2. Deploy — GATE HUMANO (G1)

⛔ **Este paso lo corre el founder, no un agente.**

Antes de correrlo, guardá el binario actual para poder volver atrás (ver paso 4):

```bash
solana program dump DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x /tmp/escrow-PREV.so
sha256sum /tmp/escrow-PREV.so | tee /tmp/escrow-PREV.so.sha256
```

Deploy (upgrade **in-place**, mismo program id, misma upgrade authority):

```bash
./scripts/deploy-devnet.sh
```

---

## 3. Post-check

```bash
# sigue executable, mismo programData, misma upgrade authority
solana program show DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

Upgrade authority esperada: `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` (EOA fee-payer de
devnet; CD-7 / HU-SOL-19 la migran antes de mainnet).

Verificar el IDL: **6** instrucciones y que las 4 viejas conservan discriminador y cuentas.

```bash
python3 - <<'EOF'
import json; d=json.load(open('target/idl/escrow.json'))
print(sorted(i['name'] for i in d['instructions']))
print({i['name']: i['discriminator'] for i in d['instructions']})
print([a['name'] for a in d['accounts']], [(e['code'],e['name']) for e in d['errors']])
EOF
```

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
- cuentas: `['EscrowIndex', 'EscrowState']`
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
sha256sum -c /tmp/escrow-PREV.so.sha256      # confirmar que la copia está intacta
solana program deploy \
  --url devnet \
  --program-id DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  /tmp/escrow-PREV.so
```

Notas:

- El rollback **no** borra las cuentas `EscrowIndex` que se hayan creado mientras el programa nuevo
  estuvo vivo: quedan como cuentas huérfanas del programa (sin fondos, solo rent del `sender`). El
  programa viejo simplemente no las conoce. No hay pérdida de fondos.
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
