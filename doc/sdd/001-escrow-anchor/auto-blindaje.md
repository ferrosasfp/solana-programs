# Auto-Blindaje — #001 escrow-anchor (WKH-215 / HU-SOL-12)

Registro de errores/divergencias durante F3 y sus fixes. Protege futuras HUs Solana del mismo tropiezo.

### [2026-07-21] W0 — `anchor init` genera subdirectorio, no scaffoldea en el cwd
- **Error**: el Story File asumía que `anchor init escrow` scaffoldea DENTRO de `solana-programs/`; la CLI 1.1.2 creó `solana-programs/escrow/` (subdir con su propio `.git`).
- **Causa raíz**: comportamiento estándar de `anchor init <name>` (crea carpeta `<name>`).
- **Fix**: `mv escrow/* .` (incluyendo dotfiles y `.git`), `rmdir escrow`. El workspace queda en `solana-programs/` con `doc/` conviviendo, `programs/escrow/` exactamente como pide la Files table. Branch `feat/001-escrow-anchor` creada sobre ese repo.
- **Aplicar en**: cualquier `anchor init` futuro → esperar un subdir con el nombre dado y subir el contenido un nivel.

### [2026-07-21] W0 — scaffold 1.1.2 es modular + tests Rust/litesvm, sin `anchor-spl`
- **Error**: el template de `anchor init` 1.1.2 generó layout modular (`state.rs`/`error.rs`/`constants.rs`/`instructions/`) con un contador de ejemplo y tests en Rust (litesvm), y NO agregó `anchor-spl`. El Story File prescribe un único `lib.rs` + tests TS (anchor-bankrun).
- **Causa raíz**: el Architect asumió el template TS clásico de Anchor; la 1.1.2 usa otro default.
- **Fix**: (1) borré los módulos del contador y el test Rust; consolidé todo en `programs/escrow/src/lib.rs` (exacto a la spec del Story File). (2) agregué `anchor-spl = "1.1.2"` (crate companion, misma versión que la CLI/`anchor-lang`, requerido por el diseño del vault/ATA y referenciado por W0.3) y `anchor-spl/idl-build` al feature `idl-build`. (3) Removí los `dev-dependencies` Rust huérfanos. La estructura destino la dicta el Story File → no es invención.
- **Aplicar en**: futuras HUs Anchor → no confiar en que el template trae `anchor-spl`; agregarlo pinneado a la versión de la CLI.

### [2026-07-21] W1 — `CpiContext::new` en anchor-lang 1.1.2 recibe `Pubkey`, no `AccountInfo`
- **Error**: `anchor build` falló `E0308: expected Pubkey, found AccountInfo` en `CpiContext::new(ctx.accounts.token_program.to_account_info(), ...)` (el snippet del Story File usa la API vieja).
- **Causa raíz**: en anchor-lang 1.1.2 la firma es `CpiContext::new(program_id: Pubkey, accounts)` y `new_with_signer(program_id: Pubkey, accounts, seeds)` (verificado en `.../anchor-lang-1.1.2/src/context.rs:188,198`). El helper `anchor_spl::token::transfer` usa `spl_token::ID` internamente e ignora ese `program_id`.
- **Fix**: pasar `ctx.accounts.token_program.key()` en los 4 handlers (deposit/release/refund/close). No cambia semántica de firma del CPI.
- **Aplicar en**: todo CPI con `CpiContext::new*` bajo anchor 1.x → primer arg es la Pubkey del programa, no su AccountInfo.

### [2026-07-21] W4 — `anchor-bankrun` startAnchor exige `[programs.localnet]`
- **Error**: `startAnchor('.', [], [])` tiró `programs.localnet not found in Anchor.toml`; el Story File sólo definía `[programs.devnet]` (+ `cluster="devnet"`).
- **Causa raíz**: bankrun usa la tabla `[programs.localnet]` para localizar `target/deploy/*.so` del validador in-process.
- **Fix**: agregué `[programs.localnet]` con el mismo program id, comentando que es sólo para bankrun y NO cambia el cluster de deploy (el deploy script pinnea `--provider.cluster devnet`). CD-5 intacto.
- **Aplicar en**: cualquier suite bankrun → mantener `[programs.localnet]` aunque el provider apunte a devnet.

### [2026-07-21] W4 — tests flaky: bankrun dedup de transacciones idénticas ("already been processed")
- **Error**: bajo `anchor test`, los tests 5a (segundo `release` idéntico) y 6 (segundo `deposit` idéntico) fallaban con "This transaction has already been processed" en vez de ejecutar y tirar `EscrowNotDeposited` / "already in use". Pasaban con `ts-mocha` directo (no determinístico: dependía de si el blockhash cambiaba).
- **Causa raíz**: dos txs con mismos ix-data + accounts + signers + recentBlockhash → misma firma → bankrun las deduplica por firma sin re-ejecutar.
- **Fix**: hacer distinta la tx de reintento. Test 6: segundo `deposit` con `deadline+1n` (mismas seeds, otro ix-data → colisiona en `init` = "already in use"). Test 5a: `bumpSlot()` (`context.warpToSlot(slot+1)`) antes del reintento → blockhash fresco → firma distinta → ejecuta y tira `EscrowNotDeposited`. Verificado determinístico (3 corridas 9/9).
- **Aplicar en**: cualquier test bankrun que reintente una operación de misma forma → variar ix-data o avanzar slot para evitar el dedup por firma.
