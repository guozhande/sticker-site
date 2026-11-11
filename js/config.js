/**
 * 共享配置 —— 必须在 app.js / upload.js 之前加载
 *
 * API 就挂在 Pages Functions 域名下：
 *   sticker-store-uzo.pages.dev  → 同源，用相对路径
 *   guozhande.github.io          → 那边没有 Functions，走绝对地址
 *   emoticon-station.com / www.emoticon-station.com → 自定义域名实际绑在 GitHub Pages
 *     （curl 实测 /api/health 返回 GitHub Pages 404，无 Functions），必须继续走绝对地址；
 *     跨源 CORS 由后端 ALLOWED_ORIGINS 增加这两个域名兜底（functions/_shared.js）。
 */
window.STICKER_API_BASE =
  location.hostname.endsWith('.pages.dev') ? '' : 'https://sticker-store-uzo.pages.dev';
