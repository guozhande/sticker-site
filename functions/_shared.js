/**
 * 上传 API 的共用逻辑（Pages Functions 版）
 *
 * 为什么不独立部署 Worker：`*.workers.dev` 在国内被 DNS 污染，解析到 Twitter 的 IP，连不上。
 * 挂在 Pages 上走 `sticker-store-uzo.pages.dev` —— 同域、国内可达、跟站点一起 git push 部署。
 *
 * 文件/目录以 `_` 开头不会被 Pages 当成路由，所以这个文件可以安全放这里。
 */

import { pinyin } from "pinyin-pro";

// 积分体系（functions/points.js）。与 _shared 循环引用：双方只用函数/常量声明，
// 且全部调用发生在函数体内，Workers ESM 运行时安全（模块求值期互不触碰）。
import {
  POINTS_AI_REF_EACH,
  POINTS_AI_VIDEO,
  cleanupExpiredPending,
  computeAiCost,
  getUserId,
  isContentModerationError,
  preDeductPoints,
  refundAiSpend,
  settleAiSpend,
} from "./points.js";

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
const AI_PROMPT_MAX = 1000;                        // 提示词最大长度（用户拍板：1000 字以内）
const AI_SIZES = new Set(["1K", "2K"]);            // size 白名单
const AI_MODEL = "doubao-seedream-5-0-pro-260628";
const ARK_IMAGES_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const AI_FETCH_TIMEOUT_MS = 180_000;              // 生成 / 下载图 各自 180s 超时（CF edge 到 ark.cn-beijing 实测慢，60s 会误杀）
const AI_EXT_OF = { jpeg: "jpg", png: "png" };     // output_format → 文件扩展名
const AI_MIME_OF = { jpg: "image/jpeg", png: "image/png" };

// ---- 图生图参考图（Seedream 官方无独立图生图端点：与文生图共用 /images/generations，仅加 image 字段，无 strength 参数）----
export const REF_IMAGE_MAX_BYTES = 5 * 1024 * 1024;   // 参考图硬限 5MB（官方 ≤30MB；前端已压到长边 1024，约 ≤2MB）
export const REF_IMAGE_MAX = 10;                      // 参考图最多 10 张（Seedream image 参数接受 2–10 张数组）
const REF_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const REF_MODES = new Set(["free", "style", "keep"]);

/**
 * 图生图参考图校验（handleAiImage / handleAiVideo 共用，v3 修正 #5：原 handleAiImage 337-345 行
 * 逐字提取为单一来源，任何未来改动（加格式/改文案）只需动此处）。
 * 返回 { ok:true, image } | { ok:false, error, status }；失败时调用方直接 fail(error, status)。
 * 缺省/null → { ok:true, image:null }（文生图原路径，零回归）。
 * 字符串 → 单张图生图（原逻辑不变）；数组 → 多参考图（2–10 张，Seedream image 参数原生支持）。
 */
export function validateRefImageBody(body) {
  let image = null;
  if (body.image !== undefined && body.image !== null) {
    if (Array.isArray(body.image)) {
      if (body.image.length > REF_IMAGE_MAX) return { ok: false, error: "参考图最多 10 张", status: 400 };
      if (body.image.length < 1) return { ok: false, error: "参考图无效，请重新上传", status: 400 };
      for (const item of body.image) {
        if (typeof item !== "string" || !REF_IMAGE_RE.test(item)) {
          return { ok: false, error: "参考图无效，请重新上传", status: 400 };
        }
        const b64 = item.slice(item.indexOf(",") + 1);
        if (base64ByteLength(b64) > REF_IMAGE_MAX_BYTES) return { ok: false, error: "参考图过大（限 5MB）", status: 400 };
      }
      image = body.image;
    } else if (typeof body.image !== "string" || !REF_IMAGE_RE.test(body.image)) {
      return { ok: false, error: "参考图无效，请重新上传", status: 400 };
    } else {
      const b64 = body.image.slice(body.image.indexOf(",") + 1);
      if (base64ByteLength(b64) > REF_IMAGE_MAX_BYTES) return { ok: false, error: "参考图过大（限 5MB）", status: 400 };
      image = body.image;
    }
  }
  return { ok: true, image };
}
/** 图生图提示词前缀（拼接后统一 slice 限长，前缀置于头部，截断只损失用户描述尾部）。
 *  单测按本常量比对文案（禁止手抄），防「参考参考图」类错字回归。 */
export const REF_PROMPT_PREFIX = {
  keep: "保持参考图中主体、构图、姿势与关键细节不变，在此基础上调整：",
  style: "参考图的整体风格、配色与质感进行创作：",
};

// ---- 可灵动图（图生视频 → GIF）----
const KLING_HOSTS = ["https://api-beijing.klingai.com", "https://api-singapore.klingai.com"];  // beijing 优先：key 区域绑定北京（2026-11-14 实测 singapore 恒 401）
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
  "https://emoticon-station.com",        // 自定义域名（同源兜底）
  "https://www.emoticon-station.com",    // 自定义域名（同源兜底）
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

export function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * `headers` 可选（默认空对象，向后兼容零回归）：附加响应头排在 CORS 头之后，
 * 显式传入可覆盖默认值（如审核接口加 Cache-Control: no-store 防中间缓存）。
 */
export function json(data, { status = 200, origin = "", headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin), ...headers },
  });
}

export function fail(message, status = 400, origin = "") {
  return json({ ok: false, error: message }, { status, origin });
}

// ── Turnstile siteverify（canonical，见 developers.cloudflare.com/turnstile） ──
// 契约：success === true + action 匹配 + 前端 hostname 在 TURNSTILE_HOSTNAMES 白名单内。
// 浏览器 → 用户后端 → siteverify，绝不从前端直调。
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// 兜底白名单：若 Pages git 集成未应用 wrangler.toml [vars]，退回内置常量，保证校验可用。
const TURNSTILE_HOSTNAMES_FALLBACK =
  "emoticon-station.com,www.emoticon-station.com,data.emoticon-station.com,sticker-store-uzo.pages.dev,guozhande.github.io";

export async function verifyTurnstile(env, token, action, clientIp) {
  const expectedHostnames = new Set(
    String(env.TURNSTILE_HOSTNAMES ?? TURNSTILE_HOSTNAMES_FALLBACK)
      .split(",")
      .map((hostname) => hostname.trim())
      .filter(Boolean),
  );
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return { ok: false, reason: "token-missing" };
  }
  if (expectedHostnames.size === 0) return { ok: false, reason: "no-hostnames" };
  let result;
  try {
    const r = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: String(env.TURNSTILE_SECRET ?? ""),
        response: token,
        remoteip: clientIp,
      }),
    });
    if (!r.ok) return { ok: false, reason: `siteverify-http-${r.status}` };
    result = await r.json();
  } catch (e) {
    console.log("[turnstile] siteverify-exc", String(e && e.message).slice(0, 100));
    return { ok: false, reason: "siteverify-unreachable" };
  }
  const codes = Array.isArray(result["error-codes"]) ? result["error-codes"].join("+") : "";
  console.log(
    "[turnstile] result",
    JSON.stringify({ success: result.success, action: result.action, hostname: result.hostname, errorCodes: codes }),
  );
  if (result.success !== true) return { ok: false, reason: codes || "verify-failed" };
  if (result.action !== action) return { ok: false, reason: `action:${result.action ?? "null"}` };
  if (!expectedHostnames.has(result.hostname)) return { ok: false, reason: `hostname:${result.hostname ?? "null"}` };
  return { ok: true };
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 同一 IP 一小时内命中指定表的次数（限流共用）。
 *
 * `table` 只由内部调用方传固定字符串（"uploads" / "ai_requests" / "client_logs"），
 * 不进用户输入，所以直接拼进 SQL 是安全的。
 */
export async function countRecentByIp(env, ipHash, sinceMs, table) {
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

/** base64 串解码后的字节数（公式对合法 base64 精确；不实际解码，防超大输入白耗 Worker CPU）。 */
function base64ByteLength(b64) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
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

// ---- 搜索键（与 pixai/gen_search_keys.py 同语义，供 js/fuzzy.js 分级匹配）----
/**
 * 多音字覆盖白名单：词 -> (覆盖全拼, 覆盖首字母)。
 * 与 gen_search_keys.py 的 MULTI_PRON_OVERRIDES 逐条一致；命中时默认读音行与覆盖行都保留
 * （错读音键无害——用户按错读音拼仍能找到）。
 */
const MULTI_PRON_OVERRIDES = {
  "降魔大圣": { py: "xiangmodasheng", ini: "xmds" },
  "长离": { py: "changli", ini: "cl" },
};

/**
 * pinyin-pro 与 pypinyin 的默认读音差异补丁。
 * 固定条目键由 pypinyin 生成（长离 -> zhangli），pinyin-pro 默认给 changli；
 * 为与固定条目的键完全对齐，这里显式保留 pypinyin 的默认读音行（覆盖行由白名单追加）。
 */
const PYPINYIN_DEFAULT_OVERRIDES = { "长离": ["zhang", "li"] };

/** 是否 CJK 基本区汉字（U+4E00-U+9FFF），与 gen_search_keys.py 的 is_cjk 一致。 */
function isCjk(ch) {
  const code = ch.codePointAt(0);
  return code >= 0x4e00 && code <= 0x9fff;
}

/** 清洗：仅保留 CJK 汉字 + ASCII 字母/数字，ASCII 转小写，其余删除。 */
function cleanSearchText(raw) {
  let out = "";
  for (const ch of String(raw ?? "")) {
    if (isCjk(ch)) out += ch;
    else if (ch >= "a" && ch <= "z") out += ch;
    else if (ch >= "0" && ch <= "9") out += ch;
    else if (ch >= "A" && ch <= "Z") out += ch.toLowerCase();
  }
  return out;
}

/** 是否含至少 1 个 CJK 汉字。 */
function hasCjk(word) {
  return [...word].some(isCjk);
}

/** 按字符串整体去重，保持首现顺序（与 gen_search_keys.py 的 unique 一致）。 */
function uniqueSearchWords(words) {
  return [...new Set(words)];
}

/**
 * 全拼（无分隔）与首字母（数字原样透传）。
 * pinyin-pro 的 nonZh: 'consecutive' 把连续非汉字块当成一个整体（与 pypinyin 的
 * lazy_pinyin 行为对齐，如 '东方project' -> dong/fang/project）；数字自己成音节，
 * 首字符天然是数字本身（'崩坏3' -> beng/huai/3 -> py=benghuai3, ini=bh3）。
 */
function toPinyinParts(word) {
  const syllables = PYPINYIN_DEFAULT_OVERRIDES[word]
    ?? pinyin(word, { toneType: "none", type: "array", nonZh: "consecutive" });
  return {
    py: syllables.join(""),
    ini: syllables.map((s) => s[0]).join(""),
  };
}

/** 一组词 -> {cn, py, ini} 平行数组（cn 与 py/ini 按下标一一对应）。 */
function buildSearchGroup(words) {
  const triples = [];
  for (const word of words) {
    const { py, ini } = toPinyinParts(word);
    triples.push([word, py, ini]);
    const override = MULTI_PRON_OVERRIDES[word];
    if (override) triples.push([word, override.py, override.ini]);
  }
  const seen = new Set();
  const out = [];
  for (const triple of triples) {
    const key = triple.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(triple);
  }
  return { cn: out.map((t) => t[0]), py: out.map((t) => t[1]), ini: out.map((t) => t[2]) };
}

/**
 * 上传条目 -> search_keys。
 * cat 组 = 作品名（字段权重 3）；tag 组 = characters 中清洗后含 >=1 个汉字的词（字段权重 2）。
 * 与 gen_search_keys.py 一致：cat 优先去重（同词不再进 tag 组）；纯英文 tag 不生成键
 * （客户端走 tags 原字段的子串匹配）。两组都为空时返回 null（客户端走回退路径）。
 */
export function buildSearchKeysForUpload(work, characters) {
  const catWords = uniqueSearchWords([cleanSearchText(work)].filter(Boolean));
  const catSet = new Set(catWords);
  const tagWords = uniqueSearchWords(
    (Array.isArray(characters) ? characters : [])
      .map(cleanSearchText)
      .filter((word) => word && hasCjk(word) && !catSet.has(word))
  );
  const cat = buildSearchGroup(catWords);
  const tag = buildSearchGroup(tagWords);
  if (!cat.cn.length && !tag.cn.length) return null;
  return { cat, tag };
}

function rowToItem(row) {
  let characters = [];
  try { characters = JSON.parse(row.characters); } catch { /* 脏数据当空数组 */ }
  let searchKeys = null;
  try { searchKeys = row.search_keys ? JSON.parse(row.search_keys) : null; } catch { /* 脏数据当 null：客户端走回退搜索 */ }
  return {
    id: row.id,
    url: `/img/${row.r2_key}`,
    filename: row.filename,
    work: row.work,
    characters,
    size: row.size,
    mime: row.mime,
    createdAt: row.created_at,
    searchKeys,
  };
}

/**
 * AI 生成访问口令（积分墙上线前的过渡闸门，handleAiImage/handleAiVideo 共用）。
 * env.AI_PASS 未配置 → 全锁（503，安全默认：新部署忘配口令时 AI 默认关闭）；
 * 请求体 pass 字段与口令不匹配 → 403。口令只存环境变量，绝不写进代码。
 * 匹配成功 → free=true：冻结设计 E 后门 —— 口令通过即免积分（零积分进出、不建 pending 流水）。
 */
function checkAiPass(body, env) {
  const pass = String(env.AI_PASS ?? "").trim();
  if (!pass) return { ok: false, error: "AI 制作暂未开放", status: 503 };
  if (String(body.pass ?? "") !== pass) return { ok: false, error: "AI 制作暂未开放", status: 403 };
  return { ok: true, free: true };
}

// ---- 各接口 ----

/** POST /api/upload  multipart/form-data: file, work, characters（新上传进 pending 待审核，通过后 +5 积分） */
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
  // Turnstile 人机验证：先于限流与业务逻辑（action=upload，token 来自表单字段 cf-turnstile-response）
  const ttToken = form.get("cf-turnstile-response");
  const turnstile = await verifyTurnstile(env, ttToken, "upload", ip);
  if (!turnstile.ok) {
    return fail(`人机验证未通过（${turnstile.reason}），请刷新页面重试`, 428, origin);
  }

  const ipHash = await sha256Hex(ip + "|sticker-salt");
  if ((await countRecentByIp(env, ipHash, Date.now() - 3600_000, "uploads")) >= RATE_LIMIT_PER_HOUR) {
    return fail("上传太频繁，请稍后再试", 429, origin);
  }

  // 游客账户（限流之后、生成 r2Key 之前）：X-Device-Id 合法用之，无头 IP hash 兜底，幂等建户。
  // 上传过审后 +5 积分发到该户；存量库漏 ALTER user_id 列时此处插入会直接 SQL 报错（见 worker/schema.sql 头部迁移说明）。
  const uid = await getUserId(request, env);
  if (!uid.ok) return fail(uid.error, uid.status, origin);

  const id = crypto.randomUUID();
  const d = new Date();
  const yyyymm = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const r2Key = `uploads/${yyyymm}/${id}.${EXT_OF[mime]}`;

  // 预生成模糊搜索键（纯函数，无 IO）；异常只记日志不阻断上传（NULL 走客户端回退）
  let searchKeys = null;
  try { searchKeys = buildSearchKeysForUpload(work, characters); }
  catch (err) { console.error("生成搜索键失败：", err.message); }

  await env.IMAGES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: mime, cacheControl: `public, max-age=${IMG_CACHE_SECONDS}, immutable` },
  });

  await env.DB
    .prepare(
      "INSERT INTO uploads (id, r2_key, filename, mime, size, work, characters, search_keys, created_at, ip_hash, status, user_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)"
    )
    .bind(
      id, r2Key, cleanFilename(file.name), mime, file.size, work, JSON.stringify(characters),
      searchKeys ? JSON.stringify(searchKeys) : null,
      Date.now(), ipHash, uid.userId
    )
    .run();

  // 打标链路（阶段一）：入队 + 打标状态初始行。两者都不影响上传主流程，失败只记日志。
  try {
    await env.TAG_QUEUE.send({ uploadId: id, r2Key, mime, op: "tag" });
  } catch (e) { console.error("打标入队失败：", e.message); /* 队列故障不影响上传主流程 */ }
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO upload_tags (upload_id, tag_status) VALUES (?, 'pending')").bind(id).run();
  } catch (e) { console.error("写打标初始行失败：", e.message); }

  return json({ ok: true, id, url: `/img/${r2Key}`, work, characters, status: "pending" }, { origin });
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
  if (hit) {
    // 缓存命中也要补 CORS 头（旧缓存条目无此头；图片公开）
    const h2 = new Headers(hit.headers);
    h2.set("Access-Control-Allow-Origin", "*");
    return new Response(hit.body, { status: hit.status, headers: h2 });
  }

  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", `public, max-age=${IMG_CACHE_SECONDS}, immutable`);
  headers.set("Access-Control-Allow-Origin", "*");   // 图片公开：允许跨域 fetch（前端「保存」按钮下载用）
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
 * POST /api/ai/image  豆包 Seedream 生成（静图）
 *
 * 无 image 字段 → 文生图（原路径，零回归）。
 * 带 image 字段 → 图生图：Seedream 官方无独立端点，同一请求体加 image 参数（无 strength 参数），
 * 相似度由 ref_mode 对应的提示词前缀控制（free/style/keep）。
 * image 为数组 → 多参考图（2–10 张），语义由用户提示词描述「图一/图二」如何结合，ref_mode 恒 free。
 *
 * 服务端先调 Seedream 拿到临时 URL，再下载图片字节存 R2，返回站内 /img/ 地址。
 * 这样既绕开前端 fetch 临时 URL 的 CORS 限制，也把约 24h 失效的临时地址落成永久站内地址。
 *
 * 拦截顺序（验收口径）：口令闸门（错口令 403，未配口令 503）→ ARK_API_KEY 未配置 503 →
 * 参数校验 400 → 限流 429 → 积分预扣 402 → 生成/结算。口令先于 key 检查：
 * 未配 key 时错误口令也必须返回 403（不因服务未配置而暴露/改变拦截语义）。
 * 冻结设计 E：口令通过=免积分跳过预扣（不建 pending 流水，生成前后零积分进出）。
 */
export async function handleAiImage(request, env, origin) {
  await cleanupExpiredPending(env);   // 惰性清理：先清算悬挂超 10 分钟的 pending 预扣（AI 悬挂保护）

  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走下面的校验 */ }

  // Turnstile 人机验证：先于口令闸门与业务逻辑（action=ai-image，token 来自 JSON 字段 cf-turnstile-response）
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const turnstile = await verifyTurnstile(env, body["cf-turnstile-response"], "ai-image", ip);
  if (!turnstile.ok) {
    return fail(`人机验证未通过（${turnstile.reason}），请刷新页面重试`, 428, origin);
  }

  // 访问口令闸门：最早一步（先于 key 配置检查与 prompt/size 校验），无口令请求不进入任何业务逻辑
  const passCheck = checkAiPass(body, env);
  if (!passCheck.ok) return fail(passCheck.error, passCheck.status, origin);

  const apiKey = String(env.ARK_API_KEY ?? "").trim();
  if (!apiKey) return fail("AI 生成未配置", 503, origin);

  const prompt = cleanPrompt(body.prompt);
  if (!prompt) return fail("请输入提示词", 400, origin);

  const rawSize = String(body.size ?? "1K");
  if (!AI_SIZES.has(rawSize)) return fail("尺寸仅支持 1K 或 2K", 400, origin);

  // ---- 图生图参考图校验（prompt/size 校验之后；失败快返回，不进 Seedream）----
  // 共享函数 validateRefImageBody（与动图 handleAiVideo 同源，v3 修正 #5）；
  // 缺省/null → 文生图原路径（零回归）
  const refImage = validateRefImageBody(body);
  if (!refImage.ok) return fail(refImage.error, refImage.status, origin);
  const image = refImage.image;

  // ref_mode 守卫（R15）：无 image 时恒 'free' —— 防绕过 UI 直连 POST ref_mode=keep 却无参考图，
  // 提示词被注入「保持参考图中主体…」而 Seedream 根本没有参考图，生成语义被污染
  // 多参考图（数组）同样恒 'free'：多图语义由用户提示词描述，不叠加单图 keep/style 前缀
  const isMultiRef = Array.isArray(image);
  const refMode = (image && !isMultiRef) ? (REF_MODES.has(String(body.ref_mode ?? "")) ? String(body.ref_mode) : "free") : "free";

  // per-IP 限流：与上传共用「IP hash + 1 小时窗口」思路，但用独立表 ai_requests
  const ipHash = await sha256Hex(ip + "|sticker-salt");
  if ((await countRecentByIp(env, ipHash, Date.now() - 3600_000, "ai_requests")) >= AI_RATE_LIMIT_PER_HOUR) {
    return fail("AI 生成太频繁，请稍后再试", 429, origin);
  }

  // 图生图提示词前缀（R6/R16）：拼接后统一再限长；前缀置于头部，截断只损失用户描述尾部、指令语义保留
  const finalPrompt = ((REF_PROMPT_PREFIX[refMode] ?? "") + prompt).slice(0, AI_PROMPT_MAX);

  // ---- 积分计费与预扣（限流之后：被限流请求不扣分；口令通过=免积分跳过预扣）----
  // 计费：1K=30 / 2K=60 + 每张参考图 2（无免费张，数组按 length 计）
  let pendingLogId = null;
  if (!passCheck.free) {
    const cost = computeAiCost(rawSize, image);
    const uid = await getUserId(request, env);
    if (!uid.ok) return fail(uid.error, uid.status, origin);
    const pre = await preDeductPoints(env, uid.userId, cost);
    if (!pre.ok) return fail(pre.error, pre.status, origin);   // 402 积分不足
    pendingLogId = pre.logId;
  }

  // ①-③ 调 Seedream 生成 + 下载 + 存 R2（抽出公共函数；按标签还原原文案，零回归）
  let frame;
  try {
    frame = await generateSeedreamFrame(finalPrompt, rawSize, env, image);
  } catch (err) {
    if (!(err instanceof FrameError)) throw err;   // 非首帧错误（理论不发生）交路由层 500
    // 风控类失败不退分（文案黑名单命中 → 预扣转正式）；欠费/网络/5xx/未配置等服务端故障 → 退分。
    // 免积分（口令通过）时无预扣流水，pendingLogId 为 null，两条分支均跳过。
    if (isContentModerationError(err.message)) {
      if (pendingLogId) await settleAiSpend(env, pendingLogId).catch((e) => console.error("AI 结算失败：", e.message));
    } else {
      if (pendingLogId) await refundAiSpend(env, pendingLogId).catch((e) => console.error("AI 退分失败：", e.message));
    }
    return fail(err.message, err.status, origin);  // 原 7 条文案/状态码逐条还原（no_key/gen_request/gen_failed/no_url/download_failed/empty_body/store_failed）
  }

  // 生成成功：预扣转正式（pending → confirmed，余额不动，幂等）；结算失败由 10 分钟惰性清理兜底退分。
  // 免积分（口令通过）时无预扣流水，跳过结算。
  if (pendingLogId) await settleAiSpend(env, pendingLogId).catch((e) => console.error("AI 结算失败：", e.message));

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
 *
 * `image` 为图生图参考图 data URI；null（默认）时请求体不含 image 字段，行为与文生图完全一致。
 * 其余字段（model/prompt/response_format/stream/watermark/size）不随 image 变化。
 */
async function generateSeedreamFrame(prompt, rawSize, env, image = null) {
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
          ...(image ? { image } : {}),   // 图生图：同端点仅加 image 字段（官方无 strength 参数，传了报 UnsupportedParameter）
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
  await cleanupExpiredPending(env);   // 惰性清理：先清算悬挂超 10 分钟的 pending 预扣（AI 悬挂保护）

  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走下方校验 */ }

  // Turnstile 人机验证：先于口令闸门与业务逻辑（action=ai-video，token 来自 JSON 字段 cf-turnstile-response）
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const turnstile = await verifyTurnstile(env, body["cf-turnstile-response"], "ai-video", ip);
  if (!turnstile.ok) {
    return fail(`人机验证未通过（${turnstile.reason}），请刷新页面重试`, 428, origin);
  }

  // 访问口令闸门：与 handleAiImage 同源（checkAiPass），最早一步（先于 key 配置检查）——
  // 未配 KLING key 时错误口令也必须 403 而非 503，两端点拦截顺序统一
  const passCheck = checkAiPass(body, env);
  if (!passCheck.ok) return fail(passCheck.error, passCheck.status, origin);

  // ── 快失败路径：秒级返回，普通 JSON（前端 !res.ok 分支照旧处理）──
  if (!String(env.KLING_API_KEY ?? "").trim()) return fail("动图生成未配置", 503, origin);

  const prompt = cleanPrompt(body.prompt);
  if (!prompt) return fail("请输入提示词", 400, origin);

  const duration = String(body.duration ?? "5");
  if (!VIDEO_DURATIONS.has(duration)) return fail("时长仅支持 3、4、5 秒", 400, origin);

  // ---- 图生图首帧校验（duration 校验之后、限流之前：校验失败快返回、不计限流额度，
  //      与 handleAiImage 同规则）---- 共享函数 validateRefImageBody（单一来源，v3 修正 #5）
  const refImage = validateRefImageBody(body);
  if (!refImage.ok) return fail(refImage.error, refImage.status, origin);
  const image = refImage.image;
  if (Array.isArray(image)) return fail("动图首帧仅支持一张图片", 400, origin);   // 可灵 first_frame 只收单张 data URI

  // ── 限流：共享 ai_requests 池（小时池 + 每日池，均按行数计；动图一次计 5 行）──
  const ipHash = await sha256Hex(ip + "|sticker-salt");
  const usedHour = await countRecentByIp(env, ipHash, Date.now() - 3600_000, "ai_requests");
  if (usedHour + VIDEO_RATE_COST > AI_RATE_LIMIT_PER_HOUR) {
    return fail("动图生成太频繁，请稍后再试（每小时动图最多 4 次，失败的尝试也计入额度）", 429, origin);
  }
  const usedDay = await countRecentByIp(env, ipHash, Date.now() - 86400_000, "ai_requests");
  if (usedDay + VIDEO_RATE_COST > AI_DAILY_RATE_LIMIT_ROWS) {
    return fail("今日动图生成次数已达上限（每天最多 8 次），请明天再试", 429, origin);
  }

  // ── 积分计费与预扣（限流之后：被限流请求不扣分；402 普通 JSON 返回，不进流；
  //    口令通过=免积分跳过预扣，pendingLogId 保持 null，后续结算/退分全部空转）──
  // 动图 150 + 首帧参考图 2（首帧只许单张，数组已被拒，无免费张）
  let pendingLogId = null;
  if (!passCheck.free) {
    const cost = POINTS_AI_VIDEO + (image ? POINTS_AI_REF_EACH : 0);
    const uid = await getUserId(request, env);
    if (!uid.ok) return fail(uid.error, uid.status, origin);
    const pre = await preDeductPoints(env, uid.userId, cost);
    if (!pre.ok) return fail(pre.error, pre.status, origin);
    pendingLogId = pre.logId;
  }

  // ── 长链路：先返回 ReadableStream（响应头立刻到达），start 内跑流水线 ──
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const ping = setInterval(() => {
        try { controller.enqueue(enc.encode("\n")); } catch { /* 客户端已断开 */ }
      }, HEARTBEAT_INTERVAL_MS);
      try {
        const payload = await runVideoPipeline(request, env, ipHash, prompt, duration, image, pendingLogId);
        controller.enqueue(enc.encode(JSON.stringify(payload) + "\n"));
      } catch {
        // 客户端断开等意外：尽力退分（claim 幂等，已结算/已退回则无操作；DB 失败由 10 分钟惰性清理兜底）
        // 免积分（口令通过）时 pendingLogId 为 null，跳过。
        if (pendingLogId) await refundAiSpend(env, pendingLogId).catch((e) => console.error("动图退分失败：", e.message));
        // 尽力补一个错误段（客户端多半收不到，纯兜底）
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
 *
 * image（用户上传的动图首帧 data URI，handleAiVideo 已校验）：有值 → 原样作可灵 first_frame、
 * 跳过 Seedream 首帧；无值 → 维持 Seedream 首帧链路（回归不变）。
 * 计费口径决策（v3 修正 #8）：有 image 时虽跳过 Seedream（省一次付费调用），但动图服务成本主体
 * 是可灵调用，本版不区分 image 来源、仍记 VIDEO_RATE_COST 5 行。后续如需激励图生图，
 * 可引入 VIDEO_RATE_COST_WITH_IMAGE = 4 对 image 路径记 4 行（常量化，本版不实现）。
 *
 * pendingLogId：AI 预扣流水行 id。失败按 finish 分流（风控类不退分、服务端故障退分），
 * 成功路径显式 settle；客户端断开（signal abort）上抛，退分由 handleAiVideo 流 start 的 catch 尽力执行。
 */
async function runVideoPipeline(request, env, ipHash, prompt, duration, image = null, pendingLogId = null) {
  /**
   * 长链路收尾统一出口：按失败文案黑名单分流——风控类 → 预扣转正式不退分（confirmed）；
   * 服务端故障（503/504/500、502-非风控）→ 退分（refunded，claim 幂等防双退）。
   * 成功路径不走这里（由调用处显式 settle）。无 pendingLogId 时纯透传。
   */
  const finish = async (payload, moderationHit = isContentModerationError(payload.error)) => {
    if (!pendingLogId) return payload;
    try {
      if (moderationHit) await settleAiSpend(env, pendingLogId);
      else await refundAiSpend(env, pendingLogId);
    } catch (err) {
      console.error(moderationHit ? "动图结算失败：" : "动图退分失败：", err.message);
    }
    return payload;
  };

  // ── ③ 首帧：有 image → 原样作 first_frame（跳过 Seedream）；无 image → 复用 Seedream 流水线，
  //       固定 1K；按 FrameError 标签映射新文案 ──
  let dataUri;
  if (image) {
    dataUri = image;   // 选中的帧原样成为第一帧（前端已压缩为白底 JPEG data URI）
  } else {
    let frame;
    try { frame = await generateSeedreamFrame(prompt, "1K", env); }
    catch (err) {
      if (!(err instanceof FrameError)) throw err;
      const message = err.tag === "no_key" ? "动图生成未配置"
        : err.tag === "store_failed" ? "首帧图存储失败，请稍后重试"
        : "首帧图生成失败，请稍后重试";
      // 风控判定用 FrameError 原始文案（映射后文案已丢失细节）
      return await finish({ ok: false, error: message, code: err.status }, isContentModerationError(err.message));
    }
    // 首帧保留 R2 不删（D9：存储便宜，未来 App 复用）

    // ── ④ data URI（唯一实测成功形态；1K 图 100-300KB + 33% 膨胀可接受）──
    try { dataUri = await toDataUri(env, frame.r2Key, frame.mime); }
    catch { return await finish({ ok: false, error: "首帧图读取失败，请稍后重试", code: 502 }); }
  }

  // ── ⑤ 记账 5 行：在 klingCreate 之前（记账=尝试而非成功；可灵 create 即计费，
  //       实测账单 3 units≈¥3/次，与后续轮询/下载/转码成败无关。失败也扣额度）──
  try { await insertAiRequests(env, ipHash, VIDEO_RATE_COST); }
  catch (err) { console.error("记录动图计数失败：", err.message); }   // 计数失败不阻断（同 handleAiImage）

  // ── ⑥ 可灵 create：host 回退 singapore → beijing，单次不循环（D5/D15）──
  const created = await klingCreate(env.KLING_API_KEY, prompt, Number(duration), dataUri);
  if (!created.ok) return await finish({ ok: false, error: `视频生成请求失败：${created.error}`, code: 502 });

  // ── ⑦ 轮询：20s×12 ≤240s（复用 create 成功的 host；每次 sleep 前检查 request.signal，
  //       客户端断开立即退出——可灵已计费，记账已前置兜底）──
  let mp4Url;
  try { mp4Url = await klingPoll(env.KLING_API_KEY, created.taskId, created.base, request.signal); }
  catch (err) {
    if (request.signal.aborted) throw err;   // 客户端已走：上抛退出，流关闭，下游 abort（退分由流 start 的 catch 兜底）
    return await finish(err.timeout
      ? { ok: false, error: "视频生成超时（约 4 分钟），任务可能仍在生成，请稍后重试", code: 504 }
      : { ok: false, error: `视频生成失败：${err.message}`, code: 502 });
  }

  // ── ⑧ 下载 MP4 落 R2（带 Chrome UA，失败重试 1 次）──
  const mp4Key = await downloadAndStoreMp4(mp4Url, env);   // 失败返回 null
  if (!mp4Key) return await finish({ ok: false, error: "视频下载失败，请稍后重试", code: 502 });

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
    return await finish({ ok: false, error: "转码服务暂不可用，请稍后重试", code: 503 });   // 含 540s 超时/客户端断开
  } finally { clearTimeout(timer); }
  const tData = await tRes.json().catch(() => ({}));
  if (tRes.status === 503) return await finish({ ok: false, error: `转码服务暂不可用：${tData.error || "容器就绪超时"}`, code: 503 });   // 容器就绪超时（透传 Worker 具体原因）
  if (!tRes.ok || !tData.ok) return await finish({ ok: false, error: `GIF 转码失败：${tData.error || "未知错误"}`, code: 500 });      // exec 失败/对象未落桶

  // 成功：预扣转正式（pending → confirmed，余额不动，幂等）
  if (pendingLogId) await settleAiSpend(env, pendingLogId).catch((err) => console.error("动图结算失败：", err.message));
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
    for (const base of KLING_HOSTS) {
      // beijing 优先：本 key 区域绑定北京（singapore 恒 401 api key not found，2026-11-14 实测）
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
  }
  return { ok: false, error: lastErr };
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
