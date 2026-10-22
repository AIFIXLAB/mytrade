import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { config, loadLeaders } from "./config.ts";
import { loadKeypair } from "./solana.ts";
import { Watcher } from "./watcher.ts";
import { Engine } from "./engine.ts";
import { createSupabaseSync } from "./supabase.ts";

if (!config.rpcUrl || !config.jupApiKey) { console.error("Set RPC_URL and JUP_API_KEY in .env (copy .env.example → .env)"); process.exit(1); }
const leaders = loadLeaders();
if (!leaders.length) { console.error("No leader wallets. Copy wallets.example.json → wallets.json and add addresses."); process.exit(1); }

const kp = config.secretKey ? loadKeypair(config.secretKey) : null;
if (config.mode === "live" && !kp) { console.error("MODE=live requires WALLET_SECRET_KEY"); process.exit(1); }

const engine = new Engine(kp, leaders);
const watcher = new Watcher(leaders);

// ---------- dashboard server (localhost only) ----------
const clients = new Set<import("node:http").ServerResponse>();
let pending = false;
engine.onChange = () => { pending = true; };
setInterval(() => {
  if (!pending || !clients.size) return;
  pending = false;
  const data = `data: ${JSON.stringify(engine.snapshot())}\n\n`;
  for (const c of clients) c.write(data);
}, 500);

createServer((req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.url === "/state") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(engine.snapshot())); return; }
  if (req.url === "/kill" && req.method === "POST") { engine.killAll(); res.writeHead(200); res.end("ok"); return; }
  if (req.url === "/" || req.url?.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + readFileSync("public/dashboard.html", "utf8") + "</body></html>");
    return;
  }
  res.writeHead(404); res.end();
}).listen(config.port, "127.0.0.1", () => console.log(`dashboard → http://localhost:${config.port}`));

// ---------- main loops ----------
await engine.init();
watcher.onStatus = (s) => console.log("[watch]", s);
watcher.onTrade = (t) => { engine.onLeaderTrade(t).catch((e) => console.error("trade handler", e)); };
watcher.start();

let monitoring = false;
setInterval(async () => {
  if (monitoring) return;
  monitoring = true;
  try { await engine.monitor(); } finally { monitoring = false; }
}, config.pollMs);
setInterval(() => engine.refreshSolUsd(), 60_000);

// ---------- optional: Supabase (state for the Vercel dashboard + trade history + remote kill) ----------
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const sb = createSupabaseSync(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.BOT_ID || "main");
  const prev = engine.onChange;
  engine.onChange = () => { prev(); sb.pushState(engine.snapshot()); };
  engine.onClosed = (t) => sb.insertTrade(t);
  sb.pushState(engine.snapshot());
  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      await sb.pollCommands(async (cmd) => {
        if (cmd === "kill") await engine.killAll();
        else if (cmd === "resume") engine.resume();
      });
    } catch (e: any) { console.error("[supabase] poll", e.message); } finally { polling = false; }
  }, 5000);
  console.log("supabase sync on → bot_state / trades / bot_commands");
}
setInterval(() => engine.syncBalance(), 30_000);

process.on("SIGINT", () => { console.log("\nstopping (positions stay open — run again to resume managing them)"); watcher.stop(); process.exit(0); });
