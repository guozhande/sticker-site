/**
 * 制作器纯函数模块（零 DOM 依赖，node:test 直测）
 *
 * UMD：浏览器挂 window.MK_CORE；node 走 module.exports。
 * 与 js/maker.js 的分工：本文件只放无副作用纯函数/常量映射，DOM 与 canvas 操作全在 maker.js。
 *
 * 设计依据（fabric 6.9.1，均经 node 构建实测）：
 * - v6 滤镜类在顶层命名空间 fabric.filters.*（非 v5 的 fabric.Image.filters.*）；
 * - fabric.Object.customProperties 默认空数组，toObject 只序列化注册过的自定义属性
 *   → 形状标记 mkShape / 裁切标记 _mkClipKind / 贴纸标记 mkSticker 必须先
 *     registerShapeSerialization 注册，否则不进撤销快照（撤销后形状面板打不开、图层名失真）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MK_CORE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 图层排序 ----------
  /**
   * 列表内上下移动：返回钳制后的目标下标（dir<0 向列表头移动，dir>0 向列表尾移动）。
   * 顶/底越界或非法输入 → 原下标不动。纯函数不修改 list。
   */
  function moveLayerIndex(list, i, dir) {
    const len = Array.isArray(list) ? list.length : 0;
    const step = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    if (!len || !step || !Number.isInteger(i) || i < 0 || i >= len) return i;
    const j = i + step;
    return j < 0 || j >= len ? i : j;
  }

  // ---------- 滤镜 ----------
  /** 滑块 -100~100 → fabric 滤镜参数 -1~1（越界钳制，非数字归 0）。 */
  function clampFilterValue(v) {
    return Math.max(-100, Math.min(100, Number(v) || 0)) / 100;
  }

  // 13 个预设 chip 定义：[标签, 工厂]。原图为空滤镜（恢复无滤镜状态）。
  // 注意 v6 滤镜类在 fabric.filters.*（v5 的 fabric.Image.filters.* 在 v6.9.1 已不存在）。
  // 冷色/暖色用 ColorMatrix 5×4 矩阵调色（每行 = R/G/B/A 通道系数 + 偏移）。
  // 冷色：压红抬蓝；暖色：抬红压蓝。偏移控制在 ±15 内，避免高光/暗部溢出。
  const COOL_MATRIX = [0.95, 0, 0, 0, -10, 0, 1, 0, 0, 0, 0, 0, 1.1, 0, 15, 0, 0, 0, 1, 0];
  const WARM_MATRIX = [1.05, 0, 0, 0, 15, 0, 1, 0, 0, 5, 0, 0, 0.9, 0, -15, 0, 0, 0, 1, 0];
  const PRESET_DEFS = [
    ['原图', null],
    ['变亮', (F) => new F.filters.Brightness({ brightness: 0.3 })],
    ['变暗', (F) => new F.filters.Brightness({ brightness: -0.3 })],
    ['高对比', (F) => new F.filters.Contrast({ contrast: 0.35 })],
    ['更鲜艳', (F) => new F.filters.Saturation({ saturation: 0.45 })],
    ['黑白', (F) => new F.filters.Grayscale()],
    ['反色', (F) => new F.filters.Invert()],
    ['复古', (F) => new F.filters.Sepia()],
    ['老照片', (F) => new F.filters.Vintage()],
    ['冷色', (F) => new F.filters.ColorMatrix({ matrix: COOL_MATRIX })],
    ['暖色', (F) => new F.filters.ColorMatrix({ matrix: WARM_MATRIX })],
    ['模糊', (F) => new F.filters.Blur({ blur: 0.35 })],
    ['像素化', (F) => new F.filters.Pixelate({ blocksize: 8 })],
  ];

  /**
   * 预设 chip 标签 → 滤镜实例数组（每次调用新建实例，绝不共享可变 filter 对象）。
   * 原图 = 空数组；fabricNs 缺失/无 filters 命名空间时返回 {}（调用方自判）。
   */
  function filterPresets(fabricNs) {
    const out = {};
    if (!fabricNs || !fabricNs.filters) return out;
    for (const [label, make] of PRESET_DEFS) out[label] = make ? [make(fabricNs)] : [];
    return out;
  }

  // ---------- 图片裁切 ----------
  const CLIP_KINDS = ['circle', 'rounded', 'ellipse', 'none'];

  /**
   * 官方配方裁切几何：对象 scale 全程不动（不归一化），clip 尺寸按缩放后可见尺寸计算，
   * absolutePositioned:true 以对象视觉中心定位。返回 { clipParams, newScale }；
   * clipParams = { type: 构造类名, props: 构造参数 } 或 null（'none'/非法输入）。
   * newScale 恒为 null：恢复原图只清 clipPath，绝不动 scale。
   */
  function computeCropGeometry(kind, naturalW, naturalH, scaleX = 1, scaleY = 1) {
    if (!CLIP_KINDS.includes(kind) || kind === 'none') return { clipParams: null, newScale: null };
    // 防御：非正数/NaN 一律按无裁切处理（NaN 与任何比较都为 false，天然落入此守卫）
    if (!(naturalW > 0) || !(naturalH > 0) || !(scaleX > 0) || !(scaleY > 0)) {
      return { clipParams: null, newScale: null };
    }
    const scaledW = naturalW * scaleX;
    const scaledH = naturalH * scaleY;
    const minSide = Math.min(scaledW, scaledH);
    const center = { originX: 'center', originY: 'center', absolutePositioned: true };
    const clipParams = {
      circle: { type: 'Circle', props: { radius: minSide / 2, ...center } },
      rounded: {
        type: 'Rect',
        props: { width: scaledW, height: scaledH, rx: minSide * 0.2, ry: minSide * 0.2, ...center },
      },
      ellipse: { type: 'Ellipse', props: { rx: scaledW / 2, ry: scaledH / 2, ...center } },
    }[kind];
    return { clipParams, newScale: null };
  }

  // ---------- 图层命名 ----------
  /**
   * 图层显示名（与 renderPanel 面板分支同一标记判定，杜绝同一对象两种名字）：
   * IText 取文本前 6 字；mkSticker 标记 → 「贴纸」+序号；mkShape 标记 → 「形状」+序号；
   * Image → 「图片」+序号；无标记 Path（画笔涂鸦）等其余对象 → 「涂鸦」+序号。
   */
  function layerName(obj, index) {
    const n = (Number(index) || 0) + 1;
    if (!obj) return '图层' + n;
    const type = String(obj.type ?? '');
    if (type === 'i-text' || type === 'text' || type === 'textbox') {
      return String(obj.text ?? '').slice(0, 6) || ('文字' + n);
    }
    if (obj.mkSticker === true) return '贴纸' + n;   // 贴纸是 Image，必须先于 image 分支判定
    if (obj.mkShape === true) return '形状' + n;
    if (type === 'image') return '图片' + n;
    return '涂鸦' + n;
  }

  // ---------- 贴纸索引校验 ----------
  /**
   * stickers.json 结构校验：返回 { ok, errors[] }。
   * 拒绝：非对象/无 packs、pack 缺 id/name/license 或 items 空、item 缺 file/name、file 跨包重复。
   */
  function validateStickerIndex(json) {
    const errors = [];
    if (!json || typeof json !== 'object' || !Array.isArray(json.packs) || json.packs.length === 0) {
      return { ok: false, errors: ['贴纸索引缺少 packs 列表'] };
    }
    const seenFiles = new Set();
    json.packs.forEach((pack, pi) => {
      const tag = `第 ${pi + 1} 个贴纸包`;
      if (!pack || typeof pack !== 'object') return errors.push(`${tag}不是对象`);
      if (!String(pack.id ?? '').trim()) errors.push(`${tag}缺少 id`);
      if (!String(pack.name ?? '').trim()) errors.push(`${tag}缺少 name`);
      if (!String(pack.license ?? '').trim()) errors.push(`${tag}缺少 license`);
      if (!Array.isArray(pack.items) || pack.items.length === 0) return errors.push(`${tag}的 items 为空`);
      pack.items.forEach((item, ii) => {
        const tag2 = `${tag}第 ${ii + 1} 枚`;
        const file = String(item?.file ?? '').trim();
        const name = String(item?.name ?? '').trim();
        if (!file) errors.push(`${tag2}缺少 file`);
        if (!name) errors.push(`${tag2}缺少 name`);
        if (file && seenFiles.has(file)) errors.push(`${tag2}的 file 重复：${file}`);
        if (file) seenFiles.add(file);
      });
    });
    return { ok: errors.length === 0, errors };
  }

  // ---------- 自定义属性序列化注册 ----------
  /**
   * 幂等注册 mkShape / _mkClipKind / mkSticker 进 fabric.Object.customProperties。
   * fabric v6 toObject 只序列化注册过的自定义属性——不注册则标记不进撤销快照，
   * 撤销后 mkShape/mkSticker 丢失（形状面板打不开、图层名回归「涂鸦」/「图片」）。
   * 入参 = fabric.Object（类本身，其上挂 customProperties 数组）。
   * 返回是否有新注册（重复调用返回 false，供幂等断言）。
   */
  function registerShapeSerialization(FabricObject) {
    const props = FabricObject && FabricObject.customProperties;
    if (!Array.isArray(props)) return false;
    let added = false;
    for (const key of ['mkShape', '_mkClipKind', 'mkSticker']) {
      if (!props.includes(key)) { props.push(key); added = true; }
    }
    return added;
  }

  return {
    moveLayerIndex,
    clampFilterValue,
    filterPresets,
    computeCropGeometry,
    layerName,
    validateStickerIndex,
    registerShapeSerialization,
  };
});
