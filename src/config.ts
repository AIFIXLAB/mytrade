import { readFileSync, existsSync } from "node:fs";

// Tiny .env loader (no dotenv dependency).
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k} (see .env.example)`);
  return v;
};
const num = (k: string, d: number) => Number(process.env[k] ?? d);

export interface Leader { address: string; label: string; weight?: number; }

export const config = {
  mode: env("MODE", "paper") as "paper" | "live",
  rpcUrl: env("RPC_URL", ""),
  wsUrl: env("WS_URL", ""),
  jupApiKey: env("JUP_API_KEY", ""),
  secretKey: process.env.WALLET_SECRET_KEY ?? "",

  paperStartSol: num("PAPER_START_SOL", 1),
  maxRiskPct: num("MAX_RISK_PCT", 0.12),           // fraction of balance per trade (video: maxRisk 0.12)
  maxSolPerTrade: num("MAX_SOL_PER_TRADE", 0.25),
  minSolReserve: num("MIN_SOL_RESERVE", 0.05),      // always keep this for fees
  slippageBps: num("SLIPPAGE_BPS", 150),            // video: slippage 1.5
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 4),
  consensusThreshold: num("CONSENSUS_THRESHOLD", 0.75), // video: score < 0.75 → skip
  takeProfitPct: num("TAKE_PROFIT_PCT", 0.35),
  stopLossPct: num("STOP_LOSS_PCT", 0.12),          // video: sl -12%
  trailingArmPct: num("TRAILING_ARM_PCT", 0.2),
  trailingDropPct: num("TRAILING_DROP_PCT", 0.1),
  maxHoldMin: num("MAX_HOLD_MIN", 240),
  followLeaderExit: (process.env.FOLLOW_LEADER_EXIT ?? "true") === "true",
  dailyLossLimitPct: num("DAILY_LOSS_LIMIT_PCT", 0.25),
  maxEntryDriftPct: num("MAX_ENTRY_DRIFT_PCT", 0.15), // skip if price already ran >15% past leader's entry
  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 15000),
  minPairAgeMin: num("MIN_PAIR_AGE_MIN", 10),
  maxTop10HolderPct: num("MAX_TOP10_HOLDER_PCT", 0.45),
  minLeaderBuySol: num("MIN_LEADER_BUY_SOL", 0.3),
  pollMs: num("POSITION_POLL_MS", 4000),
  port: num("PORT", 8787),

  narrativeLlmUrl: process.env.NARRATIVE_LLM_URL ?? "",   // OpenAI-compatible /chat/completions (e.g. xAI)
  narrativeLlmKey: process.env.NARRATIVE_LLM_KEY ?? "",
  narrativeLlmModel: process.env.NARRATIVE_LLM_MODEL ?? "",
};

export function loadLeaders(): Leader[] {
  const file = existsSync("wallets.json") ? "wallets.json" : "wallets.example.json";
  const list = JSON.parse(readFileSync(file, "utf8")) as Leader[];
  return list.filter((l) => l.address && !l.address.startsWith("PASTE"));
}

export function wsUrlFor(rpcUrl: string) {
  return config.wsUrl || rpcUrl.replace(/^http/, "ws");
}
