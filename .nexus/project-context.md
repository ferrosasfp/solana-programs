# project-context — solana-programs

Generado en F0 (NexusAgil / nexus-analyst) el 2026-08-05, para WKH-326.
Todo lo de acá se leyó de archivos del repo. Lo que no se pudo verificar está marcado como tal.

## Qué es este repo

Un solo programa Anchor: `escrow`, el escrow no custodial del momento en vuelo de una remesa.
Es la mitad on-chain de un sistema más grande; acá viven el programa, sus tests y el script de deploy.

- Repo: `github.com/ferrosasfp/solana-programs`
- Program id: `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` (devnet, `declare_id!` en `programs/escrow/src/lib.rs:62`)
- Loader: upgradeable. Upgrade authority: `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` (una sola llave devnet)
- Licencia: MIT

**No hay mainnet.** Todo el dinero custodiado hoy es faucet de devnet (README.md:26).

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
reproducibilidad, que es una falla más silenciosa (README.md:795-797).

## Estructura

```
programs/escrow/src/lib.rs     el programa entero, un solo archivo (732 líneas)
tests/escrow.ts                10 tests: depósito, release, refund, close, máquina de estados
tests/escrow-index.ts          13 tests: índice, caminos de atacante, cap, rent, compute
tests/escrow-window.ts         20 tests: ventana de custodia, bordes, barrido del vault
scripts/deploy-devnet.sh       único camino de deploy (cluster pinneado a devnet)
scripts/onchain-hash.py        lee la cadena y compara hashes; stdlib, no firma nada
scripts/programdata-capacity.py preflight de tamaño antes de un upgrade
scripts/list-live-escrows.py   lista EscrowState vivos y marca los bloqueantes
doc/mutation-run.md            cada guard roto a propósito, uno por uno, y qué test lo mató
doc/publish-idl-onchain.md     cómo se publicó el IDL en cadena
doc/decisions/                 decisiones de producto escritas
README.md                      1019 líneas; es el documento principal del repo
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
(README.md:903-908). No reformatear el programa como efecto colateral de otra HU.

## Trampas conocidas del repo (esto es lo que muerde)

1. **`anchor deploy` y bankrun shippean lo que está en `target/deploy/`, no compilan.** Restaurar
   el fuente sin rebuildear deja un binario mutado corriendo y la suite reporta fallas que no tienen
   nada que ver con el código en disco. Este repo se comió esto dos veces
   (README.md:782-785, `doc/mutation-run.md:9-15`). **Rebuildear siempre antes de correr la suite.**
2. **Los `///` y `//!` viajan al IDL y le mueven el sha256 canónico.** Los `//` no. Está medido en
   las dos direcciones (README.md:32). Hay tres doc comments hoy que dicen cosas falsas y se
   corrigieron con `//` adyacentes en vez de editarlos, justamente por esto.
3. **Los códigos de `ErrorCode` son posicionales desde 6000.** Insertar una variante en el medio
   renumera todo lo que sigue y rompe cualquier cliente que mapee códigos
   (`programs/escrow/src/lib.rs:478-480`). Se apendiza al final, siempre.
4. **`EscrowStatus` tiene EXACTAMENTE tres variantes y el número es parte del contrato.** Los dos
   consumidores pinnean un IDL con tres; un byte de status 3 hace que su `BorshAccountsCoder` tire.
   `escrow-window.ts` E1b es el alambre (`programs/escrow/src/lib.rs:438-444`).
5. **El layout de `EscrowState` está congelado.** Agregar un campo mantiene el discriminador y rompe
   el borsh de toda cuenta ya en cadena: `release`/`refund`/`close` empezarían a fallar con
   `AccountDidNotDeserialize` (README.md:381-387). `escrow.ts` 1a asertea los 154 bytes.
6. **bankrun deduplica txs por firma.** Un retry de una tx de forma idéntica "pasa" sin ejecutarse si
   no se avanza el slot. Ver `bumpSlot()` en `tests/escrow-index.ts:309-312` (CD-12).
7. **El compute de `deposit + register_escrow` NO es una constante**: 52.826..79.826 CU sobre 28
   corridas, en pasos de 1.500, porque los bumps canónicos cambian con los keypairs aleatorios de
   cada corrida (`tests/escrow-index.ts:725-731`). Dimensionar contra el peor caso, nunca contra una
   muestra.
8. **El ProgramData no crece solo.** Un upgrade que no entra falla adentro del loader sin mencionar
   el tamaño, después de subir el binario entero. Por eso el deploy corre
   `programdata-capacity.py` primero (README.md:970-996).
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
  (`tests/escrow-index.ts:328-350`).
- **`escrow-window.ts` re-declara las constantes del programa como literales propios** en vez de
  importarlas, a propósito: un test que le pregunta al programa su propio número sigue pasando
  después de que alguien lo divida por diez (README.md:763-765).
- **Cada guard nuevo se rompe a propósito y se registra en `doc/mutation-run.md`** con qué test lo
  mató. Un guard sin mutante no cuenta como probado acá.
- **Las listas blancas se escriben como listas blancas, no como negaciones** (`is_terminal()`,
  `programs/escrow/src/lib.rs:447-457`), aunque hoy den lo mismo.
- **Prosa falsable.** El README dice qué NO se probó y con qué input se refutaría cada afirmación.
  Una frase que promete una propiedad universal hace que nadie vuelva a mirar ahí.

## Sistemas externos y consumidores

| Consumidor | Qué hace contra este programa | Archivo |
|---|---|---|
| `chaski-v3` | arma **sólo** `deposit` (partial-signed por la wallet) | `src/infrastructure/solana-wallet.ts:315-322` |
| `wasiai-facilitator` | firma `release` y lee `EscrowState` | `src/chains/solana-escrow.ts` |

Los dos vendorean el IDL y **pinnean su sha256 canónico**, desde el re-pin del 2026-08-05
(`chaski-v3` `bd85dfa`, `wasiai-facilitator` `f9bddce`)
`bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`, que es el mismo que devuelve
`anchor idl fetch` y el que construye este árbol (el anterior era `fb64c937…`):

- `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:22` + `chaski-v3/contracts/CONTRACT-VERSIONS.md`
  (hay un test que exige que el doc publique exactamente la constante, `:107-142`)
- `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:30`

El IDL también está publicado on-chain en la cuenta de metadata canónica
`7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC`.

**Regla:** este repo se LEE desde los consumidores, nunca al revés, y los consumidores no se
escriben desde acá.

## CI

| Workflow | Qué hace | Estado |
|---|---|---|
| `.github/workflows/ci.yml` | clippy `-D warnings`, `anchor build`, la suite completa de pruebas | verde |
| `.github/workflows/verified-build.yml` | rebuild en el contenedor pinneado + compara contra devnet | **rojo esperado** mientras el árbol lleve WKH-343 sin desplegar: el rebuild ya no reproduce devnet, y eso es el job funcionando |

`verified-build.yml` tiene una bandera declarada, `SOURCE_REPRODUCES_CHAIN`, hoy en `true`. **No es
un mute switch**: en `false` el job *exige* que el rebuild difiera de devnet, así que desplegar y
olvidarse de moverla pone la corrida en rojo en vez de pasarla en silencio (README.md:822-837).

## Golden path

- Devnet y sólo devnet. `scripts/deploy-devnet.sh` pinnea el cluster para que una config ambiente no
  lo redirija.
- El mint NO está clavado en el programa; entra como cuenta y queda grabado en `EscrowState.mint`.
  Es una decisión con una condición que la da vuelta, escrita en `lib.rs:520-524`.
- Sin secrets en el repo. La carpeta `chaski-v3/m5-keys/` está PROHIBIDA de abrir.
- El deploy es irreversible y lo autoriza el founder aparte. Ninguna HU lo incluye por default.
