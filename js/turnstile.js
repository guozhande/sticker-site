/**
 * Turnstile 共享助手 —— 显式渲染 + 每次动作取新 token（canonical SPA 模式，见 CF Turnstile 文档）。
 * 加载顺序：config.js 之后、使用方（upload.js / ai.js / maker.js）之前。
 * 暴露 window.StickerTurnstile.getToken(action) → Promise<string>（失败 reject）。
 * 惰性加载：getToken 首次调用时才加载 Turnstile API 脚本。
 */
(function () {
  const SITEKEY = "0x4AAAAAAGAWJSl2qhOPvjAe";
  const API_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__stOnload";
  const TOKEN_TIMEOUT_MS = 15_000;

  let widgetReady = false;        // __stOnload 已触发（API 就绪）
  let scriptFailed = false;
  let loadPromise = null;
  const rendered = new Map();     // action -> widgetId（同 action 复用 widget，execute 取新 token）
  const pending = new Map();      // action -> { resolve, reject }

  function ensureContainer() {
    let el = document.getElementById("st-turnstile-widget");
    if (!el) {
      el = document.createElement("div");
      el.id = "st-turnstile-widget";
      // 隐形挂载点：Turnstile 只需要一个可渲染的 DOM 节点，不展示给用户
      el.style.cssText = "position:fixed;left:0;bottom:0;z-index:-1;";
      document.body.appendChild(el);
    }
    return el;
  }

  function renderWidget(action, p) {
    if (rendered.has(action)) {
      // widget 已存在：execute 取一枚新 token（callback 触发 resolve）
      try {
        window.turnstile.execute(rendered.get(action), { action });
      } catch (e) {
        pending.delete(action);
        p.reject(e);
      }
      return;
    }
    try {
      const wid = window.turnstile.render(ensureContainer(), {
        sitekey: SITEKEY,
        action,
        "refresh-expired": "auto",
        callback: (token) => {
          const q = pending.get(action);
          if (q) {
            pending.delete(action);
            q.resolve(token);
          }
        },
        "error-callback": () => {
          const q = pending.get(action);
          if (q) {
            pending.delete(action);
            q.reject(new Error("turnstile error"));
          }
        },
      });
      rendered.set(action, wid);
    } catch (e) {
      pending.delete(action);
      p.reject(e);
    }
  }

  function loadScript() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
      if (window.turnstile) {
        widgetReady = true;
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = API_SCRIPT;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();       // API 就绪后 __stOnload 置 widgetReady
      s.onerror = () => {
        scriptFailed = true;
        reject(new Error("turnstile script load failed"));
      };
      document.head.appendChild(s);
    });
    return loadPromise;
  }

  // API 就绪回调（由 script URL 的 onload 参数触发）
  window.__stOnload = function () {
    widgetReady = true;
    for (const [action, p] of [...pending]) {
      renderWidget(action, p);
    }
  };

  window.StickerTurnstile = {
    getToken(action) {
      if (scriptFailed) return Promise.reject(new Error("turnstile unavailable"));
      return loadScript().then(() => new Promise((resolve, reject) => {
        const p = { resolve, reject };
        pending.set(action, p);
        if (widgetReady) {
          renderWidget(action, p);
        }
        // __stOnload 触发时会统一渲染所有 pending；此处兜底超时
        setTimeout(() => {
          if (pending.has(action)) {
            pending.delete(action);
            reject(new Error("turnstile timeout"));
          }
        }, TOKEN_TIMEOUT_MS);
      }));
    },
  };
})();
