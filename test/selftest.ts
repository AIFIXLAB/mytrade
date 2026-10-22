// Offline self-test: base58, key loading, tx signing, trade parsing. No network needed.
import { generateKeyPairSync, verify } from "node:crypto";
import assert from "node:assert/strict";
import { b58decode, b58encode, loadKeypair, signSerializedTx, SOL_MINT } from "../src/solana.ts";
import { parseTrade } from "../src/watcher.ts";

// base58 known vectors
assert.equal(b58encode(new Uint8Array(Buffer.from("hello world"))), "StV1DL6CwTryKyV");
assert.deepEqual(Buffer.from(b58decode("StV1DL6CwTryKyV")).toString(), "hello world");
assert.equal(b58encode(new Uint8Array([0, 0, 1])), "112");
assert.deepEqual([...b58decode("112")], [0, 0, 1]);
assert.equal(b58encode(new Uint8Array(32)), "11111111111111111111111111111111");
assert.equal(b58decode(SOL_MINT).length, 32);

// keypair: build a 64-byte Phantom-style secret from a fresh ed25519 key
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const secret58 = b58encode(new Uint8Array(Buffer.concat([seed, pub])));
const kp = loadKeypair(secret58);
assert.equal(kp.publicKey, b58encode(new Uint8Array(pub)));
assert.equal(loadKeypair(JSON.stringify([...Buffer.concat([seed, pub])])).publicKey, kp.publicKey);

// v0 tx: 2 required signers (other, us) → we must fill slot #1 only
const other = new Uint8Array(32).fill(7);
const message = Buffer.concat([
  Buffer.from([0x80, 2, 0, 1]),            // v0 prefix + header
  Buffer.from([3]), Buffer.from(other), Buffer.from(pub), Buffer.alloc(32, 9), // 3 keys
  Buffer.alloc(32, 1),                       // recent blockhash
  Buffer.from([0, 0]),                       // 0 ix, 0 lookups
]);
const unsigned = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message]).toString("base64");
const signed = Buffer.from(signSerializedTx(unsigned, kp), "base64");
const sig0 = signed.subarray(1, 65), sig1 = signed.subarray(65, 129);
assert.ok(sig0.every((b) => b === 0), "must not touch other signer slot");
assert.ok(verify(null, message, publicKey, sig1), "our signature must verify");
assert.throws(() => signSerializedTx(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from([0x80, 1, 0, 0, 1]), Buffer.from(other), Buffer.alloc(34)]).toString("base64"), kp));

// parseTrade: leader spends 1.5 SOL, receives 1,000,000 tokens
const leader = { address: "LeaderAddr111", label: "leo" };
const MEME = "MemeMint1111";
const tok = (mint: string, owner: string, amount: string) => ({ accountIndex: 1, mint, owner, uiTokenAmount: { amount, decimals: 6 } });
const buyTx = {
  blockTime: 1700000000,
  transaction: { message: { accountKeys: [{ pubkey: "LeaderAddr111" }, { pubkey: "x" }] } },
  meta: { err: null, preBalances: [3_000_000_000, 0], postBalances: [1_499_000_000, 0], preTokenBalances: [], postTokenBalances: [tok(MEME, "LeaderAddr111", "1000000000000")] },
};
const b = parseTrade(buyTx, leader, "sigBuy")!;
assert.equal(b.side, "BUY"); assert.equal(b.mint, MEME); assert.ok(Math.abs(b.solAmount - 1.501) < 1e-9);

const sellTx = {
  ...buyTx,
  meta: { err: null, preBalances: [1_000_000_000, 0], postBalances: [2_000_000_000, 0], preTokenBalances: [tok(MEME, "LeaderAddr111", "1000")], postTokenBalances: [tok(MEME, "LeaderAddr111", "250")] },
};
const s = parseTrade(sellTx, leader, "sigSell")!;
assert.equal(s.side, "SELL"); assert.equal(s.soldFraction, 0.75);

// a plain token transfer in (no SOL spent) must NOT count as a buy
const airdrop = { ...buyTx, meta: { ...buyTx.meta, postBalances: [3_000_000_000 - 5000, 0] } };
assert.equal(parseTrade(airdrop, leader, "sigAir"), null);

console.log("selftest: all checks passed ✓");
