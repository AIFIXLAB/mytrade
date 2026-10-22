import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config, type Leader } from "./config.ts";
import { consensus, type AgentName } from "./agents.ts";
import { dexInfo, rugcheck, onchainChecks } from "./market.ts";
import { quoteOut, swap } from "./jupiter.ts";
import { rpc, SOL_MINT, USDC_MINT, LAMPORTS, type Keypair } from "./solana.ts";
import type { LeaderTrade } from "./watcher.ts";
import type { ScanHit } from "./scanner.ts";

export interface Exits { tp: number; sl: number; arm: number; drop: number; holdMin: number; }

export interface Position {
  mint: string; symbol: string; leader: string;
  tokenRaw: string;           // bigint as string (JSON-safe)
  solIn: number; solOut: number;
  openedAt: number; peakValueSol: number; lastValueSol: number;
  quoteFails: number;
  decimals?: number;
  exits?: Exits;              // per-position exit rules (scanner trades use tighter ones)
}

export interface ClosedTrade {
  closed_at: string; mode: string; symbol: string; mint: string; leader: string;
  sol_in: number; sol_out: number; pnl_sol: number; pnl_usd: number; reason: string; tx: string;
}

export interface State {
  mode: "paper" | "live"; status: string; startedAt: number;
  startSol: number; cashSol: number; equitySol: number; solUsd: number;
  realizedSol: number; dayStartEquitySol: number; dayKey: string;
  wins: number; losses: number; copies: number; skipped: number; signals: number;
  equity: { t: number; usd: number }[];
  markers: { t: number; usd: number; label: string; win: boolean }[];
  log: { t: number; text: string; kind: "signal" | "enter" | "fill" | "exit" | "skip" | "info" | "error" }[];
  feed: { t: number; kind: "mirror" | "exit"; leader: string; symbol: string; sol: number; pnlUsd?: number }[];
  agents: Record<AgentName, { score: number; note: string }>;
  consensus: { symbol: string; score: number; decision: string } | null;
  positions: Position[];
  leaderStats: Record<string, { wins: number; losses: number }>;
  halted: boolean;
}

const DATA = "data/state.json";
const today = () => new Date().toISOString().slice(0, 10);

export class Engine {
  s: State;
  private recentBuys = new Map<string, Map<string, number>>(); // mint → leader → ts
  private busy = new Set<string>();
  private scanCooldown = new Map<string, number>(); // mint → last scanner entry ts
  private scanEntries: number[] = [];
  private scanSkipped = new Map<string, number>();  // mint → when the scanner last skipped it               // timestamps of scanner entries (rate limit)
  onChange: () => void = () => {};
  onClosed: (t: ClosedTrade) => void = () => {};

  private kp: Keypair | null;
  private leaders: Leader[];
  constructor(kp: Keypair | null, leaders: Leader[]) {
    this.kp = kp;
    this.leaders = leaders;
    const fresh: State = {
      mode: config.mode, status: "starting", startedAt: Date.now(),
      startSol: config.paperStartSol, cashSol: config.paperStartSol, equitySol: config.paperStartSol, solUsd: 0,
      realizedSol: 0, dayStartEquitySol: config.paperStartSol, dayKey: today(),
      wins: 0, losses: 0, copies: 0, skipped: 0, signals: 0,
      equity: [], markers: [], log: [], feed: [],
      agents: Object.fromEntries((["SCAN", "WHALE", "NARRATIVE", "SNIPER", "RISK", "EXIT"] as AgentName[]).map((a) => [a, { score: 0, note: "idle" }])) as State["agents"],
      consensus: null, positions: [], leaderStats: {}, halted: false,
    };
    this.s = fresh;
    if (existsSync(DATA)) {
      try {
        const saved = JSON.parse(readFileSync(DATA, "utf8")) as State;
        if (saved.mode === config.mode) this.s = { ...fresh, ...saved, status: "resumed" };
      } catch { /* corrupt → start fresh */ }
    }
  }

  // ---------- helpers ----------
  private log(kind: State["log"][number]["kind"], text: string) {
    this.s.log.push({ t: Date.now(), kind, text });
    if (this.s.log.length > 400) this.s.log.splice(0, this.s.log.length - 400);
    console.log(new Date().toISOString().slice(11, 19), kind.padEnd(6), text);
    this.onChange();
  }
  private persist() {
    mkdirSync("data", { recursive: true });
    writeFileSync(DATA, JSON.stringify(this.s));
  }
  private usd(sol: number) { return sol * (this.s.solUsd || 0); }

  async refreshSolUsd() {
    try { this.s.solUsd = Number(await quoteOut(SOL_MINT, USDC_MINT, BigInt(LAMPORTS))) / 1e6; } catch {}
  }

  async init() {
    await this.refreshSolUsd();
    if (config.mode === "live") {
      if (!this.kp) throw new Error("live mode needs WALLET_SECRET_KEY");
      const lamports = (await rpc<{ value: number }>(config.rpcUrl, "getBalance", [this.kp.publicKey])).value;
      this.s.cashSol = lamports / LAMPORTS;
      if (!this.s.equity.length) { this.s.startSol = this.s.cashSol; this.s.dayStartEquitySol = this.s.cashSol; }
      this.log("info", `live wallet ${this.kp.publicKey.slice(0, 6)}… balance ${this.s.cashSol.toFixed(3)} SOL`);
    } else {
      this.log("info", `paper mode · virtual ${this.s.cashSol.toFixed(3)} SOL · real quotes, no transactions`);
    }
    this.s.status = "live";
    this.markEquity();
  }

  private markEquity() {
    const unreal = this.s.positions.reduce((sum, p) => sum + p.lastValueSol, 0);
    this.s.equitySol = this.s.cashSol + unreal;
    if (this.s.dayKey !== today()) { this.s.dayKey = today(); this.s.dayStartEquitySol = this.s.equitySol; }
    this.s.equity.push({ t: Date.now(), usd: this.usd(this.s.equitySol) });
    if (this.s.equity.length > 3000) this.s.equity.splice(0, this.s.equity.length - 3000);
    this.persist();
    this.onChange();
  }

  // ---------- signals ----------
  async onLeaderTrade(t: LeaderTrade) {
    this.s.signals++;
    if (t.side === "SELL") return this.onLeaderSell(t);

    const leaderMap = this.recentBuys.get(t.mint) ?? new Map<string, number>();
    leaderMap.set(t.leader.address, Date.now());
    for (const [k, ts] of leaderMap) if (Date.now() - ts > 30 * 60_000) leaderMap.delete(k);
    this.recentBuys.set(t.mint, leaderMap);

    if (this.busy.has(t.mint)) return;
    this.busy.add(t.mint);
    try {
      const [token, rug, chain] = await Promise.all([
        dexInfo(t.mint).catch(() => null), rugcheck(t.mint), onchainChecks(t.mint).catch(() => null),
      ]);
      const sym = "$" + (token?.symbol ?? t.mint.slice(0, 5)).toUpperCase();
      const size = this.sizeSol();
      let drift: number | null = null;
      let quotedTokens = 0n;
      if (size > 0 && t.tokenDeltaRaw > 0n) {
        try {
          quotedTokens = await quoteOut(SOL_MINT, t.mint, BigInt(Math.floor(size * LAMPORTS)));
          const leaderPx = t.solAmount / Number(t.tokenDeltaRaw);
          const ourPx = size / Number(quotedTokens);
          drift = ourPx / leaderPx - 1;
        } catch { drift = null; }
      }
      const dailyPnlPct = this.s.dayStartEquitySol > 0 ? this.s.equitySol / this.s.dayStartEquitySol - 1 : 0;
      const { score, votes, vetoed } = await consensus({
        trade: t, token, rug, chain, entryDriftPct: drift,
        leaderStats: this.s.leaderStats[t.leader.address] ?? { wins: 0, losses: 0 },
        confluence: leaderMap.size - 1,
        openPositions: this.s.positions.length,
        alreadyHolding: this.s.positions.some((p) => p.mint === t.mint),
        dailyPnlPct,
      });
      for (const v of votes) this.s.agents[v.agent] = { score: v.score, note: v.note };
      this.log("signal", `bot.signal("${sym}")  score=${score.toFixed(2)}  agents=${votes.filter((v) => v.score >= 0.5).length}/6  ← ${t.leader.label}`);

      const halted = this.s.halted || existsSync("STOP");
      if (halted || vetoed || score < config.consensusThreshold || size <= 0) {
        this.s.skipped++;
        const why = halted ? "halted (STOP file / kill)" : vetoed ? `${vetoed.agent}: ${vetoed.note}` : size <= 0 ? "no balance" : `score ${score.toFixed(2)} < ${config.consensusThreshold}`;
        this.s.consensus = { symbol: sym, score, decision: "SKIP" };
        this.log("skip", `skip ${sym}  ${why}`);
        return;
      }
      this.s.consensus = { symbol: sym, score, decision: "ENTER" };
      await this.enter(t.mint, t.leader.label, sym, size, quotedTokens);
    } finally {
      this.busy.delete(t.mint);
    }
  }

  private sizeSol() {
    const free = this.s.cashSol - config.minSolReserve;
    return Math.max(0, Math.min(free, this.s.equitySol * config.maxRiskPct, config.maxSolPerTrade));
  }

  private async enter(mint: string, label: string, sym: string, size: number, quotedTokens: bigint, exits?: Exits) {
    const lamports = BigInt(Math.floor(size * LAMPORTS));
    const ex = exits ?? this.defaultExits();
    this.log("enter", `const entry = await bot.enter({ mint:"${mint.slice(0, 4)}…${mint.slice(-4)}", size:${size.toFixed(3)} })`);
    try {
      let tokens: bigint, solIn: number, sig = "paper";
      if (config.mode === "live") {
        const r = await swap(this.kp!, SOL_MINT, mint, lamports, config.slippageBps);
        tokens = BigInt(r.outputAmountResult ?? r.quotedOut);
        solIn = Number(r.inputAmountResult ?? lamports) / LAMPORTS;
        sig = r.signature ?? "?";
      } else {
        tokens = (quotedTokens > 0n ? quotedTokens : await quoteOut(SOL_MINT, mint, lamports)) * 995n / 1000n; // assume 0.5% worse fill
        solIn = size + 0.0002; // network + priority fee estimate
      }
      this.s.cashSol -= solIn;
      const decimals = await onchainChecks(mint).then((c) => c.decimals).catch(() => undefined);
      this.s.positions.push({ mint, symbol: sym, leader: label, tokenRaw: tokens.toString(), solIn, solOut: 0, openedAt: Date.now(), peakValueSol: solIn, lastValueSol: solIn, quoteFails: 0, decimals, exits: ex });
      this.s.copies++;
      this.s.feed.unshift({ t: Date.now(), kind: "mirror", leader: label, symbol: sym, sol: solIn });
      this.s.feed.splice(60);
      this.log("fill", `✓ filled tx ${sig.slice(0, 5)}…  sl -${(ex.sl * 100).toFixed(0)}%  tp +${(ex.tp * 100).toFixed(0)}%  max ${ex.holdMin}m`);
      this.markEquity();
    } catch (e: any) {
      this.s.skipped++;
      this.log("error", `entry ${sym} failed: ${e.message}`);
    }
  }

  private defaultExits(): Exits {
    return { tp: config.takeProfitPct, sl: config.stopLossPct, arm: config.trailingArmPct, drop: config.trailingDropPct, holdMin: config.maxHoldMin };
  }

  // ---------- scanner signals (no wallet: the coin itself is moving) ----------
  async onScanHit(hit: ScanHit) {
    const { token, momentum } = hit;
    const mint = token.mint;
    const now = Date.now();
    if (this.busy.has(mint) || this.s.positions.some((p) => p.mint === mint)) return;
    if (now - (this.scanCooldown.get(mint) ?? 0) < config.scanCooldownMin * 60_000) return;
    if (now - (this.scanSkipped.get(mint) ?? 0) < 10 * 60_000) return; // skipped recently → don't re-check every tick
    this.s.signals++;
    this.scanEntries = this.scanEntries.filter((t) => now - t < 3600_000);
    const sym = "$" + token.symbol.toUpperCase();
    if (this.scanEntries.length >= config.scanMaxEntriesPerHour) return;
    this.busy.add(mint);
    try {
      const [rug, chain] = await Promise.all([rugcheck(mint), onchainChecks(mint).catch(() => null)]);
      const size = this.sizeSol();
      let quotedTokens = 0n;
      if (size > 0) { try { quotedTokens = await quoteOut(SOL_MINT, mint, BigInt(Math.floor(size * LAMPORTS))); } catch {} }
      const dailyPnlPct = this.s.dayStartEquitySol > 0 ? this.s.equitySol / this.s.dayStartEquitySol - 1 : 0;
      const pseudo: LeaderTrade = { side: "BUY", leader: { address: "scanner", label: "scanner" }, mint, signature: "scan", solAmount: 0, tokenDeltaRaw: 0n, tokenPreRaw: 0n, decimals: 0, soldFraction: 0, blockTime: 0 };
      const { score, votes, vetoed } = await consensus({
        trade: pseudo, token, rug, chain, entryDriftPct: 0, momentum,
        leaderStats: { wins: 0, losses: 0 }, confluence: 0,
        openPositions: this.s.positions.length, alreadyHolding: false, dailyPnlPct,
      });
      for (const v of votes) this.s.agents[v.agent] = { score: v.score, note: v.note };
      this.log("signal", `scan.signal("${sym}")  score=${score.toFixed(2)}  ${momentum.note}`);
      const halted = this.s.halted || existsSync("STOP");
      if (halted || vetoed || score < config.consensusThreshold || size <= 0 || quotedTokens <= 0n) {
        this.s.skipped++;
        const why = halted ? "halted (STOP file / kill)" : vetoed ? `${vetoed.agent}: ${vetoed.note}` : size <= 0 ? "no balance" : quotedTokens <= 0n ? "no swap route" : `score ${score.toFixed(2)} < ${config.consensusThreshold}`;
        this.s.consensus = { symbol: sym, score, decision: "SKIP" };
        this.scanSkipped.set(mint, now);
        this.log("skip", `skip ${sym}  ${why}`);
        return;
      }
      this.s.consensus = { symbol: sym, score, decision: "ENTER" };
      this.scanCooldown.set(mint, now);
      this.scanEntries.push(now);
      await this.enter(mint, "scanner", sym, size, quotedTokens, {
        tp: config.scanTakeProfitPct, sl: config.scanStopLossPct, arm: config.scanTrailingArmPct, drop: config.scanTrailingDropPct, holdMin: config.scanMaxHoldMin,
      });
    } finally {
      this.busy.delete(mint);
    }
  }

  private async onLeaderSell(t: LeaderTrade) {
    if (!config.followLeaderExit) return;
    const p = this.s.positions.find((x) => x.mint === t.mint && x.leader === t.leader.label);
    if (!p) return;
    const frac = t.soldFraction >= 0.5 ? 1 : Math.max(0.25, t.soldFraction);
    this.log("exit", `${t.leader.label} sold ${(t.soldFraction * 100).toFixed(0)}% of ${p.symbol} → follow out ${(frac * 100).toFixed(0)}%`);
    await this.sell(p, frac, "follow-out");
  }

  // ---------- position management ----------
  /** USD price per whole token for up to 30 coins in ONE DexScreener call (doesn't touch the Jupiter quota). */
  private async dexPrices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!mints.length) return out;
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(0, 30).join(",")}`, { signal: AbortSignal.timeout(6000) });
      const list: any[] = r.ok ? await r.json() : [];
      const liq = new Map<string, number>();
      for (const p of Array.isArray(list) ? list : []) {
        const m = p.baseToken?.address, usd = Number(p.priceUsd), l = Number(p.liquidity?.usd ?? 0);
        if (!m || !(usd > 0) || l < (liq.get(m) ?? -1)) continue;
        liq.set(m, l); out.set(m, usd);
      }
    } catch { /* fall back to Jupiter */ }
    return out;
  }

  async monitor() {
    const open = this.s.positions.filter((p) => !this.busy.has(p.mint));
    const prices = this.s.solUsd > 0 ? await this.dexPrices(open.map((p) => p.mint)) : new Map<string, number>();
    for (const p of [...this.s.positions]) {
      if (this.busy.has(p.mint)) continue;
      try {
        const usd = prices.get(p.mint);
        if (usd && p.decimals !== undefined) {
          // mid-price value minus ~1% for slippage/fees, so TP/SL aren't triggered optimistically
          p.lastValueSol = (Number(BigInt(p.tokenRaw)) / 10 ** p.decimals) * usd / this.s.solUsd * 0.99;
        } else {
          const out = await quoteOut(p.mint, SOL_MINT, BigInt(p.tokenRaw));
          p.lastValueSol = Number(out) / LAMPORTS;
        }
        p.quoteFails = 0;
      } catch {
        p.quoteFails++;
        if (p.quoteFails === 15) this.log("error", `${p.symbol}: no route for 15 polls — liquidity may be pulled`);
        continue;
      }
      p.peakValueSol = Math.max(p.peakValueSol, p.lastValueSol);
      const basis = p.solIn - p.solOut;
      const pnl = basis > 0 ? p.lastValueSol / basis - 1 : 0;
      const fromPeak = p.peakValueSol > 0 ? 1 - p.lastValueSol / p.peakValueSol : 0;
      const peakPnl = basis > 0 ? p.peakValueSol / basis - 1 : 0;
      const ageMin = (Date.now() - p.openedAt) / 60000;
      const ex = p.exits ?? this.defaultExits();
      let reason = "";
      if (pnl >= ex.tp) reason = "take-profit";
      else if (pnl <= -ex.sl) reason = "stop-loss";
      else if (peakPnl >= ex.arm && fromPeak >= ex.drop) reason = "trailing-stop";
      else if (ageMin >= ex.holdMin) reason = "time-exit";
      if (reason) await this.sell(p, 1, reason);
    }
    this.markEquity();
  }

  private async sell(p: Position, fraction: number, reason: string) {
    if (this.busy.has(p.mint)) return;
    this.busy.add(p.mint);
    try {
      const total = BigInt(p.tokenRaw);
      const amt = fraction >= 0.999 ? total : (total * BigInt(Math.floor(fraction * 10000))) / 10000n;
      if (amt <= 0n) return;
      let solOut: number, sig = "paper";
      if (config.mode === "live") {
        const r = await swap(this.kp!, p.mint, SOL_MINT, amt, Math.max(config.slippageBps, 300)); // wider slippage on exits
        solOut = Number(r.outputAmountResult ?? r.quotedOut) / LAMPORTS;
        sig = r.signature ?? "?";
      } else {
        solOut = (Number(await quoteOut(p.mint, SOL_MINT, amt)) / LAMPORTS) * 0.995 - 0.0002;
      }
      this.s.cashSol += solOut;
      p.solOut += solOut;
      p.tokenRaw = (total - amt).toString();
      const closed = total - amt === 0n;
      if (closed) {
        const pnlSol = p.solOut - p.solIn;
        this.s.realizedSol += pnlSol;
        const win = pnlSol > 0;
        win ? this.s.wins++ : this.s.losses++;
        const ls = (this.s.leaderStats[p.leader] ??= { wins: 0, losses: 0 });
        win ? ls.wins++ : ls.losses++;
        this.s.positions = this.s.positions.filter((x) => x !== p);
        const pnlUsd = this.usd(pnlSol);
        this.s.feed.unshift({ t: Date.now(), kind: "exit", leader: p.leader, symbol: p.symbol, sol: solOut, pnlUsd });
        this.s.feed.splice(60);
        this.markEquity();
        this.s.markers.push({ t: Date.now(), usd: this.usd(this.s.equitySol), label: `${p.symbol} ${pnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnlUsd).toFixed(0)}`, win });
        this.log("exit", `exit ${p.symbol} ${pnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnlUsd).toFixed(2)}  ${reason}  tx ${sig.slice(0, 5)}…`);
        this.onClosed({ closed_at: new Date().toISOString(), mode: config.mode, symbol: p.symbol, mint: p.mint, leader: p.leader, sol_in: p.solIn, sol_out: p.solOut, pnl_sol: pnlSol, pnl_usd: pnlUsd, reason, tx: sig });
      } else {
        p.lastValueSol = Math.max(0, p.lastValueSol - solOut);
        this.log("exit", `partial ${p.symbol} ${(fraction * 100).toFixed(0)}%  ${reason}`);
      }
    } catch (e: any) {
      this.log("error", `sell ${p.symbol} failed: ${e.message}`);
    } finally {
      this.busy.delete(p.mint);
      this.persist();
    }
  }

  /** Live mode: re-read the real SOL balance so fees/rent never make our books drift from the chain. */
  async syncBalance() {
    if (config.mode !== "live" || !this.kp || this.busy.size) return;
    try {
      const lamports = (await rpc<{ value: number }>(config.rpcUrl, "getBalance", [this.kp.publicKey])).value;
      this.s.cashSol = lamports / LAMPORTS;
    } catch {}
  }

  resume() {
    this.s.halted = false;
    this.log("info", "RESUME: new entries allowed again");
  }

  async killAll() {
    this.s.halted = true;
    this.log("info", "KILL: halting entries and closing all positions");
    for (const p of [...this.s.positions]) await this.sell(p, 1, "kill-switch");
  }

  snapshot() {
    return {
      ...this.s,
      leaders: this.leaders.length,
      config: { threshold: config.consensusThreshold, maxRiskPct: config.maxRiskPct, slippageBps: config.slippageBps, tp: config.takeProfitPct, sl: config.stopLossPct },
    };
  }
}
