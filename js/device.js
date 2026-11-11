/**
 * 设备标识公共模块 —— 必须在 ai.js / points-center.js 之前加载（IIFE + window 挂载，与 fuzzy.js/ai.js 同风格）
 *
 * 游客积分账户的唯一凭证：后端 getUserId 读 X-Device-Id 头（8–64 位 [A-Za-z0-9-]），
 * 无头时才走 sha256(ip|salt) 兜底。前端所有积分/AI/上传请求经 apiFetch 自动带头，
 * 保证签到、充值、AI 扣分、上传奖励全部落在同一设备账户上。
 *
 * 刻意不做：不提供删除/重置设备号 UI —— 清了 localStorage 即丢账户（无登录的已知取舍）。
 */
(function () {
  'use strict';

  const DEVICE_KEY = 'stickerDeviceId';   // localStorage 存储键
  let memoryDeviceId = '';                // 隐私模式下 localStorage 不可用时的内存降级（同会话稳定）

  /** 生成设备号：randomUUID 优先（36 位含 '-'，天然过 ^[A-Za-z0-9-]{8,64}$）；
   *  旧 WebView 无 randomUUID → getRandomValues 16 字节小写 hex（32 位，同样过正则）。 */
  function generateDeviceId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (err) {
      console.error('生成设备号失败：', err?.message ?? err);   // 不吞异常：记录原因，落入终极兜底
    }
    // 终极兜底：连 crypto 都没有的极老 WebView，用时间戳+随机数（仍过正则）
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /** 取设备号：先读 localStorage；没有 → 生成并写入。
   *  整段 try/catch：隐私模式下 localStorage 读写抛异常 → 降级为内存变量
   *  （同一次会话内稳定，刷新丢失，可接受）。 */
  function getDeviceId() {
    if (memoryDeviceId) return memoryDeviceId;
    try {
      const stored = localStorage.getItem(DEVICE_KEY);
      if (stored) return stored;
      const fresh = generateDeviceId();
      localStorage.setItem(DEVICE_KEY, fresh);
      return fresh;
    } catch (err) {
      console.error('localStorage 不可用（隐私模式？），设备号降级为内存变量：', err?.message ?? err);
      memoryDeviceId = generateDeviceId();
      return memoryDeviceId;
    }
  }

  /** fetch 包装：只做 X-Device-Id 头部注入，不做业务包装（保持各调用点现有错误处理不动）。 */
  function apiFetch(url, options) {
    const opts = options || {};
    const headers = new Headers(opts.headers || {});
    headers.set('X-Device-Id', getDeviceId());
    return fetch(url, { ...opts, headers });
  }

  window.StickerDevice = { getDeviceId, apiFetch };
})();
