#!/usr/bin/env bun
/**
 * artifact-verify.mjs — on-chain artifact read-back verifier (keyless, fail-closed, read-only)
 *
 * Fleet law: a claim without a read-back is a story. This tool re-reads the fleet's
 * public anchor claims DIRECTLY from public chains — no keys, no private repos, no trust.
 *
 * Verifies an ETHEREUM heartbeat anchor of the fleet by block scan (txids are opsec-redacted
 * in public repos, so we find it ourselves):
 *  1. fetch block N with full tx bodies (public RPC)
 *  2. find self-addressed txs (to === from, inert EOA doctrine)
 *  3. decode calldata as root(32)‖height(4)
 *  4. match root prefix (claimed) and height (claimed heartbeat)
 *  5. receipt: status===1, gasUsed, effectiveGasPrice, real cost in ETH
 *
 * Usage:
 *   bun scripts/artifact-verify.mjs --block 25958268 --root-prefix 8f513865 --height 25 \
 *        [--rpc https://ethereum-rpc.publicnode.com] [--out receipts/...json]
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const RPC = arg("--rpc", "https://ethereum-rpc.publicnode.com");
const BLOCK = Number(arg("--block", "0"));
const ROOT_PREFIX = (arg("--root-prefix", "") || "").toLowerCase();
const HEIGHT = Number(arg("--height", "-1"));
// אופסק fail-safe: הקבלה מצונזרת כברירת-מחדל (txid מלא לעולם לא נכתב) —
// רק --no-censor מכבה (לשימוש-פרטי בלבד). הנתיב-הבטוח הוא נתיב-ברירת-המחדל.
const CENSOR = !process.argv.includes("--no-censor");
const cens = (txid) => (CENSOR && typeof txid === "string" && /^0x[a-fA-F0-9]{64}$/.test(txid)
  ? txid.slice(0, 10) + "…" + txid.slice(-6) + " [מצונזר-אופסק]"
  : txid);

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(25000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`RPC error ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// some public nodes return null receipts for older txs — fail-over chain, all keyless
const RECEIPT_RPCS = [RPC, "https://eth.drpc.org", "https://cloudflare-eth.com"];
async function rpcReceipt(txid) {
  for (const url of RECEIPT_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txid] }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await res.json();
      if (j && j.result) return j.result;
    } catch { /* honest fall-through to next node */ }
  }
  return null;
}

const receipt = {
  format: "artifact-readback-v1",
  at: new Date().toISOString(),
  chain: "ethereum-mainnet",
  rpc: RPC,
  claimed: { block: BLOCK, rootPrefix: ROOT_PREFIX, heartbeat: HEIGHT },
  keyless: true,
  broadcast: false,
  findings: [],
  verdict: "RED",
};

if (!BLOCK || !ROOT_PREFIX) {
  receipt.fatal = "missing --block or --root-prefix; refusing to guess (fail-closed)";
  await Bun.write(arg("--out", `receipts/artifact-readback-${Date.now()}.json`), JSON.stringify(receipt, null, 2) + "\n");
  console.log("ARTIFACT READBACK · RED · missing args");
  process.exit(1);
}

try {
  const hexBlock = "0x" + BLOCK.toString(16);
  const b = await rpc("eth_getBlockByNumber", [hexBlock, true]);
  if (!b) throw new Error("block not found");
  receipt.blockMeasured = {
    number: parseInt(b.number, 16),
    timestamp: new Date(parseInt(b.timestamp, 16) * 1000).toISOString(),
    txCount: b.transactions.length,
  };

  for (const tx of b.transactions) {
    const to = (tx.to || "").toLowerCase();
    const from = (tx.from || "").toLowerCase();
    const input = tx.input || "0x";
    if (!to || to !== from) continue; // inert-EOA doctrine: self-addressed only
    if (input.length < 74) continue; // "0x"+72 hex = root(32B)‖height(4B) exactly; longer JSON payloads also pass
    const raw = Buffer.from(input.slice(2), "hex");
    const rootHex = raw.slice(0, 32).toString("hex"); // no 0x — pure hex body
    const root = "0x" + rootHex;
    const height = raw.length >= 36 ? raw.readUInt32BE(32) : null;
    const f = {
      txid: cens(tx.hash),
      root,
      height,
      rootPrefixMatch: rootHex.startsWith(ROOT_PREFIX.toLowerCase().replace(/^0x/, "")),
      heightMatch: HEIGHT < 0 || height === HEIGHT,
      inputBytes: raw.length,
    };
    if (f.rootPrefixMatch || f.heightMatch) {
      const rc = await rpcReceipt(tx.hash);
      f.status = rc?.status ?? null;
      f.blockNumber = rc ? parseInt(rc.blockNumber, 16) : null;
      f.gasUsed = rc ? parseInt(rc.gasUsed, 16) : null;
      f.effectiveGasPriceWei = rc ? parseInt(rc.effectiveGasPrice, 16) : null;
      f.costETH = f.gasUsed != null && f.effectiveGasPriceWei != null ? f.gasUsed * f.effectiveGasPriceWei / 1e18 : null;
      f.selfAddressed = true;
      receipt.findings.push(f);
    }
  }

  const exact = receipt.findings.find(f => f.rootPrefixMatch && f.heightMatch && f.status === "0x1");
  receipt.verdict = exact ? "GREEN" : receipt.findings.length ? "AMBIGUOUS" : "NOT-FOUND";
  receipt.match = exact || null;
  if (receipt.verdict !== "GREEN") process.exitCode = 1;
} catch (e) {
  receipt.fatal = String(e.message || e);
  process.exitCode = 1;
}

const outPath = arg("--out", `receipts/artifact-readback-${Date.now()}.json`);
await Bun.write(outPath, JSON.stringify(receipt, null, 2) + "\n");
console.log(`ARTIFACT READBACK (ethereum) · ${receipt.verdict} · ${receipt.at}`);
if (receipt.match) {
  const m = receipt.match;
  console.log(`  txid   : ${cens(m.txid)}`);
  console.log(`  root   : ${m.root}`);
  console.log(`  height : ${m.height} (heartbeat)`);
  console.log(`  block  : ${m.blockNumber} · status ${m.status} · gas ${m.gasUsed} · cost ${m.costETH?.toExponential(3)} ETH`);
} else {
  for (const f of receipt.findings) console.log(`  candidate: ${f.txid.slice(0, 20)}… rootMatch=${f.rootPrefixMatch} heightMatch=${f.heightMatch}`);
}
console.log(`receipt → ${outPath}`);
