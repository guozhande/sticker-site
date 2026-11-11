/**
 * /api/* 路由
 *   GET  /api/health
 *   POST /api/upload
 *   GET  /api/uploads?work=&limit=&offset=
 *   POST /api/report
 *   POST /api/ai/image
 *   POST /api/ai/video
 *   POST /api/points/signin       （积分：签到）
 *   GET  /api/points/balance      （积分：余额 + AI 明码标价）
 *   GET  /api/points/log          （积分：流水）
 *   POST /api/points/recharge     （积分：模拟充值）
 *   GET  /api/admin/list          （审核：待审核队列，口令走 body.pass）
 *   POST /api/admin/approve       （审核：通过）
 *   POST /api/admin/reject        （审核：下架）
 */
import { corsHeaders, fail, json, handleAiImage, handleAiVideo, handleList, handleReport, handleUpload } from "../_shared.js";
import { handleAdminApprove, handleAdminList, handleAdminReject } from "../admin.js";
import { handleBalance, handleLog, handleRecharge, handleSignin } from "../points.js";

export async function onRequest(context) {
  const { request, env, params } = context;
  const origin = request.headers.get("Origin") ?? "";
  const route = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  try {
    if (route === "health") {
      return json({ ok: true, service: "sticker-api", via: "pages-functions", time: Date.now() }, { origin });
    }
    if (route === "upload" && request.method === "POST") {
      return await handleUpload(request, env, origin);
    }
    if (route === "uploads" && request.method === "GET") {
      return await handleList(new URL(request.url), env, origin);
    }
    if (route === "report" && request.method === "POST") {
      return await handleReport(request, env, origin);
    }
    if (route === "ai/image" && request.method === "POST") {
      return await handleAiImage(request, env, origin);
    }
    if (route === "ai/video" && request.method === "POST") {
      return await handleAiVideo(request, env, origin);
    }
    if (route === "points/signin" && request.method === "POST") {
      return await handleSignin(request, env, origin);
    }
    if (route === "points/balance" && request.method === "GET") {
      return await handleBalance(request, env, origin);
    }
    if (route === "points/log" && request.method === "GET") {
      return await handleLog(request, env, origin);
    }
    if (route === "points/recharge" && request.method === "POST") {
      return await handleRecharge(request, env, origin);
    }
    if (route === "admin/list" && request.method === "GET") {
      return await handleAdminList(request, env, origin);
    }
    if (route === "admin/approve" && request.method === "POST") {
      return await handleAdminApprove(request, env, origin);
    }
    if (route === "admin/reject" && request.method === "POST") {
      return await handleAdminReject(request, env, origin);
    }
    return fail("Not Found", 404, origin);
  } catch (err) {
    return fail(`服务端错误：${err.message}`, 500, origin);
  }
}
