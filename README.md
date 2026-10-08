# TruthRail — Keyless Verification Layer

> **שכבת-האימות ללא-מפתחות של הצי הריבוני** · fail-closed · zero secrets · third-party verifiable

Every claim in this repository is **measured, not asserted**. Any third party — with nothing
but public RPC endpoints and [Bun](https://bun.sh) — can re-run every verification and get
the same verdicts. No keys, no tokens, no access to private repos, no trust required.

## Verifiers

### 1. `scripts/zero-verify.mjs` — ZERO rail live verification

Verifies the ZERO Network rail (chain `0x2499` / 9369) is live **and still gas-free**:

| Gate | Claim | Failure mode |
|------|-------|--------------|
| G1 | `eth_chainId == 0x2499` | `RED` |
| G2 | `eth_gasPrice == 0x0` | `RED` + `ZERO-GATE-CLOSED` |
| G3 | chain advances during measurement | `RED` |
| G4 (optional, `--txid`) | anchor tx re-read: status=1, effectiveGasPrice=0x0, self-addressed inert EOA | `RED` |

```bash
bun run scripts/zero-verify.mjs
# receipt → receipts/zero-live-verify-<ts>.json
```

### 2. `scripts/artifact-verify.mjs` — mainnet anchor read-back (block scanning)

Independently re-reads the fleet's Ethereum-mainnet heartbeat anchors **without txids**:
scans a claimed block for self-addressed transactions (to == from — the inert-EOA doctrine),
decodes calldata `root(32B) ‖ height(4B)`, and double-matches root-prefix + height against
the public claim. Receipt is re-fetched through a public-RPC fallback chain.

```bash
bun run scripts/artifact-verify.mjs --rpc https://eth.llamarpc.com \
  --block 25958268 --root 0x8f513865 --height 25 \
  --out receipts/artifact-readback.json
```

- `--root` accepts any prefix length (≥8 hex chars recommended)
- verdict `GREEN` requires: block contains the self-tx AND calldata decodes to the claimed
  root-prefix AND height AND on-chain receipt status == 1

### 4. `scripts/zero-heartbeat.mjs` — the FREE heartbeat (the solution)

**You don't need gas money to keep the fleet's heart beating.** The heartbeat lives on
Z Chain 9369 (ZERO Network) where gas is *measured* `0x0`: the hourly cadence broadcasts
a self-addressed inert transaction carrying a JSON checkpoint payload
(`saos-weave-core/v1`). Cost per anchor: **0.000000 ETH — forever**.

```bash
bun scripts/zero-heartbeat.mjs --block 36593749 --checkpoint 1533 --root 0x102d3bf3
# GREEN ×4: block-age · anchor-discovery (block scan, no txid) · claim-match · inclusion+zero-gas
```

The mainnet rail (h25/h26) is **parked** — starved since 2026-09-12, documented, zero
urgency: the free rail carries the heartbeat. The autonomous brain (`decide()`) now
verifies both rails hourly: ZERO = primary (ALIVE ⇒ heartbeat proven free), mainnet =
archived note.

## Receipts

Measured JSON verdicts live in [`receipts/`](receipts/). Opsec law: **full txids are
censored** (`0x02648a90…4f01bf [מצונזר-אופסק]`) — they are *not needed for verification*
(the block-scanning method reconstructs them from public data). Roots, block numbers and
heights are the public commitments and are published as-is.

## Status (2026-10-08, Task 21 — measured, not claimed)

- **Dual-rail heartbeat ALIVE**: ZERO anchors hourly FREE (cp#1535/1536/1537 proven on-chain,
  gas 0x0, cost 0.000000) + Steem/Hive line broadcast live again after the Actions secret was
  refreshed with a chain-verified fleet key (10/10 soldiers verified against live authorities).
- **Cadence anti-starvation (R251)**: GitHub silently dropped 7 hourly schedule firings on
  2026-10-08 (last 06:27Z, nothing until 13:50Z). The Domain workflow now self-recalls the next
  :33 cycle — the cadence no longer depends on the scheduler. Public minutes = free forever.
- **Key-split honesty**: the R245-ROT2 vault rotation (2026-10-07 19:08Z) was never broadcast to
  the chain (0/11 vault keys match live authorities); the LIVE pre-rotation keys verified 10/10.
  headcorner's own STEEM keys exist in no cloud vault (0/4 across all generations) — operator/
  twin custody only, recorded as an honest QUEUE, not hidden.

## Laws encoded here

1. **Fail-closed** — every gate that cannot pass produces `RED` + exit 1. A skipped check is
   recorded honestly (`"skipped"`), never disguised as a pass.
2. **Zero secrets** — no private keys, no WIF, no PAT, no broadcast. Pure read-only RPC.
3. **Truth over comfort** — if the ZERO rail ever charges gas, G2 says `ZERO-GATE-CLOSED`
   in public. We publish failures too.
4. **HELD stays held** — the luck/gambling lane is frozen at code level in a private repo.
   It is *never* published here. Only an explicit operator instruction can release it.

## Fleet log

See [`worklog.md`](worklog.md) — the sovereign fleet's operational journal (Hebrew),
rebuilt after the 2026-10-08 sandbox reset; cloud state survived, local state was rebuilt
against it.
