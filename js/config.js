/**
 * 共享配置 —— 必须在 app.js / upload.js 之前加载
 *
 * API 就挂在网站自己域名下（Cloudflare Pages Functions）：
 *   sticker-store-uzo.pages.dev  → 同源，用相对路径
 *   guozhande.github.io          → 那边没有 Functions，走绝对地址
 */
window.STICKER_API_BASE =
  location.hostname.endsWith('.pages.dev') ? '' : 'https://sticker-store-uzo.pages.dev';
