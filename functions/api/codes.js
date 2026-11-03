// Cloudflare Pages Function: /api/codes
// D1 binding name: DB (see wrangler.toml)
// Model: shared list, like daralumrah + the frozen v11 tool, but on Cloudflare.
// - Pinned codes are ALWAYS on top, OUTSIDE the list, and never duplicated in it.
// - List is newest first, 20 per page.
// - No deletion, no cap.

// CHANGE PINNED CODES HERE ONLY (and keep the same list in count.js logic —
// count.js does not hard-code them, it just counts any code).
// Defaults are Ismail's two pinned codes from his frozen tool.
const PINNED = ["NG-L4OsDf55", "NG-A5xqvFoY"];

const CODE_RE = /^NG-[A-Za-z0-9]{4,}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function ensurePinned(env) {
  const now = Date.now();
  for (const code of PINNED) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO codes(code, created_at) VALUES (?, ?)"
    )
      .bind(code, now)
      .run();
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return json({ ok: false, error: "D1 database is not bound (DB)" }, 500);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  try {
    if (url.searchParams.get("pinned") === "1") {
      await ensurePinned(env);
      const placeholders = PINNED.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT code, copies, opens, created_at FROM codes WHERE code IN (${placeholders})`
      )
        .bind(...PINNED)
        .all();
      const byCode = new Map((rows.results || []).map((r) => [r.code, r]));
      const pinned = PINNED.map(
        (code) => byCode.get(code) || { code, copies: 0, opens: 0, created_at: Date.now() }
      );
      return json({ ok: true, pinned });
    }

    const placeholders = PINNED.map(() => "?").join(",");
    if (q) {
      const rows = await env.DB.prepare(
        `SELECT code, copies, opens, created_at FROM codes
         WHERE code LIKE ? AND code NOT IN (${placeholders})
         ORDER BY created_at DESC, id DESC LIMIT 50`
      )
        .bind(`%${q}%`, ...PINNED)
        .all();
      return json({ ok: true, codes: rows.results || [], total: (rows.results || []).length, search: true });
    }

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM codes WHERE code NOT IN (${placeholders})`
    )
      .bind(...PINNED)
      .first();
    const total = totalRow ? totalRow.n : 0;

    const rows = await env.DB.prepare(
      `SELECT code, copies, opens, created_at FROM codes
       WHERE code NOT IN (${placeholders})
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    )
      .bind(...PINNED, limit, offset)
      .all();

    return json({
      ok: true,
      codes: rows.results || [],
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
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
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const code = String(body.code || "").trim();
  if (!CODE_RE.test(code)) {
    return json({ ok: false, error: "الكود لازم يبدأ بـ NG- ويكون حروف وأرقام بس" }, 400);
  }
  try {
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO codes(code, created_at) VALUES (?, ?)"
    )
      .bind(code, Date.now())
      .run();
    const added = res.meta && res.meta.changes ? res.meta.changes > 0 : false;
    return json({ ok: true, added, code });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}
