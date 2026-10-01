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
  currentSticker: null,
};

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
    renderGallery(state.stickers);

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
      filterAndRender();
    });
    $secondaryNav.appendChild(btn);
  });
}

// ====== 搜索 ======
$search.addEventListener('input', () => {
  state.searchQuery = $search.value.trim().toLowerCase();
  filterAndRender();
});
$searchBtn.addEventListener('click', () => {
  state.searchQuery = $search.value.trim().toLowerCase();
  filterAndRender();
});

// ====== 过滤 ======
function filterAndRender() {
  let list = state.stickers;

  // 一级过滤
  if (state.primary !== '主页') {
    list = list.filter(s => s.subcategory === state.primary);
  }

  // 二级过滤（多标签：任一命中即显示）
  if (state.secondary) {
    list = list.filter(s => labelsOf(s).includes(state.secondary));
  }

  // 搜索
  if (state.searchQuery) {
    const q = state.searchQuery;
    list = list.filter(s =>
      (s.filename || '').toLowerCase().includes(q) ||
      labelsOf(s).some(c => c.toLowerCase().includes(q)) ||
      (s.subcategory || '').includes(q) ||
      s.tags.some(t => t.includes(q))
    );
  }

  renderGallery(list);
}

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
  if (e.key === 'Escape') closePreview();
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
