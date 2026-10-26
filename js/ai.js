/**
 * AI 制作表情（豆包 Seedream 文生图 + 可灵动图转 GIF）
 *
 * 静图闭环：输入提示词 → POST /api/ai/image 生成 → 展示站内 /img/ai/ 地址 →
 *           弹窗填作品名/角色名 → 复用 /api/upload 上传到站。
 * 动图闭环：输入提示词 → POST /api/ai/video（长链路心跳流式，约 2-4 分钟）→
 *           结果同样是 <img> 展示 + 同一套上传弹窗（GIF87a/89a 后端已支持）。
 *
 * 依赖：js/config.js（window.STICKER_API_BASE），必须在 ai.js 之前加载。
 */
(function () {
  'use strict';

  const API = window.STICKER_API_BASE ?? '';
  const PROMPT_MAX = 500;   // 对齐 functions/_shared.js AI_PROMPT_MAX
  const WORK_MAX = 60;      // 对齐 functions/_shared.js MAX_WORK_LEN
  const CHAR_MAX = 12;      // 对齐 functions/_shared.js MAX_CHARS
  const CHAR_LEN = 40;      // 对齐 functions/_shared.js MAX_CHAR_LEN
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;   // 对齐 functions/_shared.js MAX_BYTES
  // 动图前端兜底（15 分钟）：覆盖健康最坏 ≈10.5 分钟。极端最坏 21 分钟超出时，
  // 超时 abort → 后端全链路取消、无孤儿产物；已产生的费用不退还（文案已提示）。
  const VIDEO_TIMEOUT_MS = 900_000;

  const $ = (id) => document.getElementById(id);

  // ---------- 状态 ----------
  let busy = false;          // 生成在途锁（防连点）
  let uploading = false;     // 上传在途锁（防连点）
  let currentMode = 'image'; // 当前类型：image=静图 / video=动图
  let currentSize = '1K';    // 当前选中的尺寸（静图）
  let currentDuration = '5'; // 当前视频时长（动图，秒）
  let lastImageUrl = '';     // 后端返回的相对地址 /img/ai/<yyyymm>/<uuid>.<ext>

  // ---------- DOM ----------
  const $prompt = $('ai-prompt');
  const $count = $('ai-count');
  const $generate = $('ai-generate');
  const $result = $('ai-result');
  const $empty = $('ai-empty');
  const $loading = $('ai-loading');
  const $loadingText = $('ai-loading-text');
  const $error = $('ai-error');
  const $figure = $('ai-figure');
  const $img = $('ai-img');
  const $sizeField = $('ai-size-field');
  const $durationField = $('ai-duration-field');
  const $uploadBtn = $('ai-upload-btn');
  const $regenBtn = $('ai-regen-btn');
  const $work = $('ai-work');
  const $chars = $('ai-chars');
  const $uploadSubmit = $('ai-upload-submit');

  // ---------- 工具 ----------
  let toastTimer = null;
  function toast(msg) {
    const el = $('up-toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function showModal(id) { $(id).classList.add('show'); }
  function closeModal(id) { $(id).classList.remove('show'); }

  /** 结果区四种状态：empty / loading / error / done。 */
  function setResultState(state) {
    $empty.hidden = state !== 'empty';
    $loading.hidden = state !== 'loading';
    $error.hidden = state !== 'error';
    $figure.hidden = state !== 'done';
  }

  /** 从站内 /img/ai/...jpg（或 .gif）地址取扩展名。 */
  function extFromUrl(url) {
    const m = String(url).match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : 'jpg';
  }

  /** 角色名：中英文逗号分隔、去空白、去重、限 12 个。 */
  function parseCharacters(raw) {
    const seen = new Set();
    const out = [];
    for (const part of raw.split(/[,，]/)) {
      const s = part.trim().slice(0, CHAR_LEN);
      if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      if (out.length >= CHAR_MAX) break;
    }
    return out;
  }

  function syncGenerateButton() {
    $generate.disabled = busy || !$prompt.value.trim();
  }

  // ---------- 生成 ----------
  async function generate() {
    if (busy) return;
    const prompt = $prompt.value.trim();
    if (!prompt) return toast('请先输入提示词');
    const isVideo = currentMode === 'video';

    busy = true;
    setModeControlsDisabled(true);   // busy 期间锁定类型/时长按钮，防「结果与当前模式错位」
    $generate.textContent = '生成中…';
    setResultState('loading');
    $loadingText.textContent = isVideo
      ? '正在生成动图，约需 2–4 分钟，请保持页面在前台…'
      : '正在生成，约需 10–30 秒…';

    // 不用 AbortController.timeout（无此静态方法，调用即 TypeError 且发生在 try 之前 → busy 永久锁死）；
    // 不用 AbortSignal.timeout（旧版微信 X5/WKWebView 缺失 → 同样死锁）。setTimeout 方案全兼容。
    const ctrl = new AbortController();
    const timer = isVideo ? setTimeout(() => ctrl.abort(), VIDEO_TIMEOUT_MS) : 0;
    try {
      const res = await fetch(isVideo ? `${API}/api/ai/video` : `${API}/api/ai/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isVideo
          ? { prompt, duration: Number(currentDuration) }
          : { prompt, size: currentSize }),
        signal: ctrl.signal,   // 静图：timer 为 0，signal 永不 abort，行为与原裸 fetch 一致
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const data = isVideo ? await readVideoResult(res) : await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || '生成失败');
      lastImageUrl = data.url;
      $img.src = `${API}${data.url}`;
      $img.alt = prompt.slice(0, 50);
      setResultState('done');
      if (data.degraded) toast('GIF 超过 500KB，微信导入可能失败');
    } catch (err) {
      $error.textContent = errorMessage(err, isVideo);   // textContent：不进 innerHTML
      setResultState('error');
    } finally {
      if (timer) clearTimeout(timer);   // 定时器必清，busy 必释放
      setModeControlsDisabled(false);
      busy = false;
      $generate.textContent = '生成';
      syncGenerateButton();
    }
  }

  /** 读动图流式响应：心跳是 "\n" 行，最后一行是单行 JSON。 */
  async function readVideoResult(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    buf += dec.decode();
    const lines = buf.split('\n').filter((s) => s.trim());
    try { return JSON.parse(lines[lines.length - 1] ?? '{}'); }
    catch { throw new Error('生成结果解析失败，请重试'); }
  }

  /** busy 期间锁定类型/时长按钮（disabled 按钮不触发 click）。 */
  function setModeControlsDisabled(disabled) {
    document.querySelectorAll('[data-mode], [data-duration]').forEach((b) => { b.disabled = disabled; });
  }

  /** 动图错误文案：超时/断网提示「重新计费」，429/5xx 直接展示后端中文文案（额度/服务已区分）。 */
  function errorMessage(err, isVideo) {
    if (!isVideo) return err.message || '生成失败，请重试';
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return '生成超时，本次请求已取消；已产生的费用不退还，请勿立即重试（每次都会重新计费）';
    }
    if (err instanceof TypeError) {
      return '网络中断，本次请求已取消；已产生的费用不退还，请勿立即重试（每次都会重新计费）';
    }
    return err.message || '生成失败，请重试';
  }

  // ---------- 上传 ----------
  function openUpload() {
    if (!lastImageUrl) return;
    $work.value = '';
    $chars.value = '';
    $uploadSubmit.disabled = true;
    showModal('ai-upload-modal');
    $work.focus();
  }

  async function submitUpload(work, characters) {
    if (uploading) return;   // 防双击并发两次 POST
    uploading = true;
    $uploadSubmit.disabled = true;
    $uploadSubmit.textContent = '上传中…';
    try {
      // /img/ai/... 是 CF 同源地址，前端 fetch 成 blob 无 CORS 问题
      const imgRes = await fetch(`${API}${lastImageUrl}`);
      if (!imgRes.ok) throw new Error('图片获取失败');
      const blob = await imgRes.blob();
      if (blob.size > MAX_UPLOAD_BYTES) throw new Error('图片超过 8MB，无法上传');

      const fd = new FormData();
      fd.append('file', new File([blob], `ai_${Date.now()}.${extFromUrl(lastImageUrl)}`, { type: blob.type || 'image/jpeg' }));
      fd.append('work', work);
      fd.append('characters', JSON.stringify(characters));

      const res = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      closeModal('ai-upload-modal');
      showUploadSuccess(work);
    } catch (err) {
      toast(`上传失败：${err.message}`);
    } finally {
      uploading = false;
      $uploadSubmit.disabled = !$work.value.trim();
      $uploadSubmit.textContent = '提交';
    }
  }

  function showUploadSuccess(work) {
    $('ai-success-work').textContent = work;   // textContent：用户输入永不进 innerHTML
    showModal('ai-success-modal');
  }

  // ---------- 事件绑定 ----------
  // 类型切换（静图/动图）：显隐尺寸组与时长组。按 data 属性分组绑定，互不污染各自状态
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mode]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      $sizeField.hidden = currentMode === 'video';
      $durationField.hidden = currentMode !== 'video';
    });
  });

  // 尺寸按钮（仅静图）
  document.querySelectorAll('[data-size]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-size]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSize = btn.dataset.size;
    });
  });

  // 时长按钮（仅动图）
  document.querySelectorAll('[data-duration]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-duration]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentDuration = btn.dataset.duration;
    });
  });

  $prompt.addEventListener('input', () => {
    $count.textContent = String($prompt.value.length);
    syncGenerateButton();
  });

  $generate.addEventListener('click', generate);
  $uploadBtn.addEventListener('click', openUpload);
  $regenBtn.addEventListener('click', generate);

  $('ai-upload-cancel').addEventListener('click', () => closeModal('ai-upload-modal'));
  $('ai-upload-close').addEventListener('click', () => closeModal('ai-upload-modal'));
  $work.addEventListener('input', () => {
    $uploadSubmit.disabled = uploading || !$work.value.trim();
  });
  $uploadSubmit.addEventListener('click', () => {
    const work = $work.value.trim().slice(0, WORK_MAX);
    if (!work) return toast('请填写作品名称');
    submitUpload(work, parseCharacters($chars.value));
  });
  $('ai-success-close').addEventListener('click', () => closeModal('ai-success-modal'));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['ai-upload-modal', 'ai-success-modal']) {
      if ($(id).classList.contains('show')) return closeModal(id);
    }
  });
})();
