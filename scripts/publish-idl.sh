#!/usr/bin/env bash
# Publica el IDL en la cuenta de metadata canonica del programa.
#
# ── LA CAUSA, medida el 2026-08-11 ─────────────────────────────────────────────────────────
#
# `program-metadata` arma un plan de 7 transacciones ENCADENADAS: la #1 crea la cuenta y las #2..#7
# le escriben el contenido en pedazos. Las despacha sin esperar que la #1 sea visible, asi que el
# nodo RPC simula las siguientes contra un estado donde la cuenta todavia no existe (eso es el
# preflight) y las RECHAZA con InvalidAccountData. Nunca las transmite.
#
# LA EVIDENCIA QUE LO ATA: `getSignaturesForAddress` sobre la authority muestra 25 transacciones y
# CERO con error. Eso no significa "todo aterrizo bien" — significa que las que fallaron nunca
# llegaron a la cadena. Una transaccion que falla EJECUTANDOSE deja su error escrito; estas no
# dejaron ninguno porque murieron en el preflight, del lado del cliente.
#
# El sintoma es siempre el mismo numero: la cuenta queda en 926 bytes, que es exactamente lo que
# escribe la #1. Y `anchor idl init` NO es una alternativa: Anchor 1.1.2 envuelve esta misma
# herramienta, con el mismo resultado.
#
# ⚠️ NO CONFUNDIR CON LO QUE ESTE ARCHIVO DECIA ANTES. Llego a documentar como causa un "descarte
# de transacciones sin rastro" y un "limite de tasa". Las dos eran conjeturas escritas como si
# fueran mediciones. La primera es falsa; la segunda existe (el RPC publico devuelve 429 si se lo
# martilla) pero es un estorbo, no la causa: 15 minutos de silencio total no cambiaron nada.
#
# ── EL ARREGLO ────────────────────────────────────────────────────────────────────────────
#
# Exportar el plan con `--export` y mandarlo NOSOTROS, en orden, esperando confirmacion entre cada
# transaccion. Medido asi, la cuenta crece 968 bytes por transaccion, de 0 a 4982, siempre.
#
# ── LO QUE ESTE SCRIPT NO HACE, Y ES DELIBERADO ───────────────────────────────────────────
# · No cierra el IDL publicado. Antes lo hacia como paso 0 "porque `create` no sobreescribe", y el
#   2026-08-11 borro de la cadena un IDL bueno y no pudo reponerlo: el estado final fue PEOR que no
#   haber corrido nada. `write` crea O ACTUALIZA, asi que cerrar nunca hizo falta.
# · No recibe llave: usa el firmante por defecto de `solana config`.
set -uo pipefail

PROGRAM_ID="${PROGRAM_ID:-DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x}"
RPC="${RPC:-https://api.devnet.solana.com}"
IDL_FILE="${IDL_FILE:-target/idl/escrow.json}"
IDL_PDA="${IDL_PDA:-7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC}"
PM=(npx --yes --package=@solana-program/program-metadata@0.5.1 -- program-metadata --rpc "$RPC")
say() { printf '%s\n' "$*"; }
hr()  { printf '%s\n' "────────────────────────────────────────────────────────"; }

# Verifica la cuenta LEYENDO la cadena: descomprime y compara hash canonico.
# 0 = coincide · 1 = distinto/ausente/truncada · 2 = no se pudo preguntar (NO es lo mismo que mal)
verificar_onchain() {
  python3 - "$1" "$2" "$RPC" <<'PY'
import sys, json, base64, zlib, hashlib, urllib.request
addr, esperado, rpc = sys.argv[1], sys.argv[2], sys.argv[3]
def canon(v):
    if isinstance(v, dict): return "{" + ",".join(json.dumps(k, ensure_ascii=False)+":"+canon(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, list): return "[" + ",".join(canon(x) for x in v) + "]"
    return json.dumps(v, ensure_ascii=False)
try:
    req = urllib.request.Request(rpc, data=json.dumps({"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
        "params":[addr,{"encoding":"base64","commitment":"finalized"}]}).encode(),
        headers={"Content-Type":"application/json"})
    v = json.loads(urllib.request.urlopen(req, timeout=60).read())["result"]["value"]
except Exception:
    sys.exit(2)
if v is None: sys.exit(1)
raw = base64.b64decode(v["data"][0])
# La cabecera zlib depende del NIVEL de compresion (78 01 / 78 5e / 78 9c / 78 da), asi que se
# prueba cada offset que arranque en 0x78 en vez de clavar un magic que envejece.
d = None
for i in range(len(raw) - 1):
    if raw[i] != 0x78: continue
    try:
        d = json.loads(zlib.decompress(raw[i:]).decode("utf-8")); break
    except Exception:
        continue
if d is None: sys.exit(1)
sys.exit(0 if hashlib.sha256(canon(d).encode()).hexdigest() == esperado else 1)
PY
}

# ── Minificar y calcular el hash canonico ────────────────────────────────────────────────
# ⚠️ `ensure_ascii=False` NO es opcional: el default de Python escapa los no-ASCII y da un hash
# DISTINTO al de `JSON.stringify`, que es el que pinean los consumidores.
MIN="$(mktemp --suffix=.json)"
HASH="$(python3 - "$IDL_FILE" "$MIN" <<'PY'
import json, sys, hashlib, io
d = json.load(io.open(sys.argv[1], encoding="utf-8"))
io.open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(d, separators=(",", ":"), ensure_ascii=False))
def canon(v):
    if isinstance(v, dict): return "{" + ",".join(json.dumps(k, ensure_ascii=False)+":"+canon(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, list): return "[" + ",".join(canon(x) for x in v) + "]"
    return json.dumps(v, ensure_ascii=False)
print(hashlib.sha256(canon(d).encode()).hexdigest())
PY
)"
hr
say "IDL           : $IDL_FILE"
say "Hash canonico : $HASH"
say "Programa      : $PROGRAM_ID"
hr

verificar_onchain "$IDL_PDA" "$HASH"
case $? in
  0) say "Ya esta publicado y coincide. Nada que hacer."; rm -f "$MIN"; exit 0 ;;
  2) say "⚠️  No se pudo leer la cadena. Abortando: no se toca nada a ciegas."; rm -f "$MIN"; exit 1 ;;
esac
say "En la cadena hay algo distinto de este archivo, o no hay nada. Se publica."

WALLET="$(solana config get 2>/dev/null | sed -n 's/^Keypair Path: //p' | tr -d '[:space:]')"
[ -f "$WALLET" ] || { say "❌ No encuentro la llave de \`solana config\`."; rm -f "$MIN"; exit 1; }

PLAN="$(mktemp)"
say "Exportando el plan de transacciones…"
"${PM[@]}" --export --export-encoding base64 write idl "$PROGRAM_ID" "$MIN" > "$PLAN" 2>&1
N="$(grep -c '^\[Transaction' "$PLAN" || true)"
[ "${N:-0}" -ge 1 ] || { say "❌ El export no produjo transacciones."; cat "$PLAN"; rm -f "$MIN" "$PLAN"; exit 1; }
say "  $N transacciones"

say "Enviandolas EN ORDEN (esto tarda; es el arreglo, no lentitud gratuita)…"
node "$(dirname "$0")/enviar-plan-en-orden.cjs" "$PLAN" "$WALLET" 1

hr
verificar_onchain "$IDL_PDA" "$HASH"
if [ $? -eq 0 ]; then
  say "✅ PUBLICADO Y VERIFICADO leyendo la cadena."
  say "   hash canonico: $HASH"
  rm -f "$MIN" "$PLAN"; exit 0
fi
say "❌ La cuenta NO quedo con el contenido esperado."
say "   El plan quedo en: $PLAN"
say "   Se puede retomar desde la transaccion N sin rehacer las anteriores:"
say "     node scripts/enviar-plan-en-orden.cjs $PLAN \"\$(solana config get | sed -n 's/^Keypair Path: //p')\" N"
rm -f "$MIN"; exit 1
