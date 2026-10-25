/**
 * 自制表情制作器 —— 自定义制作（纯前端，无构建）
 *
 * 功能闭环：导入图片 / 文字 / 画笔 / 橡皮 / 撤销 / 删除 / 清空 / 导出 PNG / 上传
 * （上传复用现有 /api/upload：作品名必填、角色名选填逗号分隔）。
 *
 * 依赖顺序（见 maker/index.html 页尾）：
 *   js/config.js（window.STICKER_API_BASE）→ vendor/fabric-6.9.1.min.js（window.fabric）
 *
 * 关键实现依据（fabric v6，均已实测）：
 * - 撤销：v6 无内置撤销。add/remove 先改 _objects 后发事件 → 推入的全是变更后快照；
 *   初始播种 S0 空画布锚点；撤销 = pop 丢弃当前帧再加载新栈顶；
 *   splice(1,1) 挤最旧非锚点帧，S0 永驻 index 0（禁用 shift()）。
 * - 导出：canvas.toBlob({ multiplier: 1 }) 恒为逻辑尺寸，不受 devicePixelRatio 影响。
 * - 删除/清空/撤销后必须 discardActiveObject()：v6 remove/clear 不自动丢选中（幽灵选中）。
 * - 文本编辑退出仅在文本变化时 fire object:modified → 不监听 text:editing:exited 做撤销。
 */
(function () {
  'use strict';

  // 编辑器组件加载失败（离线/被拦）时不白屏：显示全屏提示横幅
  if (typeof fabric === 'undefined') {
    document.getElementById('fabric-fail').hidden = false;
    return;
  }

  const API = window.STICKER_API_BASE ?? '';
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;   // 对齐 functions/_shared.js MAX_BYTES
  const MAX_IMPORT_BYTES = 10 * 1024 * 1024;  // 导入单文件上限
  const MAX_IMPORT_PIXELS = 4096 * 4096;      // 解码像素上限（≈64MB RGBA，防移动端 OOM）
  const UNDO_LIMIT = 20;                      // 撤销步数上限（另加 S0 锚点）
  const SIZE_MIN = 64;                        // 自定义画布边长下限
  const SIZE_MAX = 1000;                      // 自定义画布边长上限（再大 PNG 易超 8MB）
  const WORK_MAX = 60;                        // 对齐 _shared.js MAX_WORK_LEN
  const CHAR_MAX = 12;                        // 对齐 _shared.js MAX_CHARS
  const CHAR_LEN = 40;                        // 对齐 _shared.js MAX_CHAR_LEN
  const ERASER_COLOR = '#ffffff';             // 橡皮 = 白底上的白画笔（视觉等价擦除）
  const ERASER_WIDTH = 16;                    // 橡皮固定笔宽
  const STROKE_WIDTH = 2;                     // 白/黑描边固定 2px
  const BLACK = '#333333';                    // 面板「黑」（与色盘同款）

  // ---------- 状态 ----------
  let canvas = null;
  let epoch = 0;             // 清空/切尺寸时 +1：使在途 importImage 失效
  let submitting = false;    // 上传在途锁（防连点并发两次 POST）
  let undoBusy = false;      // 撤销在途锁（loadFromJSON 异步，防连点交错）
  let suppressUndo = false;  // resetCanvasState / undoRestore 期间抑制快照入栈
  let undoStack = [];        // 撤销快照栈：[S0 锚点, S1, ...]，S0 永驻 index 0
  let dirty = false;         // 有未上传/未导出的改动（beforeunload 拦截用）
  let drawTool = null;       // 'pen' | 'eraser' | null（null = 选择模式）
  let brushColor = '#333333';
  let brushWidth = 8;
  let confirmAction = null;  // 确认弹窗「确定」后的待执行动作
  const objectUrls = new Set();   // 导入图片的 objectURL：仅 resetCanvasState 统一 revoke

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const stageShift = $('stage-shift');
  const stageInner = $('stage-inner');
  const $mkPanel = $('mk-panel');
  const $panelDraw = $('mk-panel-draw');
  const $panelText = $('mk-panel-text');
  const $eraserHint = $('mk-eraser-hint');
  const $mkUndo = $('mk-undo');
  const $mkDel = $('mk-del');
  const $mkExport = $('mk-export');
  const $mkUpload = $('mk-upload');
  const $mkPen = $('mk-pen');
  const $mkEraser = $('mk-eraser');
  const $mkFile = $('mk-file');
  const $mkWork = $('mk-work');
  const $mkChars = $('mk-chars');
  const $mkUploadSubmit = $('mk-upload-submit');

  // ---------- 工具 ----------
  let toastTimer = null;
  function toast(msg) {
    const el = $('up-toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // ---------- 弹窗 ----------
  function showModal(id) { $(id).classList.add('show'); }
  function closeModal(id) { $(id).classList.remove('show'); }

  /** 自制确认弹窗（不用 window.confirm：WebView 表现不一致）。 */
  function openConfirm(title, hint, okText, action) {
    $('mk-confirm-title').textContent = title;
    $('mk-confirm-hint').textContent = hint;
    $('mk-confirm-ok').textContent = okText;
    confirmAction = action;
    showModal('mk-confirm-modal');
  }

  // ---------- 画布初始化与显示适配 ----------
  function initCanvas(w, h) {
    canvas = new fabric.Canvas('mk-canvas', { width: w, height: h, backgroundColor: '#ffffff' });
    // 交互画布保留 fabric 默认 enableRetinaScaling：高分屏显示清晰；
    // 导出独立走 canvas.toBlob({ multiplier: 1 })，输出恒为逻辑尺寸，互不影响。
    canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);   // v6 无默认画笔实例，必须手动 new
    canvas.freeDrawingBrush.color = brushColor;
    canvas.freeDrawingBrush.width = brushWidth;

    // 撤销入栈：fabric add/remove 先改 _objects 后发事件 → 推入的全是变更后快照
    canvas.on('object:added', undoPush);
    canvas.on('object:modified', undoPush);
    canvas.on('object:removed', undoPush);
    // 不监听 text:editing:exited 做撤销：v6 文本编辑退出仅在文本变化时 fire
    // object:modified（fabric6.js:21260-21262），双监听会推两份相同快照、撤销多耗一步。

    canvas.on('object:added', ensureButtons);
    canvas.on('object:removed', ensureButtons);
    // 按钮态必须挂全三个 selection 事件：setActiveObject 只发 selection 事件、不触发
    // object 事件，不挂则导入图片/添加文字后删除按钮永远灰；且 v6 重复点选同一已选对象时
    // 连 selection 事件都不发（fabric6.js:14168），故各动作末尾另有显式 ensureButtons() 兜底。
    canvas.on('selection:created', () => { renderPanel(); ensureButtons(); });
    canvas.on('selection:updated', () => { renderPanel(); ensureButtons(); });
    canvas.on('selection:cleared', () => { renderPanel(); ensureButtons(); });

    // iOS 键盘位移防护（加分项）：text:editing:exited 仅用于位移复位，不参与撤销
    window.visualViewport?.addEventListener('resize', keyboardShift);
    canvas.on('text:editing:entered', keyboardShift);
    canvas.on('text:editing:exited', keyboardShift);

    undoStack.push(snapshot());   // 播种 S0：初始空画布快照（撤销语义锚点）
    fitStage();
    new ResizeObserver(fitStage).observe(stage);   // 必须在 canvas 赋值之后创建
    ensureButtons();              // 初始按钮态：空画布禁用导出/上传/撤销/删除
  }

  /** 画布等比缩放居中：CSS transform 缩放不影响 fabric 指针换算（基于 getBoundingClientRect）。 */
  function fitStage() {
    if (!canvas) return;
    const s = Math.min(1, (stage.clientWidth - 16) / canvas.getWidth(),
                          (stage.clientHeight - 16) / canvas.getHeight());
    stageInner.style.width = canvas.getWidth() * s + 'px';
    stageInner.style.height = canvas.getHeight() * s + 'px';
    stageInner.style.transform = `scale(${s})`;
  }

  // ---------- 按钮态与上下文面板 ----------
  function ensureButtons() {
    $mkUndo.disabled = !canvas || undoStack.length <= 1;   // 只剩 S0 即禁用
    $mkDel.disabled = !canvas || !canvas.getActiveObject();
    const empty = !canvas || canvas.getObjects().length === 0;
    $mkExport.disabled = empty;
    $mkUpload.disabled = empty;
  }

  function updateToolHighlight() {
    $mkPen.classList.toggle('active', !!canvas && canvas.isDrawingMode && drawTool === 'pen');
    $mkEraser.classList.toggle('active', !!canvas && canvas.isDrawingMode && drawTool === 'eraser');
  }

  function renderPanel() {
    if (!canvas) { $mkPanel.hidden = true; return; }
    const obj = canvas.getActiveObject();
    if (canvas.isDrawingMode) {
      // 橡皮固定白 16：不显示色盘/笔宽，只给提示
      const eraser = drawTool === 'eraser';
      $mkPanel.hidden = false;
      $panelDraw.hidden = false;
      $panelText.hidden = true;
      $('mk-draw-swatches').hidden = eraser;
      $('mk-draw-widths').hidden = eraser;
      $eraserHint.hidden = !eraser;
      markSwatch($('mk-draw-swatches'), canvas.freeDrawingBrush.color);
      markOption($('mk-draw-widths'), `[data-width="${canvas.freeDrawingBrush.width}"]`);
      return;
    }
    if (obj instanceof fabric.IText) {
      $mkPanel.hidden = false;
      $panelDraw.hidden = true;
      $panelText.hidden = false;
      markOption($('mk-font-sizes'), `[data-size="${Math.round(obj.fontSize)}"]`);
      markSwatch($('mk-text-swatches'), obj.fill);
      const strokeKey = obj.strokeWidth
        ? (String(obj.stroke).toLowerCase() === '#ffffff' ? 'white' : 'black')
        : 'none';
      markOption($('mk-stroke-opts'), `[data-stroke="${strokeKey}"]`);
      return;
    }
    $mkPanel.hidden = true;
    $panelDraw.hidden = true;
    $panelText.hidden = true;
  }

  function markOption(group, selector) {
    group.querySelectorAll('.mk-opt').forEach((el) => el.classList.remove('active'));
    const target = group.querySelector(selector);
    if (target) target.classList.add('active');
  }

  function markSwatch(group, color) {
    const key = String(color || '').toLowerCase();
    group.querySelectorAll('.mk-swatch').forEach((el) => {
      el.classList.toggle('active', el.dataset.color.toLowerCase() === key);
    });
  }

  // ---------- 撤销：post-state 快照 + S0 锚点的 pop-丢弃语义 ----------
  function snapshot() { return JSON.stringify(canvas.toJSON()); }

  function undoPush() {
    if (suppressUndo || !canvas) return;
    undoStack.push(snapshot());
    // splice(1,1) 挤掉最旧的非锚点帧；禁用 shift()：它移除 index 0 = S0，
    // 第 21 次操作后把锚点挤掉、无法撤销回初始空画布。S0 永远留在 index 0。
    if (undoStack.length > UNDO_LIMIT + 1) undoStack.splice(1, 1);
    dirty = true;
    ensureButtons();
  }

  async function undoRestore() {
    if (undoBusy || undoStack.length <= 1) return;   // 只剩 S0：无可撤销
    undoBusy = true;
    try {
      undoStack.pop();                    // 丢弃当前状态快照（不是加载它）
      const target = undoStack[undoStack.length - 1];
      suppressUndo = true;
      try {
        // 内部 clear() 并自快照 background 键恢复白底（fabric6.js:3306-3309）
        await canvas.loadFromJSON(JSON.parse(target));
      } finally { suppressUndo = false; }
      dirty = canvas.getObjects().length > 0;
      canvas.discardActiveObject();       // loadFromJSON→clear 不自动丢选中，防幽灵选中残留
      renderPanel();
      canvas.requestRenderAll();
      ensureButtons();                    // discard 会发 selection:cleared 再刷一次，双保险
    } finally { undoBusy = false; }
  }

  // ---------- 删除：先丢弃选中再移除（顺序不可颠倒） ----------
  function deleteActive() {
    const obj = canvas.getActiveObject();
    if (!obj) return;
    canvas.discardActiveObject();   // ① 发 selection:cleared → 面板隐藏 + 按钮刷新
    canvas.remove(obj);             // ② 发 object:removed → 自动推撤销栈
    // 先 remove 会留幽灵选中（v6 _onObjectRemoved 不丢 activeObject）：删除按钮错误可用、面板残留
  }

  // ---------- 清空/切换尺寸统一入口：四步绑定，顺序不可拆分 ----------
  function resetCanvasState() {
    epoch++;                        // ①a 使在途 importImage 失效（防清空后迟到图片落地）
    suppressUndo = true;            // ①b 抑制 clear 逐对象 object:removed 污染撤销栈
    try {
      canvas.clear();               // ①c clear 会清空 backgroundColor（fabric6.js:2599）
      canvas.backgroundColor = '#ffffff';   // ①d 立即恢复白底（橡皮/白底规格前提）
    } finally { suppressUndo = false; }
    undoStack.length = 0;
    undoStack.push(snapshot());     // ② 丢弃全部历史并重新播种 S0（先于 revoke）
    for (const url of objectUrls) URL.revokeObjectURL(url);   // ③ 统一 revoke（此刻无快照再引用）
    objectUrls.clear();
    dirty = false;
    canvas.discardActiveObject();   // ④ v6 clear 不自动丢选中，防幽灵选中残留
    renderPanel();
    canvas.requestRenderAll();
    ensureButtons();
  }

  function clearWithConfirm() {
    if (!canvas || canvas.getObjects().length === 0) return;
    openConfirm('清空画布？', '画布上的所有内容都会被删除，且无法撤销恢复。', '清空', resetCanvasState);
  }

  function requestSize(w, h) {
    if (!canvas) { initCanvas(w, h); closeModal('mk-size-modal'); return; }
    if (canvas.getObjects().length > 0) {
      openConfirm('切换尺寸？', '切换画布尺寸会清空画布上的所有内容。', '切换', () => applySize(w, h));
      return;
    }
    applySize(w, h);
  }

  function applySize(w, h) {
    closeModal('mk-size-modal');
    resetCanvasState();   // 不重建 fabric 实例：白底恢复 + 弃栈播种 + revoke + 丢选中
    canvas.setDimensions({ width: w, height: h });
    fitStage();
    ensureButtons();
  }

  function showSizeModal() {
    showModal('mk-size-modal');
    $('mk-size-cancel').hidden = !canvas;   // 首次进入必须选尺寸，不给取消
    $('mk-cw').value = '';
    $('mk-ch').value = '';
  }

  // ---------- 导入图片：size/像素/坏图/epoch 四重防护 ----------
  function pickImport() {
    if (!canvas) return;
    exitDrawMode();   // 导入后要选中对象，先退出绘制模式
    $mkFile.click();
  }

  async function importImage(file) {
    if (file.size > MAX_IMPORT_BYTES) return toast('图片太大（限 10MB）');
    const myEpoch = epoch;
    const url = URL.createObjectURL(file);
    try {
      const img = await fabric.Image.fromURL(url);   // v6 返回 Promise；坏图/伪装文件会 reject
      if (epoch !== myEpoch) { URL.revokeObjectURL(url); return; }   // 期间被清空/切尺寸：丢弃
      if (img.width * img.height > MAX_IMPORT_PIXELS) {
        URL.revokeObjectURL(url);
        return toast('图片尺寸过大（像素上限 4096×4096）');
      }
      objectUrls.add(url);   // 加入集合：仅 resetCanvasState 统一 revoke
      const maxSide = Math.max(canvas.getWidth(), canvas.getHeight()) * 0.8;
      img.scale(Math.min(1, maxSide / Math.max(img.width, img.height)));
      img.set({ left: canvas.getWidth() / 2, top: canvas.getHeight() / 2, originX: 'center', originY: 'center' });
      canvas.add(img);
      canvas.setActiveObject(img);   // 发 selection:created → 删除按钮立即可用（不依赖拖拽）
      canvas.requestRenderAll();
      ensureButtons();
    } catch (err) {
      URL.revokeObjectURL(url);
      toast('图片无法读取，请换一张');
    }
  }

  // ---------- 文字 ----------
  function addText() {
    if (!canvas) return;
    exitDrawMode();   // 添加即编辑，先退出绘制模式
    const t = new fabric.IText('双击改字', {
      left: canvas.getWidth() / 2,
      top: canvas.getHeight() / 2,
      originX: 'center',
      originY: 'center',
      fontSize: Math.round(canvas.getWidth() / 8),
      fill: '#333333',
    });
    canvas.add(t);
    canvas.setActiveObject(t);   // 发 selection:created → 删除按钮立即可用
    t.enterEditing();            // 添加即编辑：移动端直接弹键盘，规避触屏双击与拖拽冲突
    canvas.requestRenderAll();
    ensureButtons();
  }

  /** 面板字号/颜色/描边统一入口：程序化改属性不触发 modified → 手动推栈。 */
  function applyTextProp(mutate) {
    const o = canvas.getActiveObject();
    if (!o) return;
    mutate(o);
    canvas.requestRenderAll();
    undoPush();
    renderPanel();
  }

  function setStroke(o, kind) {
    if (kind === 'none') o.set({ strokeWidth: 0 });
    else o.set({ stroke: kind === 'white' ? '#ffffff' : BLACK, strokeWidth: STROKE_WIDTH });
  }

  // ---------- 画笔 / 橡皮 ----------
  function setDrawTool(tool) {
    if (!canvas) return;
    if (canvas.isDrawingMode && drawTool === tool) {
      drawTool = null;            // 再点一次：退出绘制模式，回选择模式
      canvas.isDrawingMode = false;
    } else {
      drawTool = tool;
      canvas.isDrawingMode = true;
      canvas.freeDrawingBrush.color = tool === 'eraser' ? ERASER_COLOR : brushColor;
      canvas.freeDrawingBrush.width = tool === 'eraser' ? ERASER_WIDTH : brushWidth;
    }
    updateToolHighlight();
    renderPanel();
  }

  function exitDrawMode() {
    if (!canvas.isDrawingMode) return;
    drawTool = null;
    canvas.isDrawingMode = false;
    updateToolHighlight();
    renderPanel();
  }

  // ---------- 导出 PNG：fabric 自带 toBlob，恒为逻辑尺寸 ----------
  async function canvasToPngBlob() {
    const blob = await canvas.toBlob({ multiplier: 1 });
    // v6 toBlob 默认 enableRetinaScaling:false → 输出 = 逻辑尺寸 × multiplier，不受 DPR 影响
    if (!blob) throw new Error('导出失败');
    return blob;
  }

  async function exportPng() {
    try {   // 不捕获会成 unhandled promise rejection：用户看到「点了导出没反应」而非提示
      const blob = await canvasToPngBlob();
      const url = URL.createObjectURL(blob);   // 导出临时 URL，用后即 revoke（不动导入集合）
      const a = document.createElement('a');
      a.href = url;
      a.download = `sticker_${stamp()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast('导出失败，请重试');
    }
  }

  // ---------- 上传（复用 /api/upload，在途锁） ----------
  function openUpload() {
    if (!canvas || canvas.getObjects().length === 0) return;
    $mkWork.value = '';
    $mkChars.value = '';
    $mkUploadSubmit.disabled = true;
    showModal('mk-upload-modal');
    $mkWork.focus();
  }

  function parseCharacters(raw) {
    const seen = new Set();
    const out = [];
    for (const part of raw.split(/[,，]/)) {   // 中英文逗号都认
      const s = part.trim().slice(0, CHAR_LEN);
      if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      if (out.length >= CHAR_MAX) break;
    }
    return out;
  }

  async function submitUpload(work, characters) {
    if (submitting) return;   // 防双击/连点并发两次 POST（省 30 次/时限额）
    submitting = true;
    $mkUploadSubmit.disabled = true;
    $mkUploadSubmit.textContent = '上传中…';
    try {
      const blob = await canvasToPngBlob();
      if (blob.size > MAX_UPLOAD_BYTES) return toast('成品超过 8MB，无法上传');
      const fd = new FormData();
      fd.append('file', new File([blob], `maker_${Date.now()}.png`, { type: 'image/png' }));
      fd.append('work', work.trim());
      fd.append('characters', JSON.stringify(characters));   // 空数组服务端也收
      const res = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      dirty = false;
      closeModal('mk-upload-modal');
      showUploadSuccess(work.trim());
    } catch (err) {
      toast(`上传失败：${err.message}`);   // 已覆盖 canvasToPngBlob 的「导出失败」
    } finally {
      submitting = false;
      $mkUploadSubmit.disabled = !$mkWork.value.trim();
      $mkUploadSubmit.textContent = '提交';
    }
  }

  function showUploadSuccess(work) {
    $('mk-success-work').textContent = work;   // textContent：用户输入永不进 innerHTML
    showModal('mk-success-modal');
  }

  // ---------- iOS 键盘遮挡防护（加分项） ----------
  function keyboardShift() {
    if (!canvas) return;
    const vv = window.visualViewport;
    const obj = canvas.getActiveObject();
    if (!vv || !obj || !obj.isEditing) { stageShift.style.transform = ''; return; }
    // wrapperEl = 画布容器，与画布同在被缩放的 #stage-inner 内，rect 已含缩放
    const cRect = canvas.wrapperEl.getBoundingClientRect();
    const r = obj.getBoundingRect();
    const screenBottom = cRect.top + (r.top + r.height) * (cRect.width / canvas.getWidth());
    const over = screenBottom - vv.height * 0.6;   // 对象底部越入可视区下 40%
    stageShift.style.transform = over > 0 ? `translateY(${-Math.min(over, vv.height * 0.5)}px)` : '';
  }

  // ---------- 事件绑定 ----------
  $('mk-size-btn').addEventListener('click', showSizeModal);
  $('mk-size-cancel').addEventListener('click', () => closeModal('mk-size-modal'));
  document.querySelectorAll('.mk-size-preset').forEach((b) => {
    b.addEventListener('click', () => requestSize(+b.dataset.w, +b.dataset.h));
  });
  $('mk-custom-go').addEventListener('click', () => {
    const w = parseInt($('mk-cw').value, 10);
    const h = parseInt($('mk-ch').value, 10);
    if (!Number.isInteger(w) || !Number.isInteger(h) ||
        w < SIZE_MIN || w > SIZE_MAX || h < SIZE_MIN || h > SIZE_MAX) {
      return toast('请输入 64–1000 之间的整数宽高');
    }
    requestSize(w, h);
  });

  $('mk-confirm-cancel').addEventListener('click', () => closeModal('mk-confirm-modal'));
  $('mk-confirm-ok').addEventListener('click', () => {
    closeModal('mk-confirm-modal');
    const action = confirmAction;
    confirmAction = null;
    if (action) action();
  });

  $('mk-import').addEventListener('click', pickImport);
  $mkFile.addEventListener('change', () => {
    if ($mkFile.files[0]) importImage($mkFile.files[0]);
    $mkFile.value = '';   // 允许连续选同一文件
  });
  $('mk-text').addEventListener('click', addText);
  $mkPen.addEventListener('click', () => setDrawTool('pen'));
  $mkEraser.addEventListener('click', () => setDrawTool('eraser'));
  $mkUndo.addEventListener('click', undoRestore);
  $mkDel.addEventListener('click', deleteActive);
  $('mk-clear').addEventListener('click', clearWithConfirm);
  $mkExport.addEventListener('click', exportPng);

  $mkUpload.addEventListener('click', openUpload);
  $('mk-upload-cancel').addEventListener('click', () => closeModal('mk-upload-modal'));
  $('mk-upload-close').addEventListener('click', () => closeModal('mk-upload-modal'));
  $mkWork.addEventListener('input', () => {
    $mkUploadSubmit.disabled = !$mkWork.value.trim();
  });
  $mkUploadSubmit.addEventListener('click', () => {
    const work = $mkWork.value.trim().slice(0, WORK_MAX);
    if (!work) return toast('请填写作品名称');
    submitUpload(work, parseCharacters($mkChars.value));
  });
  $('mk-success-close').addEventListener('click', () => closeModal('mk-success-modal'));

  // 上下文面板：事件委托（字号/颜色/描边/笔宽）
  $mkPanel.addEventListener('click', (e) => {
    const swatch = e.target.closest('.mk-swatch');
    if (swatch) {
      const color = swatch.dataset.color;
      if ($panelText.contains(swatch)) {
        applyTextProp((o) => o.set({ fill: color }));
      } else {
        brushColor = color;
        canvas.freeDrawingBrush.color = color;
        renderPanel();
      }
      return;
    }
    const widthOpt = e.target.closest('#mk-draw-widths [data-width]');
    if (widthOpt) {
      brushWidth = +widthOpt.dataset.width;
      canvas.freeDrawingBrush.width = brushWidth;
      renderPanel();
      return;
    }
    const sizeOpt = e.target.closest('#mk-font-sizes [data-size]');
    if (sizeOpt) {
      // 重置缩放：防手拉缩放后字号显示失真
      applyTextProp((o) => o.set({ fontSize: +sizeOpt.dataset.size, scaleX: 1, scaleY: 1 }));
      return;
    }
    const strokeOpt = e.target.closest('#mk-stroke-opts [data-stroke]');
    if (strokeOpt) applyTextProp((o) => setStroke(o, strokeOpt.dataset.stroke));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['mk-confirm-modal', 'mk-upload-modal', 'mk-success-modal']) {
      if ($(id).classList.contains('show')) return closeModal(id);
    }
    const sizeModal = $('mk-size-modal');
    if (sizeModal.classList.contains('show') && canvas) closeModal('mk-size-modal');   // 首次进入必须选尺寸
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty && canvas && canvas.getObjects().length) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- 启动 ----------
  ensureButtons();   // 画布未建：初始全部禁用
  showSizeModal();   // 首次进入：弹「选择画布尺寸」
})();
