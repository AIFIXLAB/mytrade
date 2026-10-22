// Token data: DexScreener (pairs/liquidity/age), RugCheck (risk report), on-chain mint + holder checks.
import { config } from "./config.ts";
import { rpc } from "./solana.ts";

export interface TokenInfo {
  mint: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  fdv: number;
  volH1: number;
  buysH1: number;
  sellsH1: number;
  changeM5: number;
  changeH1: number;
  pairAgeMin: number;
  hasSocials: boolean;
  website?: string;
  twitter?: string;
}

const cache = new Map<string, { at: number; v: any }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

export function dexInfo(mint: string): Promise<TokenInfo | null> {
  return cached("dex:" + mint, 15_000, async () => {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!r.ok) return null;
    const j: any = await r.json();
    const pairs: any[] = (j.pairs ?? []).filter((p: any) => p.chainId === "solana");
    if (!pairs.length) return null;
    const p = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const base = p.baseToken?.address === mint ? p.baseToken : p.quoteToken;
    const socials: any[] = p.info?.socials ?? [];
    const websites: any[] = p.info?.websites ?? [];
    return {
      mint,
      symbol: base?.symbol ?? mint.slice(0, 4),
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
  });
}

export interface RugReport { score: number; dangers: string[]; warnings: string[]; }

export function rugcheck(mint: string): Promise<RugReport | null> {
  return cached("rug:" + mint, 120_000, async () => {
    try {
      const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
      if (!r.ok) return null;
      const j: any = await r.json();
      const risks: any[] = j.risks ?? [];
      return {
        score: Number(j.score_normalised ?? j.score ?? 0),
        dangers: risks.filter((x) => x.level === "danger").map((x) => x.name),
        warnings: risks.filter((x) => x.level === "warn").map((x) => x.name),
      };
    } catch { return null; }
  });
}

export interface OnchainChecks { mintAuthority: string | null; freezeAuthority: string | null; decimals: number; top10Pct: number; }

export function onchainChecks(mint: string): Promise<OnchainChecks> {
  return cached("chain:" + mint, 300_000, async () => {
    const acc: any = await rpc(config.rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const info = acc?.value?.data?.parsed?.info ?? {};
    let top10Pct = 1;
    try {
      const [largest, supply]: any[] = await Promise.all([
        rpc(config.rpcUrl, "getTokenLargestAccounts", [mint]),
        rpc(config.rpcUrl, "getTokenSupply", [mint]),
      ]);
      const total = Number(supply.value.amount);
      // The largest account is usually the AMM pool vault; skip it so the pool isn't counted as a "holder".
      const rest = (largest.value as any[]).slice(1, 11).reduce((s, a) => s + Number(a.amount), 0);
      top10Pct = total > 0 ? rest / total : 1;
    } catch { /* some RPCs rate-limit getTokenLargestAccounts */ }
    return {
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      decimals: Number(info.decimals ?? 6),
      top10Pct,
    };
  });
}
