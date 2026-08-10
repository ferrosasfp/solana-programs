# WKH-343 — runbook del upgrade a devnet

> ⛔ **ESTE DOCUMENTO SE ESCRIBIÓ. NO SE EJECUTÓ.** Ningún paso de la sección 4 se corrió. No se
> desplegó nada, no se firmó nada, no se movió un solo token. El estado real al cierre de esta HU es:
> **W0..W5 hechas, W6 planificada y NO ejecutada.**
>
> Eso **no es una entrega incompleta**: es el orden que evita cortar los depósitos. Correr el upgrade
> antes de que su gate esté satisfecho tiene un resultado medible y conocido — **ningún depósito
> entra** — así que el upgrade espera, y el que decide cuándo es el founder.

Fecha del documento: 2026-08-10. Árbol: `feat/004-wkh-343-deposito-destinatario-sin-cuenta-token`,
sobre `main` @ `8fca47294f6cd8e7ecefd330e278e63078957e26`.

---

## 1. El GATE. Sin las dos mitades, esto no se corre

> **W6 no corre hasta que (i) `chaski-v3` mande `beneficiary_ata` en su `deposit`, y (ii) el
> beneficiario en uso tenga una ATA para el mint en uso.**

| Mitad | Por qué | Estado medido | Cómo se verifica |
|---|---|---|---|
| **(i)** El cliente manda la cuenta | Si no la manda, el programa nuevo lee **otra cosa** como `beneficiary_ata` y **todo depósito falla** (ver §3) | ⛔ **NO satisfecha.** `chaski-v3` arma el depósito con 5 cuentas nombradas y no manda `beneficiary_ata` | `simulateTransaction` con `sigVerify: false` contra devnet, **más** un depósito real de `chaski-v3` **antes** del deploy |
| **(ii)** El beneficiario tiene la ATA **canónica** | Si no la tiene, el programa nuevo **rechaza el 100% de los depósitos** | ⛔ **NO satisfecha.** Medido al slot `482608313`: la ATA canónica del beneficiario `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` para el mint de Circle `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` es `Cq9AinM9WCry8Pyk5EsFJ2hdQomKAUES7Cq7YLunRGMC` y **no existe** | `python3 scripts/list-live-escrows.py --url devnet` ⇒ tiene que imprimir `beneficiary can receive: yes` |

⚠️ **La palabra "canónica" de la fila (ii) no es un adorno, y el instrumento no la preguntaba.** Hasta
el fix pack de esta HU el script preguntaba `getTokenAccountsByOwner(beneficiary, {mint})`, que filtra
por los DATOS de la cuenta (owner + mint) y por lo tanto **también devuelve token accounts que no son
la ATA canónica**. El programa exige la **dirección** derivada (`associated_token::`), así que una
cuenta no canónica pasaba el chequeo del script y el programa la rechaza con `ConstraintAssociated
(2009)`. O sea: **un `yes` falso autorizaba el deploy hacia el estado que esta fila describe como
"rechaza el 100% de los depósitos"**. Medido con una sonda que le da el mismo fixture al programa y a
las dos versiones del chequeo, en `fix-pack-blq-med-1.txt`. Hoy el script deriva la ATA y exige que la
lista la contenga; el `yes` de arriba ya significa lo que la fila dice.

Y una cosa más sobre cómo leer esa salida: **`--exit-nonzero-if-blocking` cubre CINCO condiciones**, no
una. Al principio miraba sólo "Deposited y vencido"; las otras cuatro eran cosas que el script
imprimía y después descartaba al devolver: el beneficiario impagable, un status byte desconocido,
**cero cuentas observadas** (un `--program-id` válido pero equivocado, un `--idl` viejo o el cluster
equivocado daban "0 accounts" y salían 0) y **el reloj del cluster no leído** (ahí el script sustituye
el reloj local y los veredictos de deadline se dan vuelta). Si el gate se apoya en `$?`, ahora cuentan
las cinco, y el script las lista siempre en stdout.

⛔ **Un `$?` distinto de cero NO dice por qué.** Un 429 del endpoint público a mitad del barrido también
sale distinto de cero, y se ve igual que "hay escrows bloqueantes". **La razón se lee del stdout**, que
siempre la imprime — con la bandera y sin ella. No armes el gate sobre el número solo.

⛔ **CD-22: el gate NO se declara cumplido sin la salida del script que lo demuestre.** Citar el slot
de este documento no alcanza y con el tiempo es peor que no citar nada: el estado on-chain cambia sin
que nadie edite este archivo (medido: 4 filas cambiaron de estado entre los slots `482578481` y
`482583139`, dentro de una misma sesión). **Corré el script.**

### 1.1 Las dos salidas posibles, y este documento NO elige

- **Camino A** — se abre primero la HU de `chaski-v3`; cuando aterriza, W6 corre. **Sin ventana de
  falla**, porque la cuenta va al final y el orden cliente-primero es seguro (§3).
- **Camino B** — el founder acepta **explícitamente** una interrupción de depósitos y W6 corre antes.

⛔ **Ni este documento ni quien implementó la HU eligen B.** Es decisión del founder.

---

## 2. Las 4 decisiones del founder que están ABIERTAS y que W6 necesita

Ninguna se puede derivar del repo. Van como preguntas, no como supuestos.

1. **¿Cuál es el mint pretendido en devnet?** El de Circle (`4zMMC9srt…`) o el nuestro
   (`8yRX3fZ2…`). No es cosmético: decide **quién** tiene que provisionar la ATA del beneficiario, y
   decide a qué **freeze authority** se expone la custodia. El de Circle tiene una freeze authority
   que **no es nuestra** (`CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT`, medido al slot `482578725`).
2. **¿Quién provisiona la ATA del beneficiario?** Crearla es **una** transacción, la paga cualquiera,
   y no requiere la firma del beneficiario. Pero *que alguien la corra* es una acción operativa que
   hoy no tiene dueño asignado. Es la mitad (ii) del gate.
3. **¿Camino A o camino B?** (§1.1).
4. **¿Cuál es el path del keypair de la upgrade authority?** La authority es
   `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`, leída de la cadena. El keypair **no está en el
   repo, y eso es correcto**: las 4 menciones que hay son placeholders (`README.md` en la sección de
   deploy, `scripts/deploy-devnet.sh`, `doc/publish-idl-onchain.md`) y `~/.config/solana/id.json`
   **no existe** en este host. **Lo provee el founder.**
   ⛔ No se buscó en `m5-keys/`: esa carpeta no se abre, no se lista y no se cita, ni siquiera para
   averiguar si el keypair está ahí (CD-2). Si la respuesta estuviera ahí, **esto sigue siendo una
   pregunta al founder.**

---

## 3. ⚠️ R11 — el riesgo más silencioso de esta HU. **NO VERIFICADO**

Medido **leyendo** `chaski-v3/src/infrastructure/solana-wallet.ts` (sólo lectura, CD-7): el cliente
real arma el depósito con `.accounts({sender, mint, escrowState, vault, senderAta})` **y**
`.remainingAccounts([{ pubkey: reference, ... }])` — un pubkey de referencia estilo Solana Pay que el
programa nunca lee.

**O sea: la última cuenta de la transacción de hoy no es `system_program`, es `reference`.**

### 3.1 El orden cliente-primero sigue siendo seguro

El cliente nuevo emite `[…8 declaradas…, beneficiary_ata, reference]`. El programa **viejo** consume 8
y deja las **dos** en `remaining_accounts`, que `Deposit` no mira. Funciona. Verificado
ejecutablemente: el test 14 de `tests/escrow.ts` manda un depósito con una cuenta extra pegada al
final y pasa, **contra los dos binarios** (pasaba antes del cambio y pasa después).

### 3.2 El modo de falla del cliente viejo es ENGAÑOSO, y hay que escribirlo antes de que alguien lo debuguee

El cliente **viejo** contra el programa **nuevo** emite `[…8…, reference]`. El programa nuevo lee
**`reference` como `beneficiary_ata`** y, al ser un pubkey sin cuenta detrás, tira
`AccountNotInitialized` **nombrando `beneficiary_ata`**.

⚠️ **La causa real es "el cliente no se actualizó" y el error apunta a otra cosa.** Alguien va a
perder una tarde revisando ATAs de beneficiarios que están perfectas. Está escrito también en el
comentario de la cuenta, en `programs/escrow/src/lib.rs`, para que se lea desde el código.

### 3.3 ⛔ `reference` se corre del índice 8 al 9 — **VERIFICACIÓN OBLIGATORIA DEL HANDOFF, NO VERIFICADA**

**NO está verificado** si algo del lado de `chaski-v3`, de `wasiai-facilitator` o de un explorador lee
ese `reference` **por posición fija** en vez de por barrido de `accountKeys`.

**Si alguien lo lee posicionalmente, el arreglo le rompe el camino de pago en silencio.** No hay error,
no hay excepción: lee el pubkey equivocado.

- **Quién lo verifica:** la HU de `chaski-v3`, antes de que W6 corra.
- **Cómo:** buscar en ese repo todo acceso indexado a `accountKeys`/`message.accountKeys` en el camino
  del depósito y confirmar que la referencia se ubica por comparación de pubkey, no por índice.
- ⛔ **No se asume resuelto y no se entra a `chaski-v3` a arreglarlo desde esta HU** (CD-7).

---

## 4. Los pasos. **NINGUNO SE CORRIÓ**

### 4.0 Preflight de capacidad — **este sí se corrió, y es de sólo lectura**

Es el único paso de esta sección que se ejecutó, porque no firma nada, no manda ninguna transacción y
no necesita keypair. Convierte en **MEDIDO** lo que en el SDD era **DERIVADO**.

```bash
python3 scripts/programdata-capacity.py \
  --program-id DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  --artifact target/deploy/escrow.so --url devnet
```

Salida medida el 2026-08-10 contra el artefacto **nuevo**:

| | |
|---|---|
| programdata account | `UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR` |
| bytes reservados | 412 613 (menos 45 de header del loader) |
| **usable para el binario** | **412 568** ← el número a no superar |
| artefacto nuevo | **276 800** bytes (el viejo desplegado son 274 785 ⇒ el cambio suma ~2 KB) |
| **margen** | **135 768 bytes** |
| veredicto | **ENTRA.** No hace falta `solana program extend`, no hay rent nuevo que pagar |

⇒ **No hay que ampliar el programdata.** Si en una corrida futura NO entrara, **CD-21: se reporta el
faltante en bytes y el rent que costaría, NO se paga.** (Referencia de la ampliación anterior:
+150 000 bytes ⇒ 1,044 SOL, irreversible.)

### 4.1 Barrido de escrows vivos, antes de tocar nada

```bash
python3 scripts/list-live-escrows.py --url devnet
```

Qué se busca, y son dos cosas distintas:

- **Ningún escrow en `Deposited` cuyo beneficiario no pueda recibir.** ⛔ **YA HAY UNO.** Medido al slot
  `482622899`: de 11 cuentas, 10 son terminales (7 `Refunded`, 3 `Released`) y **una está `Deposited`**
  — `5G4Zaa4RkMysquGpm61ENinp8kzo7Uu3kvpBAxFFwy4`, 5 000 000 raw del mint de Circle, sender
  `4AvAjtPg1aPwJQRvjnY1U9BHbC46rwVc5BY6FuhqUA7P`, deadline 2026-08-10 12:55:42Z — y la ATA canónica de
  su beneficiario **no existe**, así que su `release` no se puede armar.
  **Ese depósito entró durante la revisión de esta HU**, entre los slots `482620696` y `482622899`: es
  el incidente que esta HU previene, repitiéndose contra el binario **desplegado**, que no tiene el
  guard. Confirma el modo de falla y **no cambia el gate**: el upgrade sigue esperando sus dos mitades.
  Su salida, mientras el deadline aguante, es que **cualquiera** cree esa ATA (una transacción, sin
  firma del beneficiario); pasado el deadline, sólo el refund del sender. **Volver a medirlo**: este
  número ya cambió una vez mientras el documento estaba abierto. Con `--exit-nonzero-if-blocking` el
  barrido ahora devuelve **1** por esta condición — verificado en vivo con este mismo escrow.
- El upgrade de WKH-343 **no cambia el estado de ningún escrow existente**: el guard nuevo está en
  `deposit`, o sea que aplica a lo que venga. Un escrow ya depositado ni gana ni pierde salidas.

### 4.2 El deploy

```bash
anchor build
# los 3 md5 y el hash canónico del IDL: contra doc/sdd/004-.../idl-hash.md, no contra la memoria
anchor deploy --provider.cluster devnet --program-name escrow \
  --provider.wallet <PATH DEL KEYPAIR DE LA UPGRADE AUTHORITY>   # <- decisión 4 del founder
```

⚠️ **El `target/deploy/escrow-keypair.json` que este worktree generó NO es la llave del programa**
(CD-9). Es una llave aleatoria que `anchor build` creó porque el archivo no estaba
(`9gSxzEKJb2Qkxvoqnf6bwzRmYPyVCc38ZYBwm8yESshT`, que no es `DR5Go…`). El id del programa sale de
`declare_id!` y de `Anchor.toml`. **Y ⛔ NO correr `anchor keys sync`**: reescribiría `declare_id!`
con esa llave aleatoria y le cambiaría el program id a un programa con cuentas vivas en cadena.

### 4.3 Verificación post-deploy

```bash
python3 scripts/onchain-hash.py --url devnet    # el binario que quedó corriendo
```

- Comparar `artifact-sha256` / `verify-hash` contra el artefacto local.
- **Un depósito real de `chaski-v3`** tiene que entrar. Si falla con `AccountNotInitialized` sobre
  `beneficiary_ata`, releer §3.2 **antes** de sospechar de la ATA del beneficiario.
- ⛔ **Y si falla por cualquier otro motivo, la salida es §4.6 (rollback), no seguir a 4.4.** Republicar
  el IDL de un binario que hay que sacar deja las dos cosas desalineadas y agrega un paso a la
  recuperación.

### 4.4 Republicar el IDL

Recién **después** del deploy, y como paso propio:

```bash
anchor idl upgrade ...    # ver doc/publish-idl-onchain.md, incluido por qué el comando documentado falla
```

Hasta que esto corra, la cuenta `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC` sirve el IDL del
binario **desplegado**, que es el estado correcto mientras el cambio no esté desplegado.

### 4.5 Después del deploy, y no antes

- `README.md` y `SECURITY.md` hoy dicen que el árbol **diverge** de la cadena. Eso es verdad **hasta**
  que 4.2 corra, y ahí hay que darlo vuelta con la fecha y el slot del deploy nuevo.
- `SOURCE_REPRODUCES_CHAIN` de `.github/workflows/verified-build.yml` está en `true` y **el job está
  rojo a propósito** mientras el árbol diverja. ⛔ No se toca esa bandera para "arreglar" el rojo: en
  `false` el job **exige** que el rebuild difiera. Se pone verde con el deploy, no con una edición.

### 4.6 ⛔ Si 4.3 falla: VOLVER ATRÁS. Este paso faltaba

Un runbook cuyo propósito declarado es "el orden que evita cortar los depósitos" tiene que decir qué
hacer **cuando los cortó**. Hasta el fix pack de esta HU no lo decía: no había ninguna mención de
rollback ni de redespliegue del binario anterior en todo el repo.

**Cuándo se ejecuta:** cuando el depósito real de 4.3 falla y la causa no es §3.2 (cliente viejo). O
sea: el cliente manda `beneficiary_ata`, la ATA canónica del beneficiario existe, y el depósito igual
no entra.

**Quién decide:** el founder. No es una decisión del que corre el runbook, porque el rollback deja la
cadena con un binario que **acepta** depósitos que después nadie puede liberar — es exactamente el
agujero que esta HU cierra, y volver a abrirlo a cambio de que los depósitos entren es un trade que
elige el dueño del producto.

**De dónde salen los bytes viejos:** hay que **reconstruirlos**. `target/` está en `.gitignore`, así
que el `.so` desplegado el 2026-08-05 no está en el repo. Se rebuildea desde `main`, en el contenedor
pinneado, y **se verifica el hash ANTES de desplegar**:

```bash
# en un worktree limpio de main, NO en este
git worktree add /tmp/escrow-rollback main
cd /tmp/escrow-rollback && anchor build
sha256sum target/deploy/escrow.so
# tiene que dar 59ec1098cd64d04cab1063fd837e84a70c7962741a3c14932d249cab28b328ef
# (el mismo valor que README.md publica como `artifact-sha256`; el `verify-hash`,
#  que es sin el padding final, es 455e4e36fa7c63be568d470a89f7eded9aff5806b198340936a578810be09291)
anchor deploy --provider.cluster devnet --program-name escrow \
  --provider.wallet <PATH DEL KEYPAIR DE LA UPGRADE AUTHORITY>
python3 scripts/onchain-hash.py --url devnet \
  --expect-artifact-sha256 59ec1098cd64d04cab1063fd837e84a70c7962741a3c14932d249cab28b328ef
```

⛔ **Si el hash del rebuild NO coincide, PARAR y no desplegar.** Un binario que no reproduce el que
estaba corriendo no es un rollback: es un tercer binario sin probar.

⚠️ **Lo que el rollback NO deshace:** los depósitos que ENTRARON mientras el binario nuevo estuvo
vigente ya existen y son válidos para los dos binarios (el guard vive en `deposit`, no en el estado).
Y si 4.4 ya corrió, el IDL on-chain describe el binario nuevo: hay que republicar el viejo, o queda un
IDL que no corresponde al binario que corre.

**Lo que este paso NO está:** no está ejecutado, no está ensayado, y **el hash del rebuild de `main`
no se verificó** — los dos valores de arriba salen de lo que se leyó de la cadena el 2026-08-05
(`README.md`, sección Deployment), no de un rebuild hecho hoy.

---

## 5. Lo que este upgrade NO hace. **No lo escribas al revés**

- **No recupera nada.** Los 40 000 000 raw volvieron por `refund` el 2026-08-10 (slots `482579398`,
  `482579872`, `482579957`, `482580179`, los cuatro `err: None`), firmados por el sender. **El arreglo
  PREVIENE; nunca recuperó nada** y no tuvo ninguna participación en esos refunds.
- **No arregla depósitos ya hechos.** El guard vive en `deposit`.
- **No valida el mint.** El programa sigue aceptando cualquiera, a propósito. ⚠️ Lo que **sí** existe,
  y este documento afirmaba lo contrario ("sigue sin hacerse"), es el control en el co-firmante:
  `wasiai-facilitator/src/methods/solana-sponsor/cr1.ts:281-282` compara el mint contra
  `SOLANA_USDC_MINT` y devuelve `MINT_MISMATCH`, desde el commit `e14383f` del 2026-08-04 (ancestro de
  `origin/main`, verificado). **Alcance:** cubre los depósitos que pasan por el patrocinador; uno
  armado y firmado por fuera no lo atraviesa. **NO medido:** si el servicio en producción corre ese
  commit — se leyó el repo, no el deploy.
- **No recupera el alquiler.** `refund` no cierra cuentas: quedaron 8 cuentas vivas con
  **16 008 000 lamports = 0,016008 SOL** (4 × 1 962 720 del `EscrowState` + 4 × 2 039 280 del vault,
  medido al slot `482583245`). Se recuperan con `close`, que ya existe y funcionó en cadena (slot
  `482045751`). Es **residuo declarado, alcance de WKH-327**, no de esta HU.
- **No elimina el problema que la HU ataca.** Acota el caso "la ATA nunca existió" y deja **abierto**
  "existía y el beneficiario la cerró después del depósito". El test 15 de `tests/escrow.ts` ejerce
  ese caso a propósito.
- **Y ese no es el único camino abierto: hay un SEGUNDO, y es PREEXISTENTE.** `deposit` recibe
  `beneficiary` como arg `Pubkey` sin constraint de tipo (`lib.rs:146`), mientras `release` lo declara
  `SystemAccount` (el campo `beneficiary` de `pub struct Release`, citado **por nombre y sin número**:
  ese campo cambió de línea tres veces en un solo día por comentarios agregados más arriba, sin que
  nadie lo tocara). **Medido en bankrun:** con un `beneficiary` propiedad del SPL Token
  program y su ATA canónica creada, el **depósito ENTRA** — el guard de esta HU queda satisfecho — y el
  `release` falla **siempre** con `AccountNotSystemOwned (3011)`, con el vault todavía lleno. Única
  salida: el refund del sender, que es la forma exacta del incidente que esta HU previene. No es una
  regresión (el binario desplegado ya se comporta así) y necesita un **cliente modificado**:
  `chaski-v3` manda la pubkey de una billetera. Corrida completa en `fix-pack-mnr-2.txt`.
