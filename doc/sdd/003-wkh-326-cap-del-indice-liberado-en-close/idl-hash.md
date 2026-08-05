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
