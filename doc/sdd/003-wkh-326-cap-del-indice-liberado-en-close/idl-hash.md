# WKH-326 — sha256 canónico del IDL construido

**Este número vive SOLO acá (CD-17).** No se pinnea en `chaski-v3` ni en `wasiai-facilitator`, y no
se escribe en `CONTRACT-VERSIONS.md`. El re-pin es trabajo de la HU de deploy, una sola vez, con el
hash que efectivamente se publique en cadena.

| | sha256 canónico |
|---|---|
| `main` (IDL vendoreado en los dos consumidores) | `fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071` |
| esta rama, `target/idl/escrow.json` post-W5 | `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922` |

Medido el 2026-08-05 sobre el artefacto construido, después de los comentarios de W5.

## Cómo se calculó, y por qué no con el snippet de python del Story File

El Story File propone `hashlib.sha256(json.dumps(d, sort_keys=True, separators=(',',':')))`. Sobre
el IDL de `main` ese snippet **no** reproduce `fb64c937…`: devuelve
`447a05a70869cf0cecc9a3298d147fb23b03720091110e951a3e898040d5ae9e`. La causa es que
`json.dumps` escapa lo no-ASCII por defecto (`ensure_ascii=True`) y los `docs` del IDL tienen
acentos y un `⚠️`. Siguiendo la instrucción del propio Story File ("si no reproduce `fb64c937…`, no
es la canonicalización correcta"), se usó el algoritmo de
`chaski-v3/contracts/idl/canonical-hash.ts`, en **modo lectura**: claves ordenadas recursivamente,
`JSON.stringify` de los escalares, UTF-8, sha256.

Control antes de creerle al número nuevo: ese algoritmo, corrido sobre el IDL vendoreado de `main`,
devuelve exactamente `fb64c937…`. Sin ese control el hash nuevo sería un número que no sé reproducir.

Los dos consumidores llegaron al mismo `bfbdfe5a…` por su cuenta al correr sus tests de pin (W3),
cada uno con su propia copia del canonicalizador.

## Qué NO movió el hash

`target/idl/escrow.json` tiene el mismo md5 (`c8e10be9a38bd96b4f0e2ebb422c0c28`) antes y después de
los comentarios de W5, que son todos `//`. Lo que sí movió el hash respecto de `main` es la cuenta
`escrow_index` nueva en `close` y su doc comment `///`, que es la única excepción a CD-6.

El `.so` sí cambió de md5 con los comentarios de W5 (`70480969…` → `d4b736cf…`) aunque no cambió una
línea de lógica. Motivo verificado, no supuesto: el binario embebe la ruta del fuente y los macros
de Anchor embeben el **número de línea** del constraint que falla (los logs dicen `AnchorError thrown
in programs/escrow/src/lib.rs:354`). Los comentarios de W5 corrieron las líneas de abajo, así que
esos números cambiaron.

Refutable con dos inputs que **sí ejecutan** (el `strings target/deploy/escrow.so | grep lib.rs` que
figuraba acá antes no sirve: devuelve 3 hits, los tres la *ruta* del fuente, **cero** números de
línea, así que no puede ni confirmar ni tumbar la afirmación):

```bash
# 1. el binario embebe números de línea de constraints — 8 distintos hoy
anchor test --skip-build --skip-deploy --skip-local-validator > /tmp/suite.log 2>&1
grep -o 'AnchorError thrown in .*lib.rs:[0-9]*' /tmp/suite.log | sort -u

# 2. entre el commit del código (3cbefb2) y el de los comentarios de W5 (4345539) no cambió
#    ni una línea que no sea comentario — el diff sale VACÍO
git show 3cbefb2:programs/escrow/src/lib.rs > /tmp/pre.rs
git show 4345539:programs/escrow/src/lib.rs > /tmp/post.rs
diff <(grep -v '^\s*//' /tmp/pre.rs) <(grep -v '^\s*//' /tmp/post.rs)
```

Corridos el 2026-08-05: (1) devuelve `lib.rs:148,155,159,198,207,246,250,354`; (2) sale vacío, exit
0. Los dos juntos son lo que sostiene la conclusión: el fuente lógico es idéntico y lo único que el
binario pudo haber absorbido son los números de línea que los comentarios corrieron.

## Cierre — 2026-08-05: desplegado, republicado y re-clavado

Todo lo de arriba se escribió **antes** del despliegue y se deja tal cual: es el registro de cómo
estaban las cosas. Lo que cambió después:

| | |
|---|---|
| Programa desplegado en devnet | slot `480496830` → `481495859` |
| Firma del despliegue | `UjFgwnmUviG9kRVfCNB1kcKeGQAYxsJkZpKQHycM8o6KFFJhDETfzAQyjccQbXd8TgcasN7gyHazjfWhQudjK7F` |
| `sha256` del `.so` local (274800 bytes) | `10d6dd04784024c811c37dc8e5d5624c862438d8f6427408bd5f357553b1adf7` |
| `verify-hash` (sin el padding), en cadena y local | `455e4e36fa7c63be568d470a89f7eded9aff5806b198340936a578810be09291` |
| `artifact-sha256` de la cuenta ProgramData (412568 bytes, 137768 de relleno a cero) | `59ec1098cd64d04cab1063fd837e84a70c7962741a3c14932d249cab28b328ef` |
| IDL republicado en cadena | `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC`, por el camino del buffer |
| sha256 canónico del IDL en cadena | `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922` |
| Re-pin en `chaski-v3` | commit `bd85dfa`, verde |
| Re-pin en `wasiai-facilitator` | commit `f9bddce`, verde |

Así que la frase de arriba ("este número vive SOLO acá") **ya no rige**: el re-pin era trabajo de la
HU de deploy, esa HU ocurrió, y `bfbdfe5a…` es ahora el número que clavan la cadena, este árbol y
los dos consumidores. Verificado leyendo, no asumido: `anchor idl fetch` sobre devnet y
`anchor build` acá dan el mismo hash canónico, y los dos `escrow-idl.hash.test.ts` tienen ese valor.

Los dos hashes del binario quedaron clavados en `.github/workflows/verified-build.yml` y publicados
en el README, que es lo que hace que un redespliegue no anunciado ponga el CI en rojo.

**Lo que NO se hizo, y hay que decirlo:** los tres doc comments falsos de `lib.rs` seguían siendo la
única cosa que pedía esta republicación para arreglarse gratis, y la ventana se pasó. El IDL fue a
la cadena con ellos adentro. Corregirlos ahora movería el hash una tercera vez y obligaría a
republicar y re-clavar los dos consumidores de nuevo, así que viajan con el próximo cambio de
interfaz, que es la HU de eventos, ya en la cola y que mueve el hash igual.
