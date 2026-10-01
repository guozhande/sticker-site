/**
 * 表情包上传 API
 *
 *   图片字节  →  R2   (绑定 IMAGES，桶 sticker-images)
 *   元数据    →  D1   (绑定 DB，表 uploads)
 *
 * 路由
 *   GET  /health                              健康检查
 *   POST /api/upload                          multipart/form-data: file, work, characters
 *   GET  /api/uploads?work=&limit=&offset=    上传列表（只返回 visible）
 *   GET  /img/<key>                           从 R2 取图（带长效缓存）
 *   POST /api/report                          侵权投诉 → 把该条置为 hidden
 */

// ---- 限制 ----
const MAX_BYTES = 8 * 1024 * 1024;                 // 单文件 8MB（GIF 可能较大）
const ALLOWED_MIME = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const EXT_OF = { "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_WORK_LEN = 60;
const MAX_CHAR_LEN = 40;
const MAX_CHARS = 12;                              // 非单角色时最多填 12 个
const RATE_LIMIT_PER_HOUR = 30;                    // 同一 IP 每小时最多上传次数

// ---- 允许跨域的站点 ----
const ALLOWED_ORIGINS = [
  "https://sticker-store-uzo.pages.dev",
  "https://guozhande.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, { status = 200, origin = "" } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

function fail(message, status = 400, origin = "") {
  return json({ ok: false, error: message }, { status, origin });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 清洗用户输入的标签：去空白、限长、去重、丢空值。 */
function cleanLabels(raw, maxLen) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    const s = String(item ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLen);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 同一 IP 一小时内已上传多少次。 */
async function recentCountByIp(env, ipHash, sinceMs) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM uploads WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, sinceMs)
    .first();
  return row?.n ?? 0;
}

function rowToItem(row) {
  let characters = [];
  try { characters = JSON.parse(row.characters); } catch { /* 脏数据当空数组 */ }
  return {
    id: row.id,
    url: `/img/${row.r2_key}`,
    filename: row.filename,
    work: row.work,
    characters,
    size: row.size,
    mime: row.mime,
    createdAt: row.created_at,
  };
}

// ---- 路由 ----

async function handleUpload(request, env, origin) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("缺少 file 字段", 400, origin);
  if (file.size === 0) return fail("文件为空", 400, origin);
  if (file.size > MAX_BYTES) return fail(`文件超过 ${MAX_BYTES / 1024 / 1024}MB`, 413, origin);

  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.has(mime)) return fail(`不支持的格式：${mime}`, 415, origin);

  const works = cleanLabels(form.get("work"), MAX_WORK_LEN);
  if (works.length === 0) return fail("作品名不能为空", 400, origin);
  const work = works[0];

  let rawChars = [];
  try { rawChars = JSON.parse(String(form.get("characters") ?? "[]")); } catch { rawChars = []; }
  const characters = cleanLabels(rawChars, MAX_CHAR_LEN).slice(0, MAX_CHARS);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + "|sticker-salt");

  const hourAgo = Date.now() - 3600_000;
  if ((await recentCountByIp(env, ipHash, hourAgo)) >= RATE_LIMIT_PER_HOUR) {
    return fail("上传太频繁，请稍后再试", 429, origin);
  }

  const id = crypto.randomUUID();
  const ext = EXT_OF[mime];
  const d = new Date();
  const yyyymm = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const r2Key = `uploads/${yyyymm}/${id}.${ext}`;

  await env.IMAGES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" },
  });

  await env.DB
    .prepare(
      "INSERT INTO uploads (id, r2_key, filename, mime, size, work, characters, created_at, ip_hash, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible')"
    )
    .bind(id, r2Key, file.name.slice(0, 200), mime, file.size, work, JSON.stringify(characters), Date.now(), ipHash)
    .run();

  return json({ ok: true, id, url: `/img/${r2Key}`, work, characters }, { origin });
}

async function handleList(url, env, origin) {
  const work = url.searchParams.get("work");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 60, 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const where = work ? "status = 'visible' AND work = ?" : "status = 'visible'";
  const binds = work ? [work, limit, offset] : [limit, offset];

  const { results } = await env.DB
    .prepare(`SELECT * FROM uploads WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds)
    .all();

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM uploads WHERE ${where}`)
    .bind(...(work ? [work] : []))
    .first();

  return json({ ok: true, total: totalRow?.n ?? 0, items: (results ?? []).map(rowToItem) }, { origin });
}

/**
 * 从 R2 取图。
 *
 * 先查 Cloudflare 边缘缓存 —— 命中就直接返回，**不碰 R2，不计 B 类操作**。
 * 没有缓存的话：第 1 个访客触发 1 次 B 类，之后所有访客（同一地区）都命中缓存。
 *
 * 缓存时长 7 天：上传的图内容不会变，7 天足够摊薄重复访问；
 * 同时给「侵权下架」留出最长 7 天的生效窗口（下架会同时删掉 R2 对象）。
 */
async function handleImage(request, key, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/img/${encodeURIComponent(key)}`, request.url).toString(), {
    method: "GET",
  });

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  const res = new Response(obj.body, { headers });

  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/**
 * 侵权投诉：置为 hidden，并**删掉 R2 里的图片本体**。
 *
 * 两步都要做：只改数据库的话，图片字节还在 R2、边缘缓存里也可能还有副本，
 * 靠 URL 直接访问依然能看到。
 */
async function handleReport(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* 忽略 */ }
  const id = String(body.id ?? "").trim();
  if (!id) return fail("缺少 id", 400, origin);

  const row = await env.DB
    .prepare("SELECT r2_key FROM uploads WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("找不到该条目", 404, origin);

  await env.DB.prepare("UPDATE uploads SET status = 'hidden' WHERE id = ?").bind(id).run();
  await env.IMAGES.delete(row.r2_key);

  return json({ ok: true, id, status: "hidden" }, { origin });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, service: "sticker-api", time: Date.now() }, { origin });
      }
      if (url.pathname === "/api/upload" && request.method === "POST") {
        return await handleUpload(request, env, origin);
      }
      if (url.pathname === "/api/uploads" && request.method === "GET") {
        return await handleList(url, env, origin);
      }
      if (url.pathname === "/api/report" && request.method === "POST") {
        return await handleReport(request, env, origin);
      }
      if (url.pathname.startsWith("/img/") && request.method === "GET") {
        return await handleImage(request, decodeURIComponent(url.pathname.slice("/img/".length)), env, ctx);
      }
      return fail("Not Found", 404, origin);
    } catch (err) {
      return fail(`服务端错误：${err.message}`, 500, origin);
    }
  },
};
