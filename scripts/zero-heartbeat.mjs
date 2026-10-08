#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// zero-heartbeat — סורק-חיות-הלב-החינמי (Z Chain 9369 · gasPrice מדוד 0x0)
//
// Task 20 · הפתרון-ללא-כסף: הלב של הצי לא צריך את-מסילת-המייננט-היקרה —
// הוא פועם **חינם** על ZERO. הקצב-השעתי (weave-anchor-zero) משדר self-tx
// אינרטי (סלקטור 0xa9059cbb, to==from, ערך 0) עם מטען-checkpoint JSON
// (protocol saos-weave-core/v1 · action checkpoint · chainId 9369).
//
// אימות-עצמאי לכל-צד-שלישי — **סריקת-בלוק, אף-txid לא נטמן**:
//   הטענה-הציבורית: (block · checkpoint · root-prefix)
//   השופט: השרשרת — אנחנו מוציאים את-הבלוק, מוצאים את-ה-self-tx,
//   מפענחים-את-המטען, ומשווים. + גיל-מדוד מהטיימסטמפ-על-השרשרת.
//
//   bun scripts/zero-heartbeat.mjs --block 36593749 --checkpoint 1533 \
//     --root 0x102d3bf3 [--threshold-hours 3]
//
// פסיקות: GREEN (עוגן-מאומת ובתוך-הסף — הלב פועם חינם) · RED (לא-אומת /
// ישן) · exit 1 על RED. אפס-סודות · אפס-שידור · RPC ציבורי בלבד.
// ─────────────────────────────────────────────────────────────────────────────

const ZRPC = "https://rpc.zero.tech";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
}
const BLOCK = parseInt(arg("block", "0"), 10);
const CP = parseInt(arg("checkpoint", "0"), 10);
const ROOT_PREFIX = (arg("root", "") || "").toLowerCase().replace(/^0x/, "");
const THRESHOLD_H = parseFloat(arg("threshold-hours", "3"));

const receipt = {
  tool: "zero-heartbeat",
  rail: "zero-9369",
  mode: "block-scan-free-heartbeat",
  at: new Date().toISOString(),
  claim: { block: BLOCK, checkpoint: CP, rootPrefix: ROOT_PREFIX.slice(0, 8) + "…" },
  measured: { head: null, ageHours: null, anchor: null, effectiveGasPrice: null },
  gates: [],
  verdict: null,
  note: "",
};
const gate = (id, name, pass, measured, note) => {
  receipt.gates.push({ id, name, verdict: pass ? "PASS" : "FAIL", measured, note });
  if (!pass) receipt.verdict = "RED";
};

async function zcall(method, params) {
  const res = await fetch(ZRPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  return j.result ?? null;
}

if (!BLOCK || !CP || !ROOT_PREFIX) {
  gate("Z0", "args", false, null, "נדרש: --block --checkpoint --root (קידומת)");
} else {
  // G1 — הבלוק-הנטען נשלף וגילו נמדד
  const blk = await zcall("eth_getBlockByNumber", ["0x" + BLOCK.toString(16), true]);
  if (!blk?.transactions) {
    gate("Z1", "block-fetch", false, null, "בלוק-הטענה לא נשלף מ-ZERO — fail-closed");
  } else {
    const head = parseInt(await zcall("eth_blockNumber", []), 16);
    receipt.measured.head = head;
    const ts = parseInt(String(blk.timestamp), 16);
    const ageH = Math.round(((Date.now() / 1000 - ts) / 3600) * 100) / 100;
    receipt.measured.ageHours = ageH;
    gate("Z1", "block-age", ageH <= THRESHOLD_H, { ageHours: ageH, thresholdHours: THRESHOLD_H },
      ageH <= THRESHOLD_H ? "העוגן-החינמי טרי" : "העוגן-הנטען ישן מעבר-לסף — הקצב-החינמי נעתק?");

    // G2 — איתור-ה-self-עוגן בסריקת-הבלוק (בלי-txid)
    let hit = null;
    for (const tx of blk.transactions) {
      const inp = String(tx.input ?? "");
      if (!inp.startsWith("0xa9059cbb") || inp.length <= 74) continue;
      if (!tx.from || String(tx.to ?? "").toLowerCase() !== String(tx.from).toLowerCase()) continue;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(inp.slice(10), "hex").toString("utf8"));
      } catch { continue; }
      if (payload.protocol !== "saos-weave-core/v1" || payload.action !== "checkpoint" || payload.chainId !== 9369) continue;
      hit = { tx, payload };
      break;
    }
    if (!hit) {
      gate("Z2", "anchor-discovery", false, { block: BLOCK }, "לא-נמצא self-עוגן-checkpoint בבלוק-הטענה");
    } else {
      gate("Z2", "anchor-discovery", true, { block: BLOCK, selector: "0xa9059cbb", selfTx: true }, "self-עוגן-checkpoint אותר בסריקת-הבלוק (אפס-txid-מוטמע)");
      const p = hit.payload;
      const anchor = {
        checkpoint: typeof p.checkpoint === "number" ? p.checkpoint : null,
        root: String(p.root ?? ""),
        attFrom: p.attFrom ?? null,
        attTo: p.attTo ?? null,
        attestations: p.attestations ?? null,
        net: p.net ?? null,
        identity: String(hit.tx.from).slice(0, 10) + "… [מצונזר-אופסק]",
        txid: String(hit.tx.hash).slice(0, 10) + "… [מצונזר-אופסק]",
      };
      receipt.measured.anchor = anchor;

      // G3 — התאמת-הטענה (checkpoint + שורש) — השוואה בקידומת-אחידה (לקח 0x-prefix מ-Task 17)
      const cpMatch = anchor.checkpoint === CP;
      const rootMatch = anchor.root.toLowerCase().replace(/^0x/, "").startsWith(ROOT_PREFIX);
      gate("Z3", "claim-match", cpMatch && rootMatch,
        { cpClaimed: CP, cpFound: anchor.checkpoint, rootPrefixClaimed: ROOT_PREFIX.slice(0, 8), rootMatch },
        cpMatch && rootMatch ? "המטען על-השרשרת תואם-את-הטענה-הציבורית" : "חוסר-התאמה בין-הטענה-לשרשרת");

      // G4 — קבלה על-השרשרת: status=1 · גז-אפס מדוד (התכונה-הריבונית)
      const rc = await zcall("eth_getTransactionReceipt", [hit.tx.hash]);
      const statusOk = rc && (String(rc.status) === "0x1" || String(rc.status) === "1");
      const gasZero = rc ? String(rc.effectiveGasPrice ?? "x") === "0x0" || String(rc.effectiveGasPrice ?? "") === "0" : false;
      receipt.measured.effectiveGasPrice = rc?.effectiveGasPrice ?? null;
      gate("Z4", "inclusion-and-zero-gas", statusOk && gasZero,
        { status: rc?.status ?? null, effectiveGasPrice: rc?.effectiveGasPrice ?? null, gasUsed: rc?.gasUsed ?? null },
        statusOk && gasZero ? "העוגן נכלל (status 1) בגז 0x0 — העלות 0.000000" : "העוגן לא-נכלל או-שהגז-כבר-לא-אפס");
    }
  }
}

if (receipt.verdict !== "RED") receipt.verdict = "GREEN";
receipt.note =
  receipt.verdict === "GREEN"
    ? `הלב פועם חינם על ZERO: cp#${receipt.measured.anchor?.checkpoint} מאומת מסריקת-בלוק · גיל ${receipt.measured.ageHours}ש' · גז 0x0 · עלות 0.000000`
    : "המסילה-החינמית לא עברה-אימות — RED כן (הקצב-השעתי נעתק או-הטענה-שגויה)";

const out = `receipts/zero-heartbeat-${Date.now()}.json`;
await Bun.write(out, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ verdict: receipt.verdict, gates: receipt.gates.map((g) => `${g.id}:${g.verdict}`), note: receipt.note }, null, 2));
console.log(`receipt → ${out}`);
process.exit(receipt.verdict === "GREEN" ? 0 : 1);
