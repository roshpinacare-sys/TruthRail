#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────────────────────
// heartbeat-scan — סורק-חיות-הלב (mainnet, keyless, fail-closed)
//
// Task 18 · לקח-הפורנזיקה: עוגני h25/h26 (הקריאה-החוזרת של Task 17) התגלו
// כבני-26-יום — מסילת-הלב על Ethereum המייננט **מורעבת-גז** מאז 2026-09-12
// (יתרת-זהות-העיגון ≈ 3.7e-7 ETH). הכלי הזה מודד את חיות-המסילה בכל ריצה:
//
//   · סריקה מה-HEAD אחורה (ברירת-מחדל 300 בלוקים ≈ שעה) אחרי טקסים
//     ממוענים-עצמית (to==from) עם calldata בגודל 36 בייט = root(32B)‖height(4B)
//   · בדיקת-nonce מול בסל-ידיעה (anchor block + nonce) — אם ה-nonce גדל,
//     נוצרו עוגנים חדשים והסריקה תמצא אותם; אם לא — אפס-דופק מדוד
//   · מדידת יתרת-זהות-העיגון — הוכחת-הרעב (אפס-ניחושים)
//
// פסיקות: GREEN (עוגן-חי בתוך-הסף) · RED (מעבר לסף / אפס-נונסה-חדשה וגיל
// עובר-סף) · exit 1 על RED. דילוג-כנה נרשם — לא מתחפה.
// אפס-סודות · אפס-שידור · RPC ציבורי בלבד.
// ─────────────────────────────────────────────────────────────────────────────

const RPCS = [
  "https://eth.llamarpc.com",
  "https://eth.drpc.org",
  "https://cloudflare-eth.com",
  "https://rpc.ankr.com/eth",
];

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
}

// בסל-הידיעה: העוגן האחרון-הידוע (h26 · אומת בייט-מול-בייט ב-Task 17).
// אופסק: **אף-txid-מלא לא נטמן כאן** — הזהות נגזרת מסריקת-בלוק-הבסל הציבורי
// (self-tx עם height מדויק) — הכלי מקיים את-עצמו מנתונים-ציבוריים בלבד.
const BASELINE_BLOCK = parseInt(arg("baseline-block", "25958483"), 10);
const BASELINE_HEIGHT = parseInt(arg("baseline-height", "26"), 10);
const SCAN_BACK = parseInt(arg("scan-back", "300"), 10);
const THRESHOLD_HOURS = parseFloat(arg("threshold-hours", "48"));

const receipt = {
  tool: "heartbeat-scan",
  at: new Date().toISOString(),
  rpcs: RPCS,
  baseline: { block: BASELINE_BLOCK, height: BASELINE_HEIGHT },
  scan: { scanBack: SCAN_BACK, thresholdHours: THRESHOLD_HOURS },
  measured: { head: null, identity: null, nonceAtBaseline: null, nonceNow: null, newTxsSinceBaseline: null, balanceEth: null, baselineAgeHours: null, anchorsFound: [], latestAnchor: null },
  gates: [],
  verdict: null,
  note: "",
};

let rpc = RPCS[0];
async function call(method, params) {
  for (const r of [rpc, ...RPCS.filter((x) => x !== rpc)]) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(r, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      const j = await res.json();
      if (j.result !== undefined && j.result !== null) {
        rpc = r;
        return j.result;
      }
    } catch { /* רשת — ננסה הבא */ }
  }
  return null;
}

function gate(id, name, pass, measured, note) {
  receipt.gates.push({ id, name, verdict: pass ? "PASS" : "FAIL", measured, note });
  if (!pass && receipt.verdict !== "RED") receipt.verdict = "RED";
}

// ── 0) גזירת-זהות-העיגון מסריקת-בלוק-הבסל (בלי txid — נתונים-ציבוריים בלבד) ──
const baseBlkFull = await call("eth_getBlockByNumber", ["0x" + BASELINE_BLOCK.toString(16), true]);
if (!baseBlkFull?.transactions) {
  gate("G0", "baseline-derivation", false, null, "בלוק-הבסל לא נשלף — אין-מדידה, fail-closed");
  const out = `receipts/heartbeat-scan-${Date.now()}.json`;
  await Bun.write(out, JSON.stringify(receipt, null, 2) + "\n");
  console.log(`receipt → ${out}`);
  process.exit(1);
}
let identity = null;
let derivedRoot = null;
for (const tx of baseBlkFull.transactions) {
  const input = tx.input ?? "";
  if (input.length !== 74) continue; // root(32B)‖height(4B) בדיוק
  if (!tx.from || String(tx.to ?? "").toLowerCase() !== String(tx.from).toLowerCase()) continue;
  const raw = Buffer.from(input.slice(2), "hex");
  if (raw.readUInt32BE(32) !== BASELINE_HEIGHT) continue;
  identity = String(tx.from).toLowerCase();
  derivedRoot = "0x" + raw.slice(0, 32).toString("hex");
  break;
}
if (!identity) {
  gate("G0", "baseline-derivation", false, { block: BASELINE_BLOCK, height: BASELINE_HEIGHT }, "לא נמצא self-עוגן עם ה-height הנטען בבלוק-הבסל — הטענה הציבורית לא אומתה");
  const out = `receipts/heartbeat-scan-${Date.now()}.json`;
  await Bun.write(out, JSON.stringify(receipt, null, 2) + "\n");
  console.log(`receipt → ${out}`);
  process.exit(1);
}
const anchorBlockOfBaseline = BASELINE_BLOCK;
receipt.measured.identity = identity.slice(0, 10) + "…" + identity.slice(-6) + " [מצונזר-אופסק]";
gate("G0", "baseline-derivation", true, { identity: receipt.measured.identity, derivedRoot }, "זהות-העיגון נגזרה מסריקת-בלוק ציבורי (self-tx · height תואם) — אפס-txid נטמן");

// ── 1) גיל-הבסל ──────────────────────────────────────────────────────────────
const headHex = await call("eth_blockNumber", []);
const head = parseInt(String(headHex), 16);
receipt.measured.head = head;
const baseBlk = await call("eth_getBlockByNumber", ["0x" + anchorBlockOfBaseline.toString(16), false]);
const baseTs = parseInt(String(baseBlk?.timestamp ?? "0"), 16);
const ageHours = (Date.now() / 1000 - baseTs) / 3600;
receipt.measured.baselineAgeHours = Math.round(ageHours * 100) / 100;
gate(
  "G1",
  "baseline-age",
  ageHours <= THRESHOLD_HOURS,
  { ageHours: receipt.measured.baselineAgeHours, thresholdHours: THRESHOLD_HOURS },
  ageHours <= THRESHOLD_HOURS ? "העוגן-האחרון-הידוע בתוך-הסף" : `העוגן-האחרון בן ${receipt.measured.baselineAgeHours}ש' — מעבר לסף`,
);

// ── 2) נונסה: האם נוצר משהו מאז ─────────────────────────────────────────────
const nonceAt = parseInt(await call("eth_getTransactionCount", [identity, "0x" + anchorBlockOfBaseline.toString(16)]), 16);
const nonceNow = parseInt(await call("eth_getTransactionCount", [identity, "latest"]), 16);
const bal = await call("eth_getBalance", [identity, "latest"]);
const balanceEth = parseInt(String(bal), 16) / 1e18;
receipt.measured.nonceAtBaseline = nonceAt;
receipt.measured.nonceNow = nonceNow;
receipt.measured.newTxsSinceBaseline = nonceNow - nonceAt;
receipt.measured.balanceEth = balanceEth;

const newAnchorsExpected = nonceNow - nonceAt;
// אם אין-טקסים-חדשים וגם היתרה ≈ 0 — הרעב מוכח (לא סתם "עצלות")
const starved = balanceEth < 1e-6;
gate(
  "G2",
  "rail-liveness",
  newAnchorsExpected > 0 || ageHours <= THRESHOLD_HOURS,
  { newTxsSinceBaseline: newAnchorsExpected, balanceEth, starved },
  newAnchorsExpected > 0
    ? `${newAnchorsExpected} טקסים-חדשים מאז-הבסל — הסריקה מאתרת`
    : starved
      ? `אפס-טקסים מאז-הבסל + יתרה ${balanceEth.toExponential(2)} ETH — המסילה מורעבת (לא מתה-מבחירה)`
      : `אפס-טקסים מאז-הבסל, יתרה קיימת — קצב-העיגון השתנה`,
);

// ── 3) סריקה אחורה מה-HEAD אחרי עוגנים-חדשים ───────────────────────────────
const anchors = [];
if (newAnchorsExpected > 0) {
  for (let b = head; b > head - SCAN_BACK && anchors.length < newAnchorsExpected; b--) {
    const blk = await call("eth_getBlockByNumber", ["0x" + b.toString(16), true]);
    if (!blk?.transactions) continue;
    for (const tx of blk.transactions) {
      const input = tx.input ?? "";
      if (input.length !== 74) continue; // root(32B)‖height(4B) בדיוק
      if (!tx.from || String(tx.to ?? "").toLowerCase() !== String(tx.from).toLowerCase()) continue;
      const raw = Buffer.from(input.slice(2), "hex");
      anchors.push({
        block: b,
        root: "0x" + raw.slice(0, 32).toString("hex"),
        height: raw.readUInt32BE(32),
        txid: String(tx.hash).slice(0, 10) + "…[מצונזר-אופסק]",
      });
    }
  }
  anchors.sort((a, b) => a.height - b.height);
  receipt.measured.anchorsFound = anchors;
  receipt.measured.latestAnchor = anchors.length ? anchors[anchors.length - 1] : null;
}
gate(
  "G3",
  "anchor-discovery",
  !newAnchorsExpected || anchors.length >= newAnchorsExpected,
  { scannedBack: Math.min(SCAN_BACK, head - BASELINE_BLOCK), found: anchors.length, expected: newAnchorsExpected },
  newAnchorsExpected ? (anchors.length ? `${anchors.length} עוגנים-חדשים אותרו (עד h${Math.max(...anchors.map((a) => a.height))})` : "טקסים-חדשים קיימים אך לא נמצאו-עוגנים בחלון") : "אין-טקסים-חדשים — אין-מה לגלות (כנות)",
);

// ── פסיקה ────────────────────────────────────────────────────────────────────
if (receipt.verdict !== "RED") receipt.verdict = "GREEN";
receipt.note =
  receipt.verdict === "GREEN"
    ? `הלב חי: עוגן אחרון h${receipt.measured.latestAnchor?.height ?? BASELINE_HEIGHT}, גיל ${receipt.measured.baselineAgeHours}ש'`
    : `הלב עצור ${receipt.measured.baselineAgeHours}ש' (סף ${THRESHOLD_HOURS}ש') · יתרת-זהות ${balanceEth.toExponential(2)} ETH — הוכחת-רעב · חוק-פיצול-המטבע: הזרמת-גז = המפעיל (QUEUE)`;

const out = `receipts/heartbeat-scan-${Date.now()}.json`;
await Bun.write(out, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ verdict: receipt.verdict, gates: receipt.gates.map((g) => `${g.id}:${g.verdict}`), note: receipt.note }, null, 2));
console.log(`receipt → ${out}`);
process.exit(receipt.verdict === "GREEN" ? 0 : 1);
