// Jupiter Swap API v2: GET /order → sign → POST /execute
// Docs: https://developers.jup.ag/docs/swap/order-and-execute
import { config } from "./config.ts";
import { signSerializedTx, type Keypair } from "./solana.ts";

const BASE = "https://api.jup.ag/swap/v2";

export interface Order {
  transaction: string | null;
  requestId: string;
  outAmount: string;
  inAmount?: string;
  router?: string;
  feeBps?: number;
  lastValidBlockHeight?: number;
  errorCode?: number | string;
  errorMessage?: string;
}

export async function getOrder(p: { inputMint: string; outputMint: string; amount: bigint | string; taker?: string; slippageBps?: number }): Promise<Order> {
  const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: String(p.amount) });
  if (p.taker) q.set("taker", p.taker);
  if (p.slippageBps) q.set("slippageBps", String(p.slippageBps));
  const res = await fetch(`${BASE}/order?${q}`, { headers: { "x-api-key": config.jupApiKey } });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`jup order HTTP ${res.status}: ${j.error ?? j.errorMessage ?? ""}`);
  return j as Order;
}

export interface ExecResult { status: string; signature?: string; code?: number; inputAmountResult?: string; outputAmountResult?: string; error?: string; }

export async function swap(kp: Keypair, inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<ExecResult & { quotedOut: string }> {
  const order = await getOrder({ inputMint, outputMint, amount, taker: kp.publicKey, slippageBps });
  if (!order.transaction) throw new Error(`no transaction: ${order.errorMessage ?? order.errorCode ?? "unknown"}`);
  const signedTransaction = signSerializedTx(order.transaction, kp);
  const body: Record<string, unknown> = { signedTransaction, requestId: order.requestId };
  if (order.lastValidBlockHeight) body.lastValidBlockHeight = order.lastValidBlockHeight;
  const res = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.jupApiKey },
    body: JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.status !== "Success") throw new Error(`jup execute failed: ${j.error ?? j.status ?? res.status} ${j.signature ?? ""}`);
  return { ...(j as ExecResult), quotedOut: order.outAmount };
}

/** Quote-only (no taker): used for paper fills, mark-to-market and SOL/USD price. */
export async function quoteOut(inputMint: string, outputMint: string, amount: bigint): Promise<bigint> {
  const o = await getOrder({ inputMint, outputMint, amount });
  return BigInt(o.outAmount || "0");
}
