/**
 * 审核管理后台（Pages Functions 版）
 *
 * 四个接口：待审核队列（FIFO）/ 一键通过 / 一键下架 / 运行日志查询。
 * 状态机逻辑（pending → visible / hidden）在 functions/points.js 的 approveUpload / rejectUpload
 * 单一来源维护，本文件只做口令闸门 + 请求解析 + 响应包装。
 *
 * 口令闸门 checkAdminPass 与 _shared.js 的 checkAiPass 同构（未配置=503 安全默认），
 * 但文案刻意分开：403「口令不正确」/ 503「管理后台未配置」——
 * 管理页面需要区分「未配置提示」（冻结设计第 1/6 条），与 AI 页的统一文案不同。
 * 口令只存环境变量 ADMIN_PASS，绝不写进代码。
 *
 * 依赖方向：admin → points / _shared（单向，无循环引用）。
 */

import { fail, json } from "./_shared.js";
import { approveUpload, rejectUpload } from "./points.js";

const ADMIN_LIST_DEFAULT_LIMIT = 60;   // 首屏/默认页大小
const ADMIN_LIST_MAX_LIMIT = 200;      // 上限（与 handleList 同款钳制公式）
const ADMIN_LOGS_DEFAULT_LIMIT = 50;   // 日志页默认条数（上限同 ADMIN_LIST_MAX_LIMIT 钳制）
const ADMIN_LOG_PLATFORMS = new Set(["", "web", "app"]);   // 日志 platform 筛选白名单（''=全部）
const ADMIN_NO_STORE = { "Cache-Control": "no-store" };   // 审核/日志数据禁中间缓存

/**
 * 管理口令闸门：最早一步执行（先于一切业务逻辑，无口令请求不进入任何查询）。
 * env.ADMIN_PASS 未配置 → 503 全锁（安全默认：忘配口令时审核后台整体关闭）；
 * body.pass 不匹配 → 403。返回 { ok:true } | { ok:false, error, status }。
 */
function checkAdminPass(body, env) {
  const pass = String(env.ADMIN_PASS ?? "").trim();
  if (!pass) return { ok: false, error: "管理后台未配置", status: 503 };
  if (String(body.pass ?? "") !== pass) return { ok: false, error: "口令不正确", status: 403 };
  return { ok: true };
}

/** 待审核行 → 列表条目。characters 的 JSON.parse 带 try/catch（同 _shared rowToItem 防脏数据）。 */
function rowToAdminItem(row) {
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

/**
 * POST /api/admin/list  待审核队列。
 * FIFO 先到先审：ORDER BY created_at ASC（与 handleList 的 DESC 刻意不同——审核队列
 * 第 1 页稳定，不会被新上传挤走）。limit/offset 钳制与 handleList 同款公式。
 * 口令走 body.pass：POST JSON body（浏览器禁止 GET 带 body，故查询接口走 POST；
 * 路由层 request.json() 带 try/catch，无 body → pass='' → 403）。
 */
export async function handleAdminList(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* 无 body / 非法 JSON → pass='' → 403 */ }

  const passCheck = checkAdminPass(body, env);
  if (!passCheck.ok) return fail(passCheck.error, passCheck.status, origin);

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const { results } = await env.DB
    .prepare("SELECT * FROM uploads WHERE status = 'pending' ORDER BY created_at ASC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all();
  const total = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM uploads WHERE status = 'pending'")
    .first();

  return json({
    ok: true,
    total: total?.n ?? 0,
    limit,
    offset,
    items: (results ?? []).map(rowToAdminItem),
  }, { origin, headers: ADMIN_NO_STORE });
}

/**
 * POST /api/admin/approve  一键通过：直接调用 points.js 的 approveUpload（不做二次状态判断）。
 * pending → visible；有 user_id → 发 POINTS_UPLOAD_REWARD 分（credited:true）；存量行 → 只过审不发分。
 */
export async function handleAdminApprove(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走 id 校验 */ }

  const passCheck = checkAdminPass(body, env);
  if (!passCheck.ok) return fail(passCheck.error, passCheck.status, origin);

  const id = String(body.id ?? "").trim();
  if (!id) return fail("缺少 id", 400, origin);

  const result = await approveUpload(env, id);
  if (!result.ok) return fail(result.error, result.status, origin);

  return json({
    ok: true,
    id: result.id,
    status: "visible",
    credited: result.credited,
    points: result.points,
  }, { origin, headers: ADMIN_NO_STORE });
}

/**
 * POST /api/admin/reject  一键下架：直接调用 points.js 的 rejectUpload。
 * pending → hidden，不发分、不写积分流水、不删 R2 对象（冻结设计第 4 条：仅改状态）。
 */
export async function handleAdminReject(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走 id 校验 */ }

  const passCheck = checkAdminPass(body, env);
  if (!passCheck.ok) return fail(passCheck.error, passCheck.status, origin);

  const id = String(body.id ?? "").trim();
  if (!id) return fail("缺少 id", 400, origin);

  const result = await rejectUpload(env, id);
  if (!result.ok) return fail(result.error, result.status, origin);

  return json({ ok: true, id: result.id, status: "hidden" }, { origin, headers: ADMIN_NO_STORE });
}

/** client_logs 行 → 列表条目（字段名转驼峰，与站点接口风格一致）。 */
function rowToLogItem(row) {
  return {
    id: row.id,
    platform: row.platform,
    deviceId: row.device_id,
    page: row.page,
    level: row.level,
    message: row.message,
    stack: row.stack,
    createdAt: row.created_at,
  };
}

/**
 * POST /api/admin/logs  运行日志查询（平台筛选 + 时间倒序分页）。
 * 口令走 body.pass（与 handleAdminList 同模式）；platform 查询参数白名单 ''|'web'|'app'，
 * 非法值回退全部（''）；limit 默认 50、上限 200（与 ADMIN_LIST_MAX_LIMIT 同款钳制）。
 * 数据禁中间缓存（同审核接口 ADMIN_NO_STORE）。
 */
export async function handleAdminLogs(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* 无 body / 非法 JSON → pass='' → 403 */ }

  const passCheck = checkAdminPass(body, env);
  if (!passCheck.ok) return fail(passCheck.error, passCheck.status, origin);

  const url = new URL(request.url);
  const rawPlatform = url.searchParams.get("platform") ?? "";
  const platform = ADMIN_LOG_PLATFORMS.has(rawPlatform) ? rawPlatform : "";
  const limit = Math.min(Number(url.searchParams.get("limit")) || ADMIN_LOGS_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const where = platform ? "WHERE platform = ?" : "";
  const binds = platform ? [platform] : [];

  const { results } = await env.DB
    .prepare(`SELECT * FROM client_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all();
  const total = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM client_logs ${where}`)
    .bind(...binds)
    .first();

  return json({
    ok: true,
    total: total?.n ?? 0,
    limit,
    offset,
    items: (results ?? []).map(rowToLogItem),
  }, { origin, headers: ADMIN_NO_STORE });
}
