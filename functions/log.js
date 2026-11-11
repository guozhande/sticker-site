/**
 * 客户端运行日志上报（Pages Functions 版）
 *
 * POST /api/log：网站（js/error-report.js）与 App（CrashLogger）的错误上报通道。
 * 用户拍板：只收 error 级（不收集 warning）；只报匿名设备号 + 页面路径 + 错误文本/堆栈，
 * 不采集任何个人信息；IP 只存哈希（与上传同盐），限流 + 追溯两用。
 *
 * 错误通道本身必须尽力而为：插入失败只记 console.error，仍返回 200 ——
 * 绝不因日志系统自身故障再给客户端添乱（否则上报失败会触发客户端再次报错）。
 *
 * 30 天清理：Pages Functions 无 cron 触发器，用概率惰性清理
 * （插入后以 LOG_CLEANUP_PROBABILITY 触发，约每 50 条上报清一次旧日志）。
 *
 * 依赖方向：log → _shared（单向，无循环依赖）。
 */

import { countRecentByIp, fail, json, sha256Hex } from "./_shared.js";

const PLATFORMS = new Set(["web", "app"]);      // platform 白名单
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;    // 与 points.js DEVICE_ID_RE 同款
const MAX_MESSAGE_LEN = 200;                    // 错误消息截断长度
const MAX_STACK_LEN = 2000;                     // 堆栈截断长度
const MAX_PAGE_LEN = 80;                        // 页面路径截断长度
const LOG_RATE_LIMIT_PER_HOUR = 30;             // 同 IP 每小时最多 30 条（计数表就是 client_logs 本身）
const LOG_CLEANUP_PROBABILITY = 0.02;           // 约每 50 条上报触发一次清理
const LOG_RETENTION_MS = 30 * 86400_000;        // 日志保留最近 30 天

/** 清洗日志文本：去控制字符、压空白、限长（message/stack/page 同款清洗，只截断长度不同）。 */
function cleanLogText(raw, maxLen) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/**
 * POST /api/log  客户端错误上报。
 *
 * 拦截顺序：platform 白名单 400 → level 缺省视为 'error'、显式非 'error' 才 400
 * （服务端硬守用户拍板：只收 error 级）→
 * message 必填 400 → device_id 头缺失/非法回退 'unknown' → 限流 429 → 插入。
 */
export async function handleLog(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走下方校验 */ }

  const platform = String(body.platform ?? "");
  if (!PLATFORMS.has(platform)) return fail("platform 仅支持 web 或 app", 400, origin);

  // 只收 error 级（用户拍板）；level 缺省视为 'error'，显式非 'error' 一律 400
  const level = String(body.level ?? "error");
  if (level !== "error") return fail("仅支持 error 级别日志", 400, origin);

  const message = cleanLogText(body.message, MAX_MESSAGE_LEN);
  if (!message) return fail("缺少 message", 400, origin);

  const stack = cleanLogText(body.stack, MAX_STACK_LEN) || null;
  const page = cleanLogText(body.page, MAX_PAGE_LEN) || null;

  const rawDeviceId = request.headers.get("X-Device-Id") ?? "";
  const deviceId = DEVICE_ID_RE.test(rawDeviceId) ? rawDeviceId : "unknown";

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + "|sticker-salt");

  if ((await countRecentByIp(env, ipHash, Date.now() - 3600_000, "client_logs")) >= LOG_RATE_LIMIT_PER_HOUR) {
    return fail("上报太频繁，请稍后再试", 429, origin);
  }

  try {
    await env.DB
      .prepare(
        "INSERT INTO client_logs (id, platform, device_id, page, level, message, stack, ip_hash, created_at) " +
          "VALUES (?, ?, ?, ?, 'error', ?, ?, ?, ?)"
      )
      .bind(crypto.randomUUID(), platform, deviceId, page, message, stack, ipHash, Date.now())
      .run();
  } catch (err) {
    console.error("写入运行日志失败：", err.message);
  }

  // 概率惰性清理 30 天旧日志（Pages Functions 无 cron；失败仅记日志，不影响上报结果）
  if (Math.random() < LOG_CLEANUP_PROBABILITY) {
    try {
      await env.DB
        .prepare("DELETE FROM client_logs WHERE created_at < ?")
        .bind(Date.now() - LOG_RETENTION_MS)
        .run();
    } catch (err) {
      console.error("清理过期日志失败：", err.message);
    }
  }

  return json({ ok: true }, { origin });
}
