// Minimal Solana helpers with zero npm deps: base58, ed25519 keypair, tx signing, JSON-RPC.
import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) MAP[ALPHABET[i]] = i;

export function b58decode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const c of s) {
    const v = MAP[c];
    if (v === undefined) throw new Error("invalid base58 char: " + c);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c === "1") bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}

export function b58encode(buf: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of buf) { if (b === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export interface Keypair { publicKey: string; publicKeyBytes: Uint8Array; privateKey: KeyObject; }

/** Accepts a Phantom/Solflare base58 secret (64 bytes) or a JSON array (solana-keygen file format). */
export function loadKeypair(secret: string): Keypair {
  const raw = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : b58decode(secret.trim());
  if (raw.length !== 64 && raw.length !== 32) throw new Error("secret key must be 64 (or 32) bytes, got " + raw.length);
  const seed = raw.subarray(0, 32);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyBytes = new Uint8Array(spki.subarray(spki.length - 32));
  if (raw.length === 64 && Buffer.compare(Buffer.from(raw.subarray(32)), Buffer.from(publicKeyBytes)) !== 0) {
    throw new Error("secret key's public half does not match its seed — wrong key format?");
  }
  return { publicKey: b58encode(publicKeyBytes), publicKeyBytes, privateKey };
}

function readCompactU16(buf: Uint8Array, offset: number): [number, number] {
  let value = 0, size = 0;
  for (;;) {
    const b = buf[offset + size];
    value |= (b & 0x7f) << (size * 7);
    size++;
    if ((b & 0x80) === 0) break;
  }
  return [value, size];
}

/**
 * Signs a base64 serialized (legacy or v0) transaction as returned by Jupiter.
 * Only fills OUR signature slot; other slots (e.g. a JupiterZ market maker) are left untouched.
 */
export function signSerializedTx(base64Tx: string, kp: Keypair): string {
  const tx = new Uint8Array(Buffer.from(base64Tx, "base64"));
  const [sigCount, sigLen] = readCompactU16(tx, 0);
  const sigStart = sigLen;
  const msgStart = sigStart + sigCount * 64;
  const message = tx.subarray(msgStart);
  let p = 0;
  if (message[0] & 0x80) p = 1; // versioned message prefix
  const numRequiredSignatures = message[p];
  p += 3;
  const [numKeys, keysLen] = readCompactU16(message, p);
  p += keysLen;
  let idx = -1;
  for (let i = 0; i < Math.min(numKeys, numRequiredSignatures); i++) {
    const key = message.subarray(p + i * 32, p + i * 32 + 32);
    if (Buffer.compare(Buffer.from(key), Buffer.from(kp.publicKeyBytes)) === 0) { idx = i; break; }
  }
  if (idx < 0) throw new Error("our wallet is not a required signer of this transaction — refusing to sign");
  const sig = edSign(null, Buffer.from(message), kp.privateKey);
  tx.set(sig, sigStart + idx * 64);
  return Buffer.from(tx).toString("base64");
}

// ---------- JSON-RPC ----------
let rpcId = 0;
export async function rpc<T = any>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const j: any = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result as T;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const LAMPORTS = 1_000_000_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
