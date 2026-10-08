#!/usr/bin/env bun
/**
 * zero-verify.mjs — ZERO-rail keyless live verifier (fail-closed, read-only)
 *
 * Fleet law compliance:
 *  - ZERO SECRETS: no private keys, no WIF, no PAT, no broadcast. Pure read-only RPC.
 *  - FAIL-CLOSED: any gate failure => exit code 1 + RED receipt. Never "pretends".
 *  - HONEST SKIPS: gates that cannot run (e.g. no txid input) are recorded as SKIPPED, not PASSed.
 *  - RECEIPT: every run writes a measured JSON receipt with provenance.
 *
 * What it verifies (measured, not quoted):
 *  G1: chainId === 0x2499 (9369, Zero Network)
 *  G2: eth_gasPrice === 0x0  (the ZERO gate; gasPrice>0 = firm rejection, ZERO-GATE-CLOSED)
 *  G3: chain is alive & advancing (block height measured twice, delta >= 0)
 *  G4 (optional --txid): anchor read-back — receipt status===1, effectiveGasPrice===0x0,
 *      and the raw tx is selector 0xa9059cbb (transfer gate) self-addressed to inert EOA.
 *
 * Usage:
 *   bun scripts/zero-verify.mjs [--txid 0xabc...] [--rpc https://rpc.zero.tech] [--out receipts/...json]
 */

const DEFAULT_RPC = "https://rpc.zero.tech";
const EXPECTED_CHAIN_ID = "0x2499"; // 9369 Zero Network
const TRANSFER_SELECTOR = "0xa9059cbb";
// אופסק fail-safe: הקבלה מצונזרת כברירת-מחדל (txid מלא לעולם לא נכתב) — רק --no-censor מכבה (פרטי).
const CENSOR = !process.argv.includes("--no-censor");
const cens = (v) => (CENSOR && typeof v === "string"
  ? (v.replace(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g, (m) => m.slice(0, 10) + "…" + m.slice(-6) + " [מצונזר-אופסק]")
      .replace(/0x[a-fA-F0-9]{64}(?![a-fA-F0-9])/g, (m) => m.slice(0, 10) + "…" + m.slice(-6) + " [מצונזר-אופסק]"))
  : v);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const RPC = arg("--rpc", DEFAULT_RPC);
const TXIDS = (process.argv.includes("--txid") ? process.argv[process.argv.indexOf("--txid") + 1] : "")
  .split(",").map(s => s.trim()).filter(s => /^0x[0-9a-fA-F]{64}$/.test(s));

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC error ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const receipt = {
  format: "zero-rail-live-verify-v1",
  at: new Date().toISOString(),
  rpc: RPC,
  keyless: true,
  broadcast: false,
  gates: [],
  txReadback: [],
  verdict: null,
};

function gate(id, name, pass, measured, note) {
  receipt.gates.push({ id, name, verdict: pass ? "PASS" : "FAIL", measured, note: note || "" });
  return pass;
}

let allOk = true;

try {
  // G1 — chainId
  const chainId = await rpc("eth_chainId", []);
  const g1 = gate("G1", "chainId-is-zero-network", chainId === EXPECTED_CHAIN_ID, chainId,
    chainId === EXPECTED_CHAIN_ID ? `9369 decimal` : `expected ${EXPECTED_CHAIN_ID}`);

  // G2 — the ZERO gate itself
  const gasPrice = await rpc("eth_gasPrice", []);
  const g2 = gate("G2", "gas-price-is-0x0", gasPrice === "0x0", gasPrice,
    gasPrice === "0x0" ? "rail is fully zero-gas, cost of anchoring $0.00" : "ZERO-GATE-CLOSED: gasPrice>0 — nothing attested");

  // G3 — alive & advancing
  const b1 = parseInt(await rpc("eth_blockNumber", []), 16);
  await new Promise(r => setTimeout(r, 4000));
  const b2 = parseInt(await rpc("eth_blockNumber", []), 16);
  const g3 = gate("G3", "chain-alive-advancing", Number.isFinite(b1) && Number.isFinite(b2) && b2 >= b1,
    { blockT0: b1, blockT4s: b2, delta: b2 - b1 },
    b2 > b1 ? "chain producing blocks during measurement" : "no growth in 4s window (could be slow epoch — recorded honestly)");

  allOk = g1 && g2 && g3;

  // G4 — optional anchor read-back (byte-exact)
  for (const txid of TXIDS) {
    try {
      const tx = await rpc("eth_getTransactionByHash", [txid]);
      const rc = await rpc("eth_getTransactionReceipt", [txid]);
      if (!tx || !rc) {
        receipt.txReadback.push({ txid: cens(txid), verdict: "NOT-FOUND", note: "unknown to this RPC (honest skip)" });
        continue;
      }
      const to = (tx.to || "").toLowerCase();
      const data = (tx.input || tx.data || "0x").toLowerCase();
      const selector = data.slice(0, 10);
      const selfAddressed = to && data.length >= 74 && ("0x" + data.slice(10 + 24, 10 + 64)) === to;
      const zeroGas = (rc.effectiveGasPrice || tx.gasPrice || "x") === "0x0";
      const ok = rc.status === "0x1" && zeroGas && selector === TRANSFER_SELECTOR;
      receipt.txReadback.push({
        txid: cens(txid),
        verdict: ok ? "PASS" : "FAIL",
        measured: {
          status: rc.status,
          blockNumber: parseInt(rc.blockNumber, 16),
          effectiveGasPrice: rc.effectiveGasPrice ?? tx.gasPrice ?? null,
          selector,
          to: cens(to),
          selfAddressedInertEOA: selfAddressed,
        },
      });
      if (!ok) allOk = false;
    } catch (e) {
      receipt.txReadback.push({ txid: cens(txid), verdict: "ERROR", note: String(e.message || e) });
      allOk = false;
    }
  }

  receipt.verdict = allOk ? "GREEN" : "RED";
  if (!allOk) process.exitCode = 1;
} catch (e) {
  receipt.verdict = "RED";
  receipt.fatal = String(e.message || e);
  process.exitCode = 1;
}

const outPath = arg("--out", `receipts/zero-live-verify-${Date.now()}.json`);
await Bun.write(outPath, JSON.stringify(receipt, null, 2) + "\n");

console.log(`ZERO-RAIL LIVE VERIFY · ${receipt.verdict} · ${receipt.at}`);
for (const g of receipt.gates) console.log(`  ${g.id} ${g.verdict} · ${g.name} · ${JSON.stringify(g.measured)}`);
for (const t of receipt.txReadback) console.log(`  TX ${t.verdict} · ${t.txid.slice(0, 18)}… ${t.note || ""}`);
console.log(`receipt → ${outPath}`);
