/**
 * /api/* 路由
 *   GET  /api/health
 *   POST /api/upload
 *   GET  /api/uploads?work=&limit=&offset=
 *   POST /api/report
 */
import { corsHeaders, fail, isAuthorized, json, handleList, handleReport, handleUpload } from "../_shared.js";

export async function onRequest(context) {
  const { request, env, params } = context;
  const origin = request.headers.get("Origin") ?? "";
  const route = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // ⚠️ 必须自己再查一遍口令：本路由比根 catch-all 更具体，不会经过那道门
  if (!isAuthorized(request, env)) return fail("需要访问口令", 401, origin);

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
    return fail("Not Found", 404, origin);
  } catch (err) {
    return fail(`服务端错误：${err.message}`, 500, origin);
  }
}
