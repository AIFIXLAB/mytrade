// Scanner end-to-end with a mocked market: DexScreener lists → momentum filter → agents → entry → quick TP / SL / time exit.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
process.env.RPC_URL = "http://mock"; process.env.JUP_API_KEY = "mock"; process.env.MODE = "paper";
rmSync("data/state.json", { force: true });
const { SOL_MINT, USDC_MINT } = await import("../src/solana.ts");
const price: Record<string, number> = { HOT1: 1, HOT2: 1, LATE: 1, FLAT: 1 };
const pair = (mint: string, o: any) => ({ chainId: "solana", baseToken: { address: mint, symbol: mint.toLowerCase() }, priceUsd: "0.001", liquidity: { usd: 120000 }, fdv: 2_000_000,
  pairCreatedAt: Date.now() - 6 * 3600e3, info: { socials: [{ type: "twitter", url: "x" }] }, ...o });
const PAIRS = [
  pair("HOT1", { volume: { m5: 40000, h1: 90000 }, txns: { m5: { buys: 180, sells: 70 }, h1: { buys: 600, sells: 400 } }, priceChange: { m5: 9, h1: 22 } }),  // spike 5.3x → enter
  pair("HOT2", { volume: { m5: 30000, h1: 80000 }, txns: { m5: { buys: 150, sells: 60 }, h1: { buys: 500, sells: 380 } }, priceChange: { m5: 7, h1: 15 } }),   // spike 4.5x → enter
  pair("LATE", { volume: { m5: 50000, h1: 90000 }, txns: { m5: { buys: 200, sells: 90 }, h1: { buys: 700, sells: 500 } }, priceChange: { m5: 45, h1: 300 } }), // already vertical → ignore
  pair("FLAT", { volume: { m5: 5000, h1: 70000 }, txns: { m5: { buys: 40, sells: 38 }, h1: { buys: 400, sells: 390 } }, priceChange: { m5: 1, h1: 2 } }),     // no spike → ignore
];
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url); const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
  if (u.includes("/token-profiles/") || u.includes("/token-boosts/")) return ok(PAIRS.map((p) => ({ chainId: "solana", tokenAddress: p.baseToken.address })));
  if (u.includes("/tokens/v1/solana/")) return ok(PAIRS.map((p) => ({ ...p, priceUsd: String(price[p.baseToken.address] * 150) })));
  if (u.includes("rugcheck")) return ok({ score_normalised: 3, risks: [] });
  if (u.includes("jup.ag")) {
    const q = new URL(u).searchParams; const amt = Number(q.get("amount")); const inM = q.get("inputMint")!, outM = q.get("outputMint")!;
    let out = 0;
    if (inM === SOL_MINT && outM === USDC_MINT) out = 150e6 * amt / 1e9;
    else if (inM === SOL_MINT) out = (amt / 1e9) / price[outM] * 1e6;
    else out = (amt / 1e6) * price[inM] * 1e9;
    return ok({ outAmount: String(Math.floor(out)), requestId: "r", transaction: null });
  }
  const body = JSON.parse(init?.body ?? "{}");
  if (body.method === "getAccountInfo") return ok({ result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6 } } } } } });
  if (body.method === "getTokenSupply") return ok({ result: { value: { amount: "1000000000" } } });
  if (body.method === "getTokenLargestAccounts") return ok({ result: { value: [{ amount: "400000000" }, ...Array(10).fill({ amount: "10000000" })] } });
  return ok({ result: null });
}) as any;

const { scanOnce } = await import("../src/scanner.ts");
const { Engine } = await import("../src/engine.ts");
const { hits, checked } = await scanOnce();
assert.equal(checked, 4);
assert.deepEqual(hits.map((h) => h.token.mint).sort(), ["HOT1", "HOT2"], "only the coins starting to move");

const e = new Engine(null, []);
await e.init();
for (const h of hits) await e.onScanHit(h);
assert.equal(e.s.positions.length, 2, "should enter both movers");
assert.equal(e.s.positions[0].exits?.holdMin, 20);

price.HOT1 = 1.25; price.HOT2 = 0.9; await e.monitor();   // HOT1 +25% → TP (+20%), HOT2 −10% → SL (−8%)
assert.equal(e.s.positions.length, 0); assert.equal(e.s.wins, 1); assert.equal(e.s.losses, 1);

for (const h of hits) await e.onScanHit(h);              // cooldown: no instant re-buy
assert.equal(e.s.positions.length, 0, "cooldown blocks re-entry");
console.log(`scan-sim ok ✓  wins=${e.s.wins} losses=${e.s.losses} equity=${e.s.equitySol.toFixed(4)} SOL`);
rmSync("data", { recursive: true, force: true });
