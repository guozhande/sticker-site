/**
 * 上传 API 的共用逻辑（Pages Functions 版）
 *
 * 为什么不独立部署 Worker：`*.workers.dev` 在国内被 DNS 污染，解析到 Twitter 的 IP，连不上。
 * 挂在 Pages 上走 `sticker-store-uzo.pages.dev` —— 同域、国内可达、跟站点一起 git push 部署。
 *
 * 文件/目录以 `_` 开头不会被 Pages 当成路由，所以这个文件可以安全放这里。
 */

// ---- 限制 ----
export const MAX_BYTES = 8 * 1024 * 1024;          // 单文件 8MB
const ALLOWED_MIME = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const EXT_OF = { "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_WORK_LEN = 60;
const MAX_CHAR_LEN = 40;
const MAX_CHARS = 12;
const RATE_LIMIT_PER_HOUR = 30;                    // 同一 IP 每小时最多 30 次
const IMG_CACHE_SECONDS = 604800;                  // 边缘缓存 7 天（同时也给下架留出生效窗口）

const ALLOWED_ORIGINS = [
  "https://sticker-store-uzo.pages.dev",
  "https://guozhande.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

export function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(data, { status = 200, origin = "" } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

export function fail(message, status = 400, origin = "") {
  return json({ ok: false, error: message }, { status, origin });
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 清洗用户输入的标签：去空白、限长、去重。 */
function cleanLabels(raw, maxLen) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    const s = String(item ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLen);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
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

// ---- 各接口 ----

/** POST /api/upload  multipart/form-data: file, work, characters */
export async function handleUpload(request, env, origin) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("缺少 file 字段", 400, origin);
  if (file.size === 0) return fail("文件为空", 400, origin);
  if (file.size > MAX_BYTES) return fail(`文件超过 ${MAX_BYTES / 1024 / 1024}MB`, 413, origin);

  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.has(mime)) return fail(`不支持的格式：${mime}`, 415, origin);

  const work = cleanLabels(form.get("work"), MAX_WORK_LEN)[0];
  if (!work) return fail("作品名不能为空", 400, origin);

  let rawChars = [];
  try { rawChars = JSON.parse(String(form.get("characters") ?? "[]")); } catch { rawChars = []; }
  const characters = cleanLabels(rawChars, MAX_CHAR_LEN).slice(0, MAX_CHARS);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + "|sticker-salt");

  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM uploads WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, Date.now() - 3600_000)
    .first();
  if ((row?.n ?? 0) >= RATE_LIMIT_PER_HOUR) return fail("上传太频繁，请稍后再试", 429, origin);

  const id = crypto.randomUUID();
  const d = new Date();
  const yyyymm = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const r2Key = `uploads/${yyyymm}/${id}.${EXT_OF[mime]}`;

  await env.IMAGES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: mime, cacheControl: `public, max-age=${IMG_CACHE_SECONDS}, immutable` },
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

/** GET /api/uploads?work=&limit=&offset= */
export async function handleList(url, env, origin) {
  const work = url.searchParams.get("work");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 60, 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const where = work ? "status = 'visible' AND work = ?" : "status = 'visible'";
  const binds = work ? [work, limit, offset] : [limit, offset];

  const { results } = await env.DB
    .prepare(`SELECT * FROM uploads WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds)
    .all();

  const total = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM uploads WHERE ${where}`)
    .bind(...(work ? [work] : []))
    .first();

  return json({ ok: true, total: total?.n ?? 0, items: (results ?? []).map(rowToItem) }, { origin });
}

/**
 * GET /img/<key>  从 R2 取图
 *
 * 先查 Cloudflare 边缘缓存 —— 命中就直接返回，**不碰 R2，不计 B 类操作**。
 * 否则第 1 个访客触发 1 次 B 类，之后同地区的访客全部命中缓存。
 */
export async function handleImage(request, key, env, waitUntil) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/img/${encodeURIComponent(key)}`, request.url).toString(), { method: "GET" });

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", `public, max-age=${IMG_CACHE_SECONDS}, immutable`);
  const res = new Response(obj.body, { headers });

  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/** POST /api/report  侵权投诉 → 置为 hidden 并删掉 R2 里的图片本体 */
export async function handleReport(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* 忽略 */ }
  const id = String(body.id ?? "").trim();
  if (!id) return fail("缺少 id", 400, origin);

  const row = await env.DB.prepare("SELECT r2_key FROM uploads WHERE id = ?").bind(id).first();
  if (!row) return fail("找不到该条目", 404, origin);

  await env.DB.prepare("UPDATE uploads SET status = 'hidden' WHERE id = ?").bind(id).run();
  await env.IMAGES.delete(row.r2_key);

  return json({ ok: true, id, status: "hidden" }, { origin });
}
