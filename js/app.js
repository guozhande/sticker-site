/**
 * 我的表情 — 前端逻辑（匹配 App 交互）
 */
const state = {
  stickers: [],
  categories: [],
  subcategories: [],
  currentCat: 'all',
  currentSub: null,
  searchQuery: '',
  currentSticker: null,
};

// ====== DOM ======
const $gallery = document.getElementById('gallery');
const $search = document.getElementById('search');
const $searchBtn = document.getElementById('search-btn');
const $toast = document.getElementById('toast');
const $overlay = document.getElementById('preview-overlay');
const $previewImg = document.getElementById('preview-img');
const $previewInfo = document.getElementById('preview-info');
const $ctxMenu = document.getElementById('context-menu');

// ====== 初始化 ======
async function init() {
  try {
    const res = await fetch('data/stickers.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.stickers = data.stickers || [];
    state.categories = data.categories || [];
    state.subcategories = data.subcategories || [];
    renderCategories();
    renderSubcategories();
    renderGallery(state.stickers);
  } catch (err) {
    $gallery.innerHTML = `<div class="empty">加载失败<br><small>${err.message}</small></div>`;
  }
}

// ====== 一级分类导航（匹配 App FilterChip） ======
function renderCategories() {
  const nav = document.querySelector('.categories');
  nav.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = 'cat-btn active';
  allBtn.dataset.cat = 'all';
  allBtn.textContent = '全部';
  allBtn.addEventListener('click', () => selectCategory('all', allBtn));
  nav.appendChild(allBtn);

  // 按数量排序：放在每个分类里的 sticker 数量
  const counts = {};
  state.stickers.forEach(s => {
    const c = s.category || '其他';
    counts[c] = (counts[c] || 0) + 1;
  });

  state.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn';
    btn.dataset.cat = cat;
    btn.textContent = `${cat} (${counts[cat] || 0})`;
    btn.addEventListener('click', () => selectCategory(cat, btn));
    nav.appendChild(btn);
  });
}

// ====== 二级分类导航（一级选中后显示） ======
function renderSubcategories(parentCat) {
  const subNav = document.querySelector('.subcategories');
  if (!subNav) return;
  subNav.innerHTML = '';

  if (!parentCat || parentCat === 'all') {
    subNav.style.display = 'none';
    state.currentSub = null;
    return;
  }

  // 该一级分类下的所有二级标签
  const subs = new Set();
  state.stickers
    .filter(s => s.category === parentCat && s.subcategory)
    .forEach(s => subs.add(s.subcategory));

  if (subs.size === 0) {
    subNav.style.display = 'none';
    state.currentSub = null;
    return;
  }

  subNav.style.display = 'flex';

  const allSub = document.createElement('button');
  allSub.className = 'sub-btn active';
  allSub.textContent = '全部';
  allSub.addEventListener('click', () => {
    state.currentSub = null;
    document.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
    allSub.classList.add('active');
    filterStickers();
  });
  subNav.appendChild(allSub);

  [...subs].sort().forEach(sub => {
    const btn = document.createElement('button');
    btn.className = 'sub-btn';
    btn.textContent = sub;
    btn.addEventListener('click', () => {
      state.currentSub = sub;
      document.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterStickers();
    });
    subNav.appendChild(btn);
  });
}

function selectCategory(cat, el) {
  state.currentCat = cat;
  state.currentSub = null;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderSubcategories(cat);
  filterStickers();
}

// ====== 搜索 ======
$search.addEventListener('input', () => {
  state.searchQuery = $search.value.trim().toLowerCase();
  filterStickers();
});
$searchBtn.addEventListener('click', () => {
  state.searchQuery = $search.value.trim().toLowerCase();
  filterStickers();
});

// ====== 过滤（匹配 App 逻辑） ======
function filterStickers() {
  let list = state.stickers;

  // 一级分类过滤
  if (state.currentCat !== 'all') {
    list = list.filter(s => s.category === state.currentCat);
  }

  // 二级分类过滤
  if (state.currentSub) {
    list = list.filter(s => s.subcategory === state.currentSub);
  }

  // 搜索匹配：文件名 / 一级标签 / 二级标签 / 标签
  if (state.searchQuery) {
    const q = state.searchQuery;
    list = list.filter(s =>
      (s.filename || '').toLowerCase().includes(q) ||
      (s.category || '').includes(q) ||
      (s.subcategory || '').includes(q) ||
      s.tags.some(t => t.includes(q))
    );
  }

  renderGallery(list);
}

// ====== 渲染图片列表（匹配 App 的 3 列网格 + 文件名标签） ======
function renderGallery(list) {
  if (!list.length) {
    $gallery.innerHTML = '<div class="empty">没找到表情包<br><small>试试换个关键词</small></div>';
    return;
  }

  $gallery.innerHTML = list.map(s => `
    <div class="sticker-card"
         data-id="${s.id}"
         data-url="${s.url}"
         data-filename="${s.filename}"
         data-category="${s.category || ''}"
         data-subcategory="${s.subcategory || ''}"
         data-tags="${s.tags.join(',')}">
      <img src="${s.url}" alt="${s.tags.join(', ')}" loading="lazy"
           onerror="this.parentElement.style.display='none'">
      <div class="card-label">${s.subcategory || s.category || ''}</div>
    </div>
  `).join('');

  $gallery.querySelectorAll('.sticker-card').forEach(card => {
    card.addEventListener('click', () => openPreview(card));
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      openContextMenu(card, e.clientX, e.clientY);
    });
  });
}

// ====== 获取 sticker 数据 ======
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

// ====== 图片预览（匹配 App 的 StickerPreview） ======
function openPreview(card) {
  const s = getStickerData(card);
  state.currentSticker = s;
  $previewImg.src = s.url;
  $previewImg.alt = s.tags;

  const label = [s.filename, s.category, s.subcategory].filter(Boolean).join(' · ');
  $previewInfo.textContent = label;

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
  const s = getStickerData(card);
  state.currentSticker = s;

  const w = 160, h = 132;
  const left = Math.min(x, window.innerWidth - w);
  const top = Math.min(y, window.innerHeight - h);

  $ctxMenu.style.left = `${left}px`;
  $ctxMenu.style.top = `${top}px`;
  $ctxMenu.classList.add('show');

  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
  });
}

function closeContextMenu() {
  $ctxMenu.classList.remove('show');
}

$ctxMenu.addEventListener('click', e => {
  const action = e.target.closest('.cm-item')?.dataset.action;
  if (!action || !state.currentSticker) return;

  const s = state.currentSticker;
  switch (action) {
    case 'view':
      previewFromData(s);
      break;
    case 'download':
      downloadSticker(s);
      break;
    case 'related':
      searchRelated(s);
      break;
  }
  closeContextMenu();
});

function previewFromData(s) {
  $previewImg.src = s.url;
  $previewImg.alt = s.tags;
  const label = [s.filename, s.category, s.subcategory].filter(Boolean).join(' · ');
  $previewInfo.textContent = label;
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

// ====== 搜索关联（匹配 App 的 searchRelated） ======
function searchRelated(s) {
  const target = s.subcategory || s.category;
  if (target) {
    state.searchQuery = target;
    $search.value = target;
    state.currentCat = 'all';
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.cat-btn[data-cat="all"]')?.classList.add('active');
    filterStickers();
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

// ====== 启动 ======
init();
