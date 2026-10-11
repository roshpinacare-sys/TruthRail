#!/usr/bin/env node
// exposure-scan (TruthRail) — P0-1 enforcement, master plan T6, 2026-10-11
// TruthRail is a keyless verification layer: receipts must never carry key
// structure, rotation events, custody narratives or restore drills.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FORBIDDEN_PATHS = [
  /^receipts\/.*(?:rotation|custody|key-absorb|restore-drill|sovereign-bootstrap|key-check).*\.json$/,
  /(^|\/)ssh-keys\.tar\.enc$/,
  /(^|\/)keys\.env(\.enc|\.bak.*)?$/,
];

const FORBIDDEN_CONTENT = [
  { re: /hq\.password/i, why: "restoration passphrase pointer" },
  { re: /keysZipPass/i, why: "vault-zip passphrase pointer" },
  { re: /BEGIN (RSA |EC )?PRIVATE KEY/, why: "private key material" },
  { re: /(?:הסיסמה|המפתח) (?:היא|הוא|האמיתית)|מסמך העברת הסיסמה/i, why: "master-password narrative" },
  { re: /\b[5JKL][1-9A-HJ-NP-Za-km-z]{50,51}\b/, why: "WIF-shaped token" },
  { re: /"(?:owner|active|posting|memo)_?(?:key|auth)s?"/i, why: "authority-structure key" },
];

const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const findings = [];

for (const p of tracked) {
  for (const fp of FORBIDDEN_PATHS) if (fp.test(p)) findings.push({ p, why: "forbidden path" });
}

const targets = tracked.filter((p) => !/^\.github\//.test(p) && /\.json|\.md|\.html/.test(p));
for (const p of targets) {
  let body = "";
  try { body = readFileSync(p, "utf8"); } catch { continue; }
  for (const { re, why } of FORBIDDEN_CONTENT) if (re.test(body)) findings.push({ p, why });
}

if (findings.length) {
  console.error("EXPOSURE-GATE FAIL:");
  for (const f of findings.slice(0, 40)) console.error(`  ✗ ${f.p} — ${f.why}`);
  process.exit(1);
}
console.log(`exposure-scan: PASS — ${targets.length} files scanned, 0 violations`);
