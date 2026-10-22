// Watches leader wallets via Solana WebSocket `logsSubscribe` (works on any RPC: Helius, QuickNode, Triton…)
// and turns each confirmed transaction into a BUY/SELL signal by diffing token balances.
import { config, wsUrlFor, type Leader } from "./config.ts";
import { rpc, sleep, SOL_MINT, USDC_MINT, USDT_MINT, LAMPORTS } from "./solana.ts";

export interface LeaderTrade {
  side: "BUY" | "SELL";
  leader: Leader;
  mint: string;
  signature: string;
  solAmount: number;        // SOL spent (BUY) or received (SELL), approx
  tokenDeltaRaw: bigint;    // + on buy, − on sell
  tokenPreRaw: bigint;
  decimals: number;
  soldFraction: number;     // for SELL: portion of the leader's bag sold (0..1)
  blockTime: number;
}

const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

export class Watcher {
  private seen = new Set<string>();
  private ws?: WebSocket;
  private subs = new Map<number, Leader>();   // request id → leader (until confirmed)
  private subIds = new Map<number, Leader>(); // subscription id → leader
  private alive = false;
  onTrade: (t: LeaderTrade) => void = () => {};
  onStatus: (s: string) => void = () => {};

  private leaders: Leader[];
  constructor(leaders: Leader[]) { this.leaders = leaders; }

  start() { this.alive = true; this.connect(); }
  stop() { this.alive = false; this.ws?.close(); }

  private connect() {
    const url = wsUrlFor(config.rpcUrl);
    const ws = new WebSocket(url);
    this.ws = ws;
    let ping: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      this.onStatus(`ws connected · subscribing ${this.leaders.length} wallets`);
      this.leaders.forEach((l, i) => {
        const id = 1000 + i;
        this.subs.set(id, l);
        // one address per subscription — that's a protocol limit of logsSubscribe
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [l.address] }, { commitment: "confirmed" }] }));
      });
      ping = setInterval(() => { try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" })); } catch {} }, 30_000);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.subs.has(msg.id) && typeof msg.result === "number") {
        this.subIds.set(msg.result, this.subs.get(msg.id)!);
        return;
      }
      if (msg.method === "logsNotification") {
        const leader = this.subIds.get(msg.params.subscription);
        const v = msg.params.result.value;
        if (!leader || v.err || this.seen.has(v.signature)) return;
        this.seen.add(v.signature);
        if (this.seen.size > 50_000) this.seen.clear();
        this.handle(leader, v.signature).catch((e) => this.onStatus(`parse error ${v.signature.slice(0, 8)}: ${e.message}`));
      }
    };
    ws.onclose = () => {
      clearInterval(ping);
      this.subIds.clear();
      if (this.alive) { this.onStatus("ws closed · reconnecting in 2s"); setTimeout(() => this.connect(), 2000); }
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private async handle(leader: Leader, signature: string) {
    // The tx can take a moment to be queryable after the confirmed notification.
    let tx: any = null;
    for (let i = 0; i < 6 && !tx; i++) {
      tx = await rpc(config.rpcUrl, "getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (!tx) await sleep(300 * (i + 1));
    }
    if (!tx || tx.meta?.err) return;
    const trade = parseTrade(tx, leader, signature);
    if (trade) this.onTrade(trade);
  }
}

export function parseTrade(tx: any, leader: Leader, signature: string): LeaderTrade | null {
  const meta = tx.meta;
  const owner = leader.address;
  const deltas = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  const add = (list: any[], key: "pre" | "post") => {
    for (const b of list ?? []) {
      if (b.owner !== owner) continue;
      const d = deltas.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
      d[key] += BigInt(b.uiTokenAmount.amount);
      deltas.set(b.mint, d);
    }
  };
  add(meta.preTokenBalances, "pre");
  add(meta.postTokenBalances, "post");

  // native SOL change of the leader (+ wrapped SOL change)
  const keys: any[] = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => (typeof k === "string" ? k : k.pubkey) === owner);
  let solDelta = idx >= 0 ? (meta.postBalances[idx] - meta.preBalances[idx]) / LAMPORTS : 0;
  const wsol = deltas.get(SOL_MINT);
  if (wsol) solDelta += Number(wsol.post - wsol.pre) / LAMPORTS;

  // pick the non-quote token with the largest absolute change
  let best: { mint: string; pre: bigint; post: bigint; decimals: number } | null = null;
  for (const [mint, d] of deltas) {
    if (QUOTE_MINTS.has(mint) || d.post === d.pre) continue;
    const abs = d.post > d.pre ? d.post - d.pre : d.pre - d.post;
    const bestAbs = best ? (best.post > best.pre ? best.post - best.pre : best.pre - best.post) : -1n;
    if (abs > bestAbs) best = { mint, ...d };
  }
  if (!best) return null;
  const delta = best.post - best.pre;
  const side = delta > 0n ? "BUY" : "SELL";
  // Ignore plain transfers: a real buy spends SOL, a real sell receives SOL (or a stable).
  const stableDelta = [USDC_MINT, USDT_MINT].reduce((s, m) => { const d = deltas.get(m); return s + (d ? Number(d.post - d.pre) : 0); }, 0);
  if (side === "BUY" && solDelta >= -0.001 && stableDelta >= 0) return null;
  if (side === "SELL" && solDelta <= 0 && stableDelta <= 0) return null;

  return {
    side,
    leader,
    mint: best.mint,
    signature,
    solAmount: Math.abs(solDelta),
    tokenDeltaRaw: delta,
    tokenPreRaw: best.pre,
    decimals: best.decimals,
    soldFraction: side === "SELL" && best.pre > 0n ? Math.min(1, Number(-delta) / Number(best.pre)) : 0,
    blockTime: tx.blockTime ?? Math.floor(Date.now() / 1000),
  };
}
