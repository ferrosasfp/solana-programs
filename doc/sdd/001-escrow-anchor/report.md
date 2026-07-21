# Report — HU-SOL-12 [WKH-215] Programa escrow on-chain (Rust/Anchor) + workspace

## Resumen ejecutivo

Programa Anchor greenfield completado: escrow trustless de USDC en Solana (PDA `escrow_state`, vault ATA con authority=PDA, máquina de estados terminal). Workspace entero compila con `anchor build` (0 warnings, rebuild limpio), suite de 9/9 tests pasa (6 AC-12 obligados + 3 cobertura extra), validación APROBADA. **Status: DONE (F4 APROBADO).** Programa **NO deployado on-chain** (CD-5: devnet only; prerequisito deploy está documentado abajo). Branch `feat/001-escrow-anchor` @ commit `8efa5ba`, listo para PR → main.

---

## Pipeline ejecutado — Gates confirmados

| Fase | Gate | Status | Fecha | Artefacto |
|------|------|--------|-------|-----------|
| F0+F1 | HU_APPROVED | PASS | 2026-07-21 | work-item.md (12 ACs EARS, DT-1..5, CD-1..7) |
| F2 | SPEC_APPROVED | PASS | 2026-07-21 | sdd.md (full, 3 NEEDS CLARIFICATION resueltos en §10, readiness check completo) |
| F2.5 | Story File | PASS | 2026-07-21 | story-HU-SOL-12.md (Wave 0-4, Context literals, anti-alucinación) |
| F3 | Implementation | PASS | 2026-07-21 | `programs/escrow/src/lib.rs` (520 LOC, 4 Contexts, 4 handlers), tests/escrow.ts (585 LOC, 9 tests), Cargo.toml (profiles CD-1), Anchor.toml (devnet), CI/deploy scripts |
| **AR** | **10 vectores cerrados** | **APROBADO** | 2026-07-21 | Commit `8efa5ba` "AR + CR APROBADOS"; verificación runtime en validation.md líneas 7-12 |
| **CR** | **9/9 checks** | **APROBADO** | 2026-07-21 | Línea por línea: Contexts literales, constraints, CPI firmada, CEI, token_program pin (validation.md:31-32) |
| Fix-pack | MNR-1 (0 warnings), MNR-2 (toolchain pin) | PASS | 2026-07-21 | auto-blindaje.md líneas 35-39; commit `8efa5ba` borra variante `Overflow` dead-code + `let _ = &remittance_id;` |
| **F4** | **Validation APROBADA** | **PASS** | 2026-07-21 | validation.md: `anchor build` 0 warnings (rebuild limpio), `anchor test` 9/9, on-chain `value: null` (CD-5 cumplido, NUNCA deployado), 12/12 ACs PASS con evidencia `lib.rs:línea` |

---

## Acceptance Criteria — Veredicto Final (12/12 PASS)

| AC | Status | Evidencia (lib.rs:línea) |
|----|----|------|
| AC-1 (destino fijo) | PASS | `lib.rs:252-269` (Release: `has_one = beneficiary`), transfer a `beneficiary_ata` en `lib.rs:76` |
| AC-2 (transición terminal) | PASS | `lib.rs:62` (release), `lib.rs:100` (refund): status a terminal ANTES de CPI (CEI) |
| AC-3 (doble transición revierte) | PASS | `lib.rs:56-59` (release), `lib.rs:90-93` (refund): `EscrowNotDeposited` guard |
| AC-4 (refund indep. de authority) | PASS | `Refund` context SIN `authority` (lib.rs:279-310); solo `sender` + `Clock` |
| AC-5 (refund pre-deadline revierte) | PASS | `lib.rs:94-97`: `DeadlineNotReached` check |
| AC-6 (release no-authority revierte) | PASS | `lib.rs:252`: `has_one = authority` (ConstraintHasOne) |
| AC-7 (init, no init_if_needed) | PASS | `lib.rs:207`: `init` constraint; 0 matches de `init_if_needed` en repo |
| AC-8 (close terminal + anti-revival) | PASS | `lib.rs:325-327`: `status != Deposited` constraint + `close = sender` |
| AC-9 (vault authority=PDA + CPI firmada) | PASS | `lib.rs:219,262,297,334`: `associated_token::authority = escrow_state` en 4 Contexts; `CpiContext::new_with_signer` en `lib.rs:79-83,117-121,141-145` |
| AC-10 (overflow-checks + checked) | PASS | `Cargo.toml` raíz: `[profile.release]` + `[profile.test]` overflow-checks=true |
| AC-11 (token_program pin) | PASS | `lib.rs:230,273,308,338`: `Program<'info, Token>` en 4 Contexts |
| AC-12 (6 escenarios anchor test) | PASS | `anchor test` 9/9 passing (6 obligados + 3 extras) |

---

## AR — 10 Vectores de Ataque CERRADOS

1. **Robo por destino malicioso** → Constraint `has_one = beneficiary` + `associated_token::authority` fija inmutable (AC-1/CD-3)
2. **Doble-gasto (release + refund)** → Máquina de estados terminal (AC-2/AC-3): status a `Released`/`Refunded` → segundo intento revierte
3. **Re-invocación de release** → Guard `status == Deposited` (AC-3)
4. **Refund por operador** → Solo `sender` Signer en Refund context (AC-4); authority ausente (CD-4)
5. **Refund pre-deadline** → Check `Clock::get()?.unix_timestamp >= deadline` (AC-5)
6. **Release por no-authority** → Constraint `has_one = authority` (AC-6)
7. **Re-inicialización** → Constraint `init` (no `init_if_needed`) (AC-7); reintentos → "already in use"
8. **Close sobre Deposited** → Constraint `status != Deposited` (AC-8)
9. **Revival de estado cerrado** → Seeds reutilizables solo vía `init` nuevo post-close (AC-8)
10. **CPI a programa malicioso** → Pin `Program<'info, Token>` (AC-11) + CPI firmada (AC-9)

**Veredicto**: APROBADO — Todos cerrados con evidencia en código.

---

## Code Review — 9/9 PASS

- Constraints literales vs Story File (4 Contexts exactos)
- CEI: status a terminal ANTES de toda CPI
- CPI firmada con PDA (`CpiContext::new_with_signer`)
- `token_program: Program<'info, Token>` pin (SPL clásico)
- `overflow-checks = true` en `[profile.release]` + `[profile.test]`
- No `init_if_needed`; solo `init` explícito
- Mint env-driven (no hardcodeado)
- Space derivado `8 + EscrowState::INIT_SPACE`
- `remittance_id` no almacenado (solo arg)

---

## Config de Seguridad

| Propiedad | Valor |
|-----------|-------|
| **PDA Seeds** | `[b"escrow", sender.key().as_ref(), remittance_id.as_ref()]` + bump canónico |
| **Vault Authority** | PDA `escrow_state` |
| **State Space** | 154 bytes (8 + 146 derivado) |
| **Overflow Checks** | `[profile.release]` + `[profile.test]` = true |
| **Token Program Pin** | `Program<'info, Token>` (SPL clásico) |
| **Init Strategy** | `init` explícito (no `init_if_needed`) |
| **CEI Order** | Status a terminal ANTES de toda CPI |
| **Authority Separation** | Release: `authority`; Refund: solo `sender` (CD-4) |
| **State Transitions** | Terminal única (Released XOR Refunded); sin revival |

---

## Archivos creados

- `Anchor.toml` (35 líneas)
- `Cargo.toml` (workspace raíz, 30 líneas)
- `programs/escrow/Cargo.toml` (40 líneas)
- `programs/escrow/src/lib.rs` (520 líneas: 4 Contexts, 4 handlers, tipos, errores)
- `rust-toolchain.toml` (channel 1.89.0)
- `tests/escrow.ts` (585 líneas: 9 tests con anchor-bankrun)
- `package.json` (45 líneas: deps test)
- `tsconfig.json` (20 líneas)
- `.github/workflows/ci.yml` (50 líneas: avm + anchor build + test)
- `scripts/deploy-devnet.sh` (15 líneas: devnet only, CD-7 comment)
- `README.md` (80 líneas: CD-6 + CD-7 doc + mint env-driven)

**Total**: workspace greenfield, 11 archivos nuevos en `solana-programs/`; nada modificado fuera.

---

## Auto-Blindaje (6 entradas de F3 + fix-pack)

### W0: `anchor init` genera subdir
- **Causa**: Comportamiento estándar (`anchor init <name>` → carpeta `<name>/`)
- **Fix**: `mv escrow/* .`, integrar `doc/` pre-existente
- **Lección**: Futuras HUs Anchor → esperar subdir, subir contenido un nivel

### W0: Scaffold modular sin `anchor-spl`
- **Causa**: Template 1.1.2 distinto al clásico TS; genera state.rs/error.rs/instructions/
- **Fix**: Consolidar a `lib.rs` único, agregar `anchor-spl = "1.1.2"`
- **Lección**: No esperar que template trae `anchor-spl`; agregarlo pinneado

### W1: `CpiContext::new` espera `Pubkey`, no `AccountInfo`
- **Causa**: API 1.1.2 distinta; firma es `new(program_id: Pubkey, accounts)`
- **Fix**: Pasar `ctx.accounts.token_program.key()` en 4 handlers
- **Lección**: CPI en anchor 1.x → primer arg es Pubkey, no AccountInfo

### W4: `anchor-bankrun` exige `[programs.localnet]`
- **Causa**: Bankrun usa tabla `[programs.localnet]` para localizar `.so`
- **Fix**: Agregar entrada `[programs.localnet]` con mismo program id
- **Lección**: Suite bankrun → mantener `[programs.localnet]` aunque provider sea devnet

### W4: Tests flaky — bankrun dedup por firma
- **Causa**: Txs idénticas en signature → dedup sin re-ejecutar
- **Fix**: Test 6: variar deadline+1 (distinto ix-data); Test 5a: `bumpSlot()` (nuevo blockhash)
- **Lección**: Reintento bankrun → variar ix-data o slot para evitar dedup

### Fix-pack: Toolchain real es 1.89.0 (no 1.97.1)
- **Causa**: `anchor init` pineó real en 1.89.0 vía `rust-toolchain.toml`
- **Fix**: Adoptar 1.89.0 como pin real; CI usa `dtolnay/rust-toolchain@1.89.0`
- **Lección**: Tomar toolchain que pinea scaffold como source of truth, no asumido por SDD

---

## Deploy a devnet — Prerequisito CRÍTICO (NO ejecutado en esta HU)

**Status actual**: Programa **NO deployado on-chain** (CD-5 cumplido). Program ID `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA` es placeholder efímero.

**Antes de deploy a devnet** (acción founder-gated en HU-SOL-19 o después):
1. Generar/fijar keypair real → `solana-keygen new -o deploy-keypair.json`
2. Ejecutar `anchor keys sync` → actualiza `declare_id!` y `Anchor.toml` al pubkey real
3. Rebuild: `anchor build` (limpio con nuevo program ID)
4. Deploy: `solana program deploy --program-id deploy-keypair.json -u devnet target/deploy/escrow.so`

**Por qué no en esta HU**: HU-SOL-12 es devnet-ready (CD-5), no deploy-inclusive. Deploy requiere decisiones de dónde guardar keypair (CI secrets), ownership, rotation. Responsabilidad founder + DevOps en HU-SOL-19 / workflow posterior.

---

## Backlog — Auditoría Externa (HU-SOL-19)

| Item | Responsable | Motivo |
|------|-----------|--------|
| Auditoría externa formal | HU-SOL-19 | Input: programa + 9/9 tests + AR cerrado; output: certified safe para mainnet |
| Upgrade authority final (multisig/timelock/`--final`) | HU-SOL-19 | Mitigación: programa devnet con upgrade authority en EOA del deployer; pre-mainnet → multisig o `--final` para evitar rug-pull |
| Deploy a mainnet | HU-SOL-19 gate | Gateado por auditoría + upgrade authority |

**Entrada para HU-SOL-19**: Este programa (branch `feat/001-escrow-anchor`, commit `8efa5ba`), workspace completo, 9/9 tests, AR 10 vectores cerrados, CR 9/9, F4 APROBADO. Devnet-ready; nunca deployed en cadena (CD-5).

---

## Lecciones para próximas HUs Solana/Anchor

1. **Toolchain como source of truth**: Scaffold genera `rust-toolchain.toml` pinneado. Tomar ESO como pin real del proyecto, no lo asumido por SDD.
2. **`anchor-spl` NO viene en template**: Agregarlo explícitamente pinneado a la CLI version (e.g., `anchor-spl = "1.1.2"` para CLI 1.1.2).
3. **Bankrun flakiness por dedup**: Txs idénticas en signature → dedup. Solución: variar ix-data o slot en reintentos.
4. **`CpiContext::new*` en 1.1.2**: Primer parámetro es `Pubkey`, no `AccountInfo`. Pasar `.key()`.
5. **Bankrun requiere `[programs.localnet]`**: Incluso si provider es devnet, bankrun necesita esa entrada en `Anchor.toml`.
6. **Deployment keypair = CI concern**: Pre-deploy, dejar clara la config: dónde vive la keypair (CI secrets, nunca repo), cómo se genera, cuándo se fija.
7. **Anti-revival vía `init`**: El constraint `init` (no `init_if_needed`) es la defensa contra re-init tras close. Pattern que otros programas pueden adoptar.

---

## Status Final

- ✅ Workspace greenfield (`solana-programs/`)
- ✅ 4 instrucciones (deposit/release/refund/close)
- ✅ PDA `escrow_state` + vault ATA (authority=PDA)
- ✅ Máquina de estados terminal
- ✅ 9/9 tests (6 AC-12 + 3 cobertura)
- ✅ AR: 10 vectores cerrados
- ✅ CR: 9/9 checks
- ✅ Fix-pack: 0 warnings, toolchain pinneado
- ✅ F4 Validación: APROBADA
- ✅ Branch `feat/001-escrow-anchor` @ `8efa5ba`
- ✅ Program ID: `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA` (placeholder, será reemplazado en deploy)
- ✅ On-chain: NOT DEPLOYED (CD-5 cumplido)

**READY FOR DONE. PREREQUISITO DEPLOY DOCUMENTADO. LISTO PARA MERGE A MAIN.**

*Report compilado por nexus-docs — F4 APROBADO — 2026-07-21*
*WKH-215 / HU-SOL-12 · solana-programs repository*
