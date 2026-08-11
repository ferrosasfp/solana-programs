#!/usr/bin/env bash
# Publica el IDL en la cuenta de metadata canónica del programa, reintentando hasta que la
# escritura quede COMPLETA.
#
# ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────
#
# `program-metadata` sube el payload en VARIAS transacciones. Cuando una se cae, deja la cuenta
# (o el buffer) escrita a medias y reporta:
#
#   [Error] The provided transaction plan failed to execute.
#
# Medido el 2026-08-11: ese mensaje NO es confiable en ninguna de las dos direcciones.
#   · Un `close` que reportó ERROR sí entró: la cuenta desapareció de la cadena.
#   · Un `create` que reportó ERROR dejó la cuenta creada con 926 bytes de un stream zlib que
#     necesita ~5,5 KiB.
#   · `getSignaturesForAddress` sobre la authority devolvió 15 transacciones y NINGUNA con error.
#
# Y es FLAKY, no determinista: `list-buffers` mostró 8 buffers huérfanos de 4,5 a 5,5 KiB, todos
# por debajo del tamaño completo. O sea que fallar es lo habitual y acertar es lo raro. Repetir a
# mano hasta que salga es el trabajo que hace este script, pero con la verificación que faltaba.
#
# ── LA REGLA QUE ORDENA TODO ────────────────────────────────────────────────────────────────
#
# El exit status de la herramienta NO es evidencia. Después de cada paso se LEE la cadena y se
# valida que lo leído sea JSON parseable. Un stream truncado se detecta porque `fetch` devuelve
# hex (arranca en `789c`, el magic de zlib) en vez de un objeto.
#
# ── LO QUE ESTE SCRIPT NO HACE ──────────────────────────────────────────────────────────────
#
# · No firma con una llave que le pases: usa el firmante por defecto de tu `solana config`, que es
#   el que ya resultó ser la upgrade authority. Si ese no es el correcto, la cadena lo rechaza.
# · No arregla la causa raíz del corte, que está del lado de la herramienta. Reintenta.
# · No limpia los buffers huérfanos VIEJOS: para eso está `--cleanup`, que se corre aparte y a
#   conciencia, porque cierra TODO buffer de esa authority.
set -uo pipefail

PROGRAM_ID="${PROGRAM_ID:-DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x}"
RPC="${RPC:-https://api.devnet.solana.com}"
IDL_FILE="${IDL_FILE:-target/idl/escrow.json}"
MAX_TRIES="${MAX_TRIES:-6}"
PRIORITY_FEES="${PRIORITY_FEES:-500000}"

PM=(npx --yes --package=@solana-program/program-metadata@0.5.1 -- program-metadata --rpc "$RPC")

say() { printf '%s\n' "$*"; }
hr()  { printf '%s\n' "────────────────────────────────────────────────────────"; }

# ¿La salida es un IDL completo? Único criterio: parsea como JSON y trae instrucciones.
es_json_completo() {
  python3 - "$1" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(d, dict) and d.get("instructions") else 1)
PY
}

if [ "${1:-}" = "--cleanup" ]; then
  say "Cerrando TODOS los buffers de la authority. Ctrl-C ahora si no era lo que querías."
  AUTH="$("${PM[@]}" list-buffers 2>/dev/null | grep -oE '[1-9A-HJ-NP-Za-km-z]{43,44}' | head -1)"
  "${PM[@]}" list-buffers "$AUTH" 2>/dev/null | grep -oE '[1-9A-HJ-NP-Za-km-z]{43,44}' | while read -r b; do
    [ "$b" = "$AUTH" ] && continue
    say "  cerrando $b"
    "${PM[@]}" close-buffer "$b" >/dev/null 2>&1
  done
  say "Listo."
  exit 0
fi

hr; say "IDL a publicar : $IDL_FILE"; say "Programa       : $PROGRAM_ID"; hr

# ── Paso 0: si la cuenta existe (completa o a medias), se cierra ────────────────────────────
# `create` NO sobreescribe, y crecer una cuenta en su lugar es justo donde la herramienta se
# rompe. Se parte siempre de cuenta ausente, que es el caso que sí funciona.
tmp="$(mktemp)"
if "${PM[@]}" fetch idl "$PROGRAM_ID" > "$tmp" 2>&1; then
  if es_json_completo "$tmp"; then
    say "La cadena YA sirve un IDL completo. Si querés reemplazarlo igual, cerrá a mano y volvé."
    exit 0
  fi
fi
if ! grep -q "Account not found" "$tmp"; then
  say "Hay una cuenta de metadata (posiblemente a medias). Cerrándola…"
  "${PM[@]}" close idl "$PROGRAM_ID" >/dev/null 2>&1 || true
  sleep 3
fi

# ── Paso 1..N: buffer, VERIFICAR, y recién entonces crear ───────────────────────────────────
for i in $(seq 1 "$MAX_TRIES"); do
  hr; say "Intento $i de $MAX_TRIES"

  out="$("${PM[@]}" --priority-fees "$PRIORITY_FEES" create-buffer "$IDL_FILE" 2>&1)"
  buf="$(printf '%s' "$out" | grep -oE 'buffer: [1-9A-HJ-NP-Za-km-z]{43,44}' | awk '{print $2}' | head -1)"
  if [ -z "$buf" ]; then
    say "  no se pudo ni crear el buffer; reintentando"
    sleep 5; continue
  fi
  say "  buffer: $buf"

  # 🔴 LA PUERTA QUE FALTABA. Sin esto se publica desde un buffer truncado y queda algo que
  # PARECE publicado y no lo está — que es peor que no publicar, porque no falla ruidoso.
  if "${PM[@]}" fetch-buffer "$buf" > "$tmp" 2>&1 && es_json_completo "$tmp"; then
    say "  buffer COMPLETO ✅"
  else
    say "  buffer truncado ❌ — lo cierro y reintento"
    "${PM[@]}" close-buffer "$buf" >/dev/null 2>&1 || true
    sleep 5; continue
  fi

  "${PM[@]}" create idl "$PROGRAM_ID" --buffer "$buf" >/dev/null 2>&1 || true
  sleep 3

  # Y la verificación final es una LECTURA, nunca el exit code del create.
  if "${PM[@]}" fetch idl "$PROGRAM_ID" > "$tmp" 2>&1 && es_json_completo "$tmp"; then
    hr
    say "✅ PUBLICADO. La cadena sirve un IDL completo."
    python3 - "$tmp" <<'PY'
import json, sys, hashlib
d = json.load(open(sys.argv[1], encoding="utf-8"))
def canon(v):
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k) + ":" + canon(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    return json.dumps(v)
print("   instrucciones :", len(d.get("instructions") or []))
print("   hash canonico :", hashlib.sha256(canon(d).encode()).hexdigest())
PY
    say ""
    say "   Pasale ese hash a Claude para que re-pinee chaski-v3 y wasiai-facilitator."
    rm -f "$tmp"; exit 0
  fi

  say "  el create quedó a medias; cierro la cuenta y reintento"
  "${PM[@]}" close idl "$PROGRAM_ID" >/dev/null 2>&1 || true
  sleep 5
done

hr
say "❌ No se logró en $MAX_TRIES intentos."
say "   La cuenta quedó CERRADA (sin IDL publicado), que es el estado honesto:"
say "   mejor ausente que a medias, porque a medias parece publicado."
say "   Reintentá con MAX_TRIES=12 ./scripts/publish-idl.sh"
rm -f "$tmp"; exit 1
