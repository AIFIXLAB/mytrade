// Six "agents" vote on every leader BUY. Each returns a 0..1 score; a veto forces a skip.
// Consensus = weighted mean. This is the `grok.score(t.token)` step from the video, made explicit.
import { config } from "./config.ts";
import type { LeaderTrade } from "./watcher.ts";
import type { TokenInfo, RugReport, OnchainChecks } from "./market.ts";
import type { Momentum } from "./scanner.ts";

export type AgentName = "SCAN" | "WHALE" | "NARRATIVE" | "SNIPER" | "RISK" | "EXIT";
export interface Vote { agent: AgentName; score: number; note: string; veto?: boolean; }

export interface Ctx {
  trade: LeaderTrade;
  token: TokenInfo | null;
  rug: RugReport | null;
  chain: OnchainChecks | null;
  entryDriftPct: number | null;       // how much worse our price is vs the leader's fill
  leaderStats: { wins: number; losses: number };
  confluence: number;                 // other leaders that bought this mint in the last 30 min
  openPositions: number;
  alreadyHolding: boolean;
  dailyPnlPct: number;
  momentum?: Momentum;                // set when the signal came from the scanner, not a wallet
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

const WEIGHTS: Record<AgentName, number> = { SCAN: 0.15, WHALE: 0.2, NARRATIVE: 0.1, SNIPER: 0.2, RISK: 0.25, EXIT: 0.1 };

function scan(c: Ctx): Vote {
  const t = c.token;
  if (!t) return { agent: "SCAN", score: 0, note: "no DEX pair found", veto: true };
  if (t.liquidityUsd < config.minLiquidityUsd) return { agent: "SCAN", score: 0, note: `liq $${t.liquidityUsd.toFixed(0)} too thin`, veto: true };
  if (t.pairAgeMin < config.minPairAgeMin) return { agent: "SCAN", score: 0.2, note: `pair only ${t.pairAgeMin.toFixed(0)}m old`, veto: true };
  const liq = clamp(Math.log10(t.liquidityUsd / config.minLiquidityUsd + 1) / 1.5);
  const flow = t.buysH1 + t.sellsH1 > 0 ? t.buysH1 / (t.buysH1 + t.sellsH1) : 0.5;
  return { agent: "SCAN", score: clamp(0.5 * liq + 0.5 * flow + 0.1), note: `liq $${(t.liquidityUsd / 1000).toFixed(0)}k · buys ${(flow * 100).toFixed(0)}%` };
}

function whale(c: Ctx): Vote {
  if (c.momentum) return { agent: "WHALE", score: c.momentum.score, note: c.momentum.note };
  const { wins, losses } = c.leaderStats;
  const n = wins + losses;
  const wr = n >= 3 ? wins / n : 0.6; // prior until we have history
  const size = clamp(c.trade.solAmount / (config.minLeaderBuySol * 4));
  if (c.trade.solAmount < config.minLeaderBuySol) return { agent: "WHALE", score: 0.2, note: `leader buy ${c.trade.solAmount.toFixed(2)} SOL too small`, veto: true };
  const conf = clamp(c.confluence / 2);
  return { agent: "WHALE", score: clamp(0.5 * wr + 0.3 * size + 0.2 * conf + (c.trade.leader.weight ?? 0) * 0.1), note: `${c.trade.leader.label} wr ${(wr * 100).toFixed(0)}% · ${c.trade.solAmount.toFixed(2)} SOL${c.confluence ? ` · +${c.confluence} wallets` : ""}` };
}

async function narrative(c: Ctx): Promise<Vote> {
  const t = c.token;
  let score = t?.hasSocials ? 0.7 : 0.4;
  let note = t?.hasSocials ? "has socials" : "no socials";
  if (config.narrativeLlmUrl && config.narrativeLlmKey && t) {
    try {
      const prompt = `Rate 0-1 how strong the meme/narrative momentum is for Solana token $${t.symbol}. Data: FDV $${t.fdv.toFixed(0)}, 1h volume $${t.volH1.toFixed(0)}, 1h change ${t.changeH1}%, website ${t.website ?? "none"}, twitter ${t.twitter ?? "none"}. Reply with JSON {"score":number,"why":string} only.`;
      const r = await fetch(config.narrativeLlmUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.narrativeLlmKey}` },
        body: JSON.stringify({ model: config.narrativeLlmModel, messages: [{ role: "user", content: prompt }], temperature: 0 }),
        signal: AbortSignal.timeout(6000),
      });
      const j: any = await r.json();
      const out = JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}").replace(/```json|```/g, ""));
      if (typeof out.score === "number") { score = clamp(out.score); note = `llm: ${String(out.why ?? "").slice(0, 60)}`; }
    } catch { note += " · llm timeout"; }
  }
  return { agent: "NARRATIVE", score, note };
}

function sniper(c: Ctx): Vote {
  if (c.momentum) {
    const m = c.momentum.changeM5;
    return { agent: "SNIPER", score: clamp(1 - Math.abs(m - 8) / 20), note: `5m ${m > 0 ? "+" : ""}${m}% · 1h ${c.momentum.changeH1}%` };
  }
  const d = c.entryDriftPct;
  if (d === null) return { agent: "SNIPER", score: 0.4, note: "no quote" };
  if (d > config.maxEntryDriftPct) return { agent: "SNIPER", score: 0.1, note: `price already +${(d * 100).toFixed(0)}% vs leader`, veto: true };
  const hot = c.token ? clamp(c.token.changeM5 / 60) : 0; // chasing a 5m candle that's already vertical is risky
  return { agent: "SNIPER", score: clamp(1 - Math.max(0, d) / config.maxEntryDriftPct - 0.3 * hot), note: `drift ${(d * 100).toFixed(1)}% · 5m ${c.token?.changeM5 ?? 0}%` };
}

function risk(c: Ctx): Vote {
  const ch = c.chain, rug = c.rug;
  if (ch?.mintAuthority) return { agent: "RISK", score: 0, note: "mint authority still enabled", veto: true };
  if (ch?.freezeAuthority) return { agent: "RISK", score: 0, note: "freeze authority enabled", veto: true };
  if (rug?.dangers.length) return { agent: "RISK", score: 0, note: `rugcheck: ${rug.dangers[0]}`, veto: true };
  if (ch && ch.top10Pct > config.maxTop10HolderPct) return { agent: "RISK", score: 0.1, note: `top10 hold ${(ch.top10Pct * 100).toFixed(0)}%`, veto: true };
  const holders = ch ? clamp(1 - ch.top10Pct / config.maxTop10HolderPct) : 0.4;
  const warn = rug ? clamp(1 - rug.warnings.length * 0.15) : 0.5;
  return { agent: "RISK", score: clamp(0.5 * holders + 0.5 * warn), note: `top10 ${ch ? (ch.top10Pct * 100).toFixed(0) : "?"}% · ${rug?.warnings.length ?? "?"} warns` };
}

function exit(c: Ctx): Vote {
  if (c.alreadyHolding) return { agent: "EXIT", score: 0, note: "already holding", veto: true };
  if (c.openPositions >= config.maxOpenPositions) return { agent: "EXIT", score: 0, note: "max positions", veto: true };
  if (c.dailyPnlPct <= -config.dailyLossLimitPct) return { agent: "EXIT", score: 0, note: "daily loss limit hit", veto: true };
  return { agent: "EXIT", score: clamp(1 - c.openPositions / config.maxOpenPositions), note: `slots ${config.maxOpenPositions - c.openPositions}/${config.maxOpenPositions}` };
}

export async function consensus(c: Ctx): Promise<{ score: number; votes: Vote[]; vetoed: Vote | undefined }> {
  const votes: Vote[] = [scan(c), whale(c), await narrative(c), sniper(c), risk(c), exit(c)];
  const vetoed = votes.find((v) => v.veto);
  const score = vetoed ? 0 : votes.reduce((s, v) => s + v.score * WEIGHTS[v.agent], 0);
  return { score, votes, vetoed };
}
