// Cloudflare Pages Function: /api/count
// POST { code, type: "copy" | "open" } -> increments that counter.
// This is a global counter (all visitors), like daralumrah's
// "اتنسخ / اتفتح" numbers. It does NOT mean a successful referral.

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) {
    return new Response(JSON.stringify({ ok: false, error: "D1 database is not bound (DB)" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const code = String(body.code || "").trim();
  const type = body.type === "open" ? "opens" : "copies";
  if (!/^NG-[A-Za-z0-9]{4,}$/.test(code)) {
    return new Response(JSON.stringify({ ok: false, error: "invalid code" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO codes(code, created_at) VALUES (?, ?)")
      .bind(code, Date.now())
      .run();
    await env.DB.prepare(`UPDATE codes SET ${type} = ${type} + 1 WHERE code = ?`)
      .bind(code)
      .run();
    const row = await env.DB.prepare("SELECT copies, opens FROM codes WHERE code = ?")
      .bind(code)
      .first();
    return new Response(
      JSON.stringify({ ok: true, code, copies: row ? row.copies : 0, opens: row ? row.opens : 0 }),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
