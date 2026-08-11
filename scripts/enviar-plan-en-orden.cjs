// Manda el plan del IDL en orden, confirmando por el TAMAÑO DE LA CUENTA.
//
// POR QUE ASI: el plan son 7 transacciones; la #1 crea la cuenta y las #2..#7 escriben. Mandadas
// por la herramienta se pisan entre si (InvalidAccountData / UninitializedAccount): es una CARRERA.
// Mandadas en orden, la cuenta crece 968 bytes por transaccion.
//
// La confirmacion NO usa getSignatureStatuses: el RPC publico devuelve 429 con ese sondeo y una
// transaccion que SI habia entrado se reporto como "no confirmo a tiempo" (medido: la cuenta habia
// crecido igual). El tamaño de la cuenta es una consulta por vuelta y es la magnitud que importa.
const fs = require("fs");
// @solana/web3.js v1. Este repo es Rust y no tiene node_modules propio, asi que se busca donde
// suela estar. NO se clava una ruta absoluta: la primera version de este archivo apuntaba a
// ../chaski-v3/node_modules, que existe en UNA maquina y en ninguna otra.
function cargarWeb3() {
  const candidatos = [
    "@solana/web3.js",
    require("path").join(__dirname, "..", "node_modules", "@solana/web3.js"),
    require("path").join(__dirname, "..", "..", "chaski-v3", "node_modules", "@solana/web3.js"),
  ];
  for (const c of candidatos) {
    try { return require(c); } catch {}
  }
  console.error(
    "No encuentro @solana/web3.js v1. Instalalo con:\n" +
    "  npm i --no-save @solana/web3.js@^1.98\n" +
    "y volve a correr.",
  );
  process.exit(1);
}
const { Connection, Keypair, VersionedTransaction, PublicKey } = cargarWeb3();

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const PDA = new PublicKey(process.env.IDL_PDA || "7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC");
const [, , PLAN, WALLET, DESDE = "1"] = process.argv;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", () => {});

async function tam(conn) {
  for (let i = 0; i < 6; i++) {
    try {
      const info = await conn.getAccountInfo(PDA, "confirmed");
      return info ? info.data.length : 0;
    } catch { await dormir(10000); }
  }
  return -1;
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const firmante = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, "utf8"))));
  const b64s = [...fs.readFileSync(PLAN, "utf8").matchAll(/\[Transaction #(\d+)\]\n([A-Za-z0-9+/=]+)/g)]
    .map((m) => [m[1], m[2]]);

  let antes = await tam(conn);
  console.log(`  arranco con la cuenta en ${antes} bytes\n`);

  for (const [n, b64] of b64s) {
    if (Number(n) < Number(DESDE)) continue;
    await dormir(20000);
    let bh;
    for (let i = 0; i < 8; i++) {
      try { bh = (await conn.getLatestBlockhash("finalized")).blockhash; break; }
      catch { await dormir(15000); }
    }
    if (!bh) { console.log(`  #${n}: no pude obtener blockhash`); process.exit(1); }
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    tx.message.recentBlockhash = bh;
    tx.signatures = [];
    tx.sign([firmante]);
    try { await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 10 }); }
    catch (e) { console.log(`  #${n}: send fallo -> ${String(e.message).slice(0, 90)}`); }

    // Confirmar por CRECIMIENTO de la cuenta, no por el estado de la firma.
    let ahora = antes, movio = false;
    for (let i = 0; i < 12; i++) {
      await dormir(20000);
      ahora = await tam(conn);
      if (ahora > antes) { movio = true; break; }
    }
    console.log(`  #${n}: ${movio ? "✅" : "⏳"} cuenta ${antes} -> ${ahora} bytes`);
    if (!movio) { console.log("     no crecio; corto para no seguir a ciegas"); process.exit(1); }
    antes = ahora;
  }
  console.log(`\n  final: ${antes} bytes`);
})();
