#!/usr/bin/env bash
# Publica el IDL en la cuenta de metadata canónica del programa.
#
# ── LAS TRES COSAS QUE ESTE SCRIPT SABE Y QUE CUESTAN UNA NOCHE AVERIGUAR ───────────────────
#
# 1) MINIFICAR EL IDL ANTES DE SUBIRLO. Es la diferencia entre que funcione y que no.
#    `anchor build` escribe `target/idl/escrow.json` INDENTADO: 37530 bytes crudos, 5532
#    comprimidos. El mismo IDL minificado son 16020 crudos y 4883 comprimidos. El IDL que SÍ se
#    publicó con éxito (canónico d295b7c7) medía 15862 / 4894 — o sea del tamaño del minificado.
#    Con la versión indentada la escritura se corta SIEMPRE: 6 intentos, 6 buffers truncados.
#    Minificar NO cambia el hash canónico, porque el canónico re-serializa con las claves
#    ordenadas; el formato del archivo es irrelevante para él.
#
# 2) `fetch-buffer` ESTÁ ROTO en esta versión del CLI. Devuelve `[Error] undefined` incluso sobre
#    un buffer sano. Así que NO se puede usar para verificar. Este script lee la cuenta por RPC,
#    busca el magic de zlib (`789c`), descomprime y compara el hash canónico. Eso sí es una
#    verificación.
#
# 3) EL EXIT STATUS DE LA HERRAMIENTA NO ES EVIDENCIA, en ninguna de las dos direcciones. Medido:
#    un `close` que reportó [Error] entró igual (la cuenta desapareció de la cadena), y un
#    `create` que reportó [Error] dejó la cuenta con 926 bytes de un stream que necesita ~4,9 KiB.
#    `getSignaturesForAddress` sobre la authority: 15 transacciones, CERO con error. Todo se
#    decide LEYENDO la cadena.
#
# ⚠️ Y UNA TRAMPA DE LA QUE ESTE ARCHIVO YA FUE VÍCTIMA: el hash canónico se calcula con
# `ensure_ascii=False`. El default de Python escapa los no-ASCII y da un hash DISTINTO al de
# `JSON.stringify` de JS, que es el que pinean los consumidores. La primera versión de este script
# imprimía ed65e3e6… en vez de cc276126… por exactamente eso.
#
# ── LO QUE NO HACE ──────────────────────────────────────────────────────────────────────────
# · No recibe llave: usa el firmante por defecto de `solana config`, que es la upgrade authority.
# · No limpia buffers huérfanos viejos. Para eso, `--cleanup`, que cierra TODOS los de esa
#   authority y se corre a conciencia.
set -uo pipefail

PROGRAM_ID="${PROGRAM_ID:-DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x}"
RPC="${RPC:-https://api.devnet.solana.com}"
IDL_FILE="${IDL_FILE:-target/idl/escrow.json}"
MAX_TRIES="${MAX_TRIES:-6}"
PRIORITY_FEES="${PRIORITY_FEES:-500000}"

PM=(npx --yes --package=@solana-program/program-metadata@0.5.1 -- program-metadata --rpc "$RPC")
say() { printf '%s\n' "$*"; }
hr()  { printf '%s\n' "────────────────────────────────────────────────────────"; }

# Verifica una cuenta (buffer o metadata) LEYENDO la cadena: descomprime y compara hash canónico.
# $1 = address, $2 = hash canónico esperado. exit 0 sólo si descomprime Y coincide.
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
    sys.exit(2)                      # no pudimos preguntar: NO es lo mismo que estar mal
if v is None: sys.exit(1)
raw = base64.b64decode(v["data"][0])
# NO se busca un magic hardcodeado. La cabecera zlib depende del NIVEL de compresion:
# 78 01 (nivel 1), 78 5e, 78 9c (nivel 6, el que usa esta herramienta) y 78 da (nivel 9).
# Clavar uno solo es un guard que falla cuando la herramienta cambie de nivel, y ese rojo
# diria "truncado" sobre algo sano. Se prueba cada offset que arranque en 0x78.
d = None
for i in range(len(raw) - 1):
    if raw[i] != 0x78: continue
    try:
        d = json.loads(zlib.decompress(raw[i:]).decode("utf-8")); break
    except Exception:
        continue
if d is None: sys.exit(1)            # truncado o no es un IDL: el caso que costo la noche
sys.exit(0 if hashlib.sha256(canon(d).encode()).hexdigest() == esperado else 1)
PY
}

if [ "${1:-}" = "--cleanup" ]; then
  say "Cerrando TODOS los buffers de la authority. Ctrl-C si no era eso."
  AUTH="$("${PM[@]}" list-buffers 2>/dev/null | grep -oE '[1-9A-HJ-NP-Za-km-z]{43,44}' | head -1)"
  "${PM[@]}" list-buffers "$AUTH" 2>/dev/null | grep -oE '[1-9A-HJ-NP-Za-km-z]{43,44}' | while read -r b; do
    [ "$b" = "$AUTH" ] && continue
    say "  cerrando $b"; "${PM[@]}" close-buffer "$b" >/dev/null 2>&1
  done
  say "Listo."; exit 0
fi

# ── Minificar, y calcular el hash canónico del contenido ────────────────────────────────────
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
say "IDL            : $IDL_FILE"
say "Minificado     : $(wc -c < "$MIN") bytes (el original tiene $(wc -c < "$IDL_FILE"))"
say "Hash canonico  : $HASH"
say "Programa       : $PROGRAM_ID"
hr

# ── Paso 0: partir SIEMPRE de cuenta ausente ────────────────────────────────────────────────
# `create` no sobreescribe, y crecer la cuenta en su lugar es justo donde la herramienta rompe.
say "Cerrando la cuenta de metadata si existe…"
"${PM[@]}" close idl "$PROGRAM_ID" >/dev/null 2>&1 || true
sleep 3

for i in $(seq 1 "$MAX_TRIES"); do
  hr; say "Intento $i de $MAX_TRIES"
  out="$("${PM[@]}" --priority-fees "$PRIORITY_FEES" create-buffer "$MIN" 2>&1)"
  buf="$(printf '%s' "$out" | grep -oE 'buffer: [1-9A-HJ-NP-Za-km-z]{43,44}' | awk '{print $2}' | head -1)"
  [ -z "$buf" ] && { say "  no se creó el buffer; reintento"; sleep 5; continue; }
  say "  buffer: $buf"

  verificar_onchain "$buf" "$HASH"; rc=$?
  if [ "$rc" -eq 0 ]; then
    say "  buffer COMPLETO y con el hash esperado ✅"
  elif [ "$rc" -eq 2 ]; then
    say "  no pudimos leer la cadena — NO lo cierro, puede estar bien; reintento"; sleep 8; continue
  else
    say "  buffer truncado o distinto ❌ — lo cierro y reintento"
    "${PM[@]}" close-buffer "$buf" >/dev/null 2>&1 || true; sleep 5; continue
  fi

  "${PM[@]}" create idl "$PROGRAM_ID" --buffer "$buf" >/dev/null 2>&1 || true
  sleep 3

  tmp="$(mktemp)"
  "${PM[@]}" fetch idl "$PROGRAM_ID" > "$tmp" 2>&1
  if python3 - "$tmp" "$HASH" <<'PY'
import sys, json, hashlib, io
def canon(v):
    if isinstance(v, dict): return "{" + ",".join(json.dumps(k, ensure_ascii=False)+":"+canon(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, list): return "[" + ",".join(canon(x) for x in v) + "]"
    return json.dumps(v, ensure_ascii=False)
try:
    d = json.loads(io.open(sys.argv[1], encoding="utf-8").read().strip())
except Exception:
    sys.exit(1)
sys.exit(0 if hashlib.sha256(canon(d).encode()).hexdigest() == sys.argv[2] else 1)
PY
  then
    hr; say "✅ PUBLICADO Y VERIFICADO."
    say "   hash canonico en cadena: $HASH"
    say ""
    say "   Pasale ese hash a Claude para que re-pinee chaski-v3 y wasiai-facilitator."
    rm -f "$tmp" "$MIN"; exit 0
  fi
  rm -f "$tmp"
  say "  el create quedó a medias; cierro y reintento"
  "${PM[@]}" close idl "$PROGRAM_ID" >/dev/null 2>&1 || true; sleep 5
done

hr
say "❌ No se logró en $MAX_TRIES intentos. La cuenta queda CERRADA a proposito:"
say "   ausente es un estado honesto, a medias parece publicado y no lo esta."
say "   Reintentá con MAX_TRIES=12 ./scripts/publish-idl.sh"
rm -f "$MIN"; exit 1
