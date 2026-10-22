// Builds web/ for Vercel: index.html (dashboard) + config.js (public Supabase URL + anon key from env).
// The anon key is meant to be public; Row Level Security in supabase/schema.sql protects the data.
// NEVER set SUPABASE_SERVICE_ROLE_KEY on Vercel.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
// Vercel env vars win; otherwise fall back to supabase/public.json (public values only).
const pub = existsSync("supabase/public.json") ? JSON.parse(readFileSync("supabase/public.json", "utf8")) : {};
const SUPABASE_URL = process.env.SUPABASE_URL || pub.url || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || pub.publishableKey || "";
const BOT_ID = process.env.BOT_ID || pub.botId || "main";
const { SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (/sb_secret_|service_role/.test(SUPABASE_ANON_KEY)) { console.error("Refusing to build: that's a SECRET key. Use the publishable key."); process.exit(1); }
if (SUPABASE_SERVICE_ROLE_KEY) { console.error("Refusing to build: remove SUPABASE_SERVICE_ROLE_KEY from the website's env vars."); process.exit(1); }
mkdirSync("web", { recursive: true });
const body = readFileSync("public/dashboard.html", "utf8");
const cfg = SUPABASE_URL && SUPABASE_ANON_KEY
  ? `window.MIRROR_SUPABASE = ${JSON.stringify({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, botId: BOT_ID })};\n`
  : "// SUPABASE_URL / SUPABASE_ANON_KEY not set → dashboard runs in demo mode\n";
writeFileSync("web/config.js", cfg);
writeFileSync("web/index.html", `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<script src="config.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/dist/umd/supabase.js"></script>
</head><body>
${body}
</body></html>
`);
console.log(`web/ built · ${cfg.startsWith("window") ? "supabase mode" : "demo mode"}`);
