// Momentum scanner: finds Solana tokens that are STARTING to move (volume spike + buy pressure),
// without needing any wallet to follow. Data: DexScreener public API (no key).
//
// Honest limits: nobody can see a pump before it starts. This catches the first minutes of one.
// Many signals fade right after entry, so exits are tight (small TP, small SL, short max hold).
import { config } from "./config.ts";
import type { TokenInfo } from "./market.ts";

export interface Momentum {
  volSpike: number;     // 5-minute volume vs the average 5 minutes of the last hour
  buyRatio: number;     // buys / sells in the last 5 minutes
  buysM5: number;
  changeM5: number;     // % price change last 5 min
  changeH1: number;
  score: number;        // 0..1
  note: string;
}

export interface ScanHit { token: TokenInfo; momentum: Momentum; }

const DS = "https://api.dexscreener.com";
const SKIP = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (r.status === 429) throw new Error("dexscreener rate limit");
  if (!r.ok) throw new Error(`dexscreener ${r.status}`);
  return r.json();
}

/** Tokens people are paying attention to right now (new profiles + paid boosts). */
async function candidates(): Promise<string[]> {
  const lists = await Promise.allSettled([
    getJson(`${DS}/token-profiles/latest/v1`),
    getJson(`${DS}/token-boosts/latest/v1`),
    getJson(`${DS}/token-boosts/top/v1`),
  ]);
  const out = new Set<string>();
  for (const l of lists) {
    if (l.status !== "fulfilled" || !Array.isArray(l.value)) continue;
    for (const t of l.value) if (t.chainId === "solana" && t.tokenAddress && !SKIP.has(t.tokenAddress)) out.add(t.tokenAddress);
  }
  return [...out];
}

/** Best (most liquid) Solana pair per token, fetched 30 tokens per request. */
async function pairs(mints: string[]): Promise<Map<string, any>> {
  const best = new Map<string, any>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const list: any[] = await getJson(`${DS}/tokens/v1/solana/${batch.join(",")}`);
      for (const p of list ?? []) {
        const mint = p.baseToken?.address;
        if (!mint || !batch.includes(mint)) continue;
        const prev = best.get(mint);
        if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) best.set(mint, p);
      }
    } catch { /* skip batch */ }
  }
  return best;
}

function toInfo(mint: string, p: any): TokenInfo {
  const socials: any[] = p.info?.socials ?? [];
  const websites: any[] = p.info?.websites ?? [];
  return {
    mint,
    symbol: p.baseToken?.symbol ?? mint.slice(0, 4),
    priceUsd: Number(p.priceUsd ?? 0),
    liquidityUsd: Number(p.liquidity?.usd ?? 0),
    fdv: Number(p.fdv ?? p.marketCap ?? 0),
    volH1: Number(p.volume?.h1 ?? 0),
    buysH1: Number(p.txns?.h1?.buys ?? 0),
    sellsH1: Number(p.txns?.h1?.sells ?? 0),
    changeM5: Number(p.priceChange?.m5 ?? 0),
    changeH1: Number(p.priceChange?.h1 ?? 0),
    pairAgeMin: p.pairCreatedAt ? (Date.now() - Number(p.pairCreatedAt)) / 60000 : 0,
    hasSocials: socials.length > 0 || websites.length > 0,
    website: websites[0]?.url,
    twitter: socials.find((s) => s.type === "twitter")?.url,
  };
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

export function momentumOf(p: any): Momentum | null {
  const volM5 = Number(p.volume?.m5 ?? 0), volH1 = Number(p.volume?.h1 ?? 0);
  const buys = Number(p.txns?.m5?.buys ?? 0), sells = Number(p.txns?.m5?.sells ?? 0);
  const changeM5 = Number(p.priceChange?.m5 ?? 0), changeH1 = Number(p.priceChange?.h1 ?? 0);
  const avg5 = volH1 / 12;
  const volSpike = avg5 > 0 ? volM5 / avg5 : 0;
  const buyRatio = sells > 0 ? buys / sells : buys;

  // Hard gates: must be moving now, with real buyers, and not already vertical.
  if (volSpike < config.scanMinVolSpike) return null;
  if (buys < config.scanMinBuysM5 || buyRatio < config.scanMinBuyRatio) return null;
  if (changeM5 < config.scanMinChangeM5 || changeM5 > config.scanMaxChangeM5) return null;
  if (changeH1 > config.scanMaxChangeH1) return null; // already pumped hard this hour → late

  const score = clamp(
    0.35 * clamp((volSpike - config.scanMinVolSpike) / 4 + 0.4) +
    0.35 * clamp((buyRatio - 1) / 2) +
    0.3 * clamp(1 - Math.abs(changeM5 - 8) / 20),
  );
  return {
    volSpike, buyRatio, buysM5: buys, changeM5, changeH1, score,
    note: `vol ${volSpike.toFixed(1)}x · buys ${buys}/${sells} · 5m ${changeM5 > 0 ? "+" : ""}${changeM5}%`,
  };
}

/** One scan pass → hits sorted strongest first. */
export async function scanOnce(): Promise<{ checked: number; hits: ScanHit[] }> {
  const mints = await candidates();
  const best = await pairs(mints);
  const hits: ScanHit[] = [];
  for (const [mint, p] of best) {
    const fdv = Number(p.fdv ?? p.marketCap ?? 0);
    if (fdv < config.scanMinFdv || fdv > config.scanMaxFdv) continue;
    const m = momentumOf(p);
    if (m) hits.push({ token: toInfo(mint, p), momentum: m });
  }
  hits.sort((a, b) => b.momentum.score - a.momentum.score);
  return { checked: best.size, hits };
}
