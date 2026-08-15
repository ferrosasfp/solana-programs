# project-context — solana-programs

Generado en F0 (NexusAgil / nexus-analyst) el 2026-08-05, para WKH-326.
Todo lo de acá se leyó de archivos del repo. Lo que no se pudo verificar está marcado como tal.

**Re-medido el 2026-08-15**, porque un archivo de contexto que envejece en silencio es peor que no
tenerlo: doce afirmaciones de acá eran falsas y están corregidas abajo, cada una con el comando que
la vuelve a medir. Las citas a `README.md` por número de línea se cambiaron por título de sección,
que es lo que este mismo archivo ya recomendaba en "Comandos" y no aplicaba en ningún otro lado: el
README pasó de 1019 a más de 1250 líneas y **ninguna** de esas ocho citas seguía apuntando a su
párrafo.

## Qué es este repo

Un solo programa Anchor: `escrow`, el escrow no custodial del momento en vuelo de una remesa.
Es la mitad on-chain de un sistema más grande; acá viven el programa, sus tests y el script de deploy.

- Repo: `github.com/ferrosasfp/solana-programs`
- Program id: `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` (devnet, `declare_id!` en `programs/escrow/src/lib.rs:70`; decía `:62`, que es una línea del comentario de cabecera)
- Loader: upgradeable. Upgrade authority: `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` (una sola llave devnet)
- Licencia: MIT

**No hay mainnet.** Todo el dinero custodiado es faucet de devnet (fila "Money at risk" de la sección
"Status, honestly" del README). ⚠️ Y **hay** dinero custodiado: medido 2026-08-15, slot `484158416`,
un escrow en `Deposited` con 13.500.000 raw de USDC devnet de Circle y el deadline ya vencido. El
comando que lo responde es `python3 scripts/list-live-escrows.py --url devnet --markdown`; no le
creas a este renglón, que envejece solo.

## Stack

| Pieza | Versión | Dónde está declarada |
|---|---|---|
| rustc | 1.89.0 | `rust-toolchain.toml`, `Cargo.toml:9` |
| solana-cli (Agave) | 3.1.10 | `Cargo.toml:20` (`[workspace.metadata.cli]`) |
| anchor-cli | 1.1.2 | `Anchor.toml:4` |
| `@coral-xyz/anchor` (tests y consumidores) | 0.30.1 | `package.json:10` |
| `anchor-bankrun` / `solana-bankrun` | 0.5.0 / 0.4.0 | `package.json:16,20` |
| `anchor-spl`, `solana-security-txt` | — | `programs/escrow/Cargo.toml` |

Las cuatro versiones de la tabla de arriba se mueven **juntas** (`rust-toolchain.toml`, `Cargo.toml`,
los dos workflows, y la tabla "Toolchain" del README). Un desajuste no rompe el build: rompe la
reproducibilidad, que es una falla más silenciosa (sección "Toolchain" del README).

## Estructura

```
programs/escrow/src/lib.rs     el programa entero, un solo archivo (861 líneas al 2026-08-15)
tests/escrow.ts                16 tests: depósito, release, refund, close, máquina de estados
tests/escrow-index.ts          25 tests: índice, caminos de atacante, cap, rent, compute
tests/escrow-window.ts         20 tests: ventana de custodia, bordes, barrido del vault
scripts/deploy-devnet.sh       único camino de deploy (cluster pinneado a devnet)
scripts/onchain-hash.py        lee la cadena y compara hashes; stdlib, no firma nada
scripts/programdata-capacity.py preflight de tamaño antes de un upgrade
scripts/list-live-escrows.py   lista EscrowState vivos y marca los bloqueantes
doc/mutation-run.md            cada guard roto a propósito, uno por uno, y qué test lo mató
doc/publish-idl-onchain.md     cómo se publicó el IDL en cadena
doc/decisions/                 decisiones de producto escritas
README.md                      ~1270 líneas; es el documento principal del repo
SECURITY.md                    alcance de reporte de vulnerabilidades
```

`doc/sdd/` **no existía** antes de esta HU. Se crea en WKH-326.

## Comandos

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
npm ci
anchor build
anchor test --skip-build --skip-deploy --skip-local-validator
cargo clippy --all-targets -- -D warnings
```

Última corrida medida: la cifra vive en el renglón "Last measured run" de la sección
"Running the tests" del README. Se cita por **título de sección** y no por número de línea a
propósito: la cita anterior decía `README.md:769` y ya estaba corrida (el texto estaba en `:772`),
porque un número de línea se desplaza cuando alguien edita tres líneas más arriba y un ancla no.

`cargo fmt` **no** corre y **no** está enforced: el árbol no pasa `cargo fmt --all -- --check` hoy
(sección "`ci.yml`" del README). No reformatear el programa como efecto colateral de otra HU.

## Trampas conocidas del repo (esto es lo que muerde)

1. **`anchor deploy` y bankrun shippean lo que está en `target/deploy/`, no compilan.** Restaurar
   el fuente sin rebuildear deja un binario mutado corriendo y la suite reporta fallas que no tienen
   nada que ver con el código en disco. Este repo se comió esto dos veces
   (sección "Build and test" del README, `doc/mutation-run.md:9-15`). **Rebuildear siempre antes de correr la suite.**
2. **ALGUNOS `///` viajan al IDL y le mueven el sha256 canónico. Los `//!` de módulo NO, y los `///`
   sobre un `const` tampoco.** Este punto decía "los `///` y `//!` viajan" y es falso; medido el
   2026-08-15 sobre `target/idl/escrow.json`, que es el archivo que hashea al valor publicado: el
   `docs` de nivel superior es `null`, no hay sección `constants`, y ni `clamped` (que sólo existe en
   el `//!` de `lib.rs:38`) ni `MAX_ENTRIES` aparecen en el IDL. Se refuta o se confirma con
   `python3 -c "print('clamped' in open('target/idl/escrow.json').read())"`. Lo que **sí** viaja es un
   `///` sobre un handler de instrucción o sobre una cuenta dentro de un `#[derive(Accounts)]`, y ése
   es el único caso que cuesta republicar el IDL y re-pinnearlo en los dos consumidores. Quedan **dos**
   comentarios falsos, los dos fuera del IDL, así que corregirlos no mueve el hash canónico; el tercero
   (el `///` de `sender_ata` en `Close`) ya está corregido y publicado en cadena.
   ⚠️ **Pero sí puede mover el BINARIO, y es un costo aparte que este repo ya midió.** El `.so` lleva
   adentro los números de línea de las constraints, así que un comentario que agrega o saca líneas los
   corre: `doc/mutation-run.md` registra 19 líneas `//` agregadas moviendo `target/deploy/escrow.so` de
   md5 `b024cd91…` a `1ee62827…` con el IDL byte por byte idéntico. Una edición **línea-neutra** (las
   mismas líneas que salen entran) no toca el binario, y por eso la corrección del `sender_ata` se
   escribió 5 por 5.
3. **Los códigos de `ErrorCode` son posicionales desde 6000.** Insertar una variante en el medio
   renumera todo lo que sigue y rompe cualquier cliente que mapee códigos
   (`programs/escrow/src/lib.rs:487-488` y la enum entera debajo). Se apendiza al final, siempre.
4. **`EscrowStatus` tiene EXACTAMENTE tres variantes y el número es parte del contrato.** Los dos
   consumidores pinnean un IDL con tres; un byte de status 3 hace que su `BorshAccountsCoder` tire.
   `escrow-window.ts` E1b es el alambre (`programs/escrow/src/lib.rs:457-469`).
5. **El layout de `EscrowState` está congelado.** Agregar un campo mantiene el discriminador y rompe
   el borsh de toda cuenta ya en cadena: `release`/`refund`/`close` empezarían a fallar con
   `AccountDidNotDeserialize` (sección "The layout is deliberately frozen" del README). `escrow.ts` 1a
   asertea los 154 bytes.
6. **bankrun deduplica txs por firma.** Un retry de una tx de forma idéntica "pasa" sin ejecutarse si
   no se avanza el slot. Ver `bumpSlot()` en `tests/escrow-index.ts:350` (CD-12).
7. **El compute de `deposit + register_escrow` NO es una constante**: 52.826..79.826 CU sobre 28
   corridas, en pasos de 1.500, porque los bumps canónicos cambian con los keypairs aleatorios de
   cada corrida (`tests/escrow-index.ts:767-770`). Dimensionar contra el peor caso, nunca contra una
   muestra.
8. **El ProgramData no crece solo.** Un upgrade que no entra falla adentro del loader sin mencionar
   el tamaño, después de subir el binario entero. Por eso el deploy corre
   `programdata-capacity.py` primero (sección "The size preflight" del README).
9. **`--provider.cluster` fija la red y NO la billetera.** Anchor cae al `wallet` de `Anchor.toml`
   (`~/.config/solana/id.json`), que el 2026-08-05 no existía: el deploy murió con
   `Unable to read keypair file` *después* del preflight y costó una vuelta. Si el archivo hubiera
   existido con otra llave adentro habría subido el binario entero para morir adentro del loader por
   autoridad inválida. `scripts/deploy-devnet.sh` ahora exige la llave por argumento o
   `DEPLOY_KEYPAIR`, lee la upgrade authority de la cadena y aborta antes de mandar nada si no
   coinciden.

## Convenciones que el repo ya impone

- **Los tests importan el IDL construido directo, sin `existsSync` + `it.skip`.** Si falta el
  artefacto la suite tiene que explotar, no reportar cero tests (`tests/escrow-index.ts:25-27`).
- **Todo test de revert pinnea el código exacto de Anchor**, no "tira algo"
  (`expectRevert`, `tests/escrow-index.ts:370`).
- **`escrow-window.ts` re-declara las constantes del programa como literales propios** en vez de
  importarlas, a propósito: un test que le pregunta al programa su propio número sigue pasando
  después de que alguien lo divida por diez (sección "Build and test" del README).
- **Cada guard nuevo se rompe a propósito y se registra en `doc/mutation-run.md`** con qué test lo
  mató. Un guard sin mutante no cuenta como probado acá.
- **Las listas blancas se escriben como listas blancas, no como negaciones** (`is_terminal()`,
  `programs/escrow/src/lib.rs:471-481`), aunque hoy den lo mismo.
- **Prosa falsable.** El README dice qué NO se probó y con qué input se refutaría cada afirmación.
  Una frase que promete una propiedad universal hace que nadie vuelva a mirar ahí.

## Sistemas externos y consumidores

| Consumidor | Qué hace contra este programa | Archivo |
|---|---|---|
| `chaski-v3` | arma `deposit` (partial-signed por la wallet), y además `register_escrow`, `refund` y `close` | `src/infrastructure/solana-wallet.ts`: `.deposit(` en `:644`, `.registerEscrow(` en `:747`, `.refund(` en `:987`, `.close(` en `:1220` |
| `wasiai-facilitator` | firma `release` y lee `EscrowState` | `src/chains/solana-escrow.ts` |

⚠️ La fila de `chaski-v3` decía "arma **sólo** `deposit`" y citaba `:410-417`, que hoy es un docblock
sobre la recuperación de escrows. Las dos cosas estaban mal y por causas distintas: la afirmación la
volvió falsa **otro repo** (chaski empezó a armar `close`, y hay seis en cadena del 2026-08-10, cosa
que el propio README de acá ya decía), y el número lo corrió el crecimiento de ese archivo. Medido el
2026-08-15 contra `chaski-v3` `40f0b68`. Es una cita **cruzada**: ningún diff de este repo la puede
cazar, así que se re-deriva con `grep -n 'methods' -A2 src/infrastructure/solana-wallet.ts` en el otro
repo antes de citarla.

Los dos vendorean el IDL y **pinnean su sha256 canónico**. Al 2026-08-11 el valor es
`cc2761266dcf8335a17562129de040805f37f69cfe654f5be472045ba7bfcd51`, y los cuatro lados coinciden:

| Dónde | Cómo se midió |
|---|---|
| la cadena | `getAccountInfo` de la cuenta de metadata, zlib inflado desde el offset 96 (16 020 bytes) |
| este árbol | `target/idl/escrow.json` canonicalizado |
| `chaski-v3` | pin activo en `contracts/idl/escrow-idl.hash.test.ts:50`, y el doc en `contracts/CONTRACT-VERSIONS.md:95` |
| `wasiai-facilitator` | pin activo en `src/chains/escrow-idl.hash.test.ts:53` |

⚠️ **Dos trampas de este párrafo, y las dos ya nos costaron una ronda:**

1. **Los hashes viejos siguen escritos en esos mismos archivos, como comentarios `Anterior:`.** En
   `chaski-v3` el `bfbdfe5a…` vive en la línea 27 y el activo es la 50; en el facilitator el
   `bfbdfe5a…` está en el comentario justo arriba del activo. Un `grep` de 64 hexadecimales sobre
   esos archivos devuelve el histórico primero y **hace parecer que el consumidor está desalineado
   cuando no lo está**. La constante activa es la única que manda: buscá `ESCROW_IDL_SHA256 =`.
2. **La cadena envejece sola.** Este número se vuelve falso sin que nadie edite este archivo, con
   sólo republicar el IDL. El instrumento para re-verificarlo sin creerle a ningún archivo es leer
   la cuenta on-chain y canonicalizar con el algoritmo de
   `chaski-v3/contracts/idl/canonical-hash.ts` (claves ordenadas recursivamente + sha256 sobre
   UTF-8). Correr ese control **antes** de citar el valor de acá.

Historial del hash, para poder auditar el movimiento: `aa53c03f…` → `4bcc34a9…` → `fb64c937…` →
`bfbdfe5a…` → `cc276126…` (el de hoy). El `d295b7c7…` que declara
`doc/sdd/004-wkh-343-deposito-destinatario-sin-cuenta-token/idl-hash.md` es el hash **de esa rama**
al 2026-08-10, correcto como registro histórico y **ya no vigente**: `main` avanzó 13 commits
encima y el IDL se republicó.

Los dos tests de hash están **verdes**, medido el 2026-08-11: `chaski-v3` 8/8, `wasiai-facilitator`
5/5. Si alguna vez los ves rojos, no asumas que es "a propósito por un deploy pendiente" — ese
estado existió mientras WKH-343 estaba en vuelo y **ya no**.

El IDL también está publicado on-chain en la cuenta de metadata canónica
`7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC`.

**Regla:** este repo se LEE desde los consumidores, nunca al revés, y los consumidores no se
escriben desde acá.

## CI

| Workflow | Qué hace | Estado |
|---|---|---|
| `.github/workflows/ci.yml` | clippy `-D warnings`, `anchor build`, la suite completa de pruebas | verde en `ce382a8` (leído 2026-08-15) |
| `.github/workflows/verified-build.yml` | rebuild en el contenedor pinneado + compara contra devnet | verde en `ce382a8`, los dos jobs (run 31730137583) |

⚠️ La segunda fila decía "**rojo esperado** mientras el árbol lleve WKH-343 sin desplegar". WKH-343 se
desplegó el 2026-08-10 (slot `482775110`), así que esa expectativa dejó de valer y además se contradecía
con el párrafo de abajo, que ya decía `SOURCE_REPRODUCES_CHAIN` en `true`. El estado real se lee con
`gh run list --limit 8 --json displayTitle,conclusion,headSha,name`, que contesta sobre el commit más
nuevo y no sobre este archivo.

`verified-build.yml` tiene una bandera declarada, `SOURCE_REPRODUCES_CHAIN`, hoy en `true`. **No es
un mute switch**: en `false` el job *exige* que el rebuild difiera de devnet, así que desplegar y
olvidarse de moverla pone la corrida en rojo en vez de pasarla en silencio (sección
"`verified-build.yml`" del README).

## Golden path

- Devnet y sólo devnet. `scripts/deploy-devnet.sh` pinnea el cluster para que una config ambiente no
  lo redirija.
- El mint NO está clavado en el programa; entra como cuenta y queda grabado en `EscrowState.mint`.
  Es una decisión con una condición que la da vuelta, escrita en el `///` de `mint` en `Deposit`,
  `lib.rs:550-556`.
- Sin secrets en el repo. La carpeta `chaski-v3/m5-keys/` está PROHIBIDA de abrir.
- El deploy es irreversible y lo autoriza el founder aparte. Ninguna HU lo incluye por default.
