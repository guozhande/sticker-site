/**
 * /img/<r2key>  —— 从 R2 取图（带 Cloudflare 边缘缓存）
 *
 * R2 的键形如 uploads/2026-10/<uuid>.gif，
 * 所以 catch-all 拿到的是 ["uploads","2026-10","<uuid>.gif"]，拼回斜杠即可。
 */
import { handleImage } from "../_shared.js";

export async function onRequest(context) {
  const { request, env, params, waitUntil } = context;
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const key = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");
  if (!key) return new Response("Not Found", { status: 404 });

  return handleImage(request, decodeURIComponent(key), env, waitUntil);
}
