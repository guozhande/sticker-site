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
/**
 * 按**文件头**判断真实格式，不信任客户端声明的 MIME。
 *
 * 只认这四种：GIF 动图 / JPEG / PNG / WebP。
 * 不做这一步的话，.exe 改名成 .gif 再声明 image/gif 就能传上来。
 *
 * 返回真实的 MIME；不是这四种就返回 null。
 */
async function detectImageType(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const at = (text, offset) => [...text].every((ch, i) => head[offset + i] === ch.charCodeAt(0));

  if (at("GIF87a", 0) || at("GIF89a", 0)) return "image/gif";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x89 && at("PNG", 1) && head[4] === 0x0d) return "image/png";
  if (at("RIFF", 0) && at("WEBP", 8)) return "image/webp";
  return null;
}
const EXT_OF = { "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_WORK_LEN = 60;
const MAX_CHAR_LEN = 40;
const MAX_CHARS = 12;
const RATE_LIMIT_PER_HOUR = 30;                    // 同一 IP 每小时最多 30 次
const IMG_CACHE_SECONDS = 604800;                  // 边缘缓存 7 天（同时也给下架留出生效窗口）

// ---- AI 生成（豆包 Seedream 文生图）----
const AI_RATE_LIMIT_PER_HOUR = 20;                 // 同一 IP 每小时最多 AI 生成次数
const AI_PROMPT_MAX = 500;                         // 提示词最大长度
const AI_SIZES = new Set(["1K", "2K"]);            // size 白名单
const AI_MODEL = "doubao-seedream-5-0-pro-260628";
const ARK_IMAGES_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const AI_FETCH_TIMEOUT_MS = 60_000;                // 生成 / 下载图 各自 60s 超时
const AI_EXT_OF = { jpeg: "jpg", png: "png" };     // output_format → 文件扩展名
const AI_MIME_OF = { jpg: "image/jpeg", png: "image/png" };

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

/**
 * 同一 IP 一小时内命中指定表的次数（限流共用）。
 *
 * `table` 只由内部调用方传固定字符串（"uploads" / "ai_requests"），不进用户输入，
 * 所以直接拼进 SQL 是安全的。
 */
async function countRecentByIp(env, ipHash, sinceMs, table) {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ip_hash = ? AND created_at > ?`)
    .bind(ipHash, sinceMs)
    .first();
  return row?.n ?? 0;
}

/** 带超时的 fetch：Seedream 生成 / 下载图都可能要等，到点 abort。 */
async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 清洗 AI 提示词：去控制字符、压空白、限长。提示词只进 JSON 请求体，不进 HTML。 */
function cleanPrompt(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, AI_PROMPT_MAX);
}

/** 解析 Seedream 返回的 "864x1152" 为 {width, height}；解析不了返回 null。 */
function parseSize(str) {
  const m = String(str ?? "").match(/^(\d+)[xX](\d+)$/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** 清洗用户输入的标签：去掉能进 HTML 的字符、限长、去重。 */
function cleanLabels(raw, maxLen) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    // 这些字符会被拼进网页的 HTML 里（卡片标签、alt、data-*），必须去掉，
    // 否则起个 `<img src=x onerror=...>` 的名字就是 XSS。
    const s = String(item ?? "")
      .replace(/[\r\n\t<>"'`\\&=]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 清洗文件名：同样的道理，它会出现在网页的 data-filename 上。 */
function cleanFilename(name) {
  return (
    String(name ?? "")
      .replace(/[\r\n\t<>"'`\\/]+/g, "_")
      .replace(/_{2,}/g, "_")
      .slice(0, 120) || "upload"
  );
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

  const mime = await detectImageType(file);
  if (!mime) {
    return fail("只支持图片和 GIF 动图（GIF / JPG / PNG / WebP）", 415, origin);
  }

  const work = cleanLabels(form.get("work"), MAX_WORK_LEN)[0];
  if (!work) return fail("作品名不能为空", 400, origin);

  let rawChars = [];
  try { rawChars = JSON.parse(String(form.get("characters") ?? "[]")); } catch { rawChars = []; }
  const characters = cleanLabels(rawChars, MAX_CHAR_LEN).slice(0, MAX_CHARS);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + "|sticker-salt");
  if ((await countRecentByIp(env, ipHash, Date.now() - 3600_000, "uploads")) >= RATE_LIMIT_PER_HOUR) {
    return fail("上传太频繁，请稍后再试", 429, origin);
  }

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
    .bind(id, r2Key, cleanFilename(file.name), mime, file.size, work, JSON.stringify(characters), Date.now(), ipHash)
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

/**
 * POST /api/ai/image  豆包 Seedream 文生图（静图）
 *
 * 服务端先调 Seedream 拿到临时 URL，再下载图片字节存 R2，返回站内 /img/ 地址。
 * 这样既绕开前端 fetch 临时 URL 的 CORS 限制，也把约 24h 失效的临时地址落成永久站内地址。
 */
export async function handleAiImage(request, env, origin) {
  const apiKey = String(env.ARK_API_KEY ?? "").trim();
  if (!apiKey) return fail("AI 生成未配置", 503, origin);

  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走下面的校验 */ }

  const prompt = cleanPrompt(body.prompt);
  if (!prompt) return fail("请输入提示词", 400, origin);

  const rawSize = String(body.size ?? "1K");
  if (!AI_SIZES.has(rawSize)) return fail("尺寸仅支持 1K 或 2K", 400, origin);

  // per-IP 限流：与上传共用「IP hash + 1 小时窗口」思路，但用独立表 ai_requests
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + "|sticker-salt");
  if ((await countRecentByIp(env, ipHash, Date.now() - 3600_000, "ai_requests")) >= AI_RATE_LIMIT_PER_HOUR) {
    return fail("AI 生成太频繁，请稍后再试", 429, origin);
  }

  // ① 调 Seedream 拿临时 URL
  let genRes;
  try {
    genRes = await fetchWithTimeout(ARK_IMAGES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        prompt,
        response_format: "url",
        size: rawSize,
        stream: false,
        watermark: false,
      }),
    }, AI_FETCH_TIMEOUT_MS);
  } catch {
    return fail("AI 生成请求失败，请稍后重试", 502, origin);
  }

  let genData = {};
  try { genData = await genRes.json(); } catch { genData = {}; }
  if (!genRes.ok) {
    const msg = String(genData?.error?.message || genData?.message || `Seedream HTTP ${genRes.status}`)
      .replace(/\s+/g, " ").trim().slice(0, 160);
    return fail(`AI 生成失败：${msg}`, 502, origin);
  }

  const item = Array.isArray(genData?.data) ? genData.data[0] : null;
  const tmpUrl = item?.url;
  if (!tmpUrl) return fail("AI 生成失败：未返回图片地址", 502, origin);

  const ext = AI_EXT_OF[String(item.output_format ?? "").toLowerCase()] || "jpg";
  const mime = AI_MIME_OF[ext];

  // ② 下载图片字节（临时 URL 服务端可直连，无 CORS）
  let imgRes;
  try {
    imgRes = await fetchWithTimeout(tmpUrl, { method: "GET" }, AI_FETCH_TIMEOUT_MS);
  } catch {
    return fail("AI 图片下载失败，请稍后重试", 502, origin);
  }
  if (!imgRes.ok) return fail("AI 图片下载失败，请稍后重试", 502, origin);

  let bytes;
  try { bytes = new Uint8Array(await imgRes.arrayBuffer()); } catch { bytes = null; }
  if (!bytes || bytes.byteLength === 0) return fail("AI 图片下载失败：内容为空", 502, origin);

  // ③ 存 R2
  const id = crypto.randomUUID();
  const d = new Date();
  const yyyymm = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const r2Key = `ai/${yyyymm}/${id}.${ext}`;

  try {
    await env.IMAGES.put(r2Key, bytes, {
      httpMetadata: { contentType: mime, cacheControl: `public, max-age=${IMG_CACHE_SECONDS}, immutable` },
    });
  } catch {
    return fail("AI 图片存储失败，请稍后重试", 500, origin);
  }

  // ④ 记一次成功生成，用于限流计数（计数失败不影响已生成的结果）
  try {
    await env.DB
      .prepare("INSERT INTO ai_requests (id, ip_hash, created_at) VALUES (?, ?, ?)")
      .bind(id, ipHash, Date.now())
      .run();
  } catch (err) {
    console.error("记录 AI 生成计数失败：", err.message);
  }

  const dims = parseSize(item.size) || { width: 0, height: 0 };
  return json({ ok: true, url: `/img/${r2Key}`, width: dims.width, height: dims.height }, { origin });
}
