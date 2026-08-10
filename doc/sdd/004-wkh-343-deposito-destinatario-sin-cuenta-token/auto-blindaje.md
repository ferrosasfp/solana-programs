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
