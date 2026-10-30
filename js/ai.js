/**
 * AI 制作表情（豆包 Seedream 文生图/图生图 + 可灵动图转 GIF）
 *
 * 静图闭环：输入提示词（可选参考图 → 图生图）→ POST /api/ai/image 生成 → 展示站内 /img/ai/ 地址 →
 *           弹窗填作品名/角色名 → 复用 /api/upload 上传到站。
 * 动图闭环：输入提示词（可选动图首帧：静图直接作首帧 / GIF 检测帧数取第 N 帧）→ POST /api/ai/video
 *           （长链路心跳流式，约 2-4 分钟；有 image 时后端跳过 Seedream、原样作可灵 first_frame）→
 *           结果同样是 <img> 展示 + 同一套上传弹窗（GIF87a/89a 后端已支持）。
 * 参考图仅对静图生效：Seedream 无独立图生图端点（同端点加 image 字段）、无强度参数，
 * 相似度由 ref_mode（free/style/keep）对应的后端提示词前缀控制。
 * 动图首帧取帧：依赖 js/gif-frame.js（window.GifFrame）+ vendor/gifuct-js.vendor.js（window.Gifuct），
 * GIF 只在前端解析（总帧数 + 第 1/2 帧 + 手动帧号），选中帧压缩为白底 JPEG data URI 上传。
 *
 * 依赖：js/config.js（window.STICKER_API_BASE），必须在 ai.js 之前加载。
 */
(function () {
  'use strict';

  const API = window.STICKER_API_BASE ?? '';
  const PROMPT_MAX = 1000;  // 对齐 functions/_shared.js AI_PROMPT_MAX
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
  // 动图首帧取帧失败文案（js/gif-frame.js 的 reason → toast；GIF 本体只前端解析、不上传）
  const GIF_FAIL_TOAST = {
    not_gif: '不是有效的 GIF 文件',
    too_large_bytes: '动图过大（限 20MB）',
    too_large: '动图尺寸过大，请换一张',
    unreadable: '动图解析失败，请换一张',
    not_loaded: '动图取帧组件未加载，请刷新重试',
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

  // 动图首帧（仅动图模式使用）：静图压缩 data URI 或 GIF 取帧结果，共用单槽位 videoFrameDataUri
  let videoFrameDataUri = null;       // 选中帧的白底 JPEG data URI（发请求用；null = 文生图）
  let videoFrameSelection = 0;        // 首帧选图代次：删除/换图 +1，作废旧在途压缩/取帧的结算
  let videoFrameBusy = null;          // 在途取帧/压缩 Promise；非 null 时禁用生成按钮
  let videoFrameErr = false;          // 最近一次取帧失败标记（选新图时清除）
  let gifPending = null;              // 待取帧的 GIF（{ file, gif, frameCount }）；gif 为已解析对象（只解析一次）

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
  const $vidRefField = $('ai-vidref-field');
  const $vidRefAdd = $('ai-vidref-add');
  const $vidRefFile = $('ai-vidref-file');
  const $vidRefProcessing = $('ai-vidref-processing');
  const $vidRefProcessingText = $('ai-vidref-processing-text');
  const $vidRefPreview = $('ai-vidref-preview');
  const $vidRefThumb = $('ai-vidref-thumb');
  const $vidRefName = $('ai-vidref-name');
  const $vidRefRemove = $('ai-vidref-remove');
  const $gifAdd = $('ai-gif-add');
  const $gifFile = $('ai-gif-file');
  const $gifPanel = $('ai-gif-panel');
  const $gifTotal = $('ai-gif-total');
  const $gifPick1 = $('ai-gif-pick1');
  const $gifPick2 = $('ai-gif-pick2');
  const $gifFrame = $('ai-gif-frame');
  const $gifOk = $('ai-gif-ok');
  const $gifErr = $('ai-gif-err');
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
    // 参考图压缩中/动图首帧取帧中禁用生成按钮（R14：不调用的话选图瞬间存在竞态窗口）
    $generate.disabled = busy || refCompressPromise !== null || videoFrameBusy !== null || !$prompt.value.trim();
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

  // ---------- 动图首帧（图生图：静图 / GIF 取帧）----------
  /** 清动图首帧全部状态（× 删除 / 失败清理 / 换新图共用）；videoFrameSelection 自增作废旧在途结算。 */
  function clearVidRefState() {
    videoFrameSelection++;
    videoFrameDataUri = null;
    videoFrameErr = false;
    $vidRefAdd.hidden = false;
    $gifAdd.hidden = false;
    $vidRefProcessing.hidden = true;
    $vidRefPreview.hidden = true;
    $vidRefThumb.removeAttribute('src');
    $vidRefName.textContent = '';
    $gifPanel.hidden = true;
  }

  /** 清 GIF 待取帧缓存（不触碰已选帧 videoFrameDataUri）；gifPending 置 null 同步释放已解析 gif 对象内存。 */
  function clearGifState() {
    gifPending = null;
    videoFrameErr = false;
    $gifTotal.textContent = '';
    $gifFrame.max = '';
    $gifFrame.value = '';
    $gifErr.hidden = true;
    $gifPanel.hidden = true;
  }

  /** 失败恢复：显示两个入口按钮、隐藏 processing 与取帧面板；不触碰 preview（成功路径不会调用它）。 */
  function restoreVidRefEntries() {
    $vidRefAdd.hidden = false;
    $gifAdd.hidden = false;
    $vidRefProcessing.hidden = true;
    $gifPanel.hidden = true;
  }

  function setVidRefProcessing(text) {
    $vidRefProcessing.hidden = false;
    $vidRefProcessingText.textContent = text;   // textContent：文件名不进 innerHTML
  }

  function hideVidRefProcessing() {
    $vidRefProcessing.hidden = true;
  }

  /** 动图首帧：选静图 → 清旧状态 → 处理中占位 → 压缩（复用 compressRefImage）→ 预览态/失败清理。 */
  function onVidRefFileChange() {
    const file = $vidRefFile.files && $vidRefFile.files[0];
    $vidRefFile.value = '';   // 重置 input：同一文件再次选择也能触发 change
    if (!file) return;

    clearVidRefState();   // 清旧状态（作废旧在途取帧/压缩）
    clearGifState();
    const mySel = videoFrameSelection;

    $vidRefAdd.hidden = true;
    $gifAdd.hidden = true;
    setVidRefProcessing(file.name);

    // 与参考图同款生命周期：开始即禁用生成按钮；settle（成败皆）释放并同步按钮。
    // identity 守卫：只清自己的锁 —— 删除/换图后旧压缩的 finally 不得误清新取帧的锁。
    const p = compressRefImage(file)
      .then((result) => {
        if (videoFrameSelection !== mySel) return;   // 已被删除/换图：丢弃结算结果
        if (result.ok) {
          videoFrameDataUri = result.dataUri;
          $vidRefThumb.src = result.dataUri;   // data URI 直用，无需 objectURL
          $vidRefName.textContent = file.name;
          $vidRefPreview.hidden = false;
          $vidRefAdd.hidden = true;
          $gifAdd.hidden = true;
          hideVidRefProcessing();
        } else {
          if (result.reason === 'unreadable') videoFrameErr = true;   // 仅压缩失败标记，预检拒绝不算
          toast(REF_FAIL_TOAST[result.reason] || REF_FAIL_TOAST.unreadable);
          restoreVidRefEntries();
        }
      })
      .finally(() => {
        if (videoFrameBusy === p) videoFrameBusy = null;
        hideVidRefProcessing();   // 兜底：任何路径都不残留 processing
        syncGenerateButton();
      });
    videoFrameBusy = p;
    syncGenerateButton();
  }

  /**
   * 动图首帧：选 GIF → sniff → parseGIF 仅一次（gif 对象缓存进 gifPending）→ lsd 护栏 →
   * 三路分支（0 帧拒 / 1 帧当静图 / ≥2 帧显示总帧数 + 取帧面板）。
   * v3 修正 #1/#3/#4/#9：全程 try/catch，finally 保留 R14 释放；失败恢复走 catch 的 toast + restoreVidRefEntries。
   */
  function onGifFileChange() {
    // v3 修正 #9：组件未加载守卫（vendor 被 CSP/eval 阻断等）—— 早退 + 可读提示，不产生 unhandledrejection
    if (!window.GifFrame || !window.Gifuct) { toast(GIF_FAIL_TOAST.not_loaded); return; }
    const file = $gifFile.files && $gifFile.files[0];
    $gifFile.value = '';   // 重置 input：同一文件再次选择也能触发 change
    if (!file) return;
    clearVidRefState();
    clearGifState();
    const mySel = videoFrameSelection;
    setVidRefProcessing('正在读取动图…');
    const p = (async () => {
      try {
        const { gif, info } = await parseGifInput(file);   // 单次解析 + lsd 护栏，失败带 code 抛出
        if (videoFrameSelection !== mySel) return;         // 代际守卫：期间已换/删
        if (info.frameCount === 0) throw Object.assign(new Error('gif'), { code: 'unreadable' });  // 绝不显示「这是静图」
        if (info.frameCount === 1) return takeSingleFrameShortcut(file, mySel, gif);
        gifPending = { file, gif, frameCount: info.frameCount };   // ≥2：gif 对象随面板缓存，确定时复用
        $gifTotal.textContent = String(info.frameCount);           // textContent 铁律
        $gifFrame.max = String(info.frameCount);
        $gifFrame.value = '';
        $gifErr.hidden = true;
        $gifPanel.hidden = false;
        hideVidRefProcessing();
      } catch (err) {
        // v3 修正 #1/#3：任何异常（parseGIF 抛错、截断 GIF、内存异常）都落这里 ——
        // 绝不静默产出白帧、绝不让 unhandledrejection 卡死 processing 态
        console.error('[gif] onGifFileChange 失败:', err);
        if (videoFrameSelection === mySel) {                         // 仍在本代才动 UI（新代自理）
          const reason = err && err.code ? err.code : 'unreadable';
          videoFrameErr = reason === 'unreadable';                   // 仅解析失败置标记（对齐 ref 侧语义）
          toast(GIF_FAIL_TOAST[reason] || GIF_FAIL_TOAST.unreadable);
          restoreVidRefEntries();                                    // 恢复入口按钮 + 隐藏 processing/面板
        }
      }
    })().finally(() => {
      // R14 释放：finally 作为 promise reaction 恒在 p 初始化后执行
      //（若写进 async 体内且同步段先抛错，V8 会在 p 赋值前同步执行 finally → TDZ）
      if (videoFrameBusy === p) videoFrameBusy = null;
      hideVidRefProcessing();                                        // 兜底：任何路径都不残留 processing
      syncGenerateButton();
    });
    videoFrameBusy = p;
    syncGenerateButton();
  }

  /** 动图输入解析：大小护栏 → arrayBuffer → sniff → parseGIF 仅一次 → countGifFrames + lsd 护栏。失败带 code 抛出。 */
  async function parseGifInput(file) {
    if (file.size > GifFrame.GIF_MAX_UPLOAD_BYTES) throw Object.assign(new Error('gif'), { code: 'too_large_bytes' });
    const arrayBuffer = await file.arrayBuffer();
    if (!GifFrame.sniffGifBytes(arrayBuffer)) throw Object.assign(new Error('gif'), { code: 'not_gif' });
    const gif = Gifuct.parseGIF(arrayBuffer);                    // v3 修正 #4：全文结构解析仅此一次
    const info = GifFrame.countGifFrames(arrayBuffer, gif);      // 复用 gif，不再二次解析
    if (!Number.isFinite(info.lsdWidth) || !Number.isFinite(info.lsdHeight)) {
      throw Object.assign(new Error('gif'), { code: 'unreadable' });
    }
    if (Math.max(info.lsdWidth, info.lsdHeight) > GifFrame.GIF_MAX_LSD_EDGE) {
      throw Object.assign(new Error('gif'), { code: 'too_large' });
    }
    return { gif, info };
  }

  /** 1 帧动图当静图：提示后直接按第 1 帧结算（不 await，settle 自管 busy）。 */
  function takeSingleFrameShortcut(file, mySel, gif) {
    toast('这是静图，将直接作为动图首帧');
    hideVidRefProcessing();
    settleGifFrame(file, 1, file.name, mySel, gif);
  }

  /** 取帧面板：第 1/2 帧按钮或手动帧号确定 → 校验（不发请求）→ settleGifFrame（复用缓存 gif）。 */
  function onGifPick(raw) {
    if (!window.GifFrame || !window.Gifuct) { toast(GIF_FAIL_TOAST.not_loaded); return; }
    if (!gifPending) return;
    const v = GifFrame.validateFrameIndex(raw, gifPending.frameCount);
    if (!v.ok) {
      $gifErr.textContent = '请输入 1 到 ' + gifPending.frameCount + ' 之间的整数';   // textContent：不进 innerHTML
      $gifErr.hidden = false;
      return;
    }
    $gifErr.hidden = true;
    settleGifFrame(gifPending.file, v.n, gifPending.file.name + ' · 第 ' + v.n + ' 帧', videoFrameSelection, gifPending.gif);
  }

  /**
   * GIF 取帧结算（count===1 与面板确定共用）：gifFrameToDataUri → 预览态/失败清理。
   * 帧号 1 基传入，-1 换算只在 pickFramePatch 内部发生。v3 修正 #1/#3：全程 try/catch。
   */
  function settleGifFrame(file, frameNo, label, mySel, gif) {
    const p = (async () => {
      try {
        const res = await GifFrame.gifFrameToDataUri(file, frameNo, gif);   // 复用缓存 gif（v3 修正 #4）
        if (videoFrameSelection !== mySel) return;                          // 代际守卫：期间换/删，丢弃
        if (res.ok) {
          videoFrameDataUri = res.dataUri;
          $vidRefThumb.src = res.dataUri;                                   // data URI 直用，无需 objectURL
          $vidRefName.textContent = label;
          $vidRefPreview.hidden = false;
          $vidRefAdd.hidden = true;
          $gifAdd.hidden = true;
          gifPending = null;                                                // 释放缓存 gif
          $gifPanel.hidden = true;
        } else if (res.reason === 'unreadable') {
          videoFrameErr = true;                                             // 仅解析失败标记（含截断 GIF）
          toast(GIF_FAIL_TOAST.unreadable);
          restoreVidRefEntries();
        } else {
          toast(GIF_FAIL_TOAST[res.reason] || GIF_FAIL_TOAST.unreadable);
          restoreVidRefEntries();
        }
      } catch (err) {
        // v3 修正 #1/#3：gifFrameToDataUri 内部异常（理论上不应发生）也归 unreadable，
        // 不产出白帧、不卡 processing
        console.error('[gif] settleGifFrame 失败:', err);
        if (videoFrameSelection === mySel) {
          videoFrameErr = true;
          toast(GIF_FAIL_TOAST.unreadable);
          restoreVidRefEntries();
        }
      }
    })().finally(() => {
      // R14 释放：与 onGifFileChange 同款 —— finally 作 reaction 恒在 p 初始化后执行，防 TDZ
      if (videoFrameBusy === p) videoFrameBusy = null;
      syncGenerateButton();
    });
    videoFrameBusy = p;
    syncGenerateButton();
  }

  /** × 删除动图首帧：清状态 + 释放取帧锁（其 finally 的 identity 守卫不会误伤新锁）。 */
  function onVidRefRemove() {
    clearVidRefState();
    clearGifState();
    videoFrameBusy = null;   // 丢弃在途取帧的按钮锁
    syncGenerateButton();
  }

  // ---------- 生成 ----------
  async function generate() {
    if (busy) return;
    const prompt = $prompt.value.trim();
    if (!prompt) return toast('请先输入提示词');
    const isVideo = currentMode === 'video';
    const myVidSel = videoFrameSelection;

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
      // 动图不使用静图参考图（R17），两项检查仅对静图生效。
      if (!isVideo) {
        if (refCompressPromise) await refCompressPromise;
        if (refError) {
          toast('参考图无法读取，请重新添加');
          setResultState('empty');   // 恢复结果区空态，勿停留在 loading
          return;
        }
      }
      // 动图首帧（图生图）：等待在途取帧/压缩 → 代际守卫（等待期间删除/换图）toast 中止 →
      // 失败标记拒绝。绝不发 image:null 的付费文生图请求。
      if (isVideo) {
        if (videoFrameBusy) await videoFrameBusy;
        if (videoFrameSelection !== myVidSel) {
          toast('动图首帧已更换，请重新确认后生成');
          setResultState('empty');
          return;
        }
        if (videoFrameErr) {
          toast('动图首帧无法读取，请重新选择');
          setResultState('empty');
          return;
        }
      }
      const res = await fetch(isVideo ? `${API}/api/ai/video` : `${API}/api/ai/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isVideo
          ? { prompt, duration: Number(currentDuration), image: videoFrameDataUri }   // image 为 null 时后端走 Seedream 首帧
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
  /** blob → base64（FileReader 读 data URI 取后半段；用于 AndroidBridge 分块存相册）。 */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function errorMessage(err, isVideo) {    if (!isVideo) return err.message || '生成失败，请重试';
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
      // R17：静图参考图仅对静图生效 —— 切动图只隐藏、不清状态（切回静图恢复预览）。
      // 动图首帧字段仅动图显示；同样只隐藏不清状态（切回动图恢复预览）。
      $refField.hidden = currentMode === 'video';
      $vidRefField.hidden = currentMode !== 'video';
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

  // 清理输入框：清空提示词 + 计数归零 + 刷新生成按钮态 + 焦点回输入框
  $('ai-prompt-clear').addEventListener('click', () => {
    $prompt.value = '';
    $count.textContent = '0';
    syncGenerateButton();
    $prompt.focus();
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

  // 动图首帧（图生图）：静图入口 / GIF 取帧入口 / 删除 / 取帧面板（第 1/2 帧 + 手动帧号）
  $vidRefAdd.addEventListener('click', () => $vidRefFile.click());
  $gifAdd.addEventListener('click', () => $gifFile.click());
  $vidRefFile.addEventListener('change', onVidRefFileChange);
  $gifFile.addEventListener('change', onGifFileChange);
  $vidRefRemove.addEventListener('click', onVidRefRemove);
  $gifPick1.addEventListener('click', () => onGifPick(1));
  $gifPick2.addEventListener('click', () => onGifPick(2));
  $gifOk.addEventListener('click', () => onGifPick($gifFrame.value));

  $generate.addEventListener('click', generate);
  $uploadBtn.addEventListener('click', openUpload);
  $regenBtn.addEventListener('click', generate);

  // 图片加载失败兜底：手机端网络/缓存导致结果图裂图时给出可操作提示
  $img.addEventListener('error', () => {
    toast('图片加载失败，请点「保存」下载查看或重新生成');
  });
  $('ai-save-btn').addEventListener('click', async () => {
    if (!lastImageUrl) return;
    try {
      const ext = (lastImageUrl.split('.').pop() || 'png').toLowerCase();
      const resp = await fetch(`${API}${lastImageUrl}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const suggestedName = `ai_${Date.now()}.${ext}`;

      // ① App WebView：AndroidBridge 分块存相册（协议与 maker 页一致：start/chunk/end，块 128KB）
      if (window.AndroidBridge && typeof window.AndroidBridge.savePngChunk === 'function') {
        const b64 = await blobToBase64(blob);
        const CHUNK = 128 * 1024;
        window.AndroidBridge.savePngStart(suggestedName, Math.ceil(b64.length / CHUNK));
        for (let i = 0; i < b64.length; i += CHUNK) {
          window.AndroidBridge.savePngChunk(Math.floor(i / CHUNK), b64.slice(i, i + CHUNK));
        }
        const ok = window.AndroidBridge.savePngEnd(suggestedName) === true;
        toast(ok ? '已保存到相册' : '保存失败');
        return;
      }

      // ② 桌面浏览器：系统「另存为」自选位置
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: '图片', accept: { 'image/*': [`.${ext}`] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('已保存');
        return;
      }

      // ③ 兜底：浏览器自动下载
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (err) {
      if (err?.name === 'AbortError') return;   // 用户取消「另存为」：静默
      toast('保存失败，请长按图片手动保存');
    }
  });

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
