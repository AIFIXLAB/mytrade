// Pushes bot state + closed trades to Supabase and picks up commands (kill / resume) from the web dashboard.
// Uses the PostgREST HTTP API directly — no supabase-js dependency.
// The SERVICE ROLE key lives only on the machine running the bot. Never put it in the website.
import type { ClosedTrade } from "./engine.ts";

export interface SupabaseSync {
  pushState(snapshot: any): void;
  insertTrade(t: ClosedTrade): void;
  pollCommands(handler: (cmd: string) => Promise<void>): Promise<void>;
}

export function createSupabaseSync(url: string, serviceKey: string, botId = "main"): SupabaseSync {
  const base = url.replace(/\/$/, "") + "/rest/v1";
  // New-style keys (sb_secret_…) go only in the apikey header; legacy service_role JWTs also go in Authorization.
  const headers: Record<string, string> = { apikey: serviceKey, "content-type": "application/json" };
  if (!serviceKey.startsWith("sb_")) headers.authorization = `Bearer ${serviceKey}`;

  async function req(path: string, init: RequestInit & { prefer?: string } = {}) {
    const h: Record<string, string> = { ...headers };
    if (init.prefer) h.prefer = init.prefer;
    const r = await fetch(base + path, { ...init, headers: h, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`supabase ${init.method ?? "GET"} ${path.split("?")[0]} → ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  // Throttle: at most one state upsert every 3 s, always sending the newest snapshot.
  let latest: any = null, inFlight = false, lastErr = "";
  setInterval(async () => {
    if (!latest || inFlight) return;
    const snap = latest; latest = null; inFlight = true;
    try {
      await req("/bot_state?on_conflict=id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: JSON.stringify({ id: botId, snapshot: compact(snap), updated_at: new Date().toISOString() }) });
      lastErr = "";
    } catch (e: any) {
      if (e.message !== lastErr) console.error("[supabase]", (lastErr = e.message));
    } finally { inFlight = false; }
  }, 3000);

  return {
    pushState(snapshot) { latest = snapshot; },
    insertTrade(t) {
      req("/trades", { method: "POST", prefer: "return=minimal", body: JSON.stringify({ ...t, bot_id: botId }) })
        .catch((e) => console.error("[supabase] trade insert", e.message));
    },
    async pollCommands(handler) {
      const rows: any[] = (await req(`/bot_commands?bot_id=eq.${botId}&done_at=is.null&order=created_at.asc&select=id,cmd,created_at`)) ?? [];
      for (const row of rows) {
        // mark done first so a crash mid-command never re-runs it in a loop
        await req(`/bot_commands?id=eq.${row.id}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ done_at: new Date().toISOString() }) });
        const tooOld = Date.now() - Date.parse(row.created_at) > 10 * 60_000;
        if (tooOld) { console.log(`[supabase] ignoring stale command ${row.cmd} from ${row.created_at}`); continue; }
        console.log(`[supabase] command: ${row.cmd}`);
        await handler(row.cmd);
      }
    },
  };
}

/** Keep the row small: downsample the equity curve and cut long lists. */
function compact(s: any) {
  const eq: any[] = s.equity ?? [];
  const step = Math.max(1, Math.ceil(eq.length / 600));
  const equity = eq.filter((_, i) => i % step === 0 || i === eq.length - 1);
  return { ...s, equity, markers: (s.markers ?? []).slice(-40), log: (s.log ?? []).slice(-100), feed: (s.feed ?? []).slice(0, 40), leaderStats: undefined };
}
