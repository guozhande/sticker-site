/**
 * 我的表情 — 网站脚本
 * 一级标签: 主页 | 二次元 | 网络
 * 二级标签: 每个一级下的具体名称
 */
const state = {
  stickers: [],
  categories: {},       // {主页: {游戏: [...], 动漫: [...], 网络: [...]}}
  categoryOrder: [],    // 作品名的展示顺序（首字母序，写入侧用拼音算好）
  categoryGroups: {},   // {A: [作品名...], B: [...]} 首字母 → 该字母下的作品名
  uploads: [],          // 用户上传的图（来自 /api/uploads），单独记一份便于筛选
  letter: null,         // 当前选中的首字母（null=全部）
  primary: '主页',      // 当前一级
  secondary: null,      // 当前二级（null=全部）
  searchQuery: '',
  page: 0,             // 当前页码（0 基）；筛选/数据变化时由调用侧归零
  suggestIndex: [],    // 联想候选索引（buildSuggestIndex 产物，随可见集重建）
  currentSticker: null,
};

const PAGE_SIZE = 100; // §1.1 固定分页：每页 100 张（与 App 端一致）

// 内容级去重：canonical 指向同内容主条目，非主条目（别名）不渲染。
// 兼容旧数据——没有 canonical 字段的条目一律视为有效条目。
function isDuplicate(s) {
  return !!s.canonical && s.canonical !== s.id;
}

// ====== DOM ======
const $gallery = document.getElementById('gallery');
const $search = document.getElementById('search');
const $searchBtn = document.getElementById('search-btn');
const $toast = document.getElementById('toast');
const $overlay = document.getElementById('preview-overlay');
const $previewImg = document.getElementById('preview-img');
const $previewInfo = document.getElementById('preview-info');
const $ctxMenu = document.getElementById('context-menu');
const $primaryNav = document.querySelector('.primary-nav');
const $secondaryNav = document.querySelector('.secondary-nav');
const $letterNav = document.querySelector('.letter-nav');
const $pagination = document.getElementById('pagination');
const $suggest = document.getElementById('search-suggest');

// ====== 初始化 ======
async function init() {
  try {
    const res = await fetch('data/stickers.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // 只保留主条目：别名（canonical 指向他条）在此一次性剔除，
    // 之后的一级/二级导航、条目计数、列表渲染、搜索均基于去重后的结果。
    state.stickers = (data.stickers || []).filter(s => !isDuplicate(s));
    state.categories = data.categories || {};
    state.categoryOrder = data.category_order || [];
    state.categoryGroups = data.category_groups || {};

    renderPrimaryNav();
    renderSecondaryNav('主页');
    rebuildSuggestIndex();
    filterAndRender();

    loadUploads();   // 用户上传的图异步补上；接口不通也不影响网站主体
  } catch (err) {
    $gallery.innerHTML = `<div class="empty">加载失败<br><small>${err.message}</small></div>`;
  }
}

// ====== 用户上传的图 ======
// 接口在 Pages Functions 上（见 js/config.js）。拉不到就静默跳过 —— 网站主体不依赖它。
const API_BASE = window.STICKER_API_BASE ?? '';

/** 把上传接口返回的条目，转成和图库一致的结构。 */
function uploadToSticker(u) {
  return {
    id: `up-${u.id}`,
    uploadId: u.id,
    filename: u.filename,
    url: u.url.startsWith('http') ? u.url : `${API_BASE}${u.url}`,
    tags: [u.work, ...(u.characters || [])].filter(Boolean),
    category: u.work,
    categories: [u.work],
    subcategory: '二次元',   // 上传时只问了作品名，统一归二次元
    source: 'upload',
  };
}

async function loadUploads() {
  try {
    const res = await fetch(`${API_BASE}/api/uploads?limit=300`, { cache: 'no-store' });
    if (!res.ok) return;
    const items = ((await res.json()).items || []).map(uploadToSticker);
    if (!items.length) return;

    state.uploads = items;
    // 先剔除上一次拉进来的上传条目，再插最新的一批 —— 否则重复调用（比如刚上传完刷新）会越堆越多
    state.stickers = [...items, ...state.stickers.filter((s) => s.source !== 'upload')];

    // 上传的作品名可能不在网站的字母表里 —— 单独归一个「★」组放在最前，
    // 这样字母栏、三级筛选的既有逻辑完全不用改。
    const works = [...new Set(items.map((s) => s.category))].sort(compareLabels);
    state.categoryGroups = { '★': works, ...state.categoryGroups };

    renderLetterNav(state.primary);
    renderSecondaryNav(state.primary);
    state.page = 0;          // 数据总量变化，页码归零
    rebuildSuggestIndex();   // 上传条目进入联想候选
    filterAndRender();
  } catch (_) {
    /* 离线或接口异常：跳过上传内容，不影响浏览 */
  }
}

// ====== 一级导航 ======
function renderPrimaryNav() {
  $primaryNav.innerHTML = '';
  const tabs = ['主页', '二次元', '网络'];

  tabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'primary-btn';
    btn.dataset.cat = tab;
    btn.textContent = tab;
    if (tab === state.primary) btn.classList.add('active');
    btn.addEventListener('click', () => {
      state.primary = tab;
      state.secondary = null;
      state.letter = null;
      document.querySelectorAll('.primary-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderLetterNav(tab);
      renderSecondaryNav(tab);
      state.page = 0;
      rebuildSuggestIndex();
      filterAndRender();
    });
    $primaryNav.appendChild(btn);
  });
}

// ====== 二级导航 ======
// 兼容旧数据：只有 category 字符串时当单标签用
function labelsOf(s) {
  return Array.isArray(s.categories) && s.categories.length
    ? s.categories
    : (s.category ? [s.category] : []);
}

// 二级标签排序：优先用数据里算好的首字母序（category_order），
// 缺了就退回浏览器自带的拼音排序（注意：该方式会把拉丁字母标签甩到最后）
function compareLabels(a, b) {
  const order = state.categoryOrder;
  if (order && order.length) {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
  }
  return a.localeCompare(b, 'zh-Hans-CN');
}

// ====== 二级导航：首字母 A-Z ======
// 字母本身也是拼音算出来的，前端算不了，所以用数据里的 category_groups
function renderLetterNav(primary) {
  $letterNav.innerHTML = '';

  if (primary === '主页') {
    $letterNav.style.display = 'none';
    return;
  }

  // 当前一级下实际出现过的作品名
  const present = new Set();
  state.stickers.forEach(s => {
    if (s.subcategory !== primary) return;
    labelsOf(s).forEach(c => present.add(c));
  });

  // 只留这个一级下真有作品的字母（网络下可能就没有几个字母）
  const letters = Object.keys(state.categoryGroups)
    .filter(L => (state.categoryGroups[L] || []).some(n => present.has(n)));
  if (!letters.length) {
    $letterNav.style.display = 'none';
    return;
  }

  $letterNav.style.display = 'flex';

  const makeBtn = (text, value) => {
    const btn = document.createElement('button');
    btn.className = 'letter-btn' + (state.letter === value ? ' active' : '');
    btn.textContent = text;
    btn.addEventListener('click', () => {
      state.letter = value;
      state.secondary = null;      // 换字母时清掉三级选择
      renderLetterNav(state.primary);
      renderSecondaryNav(state.primary);
      state.page = 0;
      rebuildSuggestIndex();
      filterAndRender();
    });
    $letterNav.appendChild(btn);
  };

  makeBtn('全部', null);
  letters.forEach(L => makeBtn(L, L));
}

function renderSecondaryNav(primary) {
  $secondaryNav.innerHTML = '';

  if (primary === '主页') {
    $secondaryNav.style.display = 'none';
    return;
  }

  const subSet = new Set();
  state.stickers.forEach(s => {
    if (s.subcategory !== primary) return;
    labelsOf(s).forEach(c => subSet.add(c));
  });
  // 三级：按当前选中的首字母收窄
  const allowed = state.letter ? new Set(state.categoryGroups[state.letter] || []) : null;
  const subMap = [...subSet].filter(n => !allowed || allowed.has(n)).sort(compareLabels);
  if (subMap.length === 0) {
    $secondaryNav.style.display = 'none';
    return;
  }

  $secondaryNav.style.display = 'flex';

  // "全部" 按钮
  const allBtn = document.createElement('button');
  allBtn.className = 'secondary-btn active';
  allBtn.textContent = '全部';
  allBtn.addEventListener('click', () => {
    state.secondary = null;
    document.querySelectorAll('.secondary-btn').forEach(b => b.classList.remove('active'));
    allBtn.classList.add('active');
    state.page = 0;
    rebuildSuggestIndex();
    filterAndRender();
  });
  $secondaryNav.appendChild(allBtn);

  // 具体二级标签
  subMap.forEach(sub => {
    const btn = document.createElement('button');
    btn.className = 'secondary-btn';
    btn.textContent = sub;
    btn.addEventListener('click', () => {
      state.secondary = sub;
      document.querySelectorAll('.secondary-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.page = 0;
      rebuildSuggestIndex();
      filterAndRender();
    });
    $secondaryNav.appendChild(btn);
  });
}

// ====== 搜索 ======
// 查询原文存 state（不再 toLowerCase）：输入框显示用户原文，
// 大小写/字符清洗等归一化统一在 fuzzy.js 内做（§3.1/§3.7 双侧清洗）
$search.addEventListener('input', () => {
  state.searchQuery = $search.value.trim();
  state.page = 0;          // 查询变化归零
  filterAndRender();
  renderSuggest();
});
$searchBtn.addEventListener('click', () => {
  state.searchQuery = $search.value.trim();
  state.page = 0;
  filterAndRender();
  renderSuggest();
});

// ====== 过滤 ======

/** 一级+二级过滤（不含搜索词），返回全量 scoped 列表 —— 联想候选集同源。 */
function getScopedStickers() {
  let list = state.stickers;

  // 一级过滤
  if (state.primary !== '主页') {
    list = list.filter(s => s.subcategory === state.primary);
  }

  // 二级过滤（多标签：任一命中即显示）
  if (state.secondary) {
    list = list.filter(s => labelsOf(s).includes(state.secondary));
  }

  return list;
}

/** 全量过滤链：scoped → 搜索 rank（AND 叠加语义不变）。 */
function getFilteredList() {
  // 搜索：查询非空时用模糊匹配器过滤 + 打分排序；空查询保持原顺序。
  // 一级/二级筛选在前、搜索在后，AND 叠加语义不变。
  // 无 search_keys 的旧条目（如上传）由 fuzzy.js 回退旧子串逻辑（§3.6）。
  let list = getScopedStickers();
  if (state.searchQuery) {
    list = FuzzySearch.rank(list, state.searchQuery);
  }
  return list;
}

/**
 * §1.1 固定分页：每页 PAGE_SIZE 张，底部页码条。
 * 本身不归零——页码按钮点击也走这里，归零在调用侧。
 */
function filterAndRender() {
  const list = getFilteredList();
  const totalPages = Math.ceil(list.length / PAGE_SIZE);
  state.page = Math.min(Math.max(state.page, 0), Math.max(totalPages - 1, 0));  // clamp：[0, maxPage] 双向夹（负页防御，与 App coerceIn 语义统一）
  renderGallery(list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE));
  renderPagination(totalPages);
}

// ====== 固定分页 ======

/** §1.1 页码窗口算法：返回渲染序列，-1 为省略号占位（total >= 2 时调用）。 */
function pageButtons(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const clamped = Math.min(Math.max(current, 0), total - 1);
  const sorted = [...new Set([0, total - 1, clamped - 1, clamped, clamped + 1])]
    .filter(p => p >= 0 && p < total)
    .sort((a, b) => a - b);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap === 2) out.push(sorted[i] - 1);
    else if (gap > 2) out.push(-1);
    out.push(sorted[i]);
  }
  return out;
}

/** 底部页码条：‹ 1 … [n] … N ›；仅 0 条（总页数 0）时整个隐藏；N=1 显示单页「1」（用户 2026-10-24 拍板严格字面）。 */
function renderPagination(totalPages) {
  if (totalPages < 1) {
    $pagination.innerHTML = '';
    return;
  }
  const arrowBtn = (p, disabled, ariaLabel, text) =>
    `<button class="page-btn" data-page="${p}"${disabled ? ' disabled' : ''} aria-label="${ariaLabel}">${text}</button>`;
  const parts = [arrowBtn(state.page - 1, state.page === 0, '上一页', '‹')];
  for (const p of pageButtons(state.page, totalPages)) {
    if (p === -1) {
      parts.push('<span class="page-ellipsis">…</span>');
    } else {
      const active = p === state.page ? ' active' : '';
      const current = p === state.page ? ' aria-current="page"' : '';
      parts.push(`<button class="page-btn${active}" data-page="${p}"${current}>${p + 1}</button>`);
    }
  }
  parts.push(arrowBtn(state.page + 1, state.page === totalPages - 1, '下一页', '›'));
  $pagination.innerHTML = parts.join('');
}

$pagination.addEventListener('click', e => {
  const btn = e.target.closest('.page-btn');
  if (!btn || btn.disabled) return;
  const target = Number(btn.dataset.page);
  if (target === state.page) return;
  state.page = target;
  filterAndRender();
});

// ====== 搜索联想 ======

/** 候选索引重建：与 page 归零挂点同处，只在可见集（范围）变化时调用。 */
function rebuildSuggestIndex() {
  state.suggestIndex = FuzzySearch.buildSuggestIndex(getScopedStickers());
}

/** HTML 转义：联想候选标签来自数据文件，防特殊字符注入。 */
function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, ch => map[ch]);
}

/** 把当前查询的联想候选渲染进面板；无候选则隐藏。 */
function renderSuggest() {
  const matches = FuzzySearch.suggest(state.suggestIndex, state.searchQuery);
  if (!matches.length) {
    hideSuggest();
    return;
  }
  $suggest.innerHTML = matches.map(label => `<div class="ss-item">${escapeHtml(label)}</div>`).join('');
  $suggest.hidden = false;
}

function hideSuggest() {
  $suggest.hidden = true;
  $suggest.innerHTML = '';
}

// 点击候选：填入搜索框 + 触发搜索 + page 归零 + 隐藏面板（程序赋值不触发 input，下次输入再显）
$suggest.addEventListener('click', e => {
  const item = e.target.closest('.ss-item');
  if (!item) return;
  const label = item.textContent;
  $search.value = label;
  state.searchQuery = label;
  state.page = 0;
  filterAndRender();
  hideSuggest();
});

// 点击面板外任意处关闭（面板位于 .search-bar 内）
document.addEventListener('click', e => {
  if (!e.target.closest('.search-bar')) hideSuggest();
});

// ====== 渲染图片列表 ======
function renderGallery(list) {
  if (!list.length) {
    $gallery.innerHTML = '<div class="empty">没找到表情包<br><small>试试换个关键词</small></div>';
    return;
  }

  $gallery.innerHTML = list.map(s => {
    const label = [...labelsOf(s), s.subcategory].filter(Boolean).join(' · ');
    return `
    <div class="sticker-card"
         data-id="${s.id}"
         data-url="${s.url}"
         data-filename="${s.filename}"
         data-category="${s.category || ''}"
         data-categories="${labelsOf(s).join(',')}"
         data-subcategory="${s.subcategory || ''}"
         data-tags="${s.tags.join(',')}">
      <img src="${s.url}" alt="${s.tags.join(', ')}" loading="lazy"
           onerror="this.parentElement.style.display='none'">
      ${s.source === 'upload' ? '<span class="up-badge">新</span>' : ''}
      <div class="card-label">${label}</div>
    </div>`;
  }).join('');

  $gallery.querySelectorAll('.sticker-card').forEach(card => {
    card.addEventListener('click', () => openPreview(card));
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      openContextMenu(card, e.clientX, e.clientY);
    });
  });
}

// ====== 获取数据 ======
function getStickerData(card) {
  return {
    id: card.dataset.id,
    url: card.dataset.url,
    filename: card.dataset.filename,
    category: card.dataset.category,
    subcategory: card.dataset.subcategory,
    tags: card.dataset.tags,
  };
}

// ====== 预览 ======
function openPreview(card) {
  const s = getStickerData(card);
  state.currentSticker = s;
  $previewImg.src = s.url;
  $previewImg.alt = s.tags;
  $previewInfo.textContent = [s.filename, s.category, s.subcategory].filter(Boolean).join(' · ');
  $overlay.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closePreview() {
  $overlay.classList.remove('show');
  document.body.style.overflow = '';
  state.currentSticker = null;
}

$overlay.addEventListener('click', e => {
  if (e.target === $overlay) closePreview();
});
document.getElementById('preview-close').addEventListener('click', closePreview);
document.getElementById('pa-download').addEventListener('click', () => {
  if (state.currentSticker) downloadSticker(state.currentSticker);
});
document.getElementById('pa-related').addEventListener('click', () => {
  if (state.currentSticker) searchRelated(state.currentSticker);
  closePreview();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$suggest.hidden) hideSuggest();
  else closePreview();
});

// ====== 右键菜单 ======
function openContextMenu(card, x, y) {
  state.currentSticker = getStickerData(card);
  $ctxMenu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
  $ctxMenu.style.top = `${Math.min(y, window.innerHeight - 132)}px`;
  $ctxMenu.classList.add('show');
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
  });
}

function closeContextMenu() { $ctxMenu.classList.remove('show'); }

$ctxMenu.addEventListener('click', e => {
  const action = e.target.closest('.cm-item')?.dataset.action;
  if (!action || !state.currentSticker) return;
  const s = state.currentSticker;
  if (action === 'view') previewFromData(s);
  else if (action === 'download') downloadSticker(s);
  else if (action === 'related') searchRelated(s);
  closeContextMenu();
});

function previewFromData(s) {
  $previewImg.src = s.url;
  $previewImg.alt = s.tags;
  $previewInfo.textContent = [s.filename, s.category, s.subcategory].filter(Boolean).join(' · ');
  $overlay.classList.add('show');
  document.body.style.overflow = 'hidden';
}

// ====== 下载 ======
function downloadSticker(s) {
  const a = document.createElement('a');
  a.href = s.url;
  a.download = s.filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast(`已下载: ${s.filename}`);
}

// ====== 搜索关联 ======
function searchRelated(s) {
  const target = s.subcategory || s.category;
  if (target) {
    state.searchQuery = target;
    $search.value = target;
    state.primary = '主页';
    state.secondary = null;
    document.querySelectorAll('.primary-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.primary-btn[data-cat="主页"]')?.classList.add('active');
    $secondaryNav.style.display = 'none';
    state.page = 0;
    rebuildSuggestIndex();   // primary 变「主页」= 范围变化点，索引随可见集重建
    filterAndRender();
    showToast(`已筛选: ${target}`);
  }
}

// ====== Toast ======
function showToast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout($toast._timer);
  $toast._timer = setTimeout(() => $toast.classList.remove('show'), 2500);
}

init();
