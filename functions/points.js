/**
 * 积分体系共用逻辑（Pages Functions 版）
 *
 * 规则：1 积分 = 1 分钱。签到 +3/天、连签每满 7 天 +30、上传过审 +5、充值 1 元 = 100 积分；
 * AI 生成扣分：静图 1K=30 / 2K=60、动图=150、每张参考图 +2（价格唯一来源，前端从 balance 接口拿，不硬编码）。
 *
 * 游客账户：id = X-Device-Id（客户端生成 UUID）；无头时 = sha256(ip|sticker-salt) 兜底。
 * 本期无真登录/真支付：设备号自报、充值模拟，仅作参赛演示（已知风险，见设计风险清单）。
 *
 * 与 _shared.js 循环引用（_shared 的 AI 生成用本文件的预扣/结算/退回；
 * 本文件的接口用 _shared 的 json/fail/sha256Hex）。Workers ESM 运行时安全：
 * 双方相互只用函数声明，且全部调用发生在函数体内，模块求值期互不触碰。
 */

import { fail, json, sha256Hex } from "./_shared.js";

// ---- 积分常量（数值全部命名；前端「AI 明码标价」也从 /api/points/balance 下发）----
export const POINTS_SIGNIN_DAILY = 3;           // 每日签到基础分
export const POINTS_SIGNIN_STREAK_BONUS = 30;   // 连签每满 7 天额外奖励
export const POINTS_SIGNIN_STREAK_DAYS = 7;     // 连签奖励周期（天）
export const POINTS_UPLOAD_REWARD = 5;          // 上传过审奖励
export const RECHARGE_MIN_CENTS = 100;          // 最低充值 1 元（API 入参单位：分，须 100 的整数倍）
export const RECHARGE_MAX_CENTS = 100000;       // 最高充值 1000 元（API 入参单位：分）
export const POINTS_AI_IMAGE_1K = 30;           // AI 静图 1K
export const POINTS_AI_IMAGE_2K = 60;           // AI 静图 2K
export const POINTS_AI_VIDEO = 150;             // AI 动图
export const POINTS_AI_REF_EACH = 2;            // AI 每张参考图
export const AI_SETTLE_TIMEOUT_MS = 600_000;    // AI 预扣悬挂保护：10 分钟未结算自动退回
export const SIGNIN_CN_TZ_OFFSET_MS = 28_800_000; // 签到日界按 UTC+8（北京时间）

const STREAK_LOOKBACK_ROWS = 21;                // 连签推算最多回看 21 行签到流水
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;    // X-Device-Id 合法格式

// ---- 基础账户 ----

/** 幂等建户：已存在则不动（INSERT ... ON CONFLICT(id) DO NOTHING）。 */
export async function ensureUser(env, id) {
  await env.DB
    .prepare("INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(id, Date.now())
    .run();
}

/**
 * 取游客账户 id（各积分/AI/上传接口的统一入口）：
 * X-Device-Id 合法（8–64 位 [A-Za-z0-9-]）→ 用之；无头 → sha256(ip|sticker-salt) 兜底
 * （同 NAT/公司网多设备共享一个账户，冻结设计的已知取舍）；格式非法 → 400。
 * 取到后 ensureUser 幂等建户。返回 { ok:true, userId } | { ok:false, error, status }。
 */
export async function getUserId(request, env) {
  const deviceId = String(request.headers.get("X-Device-Id") ?? "").trim();
  let userId;
  if (deviceId) {
    if (!DEVICE_ID_RE.test(deviceId)) return { ok: false, error: "设备号格式非法", status: 400 };
    userId = deviceId;
  } else {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    userId = await sha256Hex(ip + "|sticker-salt");
  }
  await ensureUser(env, userId);
  return { ok: true, userId };
}

// ---- 签到 ----

/** 毫秒时间戳 → UTC+8 日历日键（如 "2026-11-10"）。签到日界的唯一换算点，禁止散落魔法数。 */
function dayKeyOf(ts) {
  return new Date(ts + SIGNIN_CN_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 日历日键的前一天（按 UTC 解析，无时区歧义）。 */
function previousDayKey(dayKey) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 连签天数：今天算第 n 天，从最近 STREAK_LOOKBACK_ROWS 行签到流水往回数连续签到。
 * 调用时机在插入今天这行之前，故从昨天开始对齐；遇间断即停。
 */
async function computeStreak(env, userId, todayKey) {
  const { results } = await env.DB
    .prepare(
      "SELECT created_at FROM points_log " +
      "WHERE user_id = ? AND reason = 'signin' AND status = 'confirmed' " +
      "ORDER BY created_at DESC LIMIT ?"
    )
    .bind(userId, STREAK_LOOKBACK_ROWS)
    .all();
  let streak = 1;
  let expected = previousDayKey(todayKey);
  for (const row of results ?? []) {
    const key = dayKeyOf(row.created_at);
    if (key === todayKey) continue;      // 今天的重复行（理论不发生，主键已防）
    if (key === expected) { streak += 1; expected = previousDayKey(expected); }
    else break;                          // 遇间断即停
  }
  return streak;
}

/** 是否主键冲突错误（D1 报 UNIQUE/SQLITE_CONSTRAINT）。 */
function isPrimaryKeyConflict(err) {
  return /UNIQUE|PRIMARY KEY|SQLITE_CONSTRAINT/.test(String(err?.message ?? ""));
}

/**
 * POST /api/points/signin  签到：+3/天，连签每满 7 天再 +30。
 * 同日重复签到靠确定性流水 id `signin:{uid}:{dayKey}` 的主键冲突原子拦截（防并发双签）。
 */
export async function handleSignin(request, env, origin) {
  await cleanupExpiredPending(env);   // 惰性清理：先清算悬挂 pending 再业务

  const uid = await getUserId(request, env);
  if (!uid.ok) return fail(uid.error, uid.status, origin);

  const now = Date.now();
  const dayKey = dayKeyOf(now);
  const logId = `signin:${uid.userId}:${dayKey}`;

  // 连签从现有流水推算（今天这行还没插，今天为第 n 天）；n%7==0 时 bonus=+30
  const streak = await computeStreak(env, uid.userId, dayKey);
  const bonus = streak % POINTS_SIGNIN_STREAK_DAYS === 0 ? POINTS_SIGNIN_STREAK_BONUS : 0;
  const gained = POINTS_SIGNIN_DAILY + bonus;

  const user = await env.DB.prepare("SELECT points FROM users WHERE id = ?").bind(uid.userId).first();
  const balance = user?.points ?? 0;   // 并发下快照可能漂移，只影响流水展示（已知风险）

  try {
    await env.DB
      .prepare(
        "INSERT INTO points_log (id, user_id, change, reason, status, balance_after, created_at) " +
        "VALUES (?, ?, ?, 'signin', 'confirmed', ?, ?)"
      )
      .bind(logId, uid.userId, gained, balance + gained, now)
      .run();
  } catch (err) {
    if (isPrimaryKeyConflict(err)) return fail("今天已签到，明天再来", 409, origin);
    throw err;   // 其余错误交路由层 500
  }

  await env.DB
    .prepare("UPDATE users SET points = points + ?, total_earned = total_earned + ?, last_signin_at = ? WHERE id = ?")
    .bind(gained, gained, now, uid.userId)
    .run();

  const after = await env.DB.prepare("SELECT points, total_earned FROM users WHERE id = ?").bind(uid.userId).first();
  return json({
    ok: true,
    gained,
    bonus,
    streak,
    points: after?.points ?? 0,
    totalEarned: after?.total_earned ?? 0,
  }, { origin });
}

// ---- 余额 / 流水 / 充值 ----

/** GET /api/points/balance  余额 + AI 明码标价（价格唯一来源，前端不硬编码）。 */
export async function handleBalance(request, env, origin) {
  await cleanupExpiredPending(env);

  const uid = await getUserId(request, env);
  if (!uid.ok) return fail(uid.error, uid.status, origin);

  const user = await env.DB.prepare("SELECT points, total_earned FROM users WHERE id = ?").bind(uid.userId).first();
  return json({
    ok: true,
    points: user?.points ?? 0,
    totalEarned: user?.total_earned ?? 0,
    prices: {
      image1K: POINTS_AI_IMAGE_1K,
      image2K: POINTS_AI_IMAGE_2K,
      video: POINTS_AI_VIDEO,
      refImage: POINTS_AI_REF_EACH,
    },
  }, { origin });
}

/** GET /api/points/log?limit=&offset=  积分流水（pending/refunded 行也返回，前端展示「AI 预扣中/已退回」）。 */
export async function handleLog(request, env, origin) {
  await cleanupExpiredPending(env);

  const uid = await getUserId(request, env);
  if (!uid.ok) return fail(uid.error, uid.status, origin);

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);   // 与 handleList 同款钳制
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const { results } = await env.DB
    .prepare(
      "SELECT id, change, reason, status, balance_after, created_at FROM points_log " +
      "WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .bind(uid.userId, limit, offset)
    .all();
  const total = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM points_log WHERE user_id = ?")
    .bind(uid.userId)
    .first();

  return json({
    ok: true,
    total: total?.n ?? 0,
    items: (results ?? []).map((row) => ({
      id: row.id,
      change: row.change,
      reason: row.reason,
      status: row.status,
      balanceAfter: row.balance_after,
      createdAt: row.created_at,
    })),
  }, { origin });
}

/**
 * POST /api/points/recharge  模拟支付：API 入参金额单位「元」（1–1000 元整数，1 元 = 100 积分），
 * 入库按分折算（recharge_orders.amount 单位「分」，points = amount），直接落 paid
 * （真支付上线前任何人可无限刷分，属已知风险，见设计风险清单）。
 */
export async function handleRecharge(request, env, origin) {
  await cleanupExpiredPending(env);

  const uid = await getUserId(request, env);
  if (!uid.ok) return fail(uid.error, uid.status, origin);

  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走金额校验 */ }
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < RECHARGE_MIN_CENTS || amount > RECHARGE_MAX_CENTS || amount % 100 !== 0) {
    return fail(`充值金额无效：须为 ${RECHARGE_MIN_CENTS / 100}–${RECHARGE_MAX_CENTS / 100} 元的整数（单位：分，如 1 元=100）`, 400, origin);
  }

  const points = amount;   // 1 积分 = 1 分钱 → 充值 100 分（1 元）= 100 积分
  const orderId = crypto.randomUUID();
  const user = await env.DB.prepare("SELECT points FROM users WHERE id = ?").bind(uid.userId).first();
  const balance = (user?.points ?? 0) + points;   // 并发下快照可能漂移，只影响流水展示（已知风险）

  await env.DB
    .prepare("INSERT INTO recharge_orders (id, user_id, amount, points, status, created_at) VALUES (?, ?, ?, ?, 'paid', ?)")
    .bind(orderId, uid.userId, points, points, Date.now())
    .run();
  await env.DB
    .prepare("UPDATE users SET points = points + ?, total_earned = total_earned + ? WHERE id = ?")
    .bind(points, points, uid.userId)
    .run();
  await env.DB
    .prepare(
      "INSERT INTO points_log (id, user_id, change, reason, status, balance_after, created_at) " +
      "VALUES (?, ?, ?, 'recharge', 'confirmed', ?, ?)"
    )
    .bind(crypto.randomUUID(), uid.userId, points, balance, Date.now())
    .run();

  return json({ ok: true, orderId, amount, points, balance }, { origin });
}

// ---- 审核（本期只导出函数，路由与界面第 3 步做）----

/**
 * 审核通过：pending → visible；上传者有 user_id → 发 POINTS_UPLOAD_REWARD 分；
 * 存量行 user_id 为 NULL → 只过审不发分（credited:false，console 记录）。
 * 状态守卫 + 条件 UPDATE（meta.changes 判定）双保险防并发重复处理。
 */
export async function approveUpload(env, uploadId) {
  const row = await env.DB
    .prepare("SELECT id, user_id, status FROM uploads WHERE id = ?")
    .bind(uploadId)
    .first();
  if (!row) return { ok: false, error: "找不到该条目", status: 404 };
  if (row.status !== "pending") return { ok: false, error: "该条目已处理", status: 409 };

  const upd = await env.DB
    .prepare("UPDATE uploads SET status = 'visible' WHERE id = ? AND status = 'pending'")
    .bind(uploadId)
    .run();
  if (upd.meta.changes !== 1) return { ok: false, error: "该条目已处理", status: 409 };   // 并发已被处理

  if (!row.user_id) {
    console.log(`审核通过但无 user_id（存量行），只过审不发分：uploadId=${uploadId}`);
    return { ok: true, id: uploadId, credited: false, points: 0 };
  }

  const user = await env.DB.prepare("SELECT points FROM users WHERE id = ?").bind(row.user_id).first();
  const balance = (user?.points ?? 0) + POINTS_UPLOAD_REWARD;
  await env.DB
    .prepare("UPDATE users SET points = points + ?, total_earned = total_earned + ? WHERE id = ?")
    .bind(POINTS_UPLOAD_REWARD, POINTS_UPLOAD_REWARD, row.user_id)
    .run();
  await env.DB
    .prepare(
      "INSERT INTO points_log (id, user_id, change, reason, status, balance_after, created_at) " +
      "VALUES (?, ?, ?, 'upload', 'confirmed', ?, ?)"
    )
    .bind(crypto.randomUUID(), row.user_id, POINTS_UPLOAD_REWARD, balance, Date.now())
    .run();

  return { ok: true, id: uploadId, credited: true, points: balance };
}

// ---- AI 计费 / 预扣 / 结算 / 退回 ----

/** 参考图张数：无 → 0；单张 → 1；数组 → 按 length 计（无免费张，每张都收）。 */
function refImageCount(image) {
  if (image == null) return 0;
  return Array.isArray(image) ? image.length : 1;
}

/** AI 静图计费：1K=30 / 2K=60 + 每张参考图 2（动图在 _shared 用 POINTS_AI_VIDEO + 首帧参考图另算）。 */
export function computeAiCost(size, image) {
  const base = size === "1K" ? POINTS_AI_IMAGE_1K : POINTS_AI_IMAGE_2K;
  return base + refImageCount(image) * POINTS_AI_REF_EACH;
}

/**
 * AI 预扣（原子）：单条 `UPDATE ... WHERE points >= ?` + meta.changes 判定保证不超扣；
 * changes===0 → 积分不足（402 文案带余额）。成功后落 status='pending' 流水，返回行 id 供结算/退回。
 * 返回 { ok:true, logId } | { ok:false, error, status }，失败由调用方直接 fail()。
 */
export async function preDeductPoints(env, userId, cost) {
  const user = await env.DB.prepare("SELECT points FROM users WHERE id = ?").bind(userId).first();
  const balance = user?.points ?? 0;

  const upd = await env.DB
    .prepare("UPDATE users SET points = points - ? WHERE id = ? AND points >= ?")
    .bind(cost, userId, cost)
    .run();
  if (upd.meta.changes !== 1) {
    return { ok: false, error: `积分不足：本次需要 ${cost} 分，当前 ${balance} 分`, status: 402 };
  }

  const logId = crypto.randomUUID();
  await env.DB
    .prepare(
      "INSERT INTO points_log (id, user_id, change, reason, status, balance_after, created_at) " +
      "VALUES (?, ?, ?, 'ai_spend', 'pending', ?, ?)"
    )
    .bind(logId, userId, -cost, balance - cost, Date.now())
    .run();
  return { ok: true, logId };
}

/** 结算 AI 预扣：pending → confirmed（余额不动，幂等）。 */
export async function settleAiSpend(env, logId) {
  await env.DB
    .prepare("UPDATE points_log SET status = 'confirmed' WHERE id = ? AND status = 'pending'")
    .bind(logId)
    .run();
}

/**
 * 退回 AI 预扣：先 claim（pending → refunded，meta.changes===1 才继续，防双退），
 * 再把分数补回 users。退回不改 change 值（保持负），退款语义由 status 流转表达。
 * 返回 true=已退；false=已结算/已退回/行不存在（幂等跳过）。
 */
export async function refundAiSpend(env, logId) {
  const claim = await env.DB
    .prepare("UPDATE points_log SET status = 'refunded' WHERE id = ? AND status = 'pending'")
    .bind(logId)
    .run();
  if (claim.meta.changes !== 1) return false;

  const row = await env.DB.prepare("SELECT user_id, change FROM points_log WHERE id = ?").bind(logId).first();
  if (!row) return false;
  await env.DB
    .prepare("UPDATE users SET points = points + ? WHERE id = ?")
    .bind(-row.change, row.user_id)   // change 恒为负，取反即补回值
    .run();
  return true;
}

/**
 * 惰性清理悬挂 pending 流水（AI 预扣 10 分钟保护）：
 * 超过 AI_SETTLE_TIMEOUT_MS 仍未结算的 pending 行 → 逐行 claim（pending→refunded）+ 补回分数。
 * 每个积分/AI 请求开头调用；claim-first 防双退。无流量时悬挂不清算（冻结设计的已知取舍）；
 * claim 成功后补分失败会留「refunded 但余额未回」残局，靠这里 console 告警人工修。
 * 函数内部吞异常（不因清理失败阻断业务请求）。
 */
export async function cleanupExpiredPending(env) {
  try {
    const threshold = Date.now() - AI_SETTLE_TIMEOUT_MS;
    const { results } = await env.DB
      .prepare("SELECT id, user_id, change FROM points_log WHERE status = 'pending' AND created_at < ?")
      .bind(threshold)
      .all();
    for (const row of results ?? []) {
      try {
        const claim = await env.DB
          .prepare("UPDATE points_log SET status = 'refunded' WHERE id = ? AND status = 'pending'")
          .bind(row.id)
          .run();
        if (claim.meta.changes !== 1) continue;   // 已被并发清理/结算
        await env.DB
          .prepare("UPDATE users SET points = points + ? WHERE id = ?")
          .bind(-row.change, row.user_id)
          .run();
      } catch (err) {
        console.error("清理悬挂积分流水失败：", err.message);
      }
    }
  } catch (err) {
    console.error("扫描悬挂积分流水失败：", err.message);
  }
}

// ---- 风控文案黑名单 ----
const MODERATION_KEYWORDS = ["风控", "审核", "违规", "敏感", "违禁", "risk", "moderation", "policy"];

/**
 * 生成失败时区分「内容风控」与「服务端故障」：命中黑名单 → 不退分（confirmed）；
 * 未命中（欠费/网络/5xx 等）→ 退分（refunded）。
 * 黑名单靠 console 日志积累文案、上线后调参（Seedream/可灵错误文案变化会漏判/误判，已记风险清单）。
 */
export function isContentModerationError(message) {
  const text = String(message ?? "").toLowerCase();
  return MODERATION_KEYWORDS.some((keyword) => text.includes(keyword));
}
