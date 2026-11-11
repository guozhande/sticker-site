/**
 * 全局错误上报（IIFE + 'use strict'，与 device.js / fuzzy.js 同风格）
 *
 * 捕获两类错误：JS 运行时错误（window error 事件）与未处理的 Promise 拒绝。
 * 资源加载失败类事件（图片 404 等）没有 message 字段，直接过滤 —— 只收 error 级
 * （用户拍板：不收集 warning）。
 *
 * 上报经 StickerDevice.apiFetch 自动带 X-Device-Id（匿名设备号），只报设备号 + 页面路径 +
 * 错误文本/堆栈，不采集任何个人信息。同错误 1 分钟去重（防循环刷），去重 Map 上限 100
 * （满时删最旧键防无限增长）；keepalive 让请求在页面卸载/崩溃瞬间也能发出
 * （body ≤2.3KB，远低于 keepalive 64KB 上限）。
 *
 * 上报自身失败一律静默，且绝不因上报失败再抛 unhandledrejection 形成死循环。
 *
 * 加载顺序：config.js → device.js → 本文件 → app.js（排在 app.js 前，能抓到 app.js 自身的报错）。
 */
(function () {
  'use strict';
  try {
    const LOG_URL = `${window.STICKER_API_BASE ?? ''}/api/log`;
    const PAGE = location.pathname;
    const DEDUP_WINDOW_MS = 60_000;    // 同错误 1 分钟去重，防循环刷
    const MAX_MESSAGE_LEN = 200;       // 与服务端 client_logs.message 截断一致
    const MAX_STACK_LEN = 2000;        // 与服务端 client_logs.stack 截断一致
    const DEDUP_MAP_MAX = 100;         // 去重 Map 上限：满时删最旧键，防无限增长

    const lastReportAt = new Map();    // `${page}|${message}` -> 上次上报毫秒时间戳

    /** 上报一条 error：去重 + keepalive + 全程静默（上报失败绝不产生新错误）。 */
    function report(page, message, stack) {
      if (!window.StickerDevice?.apiFetch) return;
      try {
        const key = `${page}|${message}`;
        const now = Date.now();
        if (now - (lastReportAt.get(key) ?? 0) < DEDUP_WINDOW_MS) return;
        if (!lastReportAt.has(key) && lastReportAt.size >= DEDUP_MAP_MAX) {
          lastReportAt.delete(lastReportAt.keys().next().value);   // 满则删最旧键
        }
        lastReportAt.set(key, now);
        StickerDevice.apiFetch(LOG_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'web', page, level: 'error', message, stack }),
          keepalive: true,
        }).catch(() => {});   // 上报自身失败静默，不抛 unhandledrejection
      } catch (_) {
        /* 上报链路任何异常一律吞掉：错误上报绝不能产生新错误 */
      }
    }

    // JS 运行时错误：无 message 的是图片/资源加载失败类事件，过滤掉免噪音
    window.addEventListener('error', (e) => {
      if (!e.message) return;
      const stack = e.error instanceof Error ? String(e.error.stack ?? '') : '';
      report(PAGE, String(e.message).slice(0, MAX_MESSAGE_LEN), stack.slice(0, MAX_STACK_LEN));
    });

    // 未处理的 Promise 拒绝
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? String(reason.stack ?? '') : '';
      report(PAGE, message.slice(0, MAX_MESSAGE_LEN), stack.slice(0, MAX_STACK_LEN));
    });
  } catch (_) {
    /* 本脚本自身报错绝对静默 */
  }
})();
