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
const AI_FETCH_TIMEOUT_MS = 180_000;              // 生成 / 下载图 各自 180s 超时（CF edge 到 ark.cn-beijing 实测慢，60s 会误杀）
const AI_EXT_OF = { jpeg: "jpg", png: "png" };     // output_format → 文件扩展名
const AI_MIME_OF = { jpg: "image/jpeg", png: "image/png" };

// ---- 可灵动图（图生视频 → GIF）----
const KLING_HOSTS = ["https://api-singapore.klingai.com", "https://api-beijing.klingai.com"];  // 与侦察脚本 kling_test.py 同序
const KLING_CREATE_PATH = "/image-to-video/kling-3.0";
const KLING_TASKS_PATH = "/tasks";
const VIDEO_DURATIONS = new Set(["3", "4", "5"]);   // 时长白名单（秒）
const VIDEO_RATE_COST = 5;                          // 动图贵：一次计 5 次额度（共享 20/h 池 → 有效上限 4 动图/时）
const AI_DAILY_RATE_LIMIT_ROWS = 40;                // 每日每 IP 上限（行数=8 动图/天；与小时池同表计数）
const KLING_CREATE_TIMEOUT_MS = 60_000;             // 单 host create 超时。create 是秒级 API 调用，收紧到 60s 把最坏双 host 压到 120s；
                                                     // §3.6 步骤 6 冒烟实测延迟后按数据回调
const KLING_POLL_INTERVAL_MS = 20_000;              // 对齐侦察脚本实测 20s 间隔
const KLING_POLL_TIMEOUT_MS = 240_000;              // 12 次轮询；可灵实测 1-3 分钟
const KLING_SINGLE_FETCH_TIMEOUT_MS = 90_000;       // 轮询单次超时。CF edge 到可灵北京实测慢（30s 会 abort 第一轮轮询），放宽到 90s
const MP4_DOWNLOAD_TIMEOUT_MS = 120_000;
const TRANSCODE_FETCH_TIMEOUT_MS = 540_000;         // = DO 单档自限 480s（45 就绪+120 cp进+90×2 ffmpeg+120 cp出+15 可见）+ 60s 余量，
                                                     // 健康慢跑不误杀；卡死 DO 终被切断
const HEARTBEAT_INTERVAL_MS = 10_000;               // 心跳间隔：< iOS WKWebView ~60s no-data 杀阈值，留足余量
// 可灵 CDN 无 UA 偶发 403（本机实测带 Chrome UA 即 200；昨晚 403 是签名传播延迟的临时现象）
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

  // ①-③ 调 Seedream 生成 + 下载 + 存 R2（抽出公共函数；按标签还原原文案，零回归）
  let frame;
  try {
    frame = await generateSeedreamFrame(prompt, rawSize, env);
  } catch (err) {
    if (!(err instanceof FrameError)) throw err;   // 非首帧错误（理论不发生）交路由层 500
    return fail(err.message, err.status, origin);  // 原 6 条文案/状态码逐条还原
  }

  // ④ 记一次成功生成，用于限流计数（计数失败不影响已生成的结果）
  try {
    await env.DB
      .prepare("INSERT INTO ai_requests (id, ip_hash, created_at) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID(), ipHash, Date.now())
      .run();
  } catch (err) {
    console.error("记录 AI 生成计数失败：", err.message);
  }

  return json({ ok: true, url: `/img/${frame.r2Key}`, width: frame.width, height: frame.height }, { origin });
}

/** 首帧流水线失败标签：tag 对应原 handleAiImage 的失败点，message/status 即原文案/原状态码。
 *  handleAiImage 按标签还原原文案（零回归）；handleAiVideo 按标签映射新动图文案。 */
class FrameError extends Error {
  constructor(tag, message, status) { super(message); this.tag = tag; this.status = status; }
}

/**
 * 调 Seedream 生成一张图并落 R2，供静图（handleAiImage）与动图首帧（handleAiVideo）共用。
 * 覆盖原 handleAiImage 的「生成拿临时 URL → 解析 → 下载字节 → 存 R2」整段，
 * 并把 parseSize 并入返回值。每个原失败点抛 FrameError（tag/message/status 逐字对齐原文案）。
 */
async function generateSeedreamFrame(prompt, rawSize, env) {
  const apiKey = String(env.ARK_API_KEY ?? "").trim();
  if (!apiKey) throw new FrameError("no_key", "AI 生成未配置", 503);   // 原 282-283 行行为

  // ① 调 Seedream 拿临时 URL（CF edge 到豆包北京实测间歇性网络异常：轻量重试 1 次，5s 间隔）
  let genRes;
  for (let attempt = 1; attempt <= 2 && !genRes; attempt++) {
    if (attempt > 1) await sleep(5000);
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
    } catch (err) {
      console.error(`Seedream 生成网络异常（第 ${attempt} 次）:`, truncate(err.message));
    }
  }
  if (!genRes) {
    throw new FrameError("gen_request", "AI 生成请求失败，请稍后重试", 502);   // 原 316-317
  }

  // ② 解析临时 URL / 扩展名 / MIME
  let genData = {};
  try { genData = await genRes.json(); } catch { genData = {}; }
  if (!genRes.ok) {
    const msg = String(genData?.error?.message || genData?.message || `Seedream HTTP ${genRes.status}`)
      .replace(/\s+/g, " ").trim().slice(0, 160);
    throw new FrameError("gen_failed", `AI 生成失败：${msg}`, 502);             // 原 322-325
  }

  const item = Array.isArray(genData?.data) ? genData.data[0] : null;
  const tmpUrl = item?.url;
  if (!tmpUrl) throw new FrameError("no_url", "AI 生成失败：未返回图片地址", 502);  // 原 330

  const ext = AI_EXT_OF[String(item.output_format ?? "").toLowerCase()] || "jpg";
  const mime = AI_MIME_OF[ext];

  // ③ 下载图片字节（临时 URL 服务端可直连，无 CORS）
  let imgRes;
  try {
    imgRes = await fetchWithTimeout(tmpUrl, { method: "GET" }, AI_FETCH_TIMEOUT_MS);
  } catch {
    throw new FrameError("download_failed", "AI 图片下载失败，请稍后重试", 502);   // 原 339-340
  }
  if (!imgRes.ok) throw new FrameError("download_failed", "AI 图片下载失败，请稍后重试", 502);  // 原 342

  let bytes;
  try { bytes = new Uint8Array(await imgRes.arrayBuffer()); } catch { bytes = null; }
  if (!bytes || bytes.byteLength === 0) throw new FrameError("empty_body", "AI 图片下载失败：内容为空", 502);  // 原 346

  // ④ 存 R2
  const id = crypto.randomUUID();
  const d = new Date();
  const yyyymm = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const r2Key = `ai/${yyyymm}/${id}.${ext}`;

  try {
    await env.IMAGES.put(r2Key, bytes, {
      httpMetadata: { contentType: mime, cacheControl: `public, max-age=${IMG_CACHE_SECONDS}, immutable` },
    });
  } catch {
    throw new FrameError("store_failed", "AI 图片存储失败，请稍后重试", 500);      // 原 358-359
  }

  const dims = parseSize(item.size) || { width: 0, height: 0 };   // 原 372 行逻辑移入
  return { r2Key, ext, mime, width: dims.width, height: dims.height };
}

// ---- 可灵动图（图生视频 → GIF）----

/**
 * POST /api/ai/video  可灵图生视频 → 转码 GIF（动图）
 *
 * 快失败路径（校验/限流/未配置）：普通 JSON、真实 HTTP 状态码，秒级返回。
 * 长链路：立即返回 ReadableStream（响应头先到达），每 10s 写一个 "\n" 心跳——
 * 任何到达的字节都会重置浏览器 no-data 静默超时计时器（iOS WKWebView ~60s / Chrome ~300s），
 * 最后一段才是单行 JSON 结果（长链路结果一律 HTTP 200，逻辑状态码放 payload.code）。
 */
export async function handleAiVideo(request, env, origin) {
  // ── 快失败路径：秒级返回，普通 JSON（前端 !res.ok 分支照旧处理）──
  if (!String(env.KLING_API_KEY ?? "").trim()) return fail("动图生成未配置", 503, origin);

  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走下方校验 */ }

  const prompt = cleanPrompt(body.prompt);
  if (!prompt) return fail("请输入提示词", 400, origin);

  const duration = String(body.duration ?? "5");
  if (!VIDEO_DURATIONS.has(duration)) return fail("时长仅支持 3、4、5 秒", 400, origin);

  // ── 限流：共享 ai_requests 池（小时池 + 每日池，均按行数计；动图一次计 5 行）──
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + "|sticker-salt");
  const usedHour = await countRecentByIp(env, ipHash, Date.now() - 3600_000, "ai_requests");
  if (usedHour + VIDEO_RATE_COST > AI_RATE_LIMIT_PER_HOUR) {
    return fail("动图生成太频繁，请稍后再试（每小时动图最多 4 次，失败的尝试也计入额度）", 429, origin);
  }
  const usedDay = await countRecentByIp(env, ipHash, Date.now() - 86400_000, "ai_requests");
  if (usedDay + VIDEO_RATE_COST > AI_DAILY_RATE_LIMIT_ROWS) {
    return fail("今日动图生成次数已达上限（每天最多 8 次），请明天再试", 429, origin);
  }

  // ── 长链路：先返回 ReadableStream（响应头立刻到达），start 内跑流水线 ──
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const ping = setInterval(() => {
        try { controller.enqueue(enc.encode("\n")); } catch { /* 客户端已断开 */ }
      }, HEARTBEAT_INTERVAL_MS);
      try {
        const payload = await runVideoPipeline(request, env, ipHash, prompt, duration);
        controller.enqueue(enc.encode(JSON.stringify(payload) + "\n"));
      } catch {
        // 客户端断开等意外：尽力补一个错误段（客户端多半收不到，纯兜底）
        try { controller.enqueue(enc.encode(JSON.stringify({ ok: false, error: "服务端错误", code: 500 }) + "\n")); } catch { /* 忽略 */ }
      } finally {
        clearInterval(ping);
        try { controller.close(); } catch { /* 忽略 */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",       // 流式结果绝不缓存
      ...corsHeaders(origin),            // 与 json()/fail() 同款 CORS 头
    },
  });
}

/**
 * 长链路流水线：任何一步失败返回 {ok:false, error, code}（code 记录本应使用的 HTTP 状态码）。
 * 客户端断开（request.signal abort）时抛错退出，由外层 start 的 finally 关流——下游已全部 abort，无孤儿产物。
 */
async function runVideoPipeline(request, env, ipHash, prompt, duration) {
  // ── ③ 首帧：复用 Seedream 流水线，固定 1K；按 FrameError 标签映射新文案 ──
  let frame;
  try { frame = await generateSeedreamFrame(prompt, "1K", env); }
  catch (err) {
    if (!(err instanceof FrameError)) throw err;
    const message = err.tag === "no_key" ? "动图生成未配置"
      : err.tag === "store_failed" ? "首帧图存储失败，请稍后重试"
      : "首帧图生成失败，请稍后重试";
    return { ok: false, error: message, code: err.status };
  }
  // 首帧保留 R2 不删（D9：存储便宜，未来 App 复用）

  // ── ④ data URI（唯一实测成功形态；1K 图 100-300KB + 33% 膨胀可接受）──
  let dataUri;
  try { dataUri = await toDataUri(env, frame.r2Key, frame.mime); }
  catch { return { ok: false, error: "首帧图读取失败，请稍后重试", code: 502 }; }

  // ── ⑤ 记账 5 行：在 klingCreate 之前（记账=尝试而非成功；可灵 create 即计费，
  //       实测账单 3 units≈¥3/次，与后续轮询/下载/转码成败无关。失败也扣额度）──
  try { await insertAiRequests(env, ipHash, VIDEO_RATE_COST); }
  catch (err) { console.error("记录动图计数失败：", err.message); }   // 计数失败不阻断（同 handleAiImage）

  // ── ⑥ 可灵 create：host 回退 singapore → beijing，单次不循环（D5/D15）──
  const created = await klingCreate(env.KLING_API_KEY, prompt, Number(duration), dataUri);
  if (!created.ok) return { ok: false, error: `视频生成请求失败：${created.error}`, code: 502 };

  // ── ⑦ 轮询：20s×12 ≤240s（复用 create 成功的 host；每次 sleep 前检查 request.signal，
  //       客户端断开立即退出——可灵已计费，记账已前置兜底）──
  let mp4Url;
  try { mp4Url = await klingPoll(env.KLING_API_KEY, created.taskId, created.base, request.signal); }
  catch (err) {
    if (request.signal.aborted) throw err;   // 客户端已走：上抛退出，流关闭，下游 abort
    return err.timeout
      ? { ok: false, error: "视频生成超时（约 4 分钟），任务可能仍在生成，请稍后重试", code: 504 }
      : { ok: false, error: `视频生成失败：${err.message}`, code: 502 };
  }

  // ── ⑧ 下载 MP4 落 R2（带 Chrome UA，失败重试 1 次）──
  const mp4Key = await downloadAndStoreMp4(mp4Url, env);   // 失败返回 null
  if (!mp4Key) return { ok: false, error: "视频下载失败，请稍后重试", code: 502 };

  // ── ⑨ 调转码 Worker（service binding；anySignal(540s 超时, request.signal)，
  //       Pages 放弃/客户端断开 → DO 侧 exec 被 SIGKILL、本档产物丢弃）──
  const gifKey = `${mp4Key.slice(0, -4)}.gif`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRANSCODE_FETCH_TIMEOUT_MS);
  let tRes;
  try {
    tRes = await env.TRANSCODE_WORKER.fetch(new Request("https://transcode.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Transcode-Token": String(env.TRANSCODE_TOKEN ?? "") },
      body: JSON.stringify({ mp4Key, gifKey }),
      signal: anySignal(ctrl.signal, request.signal),
    }));
  } catch {
    return { ok: false, error: "转码服务暂不可用，请稍后重试", code: 503 };   // 含 540s 超时/客户端断开
  } finally { clearTimeout(timer); }
  const tData = await tRes.json().catch(() => ({}));
  if (tRes.status === 503) return { ok: false, error: `转码服务暂不可用：${tData.error || "容器就绪超时"}`, code: 503 };   // 容器就绪超时（透传 Worker 具体原因）
  if (!tRes.ok || !tData.ok) return { ok: false, error: `GIF 转码失败：${tData.error || "未知错误"}`, code: 500 };      // exec 失败/对象未落桶

  return { ok: true, url: `/img/${gifKey}`, duration: Number(duration), degraded: tData.degraded === true };  // degraded 透传（D11）
}

/**
 * 可灵 create。返回 { taskId, base }；两 host 均失败返回 null（错误 code/message 截断 160 字进日志）。
 * body 逐字对齐 kling_test.py 唯一实测成功 payload：
 * settings.audio 是字符串 "off"（布尔 false 类型不符会全量失败）；
 * options.watermark_info.enabled=false 必须带（否则每个 GIF 烧可灵水印）。
 * 单 host 60s 超时（create 是秒级调用；双 host 最坏 120s，预算内）。
 */
async function klingCreate(apiKey, prompt, duration, firstFrame) {
  const payload = {
    contents: [
      { type: "prompt", text: prompt },
      { type: "first_frame", url: firstFrame },
    ],
    settings: { resolution: "720p", duration, audio: "off", multi_shot: false },
    options: { watermark_info: { enabled: false } },
  };
  let lastErr = "未知错误";
  // 实测 CF edge → 可灵北京间歇性 520/525/网络异常：整体重试 5 次（间隔 5s/10s/20s/30s 递增）
  const RETRY_DELAYS = [0, 5000, 10000, 20000, 30000];
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAYS[attempt - 1]);
    for (const base of KLING_HOSTS) {               // singapore → beijing（同侦察脚本）
    try {
      const res = await fetchWithTimeout(`${base}${KLING_CREATE_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, KLING_CREATE_TIMEOUT_MS);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        lastErr = `${base} HTTP ${res.status}: ${truncate(err?.message || String(err?.code || ""), 120)}`;
        console.error(`kling create 失败:`, lastErr);
        continue;                                    // 下一 host
      }
      const data = await res.json().catch(() => null);
      const id = data?.data?.id;                     // 侦察脚本：r.get("data").get("id")
      if (id) return { ok: true, taskId: id, base };
      lastErr = `${base} 无 task id: ${truncate(JSON.stringify(data), 120)}`;
      console.error(`kling create 异常:`, lastErr);
    } catch (err) {
      lastErr = `${base} 网络异常: ${truncate(err.message, 120)}`;
      console.error(`kling create 异常:`, lastErr);
    }
  }
  return { ok: false, error: lastErr };
  }
}

/**
 * 轮询可灵任务直到 succeeded（返回 MP4 地址）/ failed（抛带可灵消息的错）/ 240s 超时（抛 timeout 标记错）。
 * base 必须复用 create 成功的那台 host；响应兼容 data 为对象或数组两种形态（与侦察脚本一致）。
 * 每次循环开头检查 signal：客户端断开立即抛错退出（可灵已计费，记账已前置兜底）。
 */
async function klingPoll(apiKey, taskId, base, signal) {
  const deadline = Date.now() + KLING_POLL_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const res = await fetchWithTimeout(`${base}${KLING_TASKS_PATH}?task_ids=${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    }, KLING_SINGLE_FETCH_TIMEOUT_MS);
    const data = await res.json().catch(() => ({}));
    const task = Array.isArray(data?.data) ? data.data[0] : (data?.data ?? null);
    const status = task?.status;

    if (status === "succeeded") {
      const url = task?.outputs?.[0]?.url;
      if (!url) throw new Error("可灵未返回视频地址");
      return url;
    }
    if (status === "failed") {
      throw new Error(truncate(task?.message || task?.task_status_msg || "未知错误"));
    }
    if (Date.now() + KLING_POLL_INTERVAL_MS > deadline) {
      throw Object.assign(new Error("轮询超时"), { timeout: true });
    }
    await sleep(KLING_POLL_INTERVAL_MS);
  }
}

/** 读回 R2 首帧字节 → data URI（可灵 first_frame 唯一实测成功形态）。仅导出供单测。 */
export async function toDataUri(env, r2Key, mime) {
  const obj = await env.IMAGES.get(r2Key);
  if (!obj) throw new Error("首帧对象不存在");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** 分块 base64（100-300KB 单次 String.fromCharCode(...bytes) 会栈溢出）。仅导出供单测。 */
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 下载可灵 MP4 并落 R2（键 ai/<yyyymm>/<uuid>.mp4，immutable 缓存）。
 * 固定 Chrome UA（可灵 CDN 无 UA 偶发 403）；非 2xx / 空字节重试 1 次（2s backoff）。
 * 失败返回 null（错误记日志，由调用方映射文案）；成功返回 R2 键。首帧/MP4 均保留不删（D9）。
 */
async function downloadAndStoreMp4(mp4Url, env) {
  let bytes = null;
  for (let attempt = 1; attempt <= 2 && bytes === null; attempt++) {
    if (attempt > 1) await sleep(2000);
    try {
      const res = await fetchWithTimeout(mp4Url, {
        method: "GET",
        headers: { "User-Agent": CHROME_UA },
      }, MP4_DOWNLOAD_TIMEOUT_MS);
      if (!res.ok) {
        console.error(`MP4 下载 HTTP ${res.status}（第 ${attempt} 次）`);
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > 0) bytes = buf;
      else console.error(`MP4 下载内容为空（第 ${attempt} 次）`);
    } catch (err) {
      console.error(`MP4 下载异常（第 ${attempt} 次）：`, truncate(err.message));
    }
  }
  if (!bytes) return null;

  const d = new Date();
  const yyyymm = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const mp4Key = `ai/${yyyymm}/${crypto.randomUUID()}.mp4`;
  try {
    await env.IMAGES.put(mp4Key, bytes, {
      httpMetadata: { contentType: "video/mp4", cacheControl: "public, max-age=604800, immutable" },
    });
    return mp4Key;
  } catch (err) {
    console.error("MP4 存储失败：", err.message);
    return null;
  }
}

/** 插入 n 行限流计数（动图 5 行）。 */
async function insertAiRequests(env, ipHash, n) {
  const stmt = env.DB.prepare("INSERT INTO ai_requests (id, ip_hash, created_at) VALUES (?, ?, ?)");
  for (let i = 0; i < n; i++) {
    await stmt.bind(crypto.randomUUID(), ipHash, Date.now()).run();
  }
}

/** 组合两个 AbortSignal：任一 abort 即 abort（不依赖 AbortSignal.any 的兼容性）。 */
function anySignal(a, b) {
  if (a.aborted || b.aborted) return AbortSignal.abort();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}

/** 可测的 sleep（不用 scheduler.wait，vitest fake timers 可控）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 错误消息截断（日志/透传用；压空白保证 JSON 单行，心跳协议要求）。 */
function truncate(msg, n = 160) {
  return String(msg ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}
