/**
 * 我的表情 — 网站脚本
 * 一级标签: 主页 | 二次元 | 网络
 * 二级标签: 每个一级下的具体名称
 */
const state = {
  stickers: [],
  categories: {},       // {主页: {游戏: [...], 动漫: [...], 网络: [...]}}
  primary: '主页',      // 当前一级
  secondary: null,      // 当前二级（null=全部）
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
const $primaryNav = document.querySelector('.primary-nav');
const $secondaryNav = document.querySelector('.secondary-nav');

// ====== 初始化 ======
async function init() {
  try {
    const res = await fetch('data/stickers.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.stickers = data.stickers || [];
    state.categories = data.categories || {};

    renderPrimaryNav();
    renderSecondaryNav('主页');
    renderGallery(state.stickers);
  } catch (err) {
    $gallery.innerHTML = `<div class="empty">加载失败<br><small>${err.message}</small></div>`;
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
      document.querySelectorAll('.primary-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSecondaryNav(tab);
      filterAndRender();
    });
    $primaryNav.appendChild(btn);
  });
}

// ====== 二级导航 ======
function renderSecondaryNav(primary) {
  $secondaryNav.innerHTML = '';

  if (primary === '主页' || primary === '二次元') {
    $secondaryNav.style.display = 'none';
    return;
  }

  const subSet = new Set();
  state.stickers.forEach(s => { if (s.subcategory === primary && s.category) subSet.add(s.category); });
  const subMap = [...subSet].sort();
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

  // 二级过滤
  if (state.secondary) {
    list = list.filter(s => s.category === state.secondary);
  }

  // 搜索
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

// ====== 渲染图片列表 ======
function renderGallery(list) {
  if (!list.length) {
    $gallery.innerHTML = '<div class="empty">没找到表情包<br><small>试试换个关键词</small></div>';
    return;
  }

  $gallery.innerHTML = list.map(s => {
    const label = [s.category, s.subcategory].filter(Boolean).join(' · ');
    return `
    <div class="sticker-card"
         data-id="${s.id}"
         data-url="${s.url}"
         data-filename="${s.filename}"
         data-category="${s.category || ''}"
         data-subcategory="${s.subcategory || ''}"
         data-tags="${s.tags.join(',')}">
      <img src="${s.url}" alt="${s.tags.join(', ')}" loading="lazy"
           onerror="this.parentElement.style.display='none'">
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
