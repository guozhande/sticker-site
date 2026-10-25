/**
 * AI 制作表情（豆包 Seedream 文生图，静图）
 *
 * 闭环：输入提示词 → POST /api/ai/image 生成 → 展示站内 /img/ai/ 地址 →
 *       弹窗填作品名/角色名 → 复用 /api/upload 上传到站。
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

  const $ = (id) => document.getElementById(id);

  // ---------- 状态 ----------
  let busy = false;        // 生成在途锁（防连点）
  let uploading = false;   // 上传在途锁（防连点）
  let currentSize = '1K';  // 当前选中的尺寸
  let lastImageUrl = '';   // 后端返回的相对地址 /img/ai/<yyyymm>/<uuid>.<ext>

  // ---------- DOM ----------
  const $prompt = $('ai-prompt');
  const $count = $('ai-count');
  const $generate = $('ai-generate');
  const $result = $('ai-result');
  const $empty = $('ai-empty');
  const $loading = $('ai-loading');
  const $error = $('ai-error');
  const $figure = $('ai-figure');
  const $img = $('ai-img');
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

  /** 从站内 /img/ai/...jpg 地址取扩展名。 */
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
    busy = true;
    $generate.textContent = '生成中…';
    setResultState('loading');
    try {
      const res = await fetch(`${API}/api/ai/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, size: currentSize }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      lastImageUrl = data.url;
      $img.src = `${API}${data.url}`;
      $img.alt = prompt.slice(0, 50);
      setResultState('done');
    } catch (err) {
      $error.textContent = err.message || '生成失败，请重试';   // textContent：不进 innerHTML
      setResultState('error');
    } finally {
      busy = false;
      $generate.textContent = '生成';
      syncGenerateButton();
    }
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
  document.querySelectorAll('.ai-size').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ai-size').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSize = btn.dataset.size;
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
