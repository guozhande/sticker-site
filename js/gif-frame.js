'use strict';
/* GIF 帧数读取 + 第 N 帧提取。依赖 vendor/gifuct-js.vendor.js 的 window.Gifuct。
 * 帧号对外 1 基；对内 0 基的唯一换算点在 pickFramePatch 入口：frameIndex1Based - 1。 */
const GIF_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;   // GIF 文件字节硬限（仅本地解析，不传后端）；
                                                 // 最终值待 T4-6 真机实测解析耗时定档（>3s 降为 10MB，见 T4）
const GIF_MAX_LSD_EDGE = 4096;                   // 逻辑屏长边护栏（对齐 maker.js:39 MAX_IMPORT_PIXELS 先例）
const FRAME_MAX_EDGE = 1024;                     // 合成画布长边上限（内存护栏：峰值 ≈ 4MB×2 + 1 patch）
const GIF_FRAME_MAX_PIXELS = FRAME_MAX_EDGE * FRAME_MAX_EDGE;   // 单帧像素硬限（v3 修正 #1：帧级护栏）
/*   帧级护栏取值依据：vendor decompressFrame 按帧 descriptor 原尺寸分配，每像素临时内存 ≈12B
 *   （lzw 中间数组 ~8B + patch 4B）。若放宽到 4096²，单帧峰值 ≈190MB —— maker.js:39 注释明言
 *   站点自身预算「≈64MB RGBA，防移动端 OOM」，190MB 是它的 3 倍，低端机仍有闪退风险；
 *   >1024 的帧在合成层本就要缩到 1024²，1024² 上限（峰值 ≈12MB）无死角且覆盖全部真实素材（≤498px）。
 *   若未来需支持 >1024² 帧，必须先实现「解码 + 即时降采样」，再上调本常量。 */
const FRAME_JPEG_QUALITY = 0.85;                 // 与 ai.js:27 REF_JPEG_QUALITY（实测 0.85）一致

const GIFUCT_READY = () => typeof Gifuct !== 'undefined' && typeof Gifuct.parseGIF === 'function';

function sniffGifBytes(buf) {
  // file.arrayBuffer() 是原生 ArrayBuffer，不支持下标访问（buf[0] === undefined），入口先归一化
  const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  return b.length >= 6 && String.fromCharCode(b[0], b[1], b[2]) === 'GIF'
    && ((b[3] === 0x38 && b[4] === 0x37) || (b[3] === 0x38 && b[4] === 0x39))
    && b[5] === 0x61;
}

function countGifFrames(arrayBuffer, gif = null) {
  // v3 修正 #4：可选复用已解析 gif 对象（onGifFileChange 只 parseGIF 一次），避免 20MB 双重全量解析
  const parsed = gif && gif.lsd && gif.frames ? gif : Gifuct.parseGIF(arrayBuffer);
  return {
    frameCount: parsed.frames.filter((f) => f.image).length,   // 可能为 0（GIF 无图像块）
    lsdWidth: parsed.lsd.width,
    lsdHeight: parsed.lsd.height,
  };
}

function validateFrameIndex(raw, total) {
  // 返回 { ok:true, n } | { ok:false, reason:'not_int'|'out_of_range' }；纯函数，可 Node 单测
  const n = Number(raw);
  if (!Number.isInteger(n)) return { ok: false, reason: 'not_int' };
  if (n < 1 || n > total) return { ok: false, reason: 'out_of_range' };
  return { ok: true, n };
}

/* ---- 帧级 descriptor 护栏（v3 修正 #1，high）----
 * vendor decompressFrame 对 descriptor 尺寸零校验、按原始尺寸分配内存：
 *   小 lsd(100×100) + 巨帧 descriptor(30000×30000) 可绕过 LSD 护栏 → 数 GB 分配 → RangeError/OOM 闪退；
 *   帧偏移越界（left+width > lsd.width）会静默写出合成 rgba 缓冲边界产生错图；
 *   截断文件 readUnsigned 返回 NaN/undefined。解帧前统一在此拦截。
 * 返回 null（合法）| 'bad_dims'（越界/非有限 → unreadable）| 'frame_too_large'（巨帧 → too_large 文案）。 */
function validateFrameDescriptor(d, lsdWidth, lsdHeight) {
  const vals = [d.left, d.top, d.width, d.height];
  if (!vals.every((v) => Number.isFinite(v) && v >= 0)) return 'bad_dims';
  if (d.width < 1 || d.height < 1) return 'bad_dims';
  if (d.left + d.width > lsdWidth || d.top + d.height > lsdHeight) return 'bad_dims';
  if (d.width * d.height > GIF_FRAME_MAX_PIXELS) return 'frame_too_large';
  return null;
}

/* ---- 无 DOM 合成原语 ---- */

/** canvas clearRect → 区域置为全透明（disposal-2 浏览器语义）。rgba 为直方 RGBA 缓冲，width 为行宽。 */
function fillRect(rgba, width, dims, value) {
  const rows = Math.floor(rgba.length / 4 / width);
  const x1 = Math.max(0, dims.left);
  const y1 = Math.max(0, dims.top);
  const x2 = Math.min(width, dims.left + dims.width);
  const y2 = Math.min(rows, dims.top + dims.height);
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = value;
    }
  }
}

/** 等比缩放矩形；宽高下限 1（最小可见 1px）。 */
function scaleDims(dims, scale) {
  return {
    left: Math.round(dims.left * scale),
    top: Math.round(dims.top * scale),
    width: Math.max(1, Math.round(dims.width * scale)),
    height: Math.max(1, Math.round(dims.height * scale)),
  };
}

/** src-over 合成（a=1 替换 / a=0 保留）；GIF 透明仅 0/255 两态 → 无半透明舍入歧义，
 *  scale=1 时与 canvas drawImage 逐字节一致；缩小合成时按目标像素反推源坐标点采样。 */
function blendPatch(rgba, width, dst, src, patch) {
  const rows = Math.floor(rgba.length / 4 / width);
  const x1 = Math.max(0, dst.left);
  const y1 = Math.max(0, dst.top);
  const x2 = Math.min(width, dst.left + dst.width);
  const y2 = Math.min(rows, dst.top + dst.height);
  for (let y = y1; y < y2; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y - dst.top) * src.height / dst.height));
    for (let x = x1; x < x2; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x - dst.left) * src.width / dst.width));
      const si = (sy * src.width + sx) * 4;
      if (patch[si + 3] !== 0) {
        const di = (y * width + x) * 4;
        rgba[di] = patch[si];
        rgba[di + 1] = patch[si + 1];
        rgba[di + 2] = patch[si + 2];
        rgba[di + 3] = patch[si + 3];
      }
    }
  }
}

/**
 * 提取动图第 N 帧的完整合成结果（含 disposal 0-3），无 DOM 纯函数（Node 可直载单测）。
 * 参数 arrayBufferOrGif：原生 ArrayBuffer（Node 直载单测 / 兜底路径）或已解析的 gif 对象
 *   （onGifFileChange 缓存的 gifPending.gif 复用，v3 修正 #4：单次解析）。
 * frameIndex1Based：对外 1 基；入口做唯一一次 -1 换算。
 * 内存双护栏：lsd 长边 >4096 直接拒；长边 >1024 等比缩到 ≤1024 有界缓冲；解帧前逐帧 descriptor 校验。
 *
 * 语义约定（v3 修正 #6）：合成画布以全透明初始化（等价忽略 lsd.backgroundColorIndex）。
 *   浏览器渲染会把未铺满区域显示为背景色，本函数输出「帧内容 + 透明底」；
 *   透明区在最终白底 JPEG 中被压平为白色。帧内容本身与浏览器逐字节一致，底色差异由
 *   白底路径覆盖，判定为可接受（T3-5 背景色 fixture 记录差异结论）。
 *   若未来需还原背景色观感，可在初始化时按 gct[lsd.backgroundColorIndex] 填充。
 *
 * 返回 { ok:true, width, height, rgba(Uint8ClampedArray 直方 RGBA), frameCount }
 *     | { ok:false, reason:'too_large'|'no_frames'|'unreadable'|'invalid_index' }
 */
function pickFramePatch(arrayBufferOrGif, frameIndex1Based) {
  if (!GIFUCT_READY()) return { ok: false, reason: 'unreadable' };        // v3 修正 #9：组件未加载防线
  const gif = arrayBufferOrGif && arrayBufferOrGif.lsd && arrayBufferOrGif.frames
    ? arrayBufferOrGif : Gifuct.parseGIF(arrayBufferOrGif);
  const w = gif.lsd.width, h = gif.lsd.height;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    return { ok: false, reason: 'unreadable' };                            // 截断头：NaN/undefined 尺寸
  }
  if (Math.max(w, h) > GIF_MAX_LSD_EDGE) return { ok: false, reason: 'too_large' };   // 护栏①
  const rawFrames = gif.frames.filter((f) => f.image);
  if (!rawFrames.length) return { ok: false, reason: 'no_frames' };
  // v3 修正 #7：非法索引（NaN/undefined/小数/字符串）显式拒绝，不静默 clamp 成全透明帧；
  // clamp 仅用于整数越界兜底（0/-1 → 第 1 帧，N+1+ → 最后一帧）
  if (!Number.isInteger(frameIndex1Based)) return { ok: false, reason: 'invalid_index' };
  const n = Math.min(Math.max(1, frameIndex1Based), rawFrames.length);      // 1 基 clamp 后的目标帧号

  const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const rgba = new Uint8ClampedArray(cw * ch * 4);   // 全透明初始化（见上方语义约定）
  let prevDisposal = 0, prevDims = null, snapshot = null;
  for (let i = 0; i < n; i++) {
    const raw = rawFrames[i];
    const v = validateFrameDescriptor(raw.image.descriptor, w, h);   // v3 修正 #1：解帧前校验，绝不让
    if (v) return { ok: false, reason: v === 'frame_too_large' ? 'too_large' : 'unreadable' };  // vendor 按原尺寸分配
    const f = Gifuct.decompressFrame(raw, gif.gct, true);   // 单帧解码：patch 用一帧丢一帧（低内存）
    const d = scaleDims(f.dims, scale);
    if (prevDisposal === 2 && prevDims) fillRect(rgba, cw, prevDims, 0);
    if (prevDisposal === 3 && snapshot) { rgba.set(snapshot); snapshot = null; }
    if (f.disposalType === 3) snapshot = rgba.slice();
    blendPatch(rgba, cw, d, f.dims, f.patch);
    prevDisposal = f.disposalType || 0;
    prevDims = d;
  }
  // v3 修正 #3：后置校验 —— 「头合法但体截断」的任何 NaN/undefined 泄漏到此即拒，绝不产出白帧
  const frameCount = rawFrames.length;
  if (!Number.isInteger(cw) || cw < 1 || !Number.isInteger(ch) || ch < 1
    || !Number.isInteger(frameCount) || frameCount < 1
    || rgba.length !== cw * ch * 4) return { ok: false, reason: 'unreadable' };
  return { ok: true, width: cw, height: ch, rgba, frameCount };
}

async function gifFrameToDataUri(file, frameIndex1Based, gif = null) {
  // 体积检查('too_large_bytes') → arrayBuffer（原生 ArrayBuffer）→ sniffGifBytes('not_gif')
  // → pickFramePatch（gif 对象复用，v3 修正 #4）→ canvas 白底填充 → drawImage（src-over）
  // → toDataURL('image/jpeg', FRAME_JPEG_QUALITY)
  // 返回 { ok:true, dataUri, frameCount, width, height }
  //     | { ok:false, reason:'not_gif'|'too_large_bytes'|'too_large'|'unreadable'|'invalid_index' }
  if (!GIFUCT_READY()) return { ok: false, reason: 'unreadable' };
  if (file.size > GIF_MAX_UPLOAD_BYTES) return { ok: false, reason: 'too_large_bytes' };
  const arrayBuffer = await file.arrayBuffer();
  if (!sniffGifBytes(arrayBuffer)) return { ok: false, reason: 'not_gif' };
  const patch = pickFramePatch(gif || arrayBuffer, frameIndex1Based);   // 1 基传入；内部唯一 -1 换算
  if (!patch.ok) return { ok: false, reason: patch.reason === 'no_frames' ? 'unreadable' : patch.reason };
  const canvas = document.createElement('canvas');
  canvas.width = patch.width; canvas.height = patch.height;      // 已被有界合成缩至 ≤1024，无需再缩
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';                                        // 先白底：JPEG 无透明通道，透明区防变黑
  ctx.fillRect(0, 0, patch.width, patch.height);
  const patchCanvas = document.createElement('canvas');
  patchCanvas.width = patch.width; patchCanvas.height = patch.height;
  patchCanvas.getContext('2d').putImageData(new ImageData(patch.rgba, patch.width, patch.height), 0, 0);
  ctx.drawImage(patchCanvas, 0, 0);                              // src-over：透明像素透出白底（与 compressRefImage 同语义）
  return { ok: true, dataUri: canvas.toDataURL('image/jpeg', FRAME_JPEG_QUALITY),
           frameCount: patch.frameCount, width: patch.width, height: patch.height };
}

window.GifFrame = {
  GIF_MAX_UPLOAD_BYTES, GIF_MAX_LSD_EDGE, FRAME_MAX_EDGE, GIF_FRAME_MAX_PIXELS,
  sniffGifBytes, countGifFrames, validateFrameIndex, validateFrameDescriptor,
  pickFramePatch, gifFrameToDataUri,
};
