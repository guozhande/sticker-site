/**
 * AI 制作表情（豆包 Seedream 文生图/图生图 + 可灵动图转 GIF）
 *
 * 静图闭环：输入提示词（可选参考图 → 图生图）→ POST /api/ai/image 生成 → 展示站内 /img/ai/ 地址 →
 *           弹窗填作品名/角色名 → 复用 /api/upload 上传到站。
 * 动图闭环：输入提示词 → POST /api/ai/video（长链路心跳流式，约 2-4 分钟）→
 *           结果同样是 <img> 展示 + 同一套上传弹窗（GIF87a/89a 后端已支持）。
 * 参考图仅对静图生效：Seedream 无独立图生图端点（同端点加 image 字段）、无强度参数，
 * 相似度由 ref_mode（free/style/keep）对应的后端提示词前缀控制。
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
  // 参考图压缩参数（对齐 quickref：单边 >14px、宽高比 [1/16,16]；压缩后 data URI 远小于后端 5MB 硬限）
  const REF_MAX_EDGE = 1024;
  const REF_JPEG_QUALITY = 0.85;
  const REF_FAIL_TOAST = {
    too_small: '参考图尺寸太小，请换一张',
    bad_ratio: '参考图比例过窄/过宽，请换一张',
    unreadable: '图片无法读取，请换一张',
  };

  const $ = (id) => document.getElementById(id);

  // ---------- 状态 ----------
  let busy = false;          // 生成在途锁（防连点）
  let uploading = false;     // 上传在途锁（防连点）
  let currentMode = 'image'; // 当前类型：image=静图 / video=动图
  let currentSize = '1K';    // 当前选中的尺寸（静图）
  let currentDuration = '5'; // 当前视频时长（动图，秒）
  let lastImageUrl = '';     // 后端返回的相对地址 /img/ai/<yyyymm>/<uuid>.<ext>
  // 参考图（仅静图模式使用）
  let refImageDataUri = null;     // 压缩后的参考图 data URI（发请求用；null = 文生图）
  let refMode = 'free';           // free | style | keep（后端提示词前缀档位）
  let refPreviewUrl = '';         // 原图 objectURL（缩略图用；需手动 revoke）
  let refCompressPromise = null;  // 在途压缩 Promise；非 null 时禁用生成按钮
  let refError = false;           // 最近一次压缩失败标记（选新图时清除）
  let refSelection = 0;           // 选图代次：删除/换图 +1，作废旧在途压缩的结算

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
  const $refField = $('ai-ref-field');
  const $refAdd = $('ai-ref-add');
  const $refFile = $('ai-ref-file');
  const $refProcessing = $('ai-ref-processing');
  const $refProcessingText = $('ai-ref-processing-text');
  const $refPreview = $('ai-ref-preview');
  const $refThumb = $('ai-ref-thumb');
  const $refName = $('ai-ref-name');
  const $refRemove = $('ai-ref-remove');
  const $refModes = $('ai-ref-modes');
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
    // 参考图压缩中禁用生成按钮（R14：不调用的话选图瞬间存在竞态窗口）
    $generate.disabled = busy || refCompressPromise !== null || !$prompt.value.trim();
  }

  // ---------- 参考图（图生图）----------
  /** 清参考图全部状态（× 删除 / 失败清理 / 换新图共用）；refSelection 自增作废旧在途压缩的结算。 */
  function clearRefState() {
    refSelection++;
    refImageDataUri = null;
    refError = false;
    refMode = 'free';
    setRefModeActive('free');
    if (refPreviewUrl) { URL.revokeObjectURL(refPreviewUrl); refPreviewUrl = ''; }
    $refAdd.hidden = false;
    $refProcessing.hidden = true;
    $refPreview.hidden = true;
    $refModes.hidden = true;
  }

  function setRefModeActive(mode) {
    document.querySelectorAll('[data-ref-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.refMode === mode);
    });
  }

  /** 压缩完成：处理中占位 → 已选态（缩略图 + 文件名 + 相似度 chips）。 */
  function showRefPreview(name) {
    $refProcessing.hidden = true;
    $refPreview.hidden = false;
    $refModes.hidden = false;
    $refThumb.src = refPreviewUrl;
    $refName.textContent = name;   // textContent：文件名不进 innerHTML
  }

  /**
   * 读取并压缩参考图 → 长边 ≤1024 的 JPEG data URI（约 ≤2MB）。
   * 返回 { ok:true, dataUri }；预检/解码失败 { ok:false, reason:'too_small'|'bad_ratio'|'unreadable' }。
   * 预检（解码后、压缩前）：单边须 >14px、宽高比 [1/16,16]（Seedream 官方限制），
   * 超界前置拒绝、不进压缩，避免错误经 FrameError 通道只呈现通用文案。
   */
  async function compressRefImage(file) {
    let drawable = null;
    let fallbackUrl = '';
    try {
      // 优先 createImageBitmap（file 直读）；旧 WebView 缺失时回退 Image + objectURL
      if (typeof createImageBitmap === 'function') {
        drawable = await createImageBitmap(file);
      } else {
        fallbackUrl = URL.createObjectURL(file);
        drawable = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('图片解码失败'));
          img.src = fallbackUrl;
        });
      }

      const w = drawable.width;
      const h = drawable.height;
      if (w <= 14 || h <= 14) return { ok: false, reason: 'too_small' };
      if (w / h > 16 || h / w > 16) return { ok: false, reason: 'bad_ratio' };

      const scale = Math.min(1, REF_MAX_EDGE / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';                        // 先白底填充：JPEG 无透明通道，透明 PNG 直接转会变黑底
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(drawable, 0, 0, cw, ch);
      return { ok: true, dataUri: canvas.toDataURL('image/jpeg', REF_JPEG_QUALITY) };
    } catch (err) {
      console.error('参考图压缩失败：', err?.message ?? err);   // 不吞异常：记录原因，UI 走统一失败文案
      return { ok: false, reason: 'unreadable' };
    } finally {
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
      if (drawable && typeof drawable.close === 'function') drawable.close();   // ImageBitmap 释放内存
    }
  }

  /** 选中参考图 → 清旧状态 → 处理中占位 → 压缩 → 预览态/失败清理。 */
  function onRefFileChange() {
    const file = $refFile.files?.[0];
    $refFile.value = '';   // 重置 input：同一文件再次选择也能触发 change
    if (!file) return;

    clearRefState();   // 清旧状态（revoke 旧 objectURL、作废旧在途压缩）
    const mySel = refSelection;

    $refAdd.hidden = true;
    $refProcessing.hidden = false;
    $refProcessingText.textContent = file.name;   // textContent：文件名不进 innerHTML
    refPreviewUrl = URL.createObjectURL(file);

    // R14 生命周期：压缩开始即禁用生成按钮；settle（成败皆）释放并同步按钮。
    // identity 守卫：只清自己的锁 —— 删除/换图后旧压缩的 finally 不得误清新压缩的锁。
    const p = compressRefImage(file)
      .then((result) => {
        if (refSelection !== mySel) return;   // 已被删除/换图：丢弃结算结果
        if (result.ok) {
          refImageDataUri = result.dataUri;
          showRefPreview(file.name);
        } else {
          clearRefState();                                   // 恢复添加按钮态（revoke objectURL）
          if (result.reason === 'unreadable') refError = true;   // 仅压缩失败标记，预检拒绝不算
          toast(REF_FAIL_TOAST[result.reason]);
        }
      })
      .finally(() => {
        if (refCompressPromise === p) refCompressPromise = null;
        syncGenerateButton();
      });
    refCompressPromise = p;
    syncGenerateButton();
  }

  /** × 删除参考图：清状态 + 释放压缩锁（R14：× 删除时点必须调 syncGenerateButton）。 */
  function onRefRemove() {
    clearRefState();
    refCompressPromise = null;   // 丢弃在途压缩的按钮锁；其 finally 的 identity 守卫不会误伤新锁
    syncGenerateButton();
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
      // R14：await 与 refError 检查必须在 try 内 —— 提前 return 也走 finally，
      // busy / setModeControlsDisabled / 按钮文案 / syncGenerateButton 全部照常释放。
      // 双保险：即使按钮 disabled 渲染延迟、点击先到，await 在途压缩后才构造 payload，
      // 不会发出缺 image 的静默文生图请求；压缩失败后中止生成。
      // 动图不使用参考图（R17），两项检查仅对静图生效。
      if (!isVideo) {
        if (refCompressPromise) await refCompressPromise;
        if (refError) {
          toast('参考图无法读取，请重新添加');
          setResultState('empty');   // 恢复结果区空态，勿停留在 loading
          return;
        }
      }
      const res = await fetch(isVideo ? `${API}/api/ai/video` : `${API}/api/ai/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isVideo
          ? { prompt, duration: Number(currentDuration) }
          : { prompt, size: currentSize, image: refImageDataUri, ref_mode: refMode }),   // image 为 null 时后端按文生图处理
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
      // R17：参考图仅对静图生效 —— 切动图只隐藏、不清状态（切回静图恢复预览）；
      // 已选参考图时明示，避免「生成 2-4 分钟结果与参考图无关且无任何提示」的付费体感最差点
      $refField.hidden = currentMode === 'video';
      if (currentMode === 'video' && refImageDataUri) toast('参考图仅对静图生效，本次动图生成不使用参考图');
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

  // 参考图（图生图）：添加 / 选文件 / 删除 / 相似度 chips
  $refAdd.addEventListener('click', () => $refFile.click());
  $refFile.addEventListener('change', onRefFileChange);
  $refRemove.addEventListener('click', onRefRemove);
  document.querySelectorAll('[data-ref-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      refMode = btn.dataset.refMode;
      setRefModeActive(refMode);
    });
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
