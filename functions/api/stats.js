// Cloudflare Pages Function: /api/stats (v2, new in v2)
// D1 binding name: DB (kept in the live repo's wrangler.toml, NOT in this folder)
//
// GET  /api/stats
//   -> { ok, total, addedToday, online, totalViews }
//   total: codes excluding the pinned codes.
//   addedToday: codes added on the current Africa/Cairo calendar day.
//   online: fixed display value 90 (heartbeat removed, per owner decision).
//   totalViews: incremented once per page load via POST { action: "view" }.
//   All counters start from 0 on this site; old-tool counts are NOT imported.
//
// POST /api/stats  { action: "view" }
//   -> increments totalViews once. The frontend calls this once per page load,
//      never per list poll (heartbeat removed).
//
// Tables already exist from v2 (stats table); no CREATE is run per request.

const PINNED = ["NG-L4OsDf55", "NG-A5xqvFoY"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Midnight (start of day) in Africa/Cairo for the given instant, as epoch ms.
// Computed via Intl so it stays correct across any DST change.
function cairoDayStartMs(nowMs) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(nowMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  // Cairo wall-clock midnight expressed as a UTC timestamp, then shifted
  // by the actual Cairo offset on that date.
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const parts2 = {};
  for (const p of fmt.formatToParts(new Date(asUTC))) {
    if (p.type !== "literal") parts2[p.type] = Number(p.value);
  }
  const asUTC2 = Date.UTC(parts2.year, parts2.month - 1, parts2.day, parts2.hour, parts2.minute, parts2.second);
  return asUTC - (asUTC2 - asUTC);
}

async function cairoDateStr(nowMs) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(nowMs));
}
async function getStat(env, key) {
  const row = await env.DB.prepare("SELECT value FROM stats WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}
async function setStat(env, key, value) {
  await env.DB.prepare("INSERT INTO stats(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
async function initCounters(env, now) {
  // One-time initialisation only: if the counters do not exist yet, count
  // once and store them. Every later call reads the stored counters only,
  // so a page load no longer scans the whole codes table.
  let total = await getStat(env, "totalCodes");
  if (total === null) {
    const placeholders = PINNED.map(() => "?").join(",");
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM codes WHERE code NOT IN (${placeholders})`).bind(...PINNED).first();
    total = row ? row.n : 0;
    await setStat(env, "totalCodes", total);
  }
  let today = await getStat(env, "addedToday");
  const todayDate = await getStat(env, "addedTodayDate");
  const todayStr = await cairoDateStr(now);
  if (today === null || todayDate !== todayStr) {
    today = 0;
    await setStat(env, "addedToday", 0);
    await setStat(env, "addedTodayDate", todayStr);
  }
  return { total, addedToday: today };
}
async function readCountsLight(env, now) {
  const counters = await initCounters(env, now);
  const viewsRow = await env.DB.prepare("SELECT value FROM stats WHERE key = 'totalViews'").first();
  return { total: counters.total, addedToday: counters.addedToday, totalViews: viewsRow ? viewsRow.value : 0, online: 90 };
}
export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return json({ ok: false, error: "D1 database is not bound (DB)" }, 500);
  try {
    const counts = await readCountsLight(env, Date.now());
    return json({ ok: true, ...counts });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return json({ ok: false, error: "D1 database is not bound (DB)" }, 500);
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const action = body.action || body.type || "";
  try {
    const now = Date.now();
    if (action === "view") {
      await env.DB.prepare(
        "INSERT INTO stats(key, value) VALUES ('totalViews', 1) " +
        "ON CONFLICT(key) DO UPDATE SET value = value + 1"
      ).run();
        } else {
      return json({ ok: false, error: "unknown action" }, 400);
    }
    const counts = await readCountsLight(env, now);
    return json({ ok: true, ...counts });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}
