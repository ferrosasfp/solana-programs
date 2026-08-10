# Auto-blindaje — WKH-343

Entradas escritas **en el momento** en que el error ocurrió, no reconstruidas al final.
Cada una tiene el input concreto que la reproduce, para que la HU siguiente la pueda refutar.

---

### [2026-08-10 08:05] Wave W0.1 — `anchor build` avisa "Program ID mismatch" y **exita 0**: se puede leer como "el spike no compila"

- **Error**: al capturar el baseline apareció, sin que yo corriera `anchor build`, el bloque
  `Program ID mismatch detected for program 'escrow': Keypair file has: 9gSxzEK… / Source code has:
  DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`. Estuve a punto de tratarlo como ruido.
- **Causa raíz**: el worktree no traía `target/deploy/escrow-keypair.json`, así que el **primer**
  `anchor build` lo **generó** con una llave aleatoria (`9gSxzEKJb2Qkxvoqnf6bwzRmYPyVCc38ZYBwm8yESshT`,
  verificada con `solana-keygen pubkey`). Desde ese instante **toda** corrida siguiente de `anchor build`
  compara esa llave contra el `declare_id!` de `programs/escrow/src/lib.rs` y no coinciden. El primer
  build no avisó porque en ese momento el archivo no existía.
  (Se cita por **nombre de macro** y no por número de línea a propósito: esta entrada decía
  `lib.rs:62` y W2 la dejó rota al agregar 6 líneas al `//!` del módulo, que empujaron el
  `declare_id!` a `:70`. La cazó el verificador de citas re-corrido después de W4 — ver la entrada
  [09:10] más abajo.)
- **Por qué importa, y no es cosmético**: W0.2 (spike) y W5 (mutantes) deciden **"compila / no compila"**
  leyendo la salida de `anchor build`. Un mensaje de error en rojo que termina en
  *"Please run 'anchor keys sync' … or use the '--ignore-keys' flag"* es exactamente la forma que
  tiene un fallo de compilación, y habría hecho elegir la **forma B** por un motivo falso.
- **Medido (la precondición, no la consecuencia)**: sobre el árbol **sin tocar**, `anchor build` imprime
  el bloque, `cargo` **igual corre** después ("Finished `release` profile") y `BUILD_EXIT=0`. O sea que
  es una **advertencia**, no un abort. Los 3 md5 del W0.1 reproducen `doc/mutation-run.md:59`, lo que
  confirma que el artefacto se produjo bien.
- **Fix**: el discriminador es el **texto**, no el color ni el exit code:
  - `Program ID mismatch` + `anchor keys sync` ⇒ advertencia de llave, **ignorable**, el build siguió.
  - `error[E0xxx]` / `error:` con un `--> programs/escrow/src/lib.rs:NNN` ⇒ fallo de compilación **real**.

  Y control redundante que no depende de leer texto: **si el `.so` recompiló, su md5 se movió.**
- **⛔ Lo que NO hice, a propósito**: `anchor keys sync`. Reescribiría `declare_id!` a `9gSxzEK…` y las
  dos entradas de `Anchor.toml:15,18`, o sea le cambiaría el **program id** al programa que tiene 8
  cuentas vivas en cadena. La llave generada en `target/` **no** es la llave del programa (CD-9), y la
  real no se busca (CD-2).
- **Aplicar en**: cualquier worktree recién creado de este repo — `target/` está gitignoreado, así que
  el síntoma aparece **siempre** en un checkout limpio y **nunca** en el árbol donde se corrió el build
  original. Todo veredicto "no compila" en este repo tiene que citar la línea `error[...]` que lo
  sostiene, no el hecho de que la salida se vea roja.

---

### [2026-08-10 08:20] Wave W0.2 — el spike se hizo sobre el árbol sin verificar que el build recompila

- **Error**: iba a leer "compila" del spike sin haber probado antes que `anchor build`, en este árbol y
  con la advertencia de llave encima, **realmente recompila** en vez de devolver un cache hit.
- **Causa raíz**: un cache hit y una compilación exitosa dan la misma salida ("Finished … profile") y
  **el mismo exit 0**. Es el mismo par indistinguible que el del mutante: *no aplicado* y
  *sobreviviente* se ven iguales.
- **Fix**: el spike se valida por **md5 del `.so`**, no por la salida del compilador. Si la forma A
  compila, el `.so` **tiene** que dejar de ser `d4b736cf6b9e15421e7cb1d75f3d8e0d` (agregar una cuenta
  cambia el binario). Si el md5 no se movió, la conclusión no es "compiló": es **"no medí nada"**.
- **Aplicar en**: W5 completo. Ahí el control es el simétrico y **más fuerte**: antes de correr la suite
  sobre un mutante, exigir que el `sha256sum` de `lib.rs` **DIFIERA** del original — un mutante no
  aplicado y uno que sobrevive dan las dos la misma salida verde y la conclusión de cada uno es opuesta.

---

### [2026-08-10 08:28] Wave W0.2 — el heredoc SIN comillas ejecutó los backticks de mi propia prosa

- **Error**: generé `w0-spike-form-a.txt` con `python3 - <<PY` (delimitador **sin comillas**). La prosa
  del archivo estaba llena de backticks (` `beneficiary_ata` `, ` `anchor build` `, ` `error[E0xxx]` `),
  y **bash los ejecutó como sustitución de comandos antes de que python viera una sola línea**.
- **Consecuencia real, y fue doble**:
  1. El archivo salió **corrupto en silencio**: cada término entre backticks quedó reemplazado por la
     salida del comando, casi siempre vacía. Quedó escrito `"la cuenta  con associated_token::mint"`,
     sin el nombre de la cuenta — o sea, evidencia que **perdió justo el dato**.
  2. Bash **ejecutó `anchor build`** (estaba entre backticks en una oración). Fue un cache hit
     ("Finished `release` profile in 0.12s", sin `Compiling`) porque `lib.rs` no había cambiado, así
     que **no** contaminó los artefactos — verificado después: los 3 md5 siguen siendo los del spike
     (`03776e2d…` / `809a69ec…` / `5abd215a…`). Con `lib.rs` a medio editar, habría rebuildeado un
     árbol intermedio y pisado el artefacto que estaba midiendo.
- **Causa raíz**: `<<PY` interpola; `<<'PY'` no. Yo ya usaba `<<'PY'` en los comandos anteriores y lo
  perdí **exactamente** en el que necesitaba interpolar una variable (`$SP`), sin notar que la misma
  interpolación aplica a los backticks.
- **Fix**: la evidencia se escribe con la herramienta `Write`, no con heredoc. Cuando haga falta
  heredoc, `<<'PY'` **siempre**, y los valores variables se pasan por `sys.argv` o se recalculan dentro
  de python. Prosa técnica y heredoc interpolado no se mezclan.
- **Aplicar en**: los `.txt` de W1/W3/W5 y las entradas de este mismo archivo — son todos documentos con
  identificadores entre backticks, o sea el caso peor. Y el control barato que lo caza: después de
  escribir un archivo de evidencia, **releer una línea que contenía backticks** y comprobar que el
  identificador sigue ahí.

#### Addendum [08:52] — el mismo heredoc además **creó un archivo dentro de `programs/escrow/src/`**

Lo encontré recién en W1, dos waves después, en un `git status --porcelain` **completo**.

- **Qué apareció**: `?? programs/escrow/src/lib.rs:NNN`, un archivo de **0 bytes**, untracked.
- **Causa**: la prosa del `w0-spike-form-a.txt` decía *"un `error:` con un `--> programs/escrow/src/lib.rs:NNN`"*.
  Bash leyó ese `>` como una **redirección de salida** y creó el archivo cuyo nombre venía después.
  No es sólo que los backticks se ejecutan: **`>`, `<` y `|` dentro de la prosa también actúan.**
- **Por qué es peligroso y no cosmético**: quedó **dentro del directorio del programa**, con un nombre
  que empieza con `lib.rs`, y a 0 bytes. Un glob distraído (`programs/escrow/src/lib.rs*`) lo agarra, y
  un `git add programs/` lo habría commiteado como si fuera fuente del programa.
- **Fix**: `rm -f` del archivo (verificado antes: 0 bytes y untracked, así que no pisó nada versionado)
  y `git status --porcelain` **completo** después, que quedó con sólo `M tests/escrow.ts` y el
  directorio de la HU.
- **Aplicar en**: es la razón concreta por la que CD-17 pide `git status --porcelain` **completo** y no
  `| head` ni `| wc -l`. Con `| wc -l` habría leído "3 líneas" y seguido de largo; el nombre del archivo
  es el único dato que delata el problema. Lo cacé **dos waves tarde**: el `git status` completo va
  después de **cada** wave, no al final.

---

### [2026-08-10 08:30] Wave W3 — mi optimización dejó el criterio de salida INVERIFICABLE, porque la cadena se movió

- **Error**: escribí el chequeo nuevo preguntando por la ATA del beneficiario **sólo cuando el escrow
  estaba en `Deposited`**. Parecía obviamente correcto: en un escrow terminal los tokens ya salieron, así
  que una ATA faltante no traba nada. Corrí el script y el chequeo **no se ejecutó ni una vez**.
- **Causa raíz**: al slot 482593585 **no hay ningún escrow en `Deposited`** — el founder refundeó los 4
  trabados el 2026-08-10 (slots 482579398..482580179). O sea que la rama donde vivía mi chequeo estaba
  muerta, y el criterio de salida (ii) de §7.4 ("el chequeo de la ATA imprime `NO` para el mint de
  Circle") era **imposible de satisfacer**, no por un bug del chequeo sino por el estado de la cadena.
- **Lo importante, y es lo que lo hace una lección y no un descuido**: el Story File **contiene las dos
  cosas** y son inconsistentes entre sí. §7.5 P2 dice "al slot 482583139 **no hay ninguno**: 0 en
  `Deposited`", y §7.4 pide que el chequeo imprima `NO`. Con 0 escrows en `Deposited`, las dos no pueden
  ser verdad a la vez si el chequeo sólo mira los `Deposited`. La cadena se movió **entre** que el
  architect midió §1.1 (los 4 trabados, slot 482578601) y que escribió el criterio de salida.
- **Fix**: se pregunta **siempre**, para todos los escrows, y se separan dos cosas que yo había
  colapsado en una:
  - **el HECHO** (¿existe la ATA?) es una propiedad de `(beneficiario, mint)` y vale imprimirlo también
    en un escrow terminal: es lo que **explica** por qué un escrow pasado se trabó, y es lo que
    **predice** qué va a hacer el próximo depósito a ese mismo par.
  - **que el hecho sea BLOQUEANTE** depende del estado. Sólo un `Deposited` sin beneficiario pagable
    está realmente trabado, y sólo ésos entran a la lista `unpayable`.

  En la salida, un escrow terminal sin ATA imprime el `NO` **y además** `(not blocking: this escrow is
  already terminal)`. Colapsar las dos cosas o escondía el hecho, o exageraba el daño.
- **Aplicar en**: cualquier criterio de salida de esta HU que dependa del **estado on-chain** en vez del
  código. Una afirmación sobre la cadena se vuelve falsa **sin que nadie edite nada**, así que ningún
  barrido del diff la caza. Concretamente: el gate de W6 (§9.1, mitad 2) se verifica **corriendo el
  script**, nunca citando el slot 482578601 de este documento.
  Medido a favor del fix: al slot 482593777 el script sigue imprimiendo `NO` en las 4 filas del mint de
  Circle, o sea que la precondición del gate **sigue sin cumplirse** — y eso ahora es un dato que el
  script produce, no un supuesto heredado.


---

### [2026-08-10 09:10] Wave W4 — rompí una cita mía al editar OTRA cosa, dos waves antes

- **Error**: la entrada `[08:05]` de este archivo citaba `programs/escrow/src/lib.rs:62` para el
  `declare_id!`. Cuando la escribí era correcta. Al re-correr el verificador de citas **después de W4**,
  esa línea ya no era el `declare_id!` sino un renglón del `//!` del módulo.
- **Causa raíz**: en **W2** agregué 6 líneas al doc comment `//!` del módulo (la exigencia nueva en la
  tabla de instrucciones y el párrafo de la ATA). Eso empujó **todo** lo que venía después: el
  `declare_id!` pasó de `:62` a `:70`. Yo no toqué esa línea ni ese bloque; la rompí **desplazándola**.
- **Por qué ningún barrido normal la caza**: los barridos miran **lo que escribiste**, no **lo que
  corriste**. El diff de W2 no contiene la palabra `declare_id!` ni la cita del auto-blindaje, así que
  revisar el diff —que es lo que uno hace— no la muestra. Sólo aparece re-evaluando la cita **contra el
  árbol nuevo**, que es exactamente para lo que el Story File pide re-correr el verificador después de W4.
- **Fix**: dos cosas, y la segunda es la que importa.
  1. La cita ahora dice "el `declare_id!` de `programs/escrow/src/lib.rs`", **sin número de línea**. Un
     ancla por nombre no se desplaza cuando alguien edita seis líneas más arriba; un número sí. Es el
     mismo criterio que se aplicó a `.nexus/project-context.md`, cuya cita `README.md:769` ya estaba
     corrida a `:772` antes de que esta HU empezara.
  2. El verificador post-W4 quedó partido en **dos listas**: los anclajes estructurales del Story File
     §12 re-mapeados a su línea nueva, y **las citas que yo escribí**. La segunda lista es la que evita
     publicar una cita rota; la primera documenta cuánto se corrió cada cosa.
- **Medido**: de las 50 citas de §12, **23 se desplazaron** por W1/W2 (15 en `lib.rs`, 8 en
  `tests/escrow.ts`) y **ninguna desapareció** — los 23 textos siguen existiendo, sólo se movieron. Las
  27 restantes (README, SECURITY.md, `escrow-index.ts`, `escrow-window.ts`, `Anchor.toml`, `Cargo.toml`,
  `mutation-run.md`) no se movieron. Y de las citas que escribí yo, **1 de 4 estaba rota**. Resultado
  final del verificador: **41/41 OK**.
- **Aplicar en**: toda HU que agregue líneas a un archivo que otros documentos citan por número. El
  control no es "revisá tu diff": es **re-evaluar las citas contra el árbol final**. Y el arreglo
  duradero no es corregir el número, es **dejar de citar por número** lo que se puede citar por nombre.

---

### [2026-08-10 09:35] Fix pack (AR-BLQ-MED-1) — escribí un chequeo que preguntaba por el CONTENIDO cuando el programa exige la DIRECCIÓN

- **Error**: el chequeo "¿el beneficiario puede recibir?" de `scripts/list-live-escrows.py` lo escribí
  como `getTokenAccountsByOwner(beneficiary, {mint})`. Ese RPC filtra por los **datos** de la cuenta
  (owner + mint). El programa exige la **ATA canónica**, que es una condición sobre la **dirección**
  (`associated_token::`, y el código generado es explícito: `anchor-syn` 1.1.2
  `codegen/accounts/constraints.rs:1318-1321` deriva `__associated_token_address` y tira
  `ConstraintAssociated` si `#name.key()` no es esa). **Son predicados distintos**, y difieren en un
  input concreto: una token account con el mint correcto, el owner correcto y dirección no canónica.
- **Causa raíz**: elegí el RPC por lo que **devuelve** (una lista de token accounts del par, que era lo
  que quería imprimir) y no por lo que **decide**. La pregunta que el instrumento tenía que copiar no
  era "¿tiene token accounts de este mint?" sino la línea exacta que el programa evalúa.
- **Por qué es lo más caro que encontró el AR, y no un detalle de precisión**: `runbook-deploy.md`
  designa **esa línea** como la verificación de la mitad (ii) del gate del deploy, y el modo de falla
  documentado de esa mitad es *"el programa nuevo rechaza el 100% de los depósitos"*. O sea que un
  `yes` falso **autoriza el deploy hacia ese estado**. Y hoy acertaba **por casualidad**: al slot
  482608313 ninguna de las 10 token accounts de estos mints es no canónica, así que ninguna corrida
  contra devnet lo mostraba.
- **Fix**: el script deriva la ATA canónica (stdlib puro: sha256 + el test de off-curve de ed25519, que
  es la única parte que no es un hash) y exige que la lista **la contenga**. Además imprime cuántas
  cuentas **no** canónicas hay, que es exactamente el input sobre el que el chequeo viejo decía `yes`.
- **Medido, y con las dos mitades**: (1) la derivación contra `getAssociatedTokenAddressSync` de
  `@solana/spl-token`, que es otra implementación, **502 pares, 0 diferencias**; (2) una sonda que le da
  **el mismo fixture** al programa (bankrun ⇒ `ConstraintAssociated (2009)` sobre `beneficiary_ata`,
  `escrow_state` no se crea) y a las dos versiones del chequeo (**vieja: `yes`; nueva: `NO`**). Todo en
  `fix-pack-blq-med-1.txt`.
- **Aplicar en**: cualquier script que exista para **predecir** lo que un programa on-chain va a hacer.
  El criterio: no alcanza con que la respuesta coincida hoy; hay que preguntar **la misma condición**.
  Y el control que lo prueba no es correr el script contra la cadena — ahí las dos versiones dan lo
  mismo — es construir el input en el que difieren. Vale igual para `onchain-hash.py` y
  `programdata-capacity.py`, que también son instrumentos de gate.

---

### [2026-08-10 09:41] Fix pack (AR-BLQ-MED-1) — mi arreglo duplicó las requests y el endpoint devolvió 429 a mitad del barrido

- **Error**: la primera versión del arreglo preguntaba **dos** cosas por escrow (`getAccountInfo` de la
  ATA derivada **más** `getTokenAccountsByOwner` para contar las no canónicas). Contra el endpoint
  público de devnet eso terminó en **`HTTP 429 Too Many Requests`** con traceback, a mitad de los 10
  escrows.
- **Causa raíz**: agregué una pregunta nueva sin mirar que la que ya estaba **ya contenía la
  respuesta**. La lista de token accounts del par es un superconjunto: si la ATA canónica existe, está
  ahí. La pregunta correcta era de **contención**, no una segunda consulta.
- **Por qué importa**: un instrumento de gate que muere por la mitad no es mejor que uno que contesta
  mal — es peor de encontrar, porque falla de forma intermitente y sólo cuando alguien lo corre dos
  veces seguidas.
- **Fix**: una sola llamada, y el resultado se deriva de ella (`ok` = la dirección derivada está en la
  lista; `non_canonical` = todo lo demás).
- **Medido, y esto es lo que me frenó de sacar la conclusión equivocada**: instrumenté **las dos
  versiones** (la vieja salió con `git show HEAD:…`, sin `checkout`) y conté las llamadas reales:
  **13 y 13**, idénticas (`getBlockTime` 1, `getProgramAccounts` 1, `getSlot` 1,
  `getTokenAccountsByOwner` 10), las dos con `main()` devolviendo 0. O sea que el 429 que vi después
  **no era del cambio**: era de correr dos barridos completos seguidos. Sin esa medición habría
  "arreglado" un problema que no existía, o peor, habría culpado al arreglo correcto.
- **Aplicar en**: antes de atribuirle una falla de red a tu propio cambio, **contá las requests de las
  dos versiones**. Y al revés: antes de agregar una consulta, preguntate si la que ya está no responde
  lo mismo.

---

### [2026-08-10 09:55] Fix pack — una edición mía dejó las secciones del runbook en orden 4.4 → 4.6 → 4.5

- **Error**: inserté la sección nueva del rollback (4.6) usando como ancla el encabezado de **4.5**, así
  que quedó **antes** de la sección que la precede. El documento leía 4.4, 4.6, 4.5.
- **Causa raíz**: elegí el ancla por conveniencia de la herramienta (era el `old_string` único más
  cercano) y no por la posición donde el contenido tiene que quedar. Un `Edit` inserta **donde está el
  ancla**, no "al final de la sección anterior".
- **Fix**: moví el bloque de 4.5 delante del nuevo con dos ediciones y verifiqué el orden leyendo los
  encabezados del archivo, no el diff.
- **Aplicar en**: cuando el `old_string` es el **encabezado siguiente**, lo que estás pidiendo es
  insertar **antes** de él. Si querés después, el ancla tiene que ser la **última línea del bloque
  anterior**. Y la verificación no es el diff: es leer los encabezados en orden.

---

### [2026-08-10 10:05] Fix pack — rompí una cita que había escrito yo **20 minutos antes**, en la misma sesión

- **Error**: escribí en `fix-pack-mnr-2.txt` y en `runbook-deploy.md` que `release` declara el
  beneficiario como `SystemAccount` **en `lib.rs:654`**. Era correcto contra el árbol que revisó el AR.
  Después, en el **mismo** fix pack, le agregué 19 líneas de comentario a `lib.rs` más arriba (MNR-5 y
  MNR-2) y ese campo se corrió a **`:673`**. Las dos citas quedaron apuntando a un comentario.
- **Causa raíz**: escribí la cita **antes** de hacer la edición que la desplaza, y las dos cosas eran
  parte del **mismo** encargo. La entrada `[09:10]` de este archivo ya había registrado esta lección
  para ediciones separadas por dos waves; lo nuevo es que la ventana puede ser de minutos y estar
  **dentro de un solo cambio**. "Escribí la cita al final" no alcanza si el orden real es intercalado.
- **Por qué ningún barrido del diff la caza**: el mismo mecanismo de `[09:10]`. Y esta vez además
  **falló el barrido automático**: mi verificador compara la línea citada en `HEAD` contra la actual, y
  estas dos citas **no existen en `HEAD`** (las escribí en el fix pack), así que quedaron fuera del
  universo del comparador. Un verificador que sólo mira lo que se movió **no ve lo que nació torcido**.
- **Fix**: las dos citas ahora nombran el ancla — "el campo `beneficiary` de `pub struct Release`" — sin
  número, y el propio texto dice que se corrió de `:654` a `:673` para que quede el registro. Y el
  control final ya no es sólo el comparador: es una **lista explícita de las 23 citas que escribí en
  este fix pack**, cada una asertada **por contenido** contra el árbol final (23/23 OK, incluidas las 10
  que apuntan a los otros dos repos y a `anchor-syn`).
- **Medido, y es el dato que ordena el resto**: el barrido encontró **81 citas desplazadas** con ancla
  real hacia archivos que este fix pack editó. Atribuyéndolas contra `main` (`8fca4729`) y contra `HEAD`
  (`849c0b5`), **ninguna** estaba válida en `HEAD`: ya apuntaban corrido por W1/W2/W3 de esta HU. Dos
  ejemplos verificados a mano: `SECURITY.md:99` era *"The source and the chain agree today"* en `main` y
  otra cosa en `HEAD`; `SOURCE_REPRODUCES_CHAIN` vive en `README.md:886` en `HEAD` y hay citas que lo
  buscan en `:822-837`. O sea: **las únicas dos citas que rompió este fix pack son las mías**, y el
  resto es podredumbre anterior que NO se toca acá (las tablas de defectos del SDD y del Story File son
  registros históricos, y los reportes de WKH-326 están cerrados).
- **Aplicar en**: (1) las citas propias se verifican **por contenido**, en una lista explícita, no
  por un diff de líneas; (2) si en un mismo cambio vas a citar un archivo **y** editarlo, citá por
  nombre; (3) un verificador de citas necesita **dos** modos: el que detecta desplazamiento (compara
  contra la base) y el que valida las citas nuevas (compara contra el contenido).

---

### [2026-08-10 10:12] Fix pack — la herramienta de medición reportó "1 error" de clippy que no existía

- **Error**: corrí `cargo clippy --all-targets -- -D warnings` redirigiendo a un archivo y leí
  `cargo clippy: 1 errors, 1 warnings` con **exit 101**. Estuve a punto de salir a buscar un lint roto.
- **Causa raíz**: el hook de `rtk` intercepta el comando y, cuando la salida está **redirigida**, lo que
  queda en el archivo es **su propio resumen**, no la salida de clippy — y el exit code que vi era el
  del wrapper. Corriendo `rtk proxy cargo clippy … ; echo $?` la salida real es
  `Finished dev profile` y el exit **0**. Clippy está limpio.
- **Por qué es la lección de siempre con una cara nueva**: el instrumento **fabricó** el hallazgo. Si le
  hubiera creído, habría "arreglado" código sano, y con `-D warnings` cualquier cambio cosmético parece
  justificado.
- **Fix**: los comandos cuya salida importa se corren con `rtk proxy` **sin redirección**, o se leen
  con `Read`. El mismo cuidado vale para `head`/`cat`/`git log` (ya registrado en la memoria del
  proyecto).
- **Aplicar en**: cualquier verde/rojo de esta HU que venga de un archivo redirigido. Antes de creerle a
  un fallo, **reproducilo sin el envoltorio**; y antes de creerle a un verde, comprobá que el archivo
  contenga la salida de la herramienta y no un resumen.

---

### [2026-08-10 10:55] Fix pack ronda 2 — mi "antes" salió de un respaldo que ya tenía el arreglo

- **Error**: para medir qué compraba el arreglo del reloj (BLQ-BAJO-3) corrí la sonda contra
  `BACKUP-list-live-escrows.py`, que yo había etiquetado mentalmente como "el script al final de la
  ronda 1". Dio **exit 1 en los dos escenarios**, o sea "el defecto no existía", y estuve a un paso de
  escribir que el hallazgo del AR no se reproducía.
- **Causa raíz**: ese respaldo lo tomé **después** de haber hecho las ediciones de la ronda 2, justo
  antes de la batería de mutación — que es para lo que lo había creado. Era un respaldo del **estado
  arreglado**, no del anterior. El nombre no decía a qué commit correspondía y yo le puse la etiqueta
  por el momento en que me acordaba de haberlo hecho.
- **Por qué es peligroso**: un "antes" equivocado no falla, **confirma**. Habría concluido que el
  bloqueante era falso, con una medición propia respaldándome, y el argumento habría sido difícil de
  discutir precisamente porque tenía números.
- **Fix**: dejé de buscar un "antes" y medí el **contrafactual**, que es más fuerte y no depende de
  ningún archivo histórico: al script **que se entrega** se le desactiva **una sola condición** (sha256
  distinto verificado antes de correr, restauración desde respaldo con sha256 igual al original) y se le
  da el **mismo** input. Resultado: con la condición del reloj, exit 1; sin ella, **exit 0** sobre el
  mismo escrow. Lo mismo para "nada observado". El defecto queda demostrado sobre el código actual.
- **Aplicar en**: cuando quieras medir "antes vs después", el "antes" tiene que estar **identificado por
  commit o por digest**, no por memoria. Y si no lo tenés, no lo inventes: desactivá la condición nueva
  en el código actual y medí el contrafactual. Es más barato y no se puede confundir de archivo.

---

### [2026-08-10 11:02] Fix pack ronda 2 — el bloque "verbatim" del README dejó de serlo por un cambio MÍO en el script

- **Error**: en la ronda 1 pegué en el README la salida literal de
  `list-live-escrows.py --markdown` y escribí que es **verbatim**, precisamente para que refrescarla sea
  copiar y no transcribir. En la ronda 2 le agregué el program id a la línea `measured …` del script. El
  bloque del README quedó **falso otra vez**, y esta vez no por envejecer: por mi propia edición del
  productor.
- **Causa raíz**: una afirmación de PROCEDENCIA ("esto es la salida de este comando") crea una
  dependencia entre dos archivos que ningún test declara. Cambiar el formato de salida rompe el
  documento sin tocarlo.
- **Fix**: re-corrí el comando y pegué la salida nueva, y **verifiqué la igualdad mecánicamente** en vez
  de a ojo: comparé línea por línea las 14 líneas no vacías del comando contra el bloque del README ⇒ 0
  diferencias. Ese chequeo es el que convierte "verbatim" en algo comprobable.
- **Aplicar en**: cualquier documento que diga "esto es la salida de X". Si editás X, el chequeo es
  volver a correrlo y **diffear**, no leer. Y si el bloque se acorta o se edita, la palabra "verbatim"
  no puede quedarse.

---

### [2026-08-10 11:20] Fix pack ronda 2 — la MISMA línea cambió de número TRES veces en un día, y mi arreglo del arreglo también quedó viejo

- **Error**: en la ronda 1 arreglé una cita rota (`Release.beneficiary`, que yo había desplazado) y en
  el arreglo escribí *"se corrió de `:654` a `:673`"*. En la ronda 2 agregué más comentarios arriba y
  el campo pasó a **`:681`**. O sea que **el arreglo de la cita se rompió por el mismo mecanismo que la
  cita original**, en la misma sesión, un par de horas después.
- **Causa raíz**: al citar por nombre dejé igualmente un **número de destino** en la prosa, y un número
  de destino caduca exactamente igual que el de origen. Había cambiado la cita pero no la clase de
  afirmación.
- **Lo que lo hace una lección y no un descuido**: tres valores (`:654` → `:673` → `:681`) para la misma
  línea en un día, y **ninguna de las tres ediciones tocó esa línea**. Es la demostración más limpia de
  por qué un número de línea no es un ancla: no depende de lo que se edita, depende de lo que hay
  arriba.
- **Fix**: los dos lugares ahora citan **por nombre y sin ningún número**, y cuentan la historia de los
  tres números como el argumento de por qué. Lo cazó mi lista explícita de citas verificadas por
  contenido, no un diff — y lo cazó porque la lista incluía el ancla, no el número.
- **Aplicar en**: cuando arregles una cita rota, no la reemplaces por otra cita frágil. Si el ancla es
  un nombre (campo, función, encabezado), citá el nombre y **no agregues "está en la línea N"** ni como
  cortesía. Y si querés dejar constancia del movimiento, contá que se movió, no adónde.
