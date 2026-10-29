/**
 * 自制表情制作器 —— 自定义制作（纯前端，无构建）
 *
 * 功能闭环：导入图片 / 贴纸素材 / 文字（描边/阴影/渐变/粗斜体）/ 形状 / 画笔 / 橡皮 /
 *           滤镜（13 预设 + 3 滑块 + 重置）/ 图层管理（缩略图/排序/显隐）/ 图片裁切翻转 / 撤销 / 删除 / 清空 / 导出 PNG / 上传
 * （上传复用现有 /api/upload：作品名必填、角色名选填逗号分隔）。
 *
 * 依赖顺序（见 maker/index.html 页尾）：
 *   js/config.js（window.STICKER_API_BASE）→ vendor/fabric-6.9.1.min.js（window.fabric）
 *   → js/maker-core.js（window.MK_CORE 纯函数）→ js/maker.js
 *
 * 关键实现依据（fabric v6，均已实测）：
 * - 撤销：v6 无内置撤销。add/remove 先改 _objects 后发事件 → 推入的全是变更后快照；
 *   初始播种 S0 空画布锚点；撤销 = pop 丢弃当前帧再加载新栈顶；
 *   splice(1,1) 挤最旧非锚点帧，S0 永驻 index 0（禁用 shift()）。
 * - 导出：canvas.toBlob({ multiplier: 1 }) 恒为逻辑尺寸，不受 devicePixelRatio 影响。
 * - 删除/清空/撤销后必须 discardActiveObject()：v6 remove/clear 不自动丢选中（幽灵选中）。
 * - 文本编辑退出仅在文本变化时 fire object:modified → 不监听 text:editing:exited 做撤销。
 * - 图层排序：preserveObjectStacking=true 关掉「选中即置顶」；moveObjectTo 实测不发事件 → 手动推栈。
 * - 裁切：absolutePositioned clipPath 渲染时按赋值时刻矩阵定位（不跟随对象），
 *   拖动/缩放后须在 object:modified 里按当前缩放几何重算 clip（监听注册先于 undoPush）。
 * - 滤镜：v6 applyFilters 返回 Promise，必须 await 后 requestRenderAll；
 *   滤镜类在 fabric.filters.*（v6 顶层命名空间，非 v5 的 fabric.Image.filters.*）。
 * - 自定义属性 mkShape/_mkClipKind/mkSticker：必须经 MK_CORE.registerShapeSerialization 注册进
 *   fabric.Object.customProperties，否则不进 toJSON 撤销快照（撤销后形状面板失效/图层名失真）。
 */
(function () {
  'use strict';

  // 编辑器组件加载失败（离线/被拦）时不白屏：显示全屏提示横幅
  if (typeof fabric === 'undefined' || typeof MK_CORE === 'undefined') {
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
  const DEFAULT_SIZE = 240;                   // 启动默认画布边长（微信表情规格）；尺寸可随时从菜单第一项改
  const STICKER_FRACTION = 0.3;               // 贴纸插入尺寸 = 画布短边 30%（规格 25% 左右）
  const STICKER_OFFSET = 8;                   // 贴纸居中略偏移：连插 3 枚错开 -8/0/+8px，防完全叠死
  const STICKER_INDEX_URL = 'assets/stickers/stickers.json';   // 贴纸索引（首次打开弹窗时 fetch）
  const THUMB_EDGE = 48;                      // 图层缩略图最长边（显示 32px，2x 高清）
  const SHAPE_EDGE = 60;                      // 形状默认尺寸（圆角矩形 rx = 60×0.2 = 12）
  const SHAPE_SCALE = 3;                      // 心形/星形 24 视图坐标 path → 60px 视觉尺寸的缩放
  // 心形/星形 path data（24×24 视图坐标系标准图形，放大 SHAPE_SCALE 倍后插入）
  const HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
  const STAR_PATH = 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';
  const SHADOW_PRESETS = {                    // 文字阴影（霓虹取当前填充色，构造时特判）
    soft: { color: 'rgba(0,0,0,.35)', blur: 4, offsetX: 2, offsetY: 3 },
    hard: { color: 'rgba(0,0,0,.55)', blur: 0, offsetX: 3, offsetY: 3 },
  };
  const GRADIENT_STOPS = {                    // 文字渐变（首色为面板回显判别的特征色）
    rainbow: [['#ff0000', 0], ['#ff8c00', 0.2], ['#ffe600', 0.4], ['#22c55e', 0.6], ['#1e88e5', 0.8], ['#8e24aa', 1]],
    pinkblue: [['#ff7eb3', 0], ['#7ea8ff', 1]],
    goldred: [['#ffd700', 0], ['#e53935', 1]],
  };
  // 滤镜滑块 ↔ fabric 滤镜类/属性映射（input 实时预览，change 松手才推栈）
  const FILTER_SLIDERS = [
    ['mk-f-brightness', fabric.filters.Brightness, 'brightness'],
    ['mk-f-contrast', fabric.filters.Contrast, 'contrast'],
    ['mk-f-saturation', fabric.filters.Saturation, 'saturation'],
  ];

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
  let paletteMode = null;    // 'shapes'：菜单「⬜ 形状」打开的形状面板态（选中对象后由对象分支接管）
  let shapeFill = '#fdd835'; // 形状默认填充（贴纸黄）
  let shapeStroke = 'none';  // 形状默认描边档位（none/white/black）
  let stickerIndex = null;   // stickers.json 缓存（首次打开贴纸弹窗时 fetch 一次）
  let stickerSeq = 0;        // 贴纸插入序号：决定居中略偏移方向（-8/0/+8 循环）
  const objectUrls = new Set();       // 导入图片的 objectURL：仅 resetCanvasState 统一 revoke
  const filterFlights = new WeakMap();   // 每图在途 applyFilters（不挂 fabric 对象，防 Promise 进 toJSON 快照）
  const filterDirty = new WeakSet();     // 在途期间有新滤镜输入 → 尾随再跑一轮（保证末值生效）

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const stageShift = $('stage-shift');
  const stageInner = $('stage-inner');
  const $mkPanel = $('mk-panel');
  const $panelDraw = $('mk-panel-draw');
  const $panelText = $('mk-panel-text');
  const $panelImage = $('mk-panel-image');
  const $panelShapes = $('mk-panel-shapes');
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
    canvas.preserveObjectStacking = true;   // 图层管理前提：关掉「选中即置顶」，moveObjectTo 排序不被选中行为打乱
    fabric.textureSize = 8192;              // 滤镜纹理缓存上限（导入图最大 4096²，留缓存余量）
    // R10：注册自定义属性序列化——不注册则 mkShape/_mkClipKind 不进撤销快照，
    // 撤销后形状面板打不开、图层名回归「涂鸦」。必须在任何 set({mkShape:true}) 之前执行。
    MK_CORE.registerShapeSerialization(fabric.Object);
    canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);   // v6 无默认画笔实例，必须手动 new
    canvas.freeDrawingBrush.color = brushColor;
    canvas.freeDrawingBrush.width = brushWidth;

    // R11：裁切跟随——absolutePositioned clipPath 的孔洞固定在赋值时刻画布坐标，
    // 拖动/缩放后按当前缩放几何重算 clip。注册必须在 object:modified undoPush 之前：
    // 同事件监听按注册顺序执行，先重算后快照，推入撤销栈的才是「新位置+新 clip」自洽帧。
    canvas.on('object:modified', recomputeClipForActive);
    // 撤销入栈：fabric add/remove 先改 _objects 后发事件 → 推入的全是变更后快照
    canvas.on('object:added', undoPush);
    canvas.on('object:modified', undoPush);
    canvas.on('object:removed', undoPush);
    // 不监听 text:editing:exited 做撤销：v6 文本编辑退出仅在文本变化时 fire
    // object:modified（fabric6.js:21260-21262），双监听会推两份相同快照、撤销多耗一步。

    canvas.on('object:added', ensureButtons);
    canvas.on('object:removed', ensureButtons);
    // 图层面板开着时跟随对象增删/改动/选中刷新（弹窗关闭时函数内一行判断即返回，零成本）
    canvas.on('object:added', refreshLayersIfOpen);
    canvas.on('object:removed', refreshLayersIfOpen);
    canvas.on('object:modified', refreshLayersIfOpen);
    canvas.on('selection:created', refreshLayersIfOpen);
    canvas.on('selection:updated', refreshLayersIfOpen);
    canvas.on('selection:cleared', refreshLayersIfOpen);
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

  /** 面板六分支（顺序即判断优先级）：画笔 → 文字 → 图片 → 形状标记 → 滤镜面板态 → 形状面板态 → 全隐藏。 */
  function renderPanel() {
    if (!canvas) { $mkPanel.hidden = true; return; }
    const obj = canvas.getActiveObject();
    if (canvas.isDrawingMode) { showDrawPanel(); return; }
    if (obj instanceof fabric.IText) { showTextPanel(obj); return; }
    if (obj instanceof fabric.Image) { showImagePanel(obj); return; }
    if (obj && obj.mkShape === true) { showShapesPanel(obj); return; }   // R3：只认打标，严禁 instanceof Path（会把画笔涂鸦误判为形状）
    if (paletteMode === 'filter') { showFilterPanel(); return; }         // 菜单「✨ 滤镜」打开的面板态
    if (paletteMode === 'shapes') { showShapesPanel(null); return; }     // 菜单「⬜ 形状」打开的面板态
    hidePanel();
  }

  function hidePanel() {
    $mkPanel.hidden = true;
    $panelDraw.hidden = true;
    $panelText.hidden = true;
    $panelImage.hidden = true;
    $panelShapes.hidden = true;
    $('mk-filter-hint').hidden = true;   // 提示只属于滤镜面板态，任何分支切换都收起
  }

  /** 分支 1：画笔/橡皮。橡皮固定白 16：不显示色盘/笔宽，只给提示。 */
  function showDrawPanel() {
    const eraser = drawTool === 'eraser';
    hidePanel();
    $mkPanel.hidden = false;
    $panelDraw.hidden = false;
    $('mk-draw-swatches').hidden = eraser;
    $('mk-draw-widths').hidden = eraser;
    $eraserHint.hidden = !eraser;
    markSwatch($('mk-draw-swatches'), canvas.freeDrawingBrush.color);
    markOption($('mk-draw-widths'), `[data-width="${canvas.freeDrawingBrush.width}"]`);
  }

  /** 分支 2：选中文字（基础区不变 + 描边粗细/阴影/渐变/粗斜体状态同步）。 */
  function showTextPanel(obj) {
    hidePanel();
    $mkPanel.hidden = false;
    $panelText.hidden = false;
    markOption($('mk-font-sizes'), `[data-size="${Math.round(obj.fontSize)}"]`);
    markSwatch($('mk-text-swatches'), obj.fill);
    const strokeKey = strokeKeyOf(obj);
    markOption($('mk-stroke-opts'), `[data-stroke="${strokeKey}"]`);
    const $strokeWidth = $('mk-stroke-width');
    $strokeWidth.hidden = strokeKey === 'none';   // 选「无」时滑条隐藏
    if (strokeKey !== 'none') $strokeWidth.value = String(Math.round(obj.strokeWidth || STROKE_WIDTH));
    markOption($('mk-shadow-opts'), `[data-shadow="${shadowKeyOf(obj)}"]`);
    markOption($('mk-gradient-opts'), `[data-gradient="${gradientKeyOf(obj)}"]`);
    $('mk-style-opts').querySelectorAll('.mk-opt').forEach((el) => {
      el.classList.toggle('active',
        el.dataset.style === 'bold' ? obj.fontWeight === 'bold' : obj.fontStyle === 'italic');
    });
  }

  /** 分支 3：选中图片/贴纸（滤镜区 + 变换区状态同步）。 */
  function showImagePanel(obj) {
    hidePanel();
    $mkPanel.hidden = false;
    $panelImage.hidden = false;
    // 滤镜 chips：无滤镜=原图；其余组合难以精确回显，不标
    markOption($('mk-filter-chips'), (obj.filters && obj.filters.length) ? null : '[data-filter="原图"]');
    // 滑块：读当前 filter 实例值（-1~1 → -100~100）
    const filters = obj.filters || [];
    const filterVal = (Cls, prop) => filters.find((f) => f instanceof Cls)?.[prop] ?? 0;
    $('mk-f-brightness').value = String(Math.round(filterVal(fabric.filters.Brightness, 'brightness') * 100));
    $('mk-f-contrast').value = String(Math.round(filterVal(fabric.filters.Contrast, 'contrast') * 100));
    $('mk-f-saturation').value = String(Math.round(filterVal(fabric.filters.Saturation, 'saturation') * 100));
    // 裁切档位与混合模式
    markOption($('mk-clip-opts'), `[data-clip="${obj._mkClipKind || 'none'}"]`);
    $('mk-blend').value = obj.globalCompositeOperation || 'source-over';
  }

  /** 滤镜面板态：菜单「✨ 滤镜」入口，无选中图片时显示控件 + 提示（选中图片后由分支 3 接管）。 */
  function showFilterPanel() {
    hidePanel();
    $mkPanel.hidden = false;
    $panelImage.hidden = false;
    $('mk-filter-hint').hidden = false;
  }

  /** 分支 4/面板态：形状面板（obj 为 null 时显示插入默认值）。 */
  function showShapesPanel(obj) {
    hidePanel();
    $mkPanel.hidden = false;
    $panelShapes.hidden = false;
    markSwatch($('mk-shape-swatches'), obj ? obj.fill : shapeFill);
    markOption($('mk-shape-stroke'), `[data-stroke="${obj ? strokeKeyOf(obj) : shapeStroke}"]`);
  }

  function strokeKeyOf(o) {
    if (!o.strokeWidth || o.stroke == null) return 'none';   // 无描边：宽度 0 或未设色（fabric 默认 strokeWidth=1、stroke=null）
    return String(o.stroke).toLowerCase() === '#ffffff' ? 'white' : 'black';
  }

  function shadowKeyOf(o) {
    const s = o.shadow;
    if (!s) return 'none';
    if (s.blur === 12 && s.offsetX === 0 && s.offsetY === 0) return 'neon';
    if (s.blur === 0) return 'hard';
    if (s.blur === 4) return 'soft';
    return 'none';
  }

  function gradientKeyOf(o) {
    const g = o.fill;
    if (!(g instanceof fabric.Gradient)) return 'plain';
    const first = String(g.colorStops?.[0]?.color ?? '').toLowerCase();
    if (first === '#ff0000') return 'rainbow';
    if (first === '#ff7eb3') return 'pinkblue';
    if (first === '#ffd700') return 'goldred';
    return 'plain';
  }

  function markOption(group, selector) {
    group.querySelectorAll('.mk-opt').forEach((el) => el.classList.remove('active'));
    if (!selector) return;
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
    syncDirtyBridge();
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
      syncDirtyBridge();
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
    syncDirtyBridge();
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
    $('mk-cw').value = '';
    $('mk-ch').value = '';
  }

  // ---------- 导入图片：size/像素/坏图/epoch 四重防护 ----------
  function pickImport() {
    if (!canvas) return;
    exitDrawMode();   // 导入后要选中对象，先退出绘制模式
    paletteMode = null;
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

  // ---------- 贴纸素材库（索引首次打开时 fetch 一次；插入后与导入图片同等待遇） ----------
  async function openStickerModal() {
    if (!canvas) return;
    canvas.discardActiveObject();   // 防文本编辑/键盘与弹窗冲突（同 openMenu 模式）
    showModal('mk-sticker-modal');
    try {
      if (!stickerIndex) {
        const res = await fetch(STICKER_INDEX_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        stickerIndex = await res.json();
      }
    } catch (err) {
      closeModal('mk-sticker-modal');
      return toast('贴纸素材加载失败，请检查网络');
    }
    const check = MK_CORE.validateStickerIndex(stickerIndex);
    if (!check.ok) {
      closeModal('mk-sticker-modal');
      console.error('贴纸索引无效：', check.errors.join('；'));   // 不吞：记录原因，UI 给通用提示
      return toast('贴纸素材异常，请联系管理员');
    }
    renderStickerTabs();
    renderStickerGrid(stickerIndex.packs[0].id);
  }

  function renderStickerTabs() {
    const $tabs = $('mk-sticker-tabs');
    $tabs.textContent = '';
    for (const pack of stickerIndex.packs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mk-sticker-tab';
      btn.dataset.pack = pack.id;
      btn.setAttribute('role', 'tab');
      btn.textContent = `${pack.name}（${pack.items.length}）`;   // textContent：索引为静态自有文件
      $tabs.appendChild(btn);
    }
    $tabs.firstElementChild?.classList.add('active');
  }

  function renderStickerGrid(packId) {
    const pack = stickerIndex.packs.find((p) => p.id === packId);
    if (!pack) return;
    $('mk-sticker-tabs').querySelectorAll('.mk-sticker-tab')
      .forEach((b) => b.classList.toggle('active', b.dataset.pack === packId));
    $('mk-sticker-license').textContent = `许可：${pack.license}`;
    const $grid = $('mk-sticker-grid');
    $grid.textContent = '';
    for (const item of pack.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mk-sticker-cell';
      btn.dataset.file = item.file;
      btn.setAttribute('aria-label', item.name);
      const img = document.createElement('img');
      img.src = 'assets/stickers/' + item.file;   // 静态自有路径，非用户输入
      img.alt = item.name;
      img.loading = 'lazy';   // 懒加载：进入视口才真正请求
      img.decoding = 'async';
      btn.appendChild(img);
      $grid.appendChild(btn);
    }
  }

  async function insertSticker(relPath) {
    if (!canvas) return;
    exitDrawMode();   // R8：画笔模式下不退出，插入后 renderPanel 走画笔分支、看不到图片面板
    paletteMode = null;
    try {
      const img = await fabric.Image.fromURL(relPath);
      const target = Math.min(canvas.getWidth(), canvas.getHeight()) * STICKER_FRACTION;
      img.scale(Math.min(1, target / Math.max(img.width, img.height)));
      const off = (stickerSeq++ % 3 - 1) * STICKER_OFFSET;   // 居中略偏移，连插错开
      img.set({
        left: canvas.getWidth() / 2 + off,
        top: canvas.getHeight() / 2 + off,
        originX: 'center',
        originY: 'center',
        mkSticker: true,   // 图层名「贴纸 N」的判定标记（已注册进 customProperties）
      });
      canvas.add(img);   // object:added → 自动推撤销栈
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
      ensureButtons();
    } catch (err) {
      toast('贴纸加载失败，请重试');
    }
  }
  function addText() {
    if (!canvas) return;
    exitDrawMode();   // 添加即编辑，先退出绘制模式
    paletteMode = null;
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
    const patch = kind === 'none'
      ? { strokeWidth: 0 }
      : { stroke: kind === 'white' ? '#ffffff' : BLACK, strokeWidth: STROKE_WIDTH };
    if (typeof o.set === 'function') o.set(patch);   // fabric 对象：走 set 通道
    else Object.assign(o, patch);                    // 纯对象（makeShape 的 base 配置）：直接合并
  }

  // ---------- 文字特效：阴影 / 渐变字 / 粗斜体（全部走 applyTextProp 通道） ----------
  function applyTextShadow(key) {
    applyTextProp((o) => {
      if (key === 'none') return o.set('shadow', null);
      if (key === 'neon') {   // 霓虹发光：描边+光晕同取当前填充色（渐变字等非纯色填充时回退黑）
        const color = typeof o.fill === 'string' ? o.fill : BLACK;
        return o.set({ stroke: color, strokeWidth: STROKE_WIDTH,
          shadow: new fabric.Shadow({ color, blur: 12, offsetX: 0, offsetY: 0 }) });
      }
      o.set('shadow', new fabric.Shadow(SHADOW_PRESETS[key]));
    });
  }

  function applyTextGradient(key) {
    applyTextProp((o) => {
      if (key === 'plain') return o.set('fill', BLACK);
      o.set('fill', new fabric.Gradient({
        type: 'linear',
        gradientUnits: 'pixels',
        coords: { x1: 0, y1: 0, x2: Math.max(1, o.width), y2: 0 },   // 按对象当前宽重算
        colorStops: GRADIENT_STOPS[key].map(([color, offset]) => ({ offset, color })),
      }));
    });
  }

  function toggleTextStyle(key) {
    applyTextProp((o) => {
      if (key === 'bold') o.set({ fontWeight: o.fontWeight === 'bold' ? 'normal' : 'bold' });
      else o.set({ fontStyle: o.fontStyle === 'italic' ? 'normal' : 'italic' });
    });
  }

  // ---------- 形状：菜单入口 / 构造 / 插入（R8：插入第一步 exitDrawMode） ----------
  function showShapePanel() {
    if (!canvas) return;
    exitDrawMode();
    paletteMode = 'shapes';
    renderPanel();
  }

  /** 按 kind 构造形状（默认 60×60、圆角矩形 rx=12）；全部打 mkShape 标记（含心形/星形 Path）。 */
  function makeShape(kind) {
    const base = {
      left: canvas.getWidth() / 2,
      top: canvas.getHeight() / 2,
      originX: 'center',
      originY: 'center',
      fill: shapeFill,
      mkShape: true,   // R3：与 renderPanel 分支 4 / 图层名同一判定标记
    };
    setStroke(base, shapeStroke);
    switch (kind) {
      case 'rect': return new fabric.Rect({ ...base, width: SHAPE_EDGE, height: SHAPE_EDGE });
      case 'circle': return new fabric.Circle({ ...base, radius: SHAPE_EDGE / 2 });
      case 'ellipse': return new fabric.Ellipse({ ...base, rx: SHAPE_EDGE * 0.6, ry: SHAPE_EDGE * 0.4 });
      case 'rounded':
        return new fabric.Rect({ ...base, width: SHAPE_EDGE, height: SHAPE_EDGE, rx: SHAPE_EDGE * 0.2, ry: SHAPE_EDGE * 0.2 });
      case 'triangle': return new fabric.Triangle({ ...base, width: SHAPE_EDGE, height: SHAPE_EDGE * 0.9 });
      case 'heart': case 'star': {
        const obj = new fabric.Path(kind === 'heart' ? HEART_PATH : STAR_PATH, base);
        obj.scale(SHAPE_SCALE);   // 24 视图坐标 → 60px 视觉尺寸
        return obj;
      }
      default: return null;
    }
  }

  function insertShape(kind) {
    if (!canvas) return;
    exitDrawMode();   // R8：画笔模式下不退出，选中形状却看到画笔面板、画布点按仍在涂鸦
    paletteMode = null;   // 插入后 setActiveObject → 分支 4 接管面板
    const obj = makeShape(kind);
    if (!obj) return;
    canvas.add(obj);   // object:added → 自动推撤销栈
    canvas.setActiveObject(obj);
    canvas.requestRenderAll();
    ensureButtons();
  }

  /** 形状面板填色/描边：有选中形状 → 应用；无选中（面板态）→ 改插入默认值。 */
  function applyShapeFill(color) {
    const obj = canvas.getActiveObject();
    if (obj && obj.mkShape === true) applyTextProp((o) => o.set({ fill: color }));
    else { shapeFill = color; renderPanel(); }
  }

  function applyShapeStroke(kind) {
    const obj = canvas.getActiveObject();
    if (obj && obj.mkShape === true) applyTextProp((o) => setStroke(o, kind));
    else { shapeStroke = kind; renderPanel(); }
  }

  // ---------- 图片滤镜（预设 + 滑块，v6 applyFilters 为 Promise，必须 await） ----------
  /**
   * 对单图应用当前 filters。在途锁：新输入只更新 filter 实例值并置 dirty，
   * 在途轮完成后尾随再跑一轮（末值生效）；禁止并发 applyFilters 交错。
   */
  function applyImageFilters(img) {
    if (filterFlights.has(img)) {
      filterDirty.add(img);
      return filterFlights.get(img);   // 等在途轮（含本次值）完成
    }
    const flight = (async () => {
      try {
        do {
          filterDirty.delete(img);
          await img.applyFilters();        // await 后渲染：否则首帧仍是未滤镜画面（「点了没反应」）
          canvas.requestRenderAll();
        } while (filterDirty.has(img));
      } catch (err) {
        console.error('滤镜应用失败：', err?.message ?? err);   // 不吞异常：记录原因，画布保留旧图
      } finally {
        filterFlights.delete(img);
        if (filterDirty.has(img)) applyImageFilters(img);   // 关最后窗口竞态：残留 dirty 尾随收敛
      }
    })();
    filterFlights.set(img, flight);
    return flight;
  }

  async function applyFilterPreset(key) {
    const img = canvas.getActiveObject();
    if (!(img instanceof fabric.Image)) return toast('请先点选画布中的图片');   // 滤镜面板态下未选中：引导
    img.filters = MK_CORE.filterPresets(fabric)[key] ?? [];   // 一次点击只推 1 帧
    await applyImageFilters(img);
    undoPush();   // await 之后推栈：快照为过滤后状态
    renderPanel();
  }

  /** 新建同名 filter 实例改值（不原地 mutate），无同名则追加。 */
  function setImageFilterValue(img, FilterClass, prop, sliderValue) {
    const inst = new FilterClass({ [prop]: MK_CORE.clampFilterValue(sliderValue) });
    const filters = img.filters || (img.filters = []);
    const i = filters.findIndex((f) => f instanceof FilterClass);
    if (i >= 0) filters[i] = inst;
    else filters.push(inst);
  }

  /** 滑块 input：实时预览，不推栈。 */
  function onFilterSliderInput(slider, FilterClass, prop) {
    const img = canvas.getActiveObject();
    if (!(img instanceof fabric.Image)) return;
    setImageFilterValue(img, FilterClass, prop, +slider.value);
    applyImageFilters(img);
  }

  /** 滑块 change：松手才推 1 帧（尾随轮完成后推）。 */
  function onFilterSliderChange(slider, FilterClass, prop) {
    const img = canvas.getActiveObject();
    if (!(img instanceof fabric.Image)) return toast('请先点选画布中的图片');
    setImageFilterValue(img, FilterClass, prop, +slider.value);
    applyImageFilters(img).then(() => undoPush());
  }

  /** 「重置」按钮：清空滤镜并同步滑块回 0，一次点击推 1 帧。 */
  async function filterReset() {
    const img = canvas.getActiveObject();
    if (!(img instanceof fabric.Image)) return toast('请先点选画布中的图片');
    img.filters = [];
    await applyImageFilters(img);
    undoPush();
    renderPanel();   // 滑块回 0、chips 标记「原图」
  }

  // ---------- 图片变换：翻转 / 裁切（circle|rounded|ellipse|none）/ 混合模式 ----------
  function flipActive(axis) {
    const img = canvas.getActiveObject();
    if (!(img instanceof fabric.Image)) return;
    if (img.clipPath) return toast('先恢复原图再翻转');   // clipPath 镜像坐标边角 bug 规避
    img.toggle(axis);
    canvas.requestRenderAll();
    undoPush();   // 程序化改属性不触发 modified → 手动推栈
  }

  /** 官方配方裁切：scale 全程不动，clip 按缩放后可见尺寸计算；恢复原图只清 clipPath。 */
  function setClipPath(kind) {
    const img = canvas.getActiveObject();
    if (!(img instanceof fabric.Image)) return;
    const { clipParams } = MK_CORE.computeCropGeometry(kind, img.width, img.height, img.scaleX, img.scaleY);
    img.set('clipPath', clipParams ? new fabric[clipParams.type](clipParams.props) : undefined);
    img.set('_mkClipKind', clipParams ? kind : undefined);   // R11：记类型供 modified 重算
    canvas.requestRenderAll();
    undoPush();
    renderPanel();
  }

  /** R11：裁切后拖动/缩放跟随——按当前缩放几何重算 clipPath，绝不动 scale/left/top。
   *  由 initCanvas 注册（先于 object:modified undoPush），不手动 undoPush。 */
  function recomputeClipForActive() {
    const obj = canvas.getActiveObject();
    if (!(obj instanceof fabric.Image) || !obj.clipPath || !obj._mkClipKind) return;
    const { clipParams } = MK_CORE.computeCropGeometry(obj._mkClipKind, obj.width, obj.height, obj.scaleX, obj.scaleY);
    if (clipParams) obj.set('clipPath', new fabric[clipParams.type](clipParams.props));
    canvas.requestRenderAll();
  }

  function applyBlendMode() {
    const img = canvas.getActiveObject();
    if (!(img instanceof fabric.Image)) return;
    img.set('globalCompositeOperation', $('mk-blend').value);
    canvas.requestRenderAll();
    undoPush();
  }

  // ---------- 画笔 / 橡皮 ----------
  function setDrawTool(tool) {
    if (!canvas) return;
    if (canvas.isDrawingMode && drawTool === tool) {
      drawTool = null;            // 再点一次：退出绘制模式，回选择模式
      canvas.isDrawingMode = false;
    } else {
      drawTool = tool;
      paletteMode = null;         // 进入绘制模式：形状面板态让位给画笔面板
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

  // ---------- 导出 PNG：浏览器 a[download] / App WebView 分块桥 ----------
  let bridgeSaving = false;   // 分块协议防重入：协议要求独占缓冲，连点导出只提示不并发

  /** App WebView 脏状态同步：Android WebView 不派发 beforeunload，App 靠此感知丢稿风险 */
  function syncDirtyBridge() {
    window.AndroidBridge?.setDirty(!!(dirty && canvas && canvas.getObjects().length));
  }

  /** App 桥分块保存：单块 ≤128KB（base64 经 Binder 以 UTF-16 传输后约 256KB，远低于 ~1MB 事务上限），
   *  1000×1000 复杂 PNG（数 MB）也不会触发 TransactionTooLargeException，故不设体积上限。
   *  savePngEnd 同步返回保存结果（@JavascriptInterface 返回值同步回传 JS）——只有 true 才清 dirty。 */
  function bridgeSavePng(blob, name) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const dataUrl = String(fr.result);
          const b64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7);
          const CHUNK = 128 * 1024;                     // 分块长度（Binder 事务护栏）
          window.AndroidBridge.savePngStart(name, Math.ceil(b64.length / CHUNK));
          for (let i = 0; i < b64.length; i += CHUNK) {
            window.AndroidBridge.savePngChunk(Math.floor(i / CHUNK), b64.slice(i, i + CHUNK));
          }
          resolve(window.AndroidBridge.savePngEnd(name) === true);
        } catch (err) { resolve(false); }
      };
      fr.onerror = () => resolve(false);
      fr.readAsDataURL(blob);
    });
  }

  async function exportPng() {
    if (bridgeSaving) return toast('正在保存，请稍候');
    try {   // 不捕获会成 unhandled promise rejection：用户看到「点了导出没反应」而非提示
      const blob = await canvasToPngBlob();
      const name = `sticker_${stamp()}.png`;
      if (window.AndroidBridge?.savePngChunk) {   // App WebView：分块交给原生保存到相册
        let saved;
        bridgeSaving = true;
        try { saved = await bridgeSavePng(blob, name); } finally { bridgeSaving = false; }
        if (!saved) return toast('保存失败，请重试');   // R15：失败不清脏，退出仍提示丢稿
      } else {                                     // 浏览器：a[download]（不限体积，无需护栏）
        const url = URL.createObjectURL(blob);     // 导出临时 URL，用后即 revoke（不动导入集合）
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);   // 根因修复：原写法 10,000 带数字分隔符（ES2021，Chrome 75+），是全页唯一 ES2021 语法；改为 10000 后全页地板降到 ES2020（Chrome 80）
      }
      dirty = false;                        // R14/R15：只有保存成功才清脏（失败已在上面 return）
      syncDirtyBridge();
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
      syncDirtyBridge();
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

  // ---------- 图层管理（列表自上而下 = 画布 z 序自顶向下） ----------
  function openLayersModal() {
    if (!canvas) return;
    canvas.discardActiveObject();   // 防文本编辑/键盘与弹窗冲突（同 openMenu 模式）
    renderLayers();
    showModal('mk-layers-modal');
  }

  /** 图层行元信息：icon + 类别键（类别键同时用作 layerName 的类别内序号计数）。 */
  function layerMeta(obj) {
    const type = String(obj.type ?? '');
    if (type === 'i-text' || type === 'text' || type === 'textbox') return { icon: 'A', cat: 'text' };
    if (obj.mkSticker === true) return { icon: '😄', cat: 'sticker' };   // 贴纸是 Image，必须先于 image 判定
    if (obj.mkShape === true) return { icon: '⬜', cat: 'shape' };
    if (type === 'image') return { icon: '🖼', cat: 'image' };
    return { icon: '✏️', cat: 'doodle' };
  }

  /** 图片对象缩略图数据源：缩放截取（multiplier 压到最长边 ≤ THUMB_EDGE），失败回退空串。 */
  function imageThumbSrc(obj) {
    try {
      const w = obj.width * obj.scaleX;
      const h = obj.height * obj.scaleY;
      if (!(w > 0) || !(h > 0)) return '';
      return obj.toDataURL({ format: 'png', multiplier: Math.min(1, THUMB_EDGE / Math.max(w, h)) });
    } catch (err) { return ''; }
  }

  /** 图层缩略图：图片 = 缩放截取 <img>；其余 = 填充/描边色纯色块（无则灰），块内放类型图标。 */
  function layerThumb(obj, icon) {
    const box = document.createElement('span');
    box.className = 'mk-layer-thumb';
    if (obj instanceof fabric.Image) {
      const src = imageThumbSrc(obj);
      if (src) {
        const img = document.createElement('img');
        img.className = 'mk-layer-thumb-img';
        img.alt = '';
        img.src = src;   // 静态自有数据：toDataURL 产物或对象自带 URL，非用户输入
        box.appendChild(img);
        return box;
      }
    }
    const color = typeof obj.fill === 'string' ? obj.fill
      : (typeof obj.stroke === 'string' ? obj.stroke : '#cccccc');
    box.style.background = color;
    box.textContent = icon;
    return box;
  }

  function renderLayers() {
    const $list = $('mk-layers-list');
    $list.textContent = '';
    const objs = [...canvas.getObjects()].reverse();   // getObjects 为 [底..顶]，反转为顶→底展示
    const kindCount = {};   // 类别内序号计数：layerName 的序号语义 = 同类第 N 个，非行号
    objs.forEach((obj) => {
      const { icon, cat } = layerMeta(obj);
      const ordinal = kindCount[cat] = (kindCount[cat] ?? 0) + 1;
      const row = document.createElement('div');
      row.className = 'mk-layer-row' + (obj.visible ? '' : ' mk-layer-off');
      const iconEl = document.createElement('span');
      iconEl.className = 'mk-layer-icon';
      iconEl.textContent = icon;
      const name = document.createElement('span');
      name.className = 'mk-layer-name';
      name.textContent = MK_CORE.layerName(obj, ordinal - 1);   // textContent：名称含用户文本，不进 innerHTML
      row.append(layerThumb(obj, icon), iconEl, name);
      row.append(layerBtn('⬆', '上移一层', () => moveLayer(obj, 1)));
      row.append(layerBtn('⬇', '下移一层', () => moveLayer(obj, -1)));
      row.append(layerBtn(obj.visible ? '👁' : '🚫', obj.visible ? '隐藏' : '显示', () => toggleLayerVisible(obj)));
      row.append(layerBtn('🗑', '删除图层', () => deleteLayer(obj)));
      row.addEventListener('click', () => onLayerRowClick(obj));
      $list.appendChild(row);
    });
  }

  /** 图层面板开着时跟随画布事件刷新（增删/改动/选中变化；顺序变化由 moveLayer 手动刷）。 */
  function refreshLayersIfOpen() {
    if ($('mk-layers-modal').classList.contains('show')) renderLayers();
  }

  /** 操作钮：stopPropagation 不触发行选中；≥40px 触控区。 */
  function layerBtn(text, label, action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mk-layer-btn';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (e) => { e.stopPropagation(); action(); });
    return b;
  }

  /** R13：行点击第一步 exitDrawMode（否则 renderPanel 走画笔分支、画布点按仍在涂鸦）。 */
  function onLayerRowClick(obj) {
    exitDrawMode();
    canvas.setActiveObject(obj);   // 发 selection:created → renderPanel 弹对应面板
    closeModal('mk-layers-modal');
    renderPanel();
    canvas.requestRenderAll();
  }

  /** ⬆⬇：moveObjectTo 实测不发事件 → 手动推栈（R12）。dir=+1 向顶层移，dir=-1 向底层移。 */
  function moveLayer(obj, dir) {
    const objs = canvas.getObjects();
    const i = objs.indexOf(obj);
    if (i < 0) return;
    const j = MK_CORE.moveLayerIndex(objs, i, dir);
    if (j === i) return;
    canvas.moveObjectTo(obj, j);
    canvas.requestRenderAll();
    undoPush();
    renderLayers();
  }

  /** 👁：visible 赋值不发事件 → 手动推栈（R12）。 */
  function toggleLayerVisible(obj) {
    obj.visible = !obj.visible;
    canvas.requestRenderAll();
    undoPush();
    renderLayers();
  }

  /** 🗑：canvas.remove 必发 object:removed → 自动推 1 帧 + refreshLayersIfOpen 刷新列表；
   *  禁止手动 undoPush（R12：双推会一次删除入两帧相同快照，第一次撤销「没反应」、要连按两次）。 */
  function deleteLayer(obj) {
    canvas.remove(obj);
  }

  // ---------- 汉堡菜单 ----------
  const $mkMenu = $('mk-menu');
  const $mkMenuBtn = $('mk-menu-btn');
  const $mkMenuBackdrop = $('mk-menu-backdrop');

  /** R2：滤镜菜单入口——弹滤镜面板（paletteMode='filter'），滤镜作用于当前选中图片；
   *  无选中图片时面板亮出提示文案并 toast 引导点选（openMenu 已清空选中，正常都走此分支）。 */
  function filterMenuTip() {
    if (!canvas) return;
    exitDrawMode();   // 画笔模式下点完提示去点图片，别还在涂鸦
    if (canvas.getActiveObject() instanceof fabric.Image) {
      paletteMode = null;   // 已有选中图片：分支 3 直接接管
      renderPanel();
      return;
    }
    paletteMode = 'filter';
    renderPanel();
    toast('请先点选画布中的图片');
  }

  function openMenu() {
    if (canvas) canvas.discardActiveObject();   // R12：退出文本编辑/收起键盘，防抽屉与编辑态冲突
    $mkMenu.classList.add('open');
    $mkMenuBackdrop.hidden = false;
    $mkMenuBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    $mkMenu.classList.remove('open');
    $mkMenuBackdrop.hidden = true;
    $mkMenuBtn.setAttribute('aria-expanded', 'false');
  }
  $mkMenuBtn.addEventListener('click', () => ($mkMenu.classList.contains('open') ? closeMenu() : openMenu()));
  $mkMenuBackdrop.addEventListener('click', closeMenu);
  // R7：捕获阶段关闭。disabled 按钮（撤销/删除/导出灰态）点击被浏览器重定向到容器（target=$mkMenu），
  // 目标/冒泡阶段监听收不到，捕获阶段能收到——点灰项菜单也收起、不显「卡死」。
  // 捕获先于目标执行：菜单先关，叶子项自身动作（showSizeModal 等）随后照常执行，互不依赖。
  $mkMenu.addEventListener('click', closeMenu, true);
  closeMenu();   // R1：载入兜底（HTML 已带 hidden 属性，双保险）

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
  $('mk-sticker').addEventListener('click', openStickerModal);
  $('mk-shape').addEventListener('click', showShapePanel);
  $('mk-filter').addEventListener('click', filterMenuTip);
  $('mk-layers').addEventListener('click', openLayersModal);
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

  // 上下文面板：事件委托（文字/形状/画笔/滤镜/变换全部控件）
  $mkPanel.addEventListener('click', (e) => {
    const swatch = e.target.closest('.mk-swatch');
    if (swatch) {
      const color = swatch.dataset.color;
      if ($panelText.contains(swatch)) {
        applyTextProp((o) => o.set({ fill: color }));
      } else if ($panelShapes.contains(swatch)) {
        applyShapeFill(color);
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
    const shapeBtn = e.target.closest('#mk-shape-kinds [data-shape]');
    if (shapeBtn) { insertShape(shapeBtn.dataset.shape); return; }
    const shapeStrokeOpt = e.target.closest('#mk-shape-stroke [data-stroke]');
    if (shapeStrokeOpt) { applyShapeStroke(shapeStrokeOpt.dataset.stroke); return; }
    const shadowOpt = e.target.closest('#mk-shadow-opts [data-shadow]');
    if (shadowOpt) { applyTextShadow(shadowOpt.dataset.shadow); return; }
    const gradOpt = e.target.closest('#mk-gradient-opts [data-gradient]');
    if (gradOpt) { applyTextGradient(gradOpt.dataset.gradient); return; }
    const styleOpt = e.target.closest('#mk-style-opts [data-style]');
    if (styleOpt) { toggleTextStyle(styleOpt.dataset.style); return; }
    const filterChip = e.target.closest('#mk-filter-chips [data-filter]');
    if (filterChip) { applyFilterPreset(filterChip.dataset.filter); return; }
    const filterResetBtn = e.target.closest('#mk-filter-reset');
    if (filterResetBtn) { filterReset(); return; }
    const flipH = e.target.closest('#mk-flip-h');
    if (flipH) { flipActive('flipX'); return; }
    const flipV = e.target.closest('#mk-flip-v');
    if (flipV) { flipActive('flipY'); return; }
    const clipOpt = e.target.closest('#mk-clip-opts [data-clip]');
    if (clipOpt) { setClipPath(clipOpt.dataset.clip); return; }
  });

  // 滤镜滑块：input 实时预览（不推栈），change 松手推 1 帧
  for (const [id, FilterClass, prop] of FILTER_SLIDERS) {
    const slider = $(id);
    slider.addEventListener('input', () => onFilterSliderInput(slider, FilterClass, prop));
    slider.addEventListener('change', () => onFilterSliderChange(slider, FilterClass, prop));
  }
  // 文字描边粗细滑条：input 实时改，change 才推栈（仅在有描边时可达）
  const $strokeWidth = $('mk-stroke-width');
  $strokeWidth.addEventListener('input', () => {
    const o = canvas.getActiveObject();
    if (o instanceof fabric.IText && o.strokeWidth) {
      o.set({ strokeWidth: +$strokeWidth.value });
      canvas.requestRenderAll();
    }
  });
  $strokeWidth.addEventListener('change', () => {
    // change 必须推 1 帧：input 已实时改值，change 是拖拽的提交点（不推则滑条操作无法撤销）
    const o = canvas.getActiveObject();
    if (o instanceof fabric.IText && o.strokeWidth) {
      applyTextProp((x) => x.set({ strokeWidth: +$strokeWidth.value }));
    }
  });
  // 图片混合模式下拉：选中即生效
  $('mk-blend').addEventListener('change', applyBlendMode);

  // 贴纸弹窗：tab 切换 / 网格点选插入 / 关闭
  $('mk-sticker-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.mk-sticker-tab');
    if (tab) renderStickerGrid(tab.dataset.pack);
  });
  $('mk-sticker-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.mk-sticker-cell');
    if (!cell) return;
    closeModal('mk-sticker-modal');
    insertSticker('assets/stickers/' + cell.dataset.file);
  });
  $('mk-sticker-close').addEventListener('click', () => closeModal('mk-sticker-modal'));
  $('mk-layers-close').addEventListener('click', () => closeModal('mk-layers-modal'));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($mkMenu.classList.contains('open')) return closeMenu();   // 优先级：抽屉 > 弹窗
    for (const id of ['mk-size-modal', 'mk-confirm-modal', 'mk-upload-modal', 'mk-success-modal', 'mk-sticker-modal', 'mk-layers-modal']) {
      if ($(id).classList.contains('show')) return closeModal(id);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    syncDirtyBridge();   // Android WebView 不派发本事件：靠 setDirty 桥让 App 端感知
    if (dirty && canvas && canvas.getObjects().length) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- 启动 ----------
  initCanvas(DEFAULT_SIZE, DEFAULT_SIZE);   // 默认 240×240 直启可用；initCanvas 内部已 ensureButtons()
  syncDirtyBridge();                        // App 端初始置非脏
})();
