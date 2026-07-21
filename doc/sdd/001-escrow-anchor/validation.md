# Validation Report — WKH-215 / HU-SOL-12 (escrow Anchor) (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-21
**Branch/HEAD**: `feat/001-escrow-anchor` @ `8efa5ba`

## Runtime checks (evidencia propia, re-ejecutada por QA)
- `anchor build` (rebuild limpio, `cargo clean -p escrow` + borrado de `target/sbf-solana-solana`/`target/deploy`): exit 0, **0 warnings** (`grep -ic warning` → 0) — confirma claim del fix-pack MNR-1.
- `anchor test --skip-build --skip-deploy --skip-local-validator`: **9/9 passing** (553-631ms), reconfirmado 2 veces contra el `.so` recién compilado.
- On-chain devnet read-only (`getAccountInfo` RPC directo a `api.devnet.solana.com`): `value: null` para `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA` → **el programa NUNCA fue deployado** (CD-5 cumplido; ni siquiera hubo deploy a devnet, mucho menos mainnet).
- `rustc --version` → `1.89.0` (coincide con el pin documentado en el fix-pack/auto-blindaje.md, diverge del SDD §3 original de forma documentada y aceptada).
- Nota operativa (no bloqueante): al borrar `target/deploy/` para forzar el rebuild limpio, `anchor build` emite el warning informativo de Anchor CLI "Program ID mismatch" (keypair local regenerado ≠ `declare_id!`). Es comportamiento esperado de cualquier clon fresco (`target/` está en `.gitignore`, la keypair de deploy nunca se versiona) — no es un warning de compilador/clippy y no afecta build/test (ambos exit 0, 9/9 verde).

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (destino fijo) | PASS | `programs/escrow/src/lib.rs:252-269` (`has_one = beneficiary` + `associated_token::authority = beneficiary` en `Release`), transfer a `beneficiary_ata` en `lib.rs:76`. `tests/escrow.ts:259-287` (test 1) |
| AC-2 (transición terminal) | PASS | `lib.rs:62` (release), `lib.rs:100` (refund), mutados ANTES de la CPI. `tests/escrow.ts:286,372` |
| AC-3 (doble transición revierte) | PASS | `lib.rs:56-59` (release), `lib.rs:90-93` (refund), `EscrowNotDeposited`. `tests/escrow.ts:377-444` (test 5a/5b) |
| AC-4 (refund indep. de authority) | PASS | `Refund` context SIN campo `authority`, `lib.rs:279-310`; check deadline `lib.rs:94-97`. `tests/escrow.ts:347-373` (test 4, authority nunca firma) |
| AC-5 (refund pre-deadline revierte) | PASS | `lib.rs:94-97` `DeadlineNotReached`. `tests/escrow.ts:320-343` (test 3) |
| AC-6 (release no-authority revierte) | PASS | `has_one = authority` `lib.rs:252` → `ConstraintHasOne`. `tests/escrow.ts:291-316` (test 2) |
| AC-7 (init, no init_if_needed) | PASS | `init` en `lib.rs:207`; `grep -rn init_if_needed` → 0 matches en todo el repo. `tests/escrow.ts:448-460` (test 6, "already in use") |
| AC-8 (close terminal + anti-revival) | PASS | `constraint status != Deposited` + `close = sender` `lib.rs:325-327`. `tests/escrow.ts:464-483` (test 7, EscrowNotTerminal) + `tests/escrow.ts:485-529` (test 8, ciclo completo release→close→re-deposit limpio) |
| AC-9 (vault authority=PDA + CPI firmada) | PASS | `associated_token::authority = escrow_state` en los 4 Contexts (`lib.rs:219,262,297,334`); `CpiContext::new_with_signer` con `signer_seeds` derivados de `escrow_state.bump` en `lib.rs:79-83` (release), `117-121` (refund), `141-145` (close). Confirmado en runtime: logs on-chain de `anchor_test2.log` muestran el CPI `Transfer`/`CloseAccount` exitoso bajo la authority del PDA |
| AC-10 (overflow-checks + checked arithmetic) | PASS | `Cargo.toml` raíz: `[profile.release] overflow-checks = true` y `[profile.test] overflow-checks = true` confirmados. `grep` sobre `lib.rs` → 0 operadores `+`/`-` crudos sobre `amount` (no hay cómputo aritmético sobre `amount` en el scope de esta HU — el requisito de `checked_add`/`checked_sub` es vacuamente satisfecho; se removió la variante `ErrorCode::Overflow` no usada en el fix-pack, documentado, a reintroducir si una HU futura agrega aritmética) |
| AC-11 (token_program pin) | PASS | `token_program: Program<'info, Token>` en los 4 Contexts: `lib.rs:230` (Deposit), `273` (Release), `308` (Refund), `338` (Close) |
| AC-12 (6 escenarios anchor test) | PASS | `anchor test` → **9/9 passing** (los 6 exigidos + 3 extra: close-pre-terminal, anti-revival, zero-amount). Re-ejecutado por QA, ver Runtime checks |

## Drift
- **NONE**. Los 4 Contexts (`Deposit`/`Release`/`Refund`/`Close`) matchean literal los constraints del Story File. `EscrowState`/`EscrowStatus`/`ErrorCode` (salvo la variante dead-code removida en el fix-pack) idénticos a DT-2/DT-5. `remittance_id` no se almacena (solo arg), confirmado. Todos los archivos tocados caen dentro de `solana-programs/` (Scope IN); `git ls-files` no muestra nada fuera del repo objetivo. Las 6 entradas de `auto-blindaje.md` (subdir de `anchor init`, template sin `anchor-spl`, firma `CpiContext::new` con `Pubkey`, `[programs.localnet]` para bankrun, dedup de tx en bankrun, pin real de toolchain 1.89.0) son fixes de entorno/tooling documentados con causa raíz — no son scope creep ni debilitan ningún constraint de seguridad.
- Fix-pack (`8efa5ba`) verificado línea por línea (`git diff abffbd6 8efa5ba -- lib.rs`): solo agrega `let _ = &remittance_id;` (silencia warning, no toca lógica) y borra la variante `ErrorCode::Overflow` sin uso. Ningún `has_one`/`seeds`/`init`/`close`/CPI firmada/CEI/overflow-checks/pin de `Token` fue tocado.

## Gates (confirmadas por evidencia propia — no había cr-report.md/ar-report.md en disco, se re-ejecutaron los gates runtime directamente)
- `anchor build`: PASS, 0 warnings (rebuild limpio)
- `anchor test`: PASS, 9/9
- Deploy on-chain: confirmado AUSENTE (CD-5) vía lectura RPC directa a devnet

## AR/CR follow-up
- Commit `8efa5ba` documenta "AR + CR APROBADOS" (10 vectores AR cerrados, 9/9 CR) con fix-pack MNR-1 (warning unused var + dead code) / MNR-2 (pin toolchain 1.89.0 documentado + CI alineado). No se encontraron `ar-report.md`/`cr-report.md` en disco — el rastro queda en el mensaje de commit + `auto-blindaje.md`; QA re-derivó evidencia runtime propia en vez de asumir el claim.

**Listo para DONE.**
