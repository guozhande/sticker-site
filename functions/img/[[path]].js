/**
 * /img/<r2key>  —— 从 R2 取图（带 Cloudflare 边缘缓存）
 *
 * R2 的键形如 uploads/2026-10/<uuid>.gif，
 * 所以 catch-all 拿到的是 ["uploads","2026-10","<uuid>.gif"]，拼回斜杠即可。
 */
import { handleImage, isAuthorized } from "../_shared.js";

export async function onRequest(context) {
  const { request, env, params, waitUntil } = context;
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  // ⚠️ 同 api/：本路由比根 catch-all 更具体，必须自己再查一遍口令
  if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401 });

  const key = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");
  if (!key) return new Response("Not Found", { status: 404 });

  return handleImage(request, decodeURIComponent(key), env, waitUntil);
}
