// Cloudflare Pages Function: /api/codes (v2)
// D1 binding name: DB (kept in the live repo's wrangler.toml, NOT in this folder)
// Model: shared list, like the old Apps Script tool, but on Cloudflare.
// - Pinned codes are ALWAYS on top, OUTSIDE the list, and never duplicated in it.
// - List is newest first, 20 per page.
// - Search returns up to 500 matches, newest first, pinned excluded.
// - Multi-code add: up to 1000 codes at once (see extractCodes below).
// - No deletion, no cap on codes.

const PINNED = ["NG-L4OsDf55", "NG-A5xqvFoY"];

// Single-code legacy validation (kept for backward compatibility).
const SINGLE_CODE_RE = /^NG-[A-Za-z0-9]{4,}$/;

// Multi-code extraction, matching the old tool:
// - NG- + exactly 8 alphanumeric characters, anywhere in the text,
//   including inside full Nusuk links (…?p=27&id=NG-xxxxxxxx).
// - If the input contains no NG- code at all, bare 8-character tokens
//   (letters/digits only) are accepted and prefixed with NG-.
// Returns deduped codes in paste order, capped at 1000.
function extractCodes(raw) {
  const text = String(raw || "");
  const found = [];
  const seen = new Set();
  const push = (code) => {
    if (!seen.has(code)) {
      seen.add(code);
      found.push(code);
    }
  };
  const ngMatches = text.match(/NG-[A-Za-z0-9]{8}/g) || [];
  if (ngMatches.length > 0) {
    for (const m of ngMatches) {
      // Normalise the prefix to NG-, keep the suffix exactly as typed.
      push("NG-" + m.slice(3));
    }
  } else {
    const tokens = text.split(/[\s,;،]+/);
    for (const t of tokens) {
      if (/^[A-Za-z0-9]{8}$/.test(t)) push("NG-" + t);
    }
  }
  const truncated = found.length > 1000;
  return { codes: found.slice(0, 1000), truncated };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function getPinned(env) {
  const placeholders = PINNED.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT code, copies, opens, created_at FROM codes WHERE code IN (${placeholders})`
  ).bind(...PINNED).all();
  const byCode = new Map((rows.results || []).map((r) => [r.code, r]));
  return PINNED.map((code) => byCode.get(code) || { code, copies: 0, opens: 0, created_at: Date.now() });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return json({ ok: false, error: "D1 database is not bound (DB)" }, 500);
  const url = new URL(request.url);

  try {
    if (url.searchParams.get("pinned") === "1") {
      return json({ ok: true, pinned: await getPinned(env) });
    }

    const placeholders = PINNED.map(() => "?").join(",");
    // Cursor pagination (keyset): each page reads only 20 rows via the
    // created_at/id index, never an OFFSET scan. Cursor format "created:id"
    // of the last row of the previous page; absent = first page.
    const cursorRaw = url.searchParams.get("cursor") || "";
    let cursorCreated = null, cursorId = null;
    const cm = cursorRaw.match(/^(\d+):(\d+)$/);
    if (cm) { cursorCreated = Number(cm[1]); cursorId = Number(cm[2]); }
    const limit = 20;

    let rows;
    if (cursorCreated !== null) {
      rows = await env.DB.prepare(
        `SELECT id, code, copies, opens, created_at FROM codes
         WHERE code NOT IN (${placeholders})
           AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`
      ).bind(...PINNED, cursorCreated, cursorCreated, cursorId, limit + 1).all();
    } else {
      rows = await env.DB.prepare(
        `SELECT id, code, copies, opens, created_at FROM codes
         WHERE code NOT IN (${placeholders})
         ORDER BY created_at DESC, id DESC LIMIT ?`
      ).bind(...PINNED, limit + 1).all();
    }
    const allRows = rows.results || [];
    const hasNext = allRows.length > limit;
    const codes = hasNext ? allRows.slice(0, limit) : allRows;
    const nextCursor = hasNext && codes.length
      ? codes[codes.length - 1].created_at + ":" + codes[codes.length - 1].id
      : null;

    return json({
      ok: true,
      codes,
      pinned: await getPinned(env),
      limit,
      hasNext,
      nextCursor,
    });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return json({ ok: false, error: "D1 database is not bound (DB)" }, 500);
  let body = {};
  try {
    try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_codes_created ON codes(created_at DESC, id DESC)").run(); } catch {}
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  // Backward-compatible single-code path: { code: "NG-xxxxxxxx" }.
  if (typeof body.code === "string" && body.text === undefined && !Array.isArray(body.codes)) {
    const code = body.code.trim();
    if (!SINGLE_CODE_RE.test(code)) {
      return json({ ok: false, error: "الكود لازم يبدأ بـ NG- ويكون حروف وأرقام بس" }, 400);
    }
    try {
      const res = await env.DB.prepare(
        "INSERT OR IGNORE INTO codes(code, created_at) VALUES (?, ?)"
      )
        .bind(code, Date.now())
        .run();
      const added = res.meta && res.meta.changes ? res.meta.changes > 0 : false;
      return json({ ok: true, added, code, found: 1, skipped: added ? 0 : 1 });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  }

  // Multi-code path: { text: "paste…" } or { codes: ["NG-…", …] }.
  const raw = typeof body.text === "string"
    ? body.text
    : Array.isArray(body.codes)
      ? body.codes.join("\n")
      : "";
  const { codes, truncated } = extractCodes(raw);
  if (codes.length === 0) {
    return json({
      ok: false,
      error: "لم يتم العثور على أي كود صالح. الصق كود NG- + 8 أحرف، أو أكثر من كود، كل واحد في سطر أو مفصول بمسافة أو فاصلة.",
      added: 0,
      skipped: 0,
      found: 0,
    }, 400);
  }

  try {
    // Paste order is preserved on top: the first pasted code gets the
    // newest created_at, so ORDER BY created_at DESC shows it first.
    const now = Date.now();
    let added = 0;
    for (let i = 0; i < codes.length; i += 100) {
      const chunk = codes.slice(i, i + 100);
      const stmts = chunk.map((code, j) =>
        env.DB.prepare("INSERT OR IGNORE INTO codes(code, created_at) VALUES (?, ?)")
          .bind(code, now - (i + j))
      );
      const results = await env.DB.batch(stmts);
      for (const r of results) {
        if (r && r.meta && r.meta.changes) added += r.meta.changes;
      }
    }
    const skipped = codes.length - added;
    if (added > 0) {
      try {
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)").run();
        await env.DB.prepare("INSERT INTO stats(key, value) VALUES ('totalCodes', ?) ON CONFLICT(key) DO UPDATE SET value = value + ?").bind(added, added).run();
        const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const dateRow = await env.DB.prepare("SELECT value FROM stats WHERE key = 'addedTodayDate'").first();
        if (!dateRow || String(dateRow.value) !== todayStr) {
          await env.DB.prepare("INSERT INTO stats(key, value) VALUES ('addedToday', ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(added, added).run();
          await env.DB.prepare("INSERT INTO stats(key, value) VALUES ('addedTodayDate', ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(todayStr, todayStr).run();
        } else {
          await env.DB.prepare("INSERT INTO stats(key, value) VALUES ('addedToday', ?) ON CONFLICT(key) DO UPDATE SET value = value + ?").bind(added, added).run();
        }
      } catch {}
    }
    return json({
      ok: true,
      added,
      skipped,
      found: codes.length,
      truncated,
      message: truncated
        ? `تمت إضافة ${added} كود، وتخطي ${skipped} مكرر، وتم أخذ أول 1000 كود فقط.`
        : `تمت إضافة ${added} كود، وتخطي ${skipped} مكرر.`,
    });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}
