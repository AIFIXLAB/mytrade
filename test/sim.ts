// End-to-end paper run with a mocked market (no network). Exercises signal → agents → entry → TP / SL / follow-out.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
process.env.RPC_URL = "http://mock"; process.env.JUP_API_KEY = "mock"; process.env.MODE = "paper";
rmSync("data/state.json", { force: true });
let price = 1; // SOL per 1e6 raw tokens for MEME
const { SOL_MINT, USDC_MINT } = await import("../src/solana.ts");
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
  if (u.includes("dexscreener")) return ok({ pairs: [{ chainId: "solana", baseToken: { address: u.split("/").pop(), symbol: "meme" }, priceUsd: "0.01", liquidity: { usd: 90000 }, fdv: 900000, volume: { h1: 50000 }, txns: { h1: { buys: 300, sells: 120 } }, priceChange: { m5: 3, h1: 20 }, pairCreatedAt: Date.now() - 3 * 3600e3, info: { socials: [{ type: "twitter", url: "x" }] } }] });
  if (u.includes("rugcheck")) return ok({ score_normalised: 5, risks: [] });
  if (u.includes("jup.ag")) {
    const q = new URL(u).searchParams; const amt = Number(q.get("amount"));
    let out = 0;
    if (q.get("inputMint") === SOL_MINT && q.get("outputMint") === USDC_MINT) out = 150e6 * amt / 1e9;
    else if (q.get("inputMint") === SOL_MINT) out = (amt / 1e9) / price * 1e6;
    else out = (amt / 1e6) * price * 1e9;
    return ok({ outAmount: String(Math.floor(out)), requestId: "r", transaction: null });
  }
  const body = JSON.parse(init?.body ?? "{}");
  if (body.method === "getAccountInfo") return ok({ result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6 } } } } } });
  if (body.method === "getTokenSupply") return ok({ result: { value: { amount: "1000000000" } } });
  if (body.method === "getTokenLargestAccounts") return ok({ result: { value: [{ amount: "400000000" }, ...Array(10).fill({ amount: "10000000" })] } });
  return ok({ result: null });
}) as any;

const { Engine } = await import("../src/engine.ts");
const leader = { address: "L1", label: "leo" };
const e = new Engine(null, [leader]);
await e.init();
const buy = (mint: string, sol = 1) => ({ side: "BUY" as const, leader, mint, signature: "s" + mint, solAmount: sol, tokenDeltaRaw: BigInt(Math.floor(sol / price * 1e6)), tokenPreRaw: 0n, decimals: 6, soldFraction: 0, blockTime: 0 });

await e.onLeaderTrade(buy("MEME1"));
assert.equal(e.s.positions.length, 1, "should enter");
price = 1.5; await e.monitor();                         // +50% → take-profit
assert.equal(e.s.positions.length, 0); assert.equal(e.s.wins, 1);

price = 1; await e.onLeaderTrade(buy("MEME2"));
price = 0.85; await e.monitor();                        // −15% → stop-loss
assert.equal(e.s.losses, 1);

price = 1; await e.onLeaderTrade(buy("MEME3"));
await e.onLeaderTrade({ ...buy("MEME3"), side: "SELL", soldFraction: 0.8, tokenDeltaRaw: -1n }); // leader dumps → follow out
assert.equal(e.s.positions.length, 0);

await e.onLeaderTrade(buy("MEME4", 0.05));                // leader buy too small → skip
assert.ok(e.s.skipped >= 1);
const snap = e.snapshot();
console.log(`sim ok ✓  copies=${snap.copies} wins=${snap.wins} losses=${snap.losses} skipped=${snap.skipped} equity=${snap.equitySol.toFixed(4)} SOL ($${(snap.equitySol*snap.solUsd).toFixed(2)})`);
rmSync("data", { recursive: true, force: true });
