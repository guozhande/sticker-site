/**
 * 全站访问口令门
 *
 * Pages 的路由规则：**匹配到 Function 就跑 Function，匹配不到才回落到静态资源**
 * （官方文档原话："If no Function is matched, it will fall back to a static asset"）
 * 而且"更具体的路由优先" —— 所以 api/ 和 img/ 那两个 catch-all 会盖过这个根 catch-all。
 *
 * 三种放行方式：
 *   ① 网址带 ?k=口令        → 种下 cookie 后跳回干净网址（给浏览器用）
 *   ② Cookie sticker_key    → 已登录
 *   ③ 请求头 X-Access-Key   → 给 App 用（App 没有 cookie）
 *
 * 口令存在 Pages 项目的环境变量 ACCESS_KEY 里。没设就不拦（避免把自己锁死）。
 */

const COOKIE = 'sticker_key';
const GATE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要访问口令</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#333}
  .box{background:#fff;padding:32px 28px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.08);text-align:center;width:280px}
  h1{font-size:17px;margin:0 0 6px}
  p{font-size:13px;color:#666;margin:0 0 18px}
  input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #e0e0e0;border-radius:8px;font-size:14px;font-family:inherit}
  button{margin-top:12px;width:100%;padding:10px;border:none;border-radius:8px;background:#4A90D9;color:#fff;font-size:14px;cursor:pointer}
  .err{color:#d9534f;font-size:12px;margin-top:10px;min-height:16px}
</style></head>
<body><form class="box" method="GET">
  <h1>🔒 暂未对外开放</h1>
  <p>这个站点还在准备中，请输入访问口令</p>
  <input name="k" type="password" placeholder="访问口令" autofocus>
  <button type="submit">进入</button>
  <div class="err" id="e"></div>
</form>
<script>
  // 口令错误时后端会用 ?e=1 跳回来
  if (new URLSearchParams(location.search).get('e')) document.getElementById('e').textContent = '口令不对';
</script></body></html>`;

function gate() {
  return new Response(GATE_HTML, {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const key = env.ACCESS_KEY;

  // 没配口令就不拦 —— 否则一次配置失误就把站点锁死了
  if (!key) return next();

  const provided = url.searchParams.get('k');

  // ① 网址带口令
  if (provided !== null) {
    if (provided === key) {
      const clean = new URL(url);
      clean.searchParams.delete('k');
      return new Response(null, {
        status: 302,
        headers: {
          Location: clean.toString(),
          'Set-Cookie': `${COOKIE}=${key}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
          'Cache-Control': 'no-store',
        },
      });
    }
    const back = new URL(url);
    back.searchParams.delete('k');
    back.searchParams.set('e', '1');
    return new Response(null, { status: 302, headers: { Location: back.toString(), 'Cache-Control': 'no-store' } });
  }

  // ② 已带 cookie ③ 请求头（App 用）
  const cookie = request.headers.get('Cookie') ?? '';
  if (cookie.split(';').some((c) => c.trim() === `${COOKIE}=${key}`)) return next();
  if (request.headers.get('X-Access-Key') === key) return next();

  return gate();
}
