/**
 * 表情包存储站 — 前端逻辑
 */
const state = {
  stickers: [],
  categories: [],
  currentCat: 'all',
  searchQuery: '',
  currentSticker: null,
};

// ====== DOM 引用 ======
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
    renderCategories();
    renderGallery(state.stickers);
  } catch (err) {
    $gallery.innerHTML = `<div class="empty">加载失败 💀<br><small>${err.message}</small></div>`;
  }
}

// ====== 分类导航 ======
function renderCategories() {
  const nav = document.querySelector('.categories');
  nav.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = 'cat-btn active';
  allBtn.dataset.cat = 'all';
  allBtn.textContent = '全部';
  allBtn.addEventListener('click', () => selectCategory('all', allBtn));
  nav.appendChild(allBtn);

  state.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn';
    btn.dataset.cat = cat;
    btn.textContent = cat;
    btn.addEventListener('click', () => selectCategory(cat, btn));
    nav.appendChild(btn);
  });
}

function selectCategory(cat, el) {
  state.currentCat = cat;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
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

// ====== 过滤 ======
function filterStickers() {
  let list = state.stickers;
  if (state.currentCat !== 'all') {
    list = list.filter(s => s.category === state.currentCat);
  }
  if (state.searchQuery) {
    const q = state.searchQuery;
    list = list.filter(s =>
      s.tags.some(t => t.includes(q)) ||
      (s.category || '').includes(q) ||
      (s.filename || '').includes(q)
    );
  }
  renderGallery(list);
}

// ====== 渲染图片列表 ======
function renderGallery(list) {
  if (!list.length) {
    $gallery.innerHTML = '<div class="empty">😵 没找到表情包<br><small>试试换个关键词</small></div>';
    return;
  }

  $gallery.innerHTML = list.map(s => `
    <div class="sticker-card"
         data-id="${s.id}"
         data-url="${s.url}"
         data-filename="${s.filename}"
         data-category="${s.category || ''}"
         data-tags="${s.tags.join(',')}">
      <img src="${s.url}" alt="${s.tags.join(', ')}" loading="lazy"
           onerror="this.parentElement.style.display='none'">
      <div class="tags">
        ${s.tags.slice(0, 3).map(t => `<span class="tag">#${t}</span>`).join('')}
      </div>
    </div>
  `).join('');

  // 左键 → 放大查看
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
    tags: card.dataset.tags,
  };
}

// ====== 图片预览弹窗 ======
function openPreview(card) {
  const s = getStickerData(card);
  state.currentSticker = s;
  $previewImg.src = s.url;
  $previewImg.alt = s.tags;
  $previewInfo.textContent = `${s.filename} · ${s.category}`;
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

// 弹窗内按钮
document.getElementById('pa-download').addEventListener('click', () => {
  if (state.currentSticker) downloadSticker(state.currentSticker);
});
document.getElementById('pa-related').addEventListener('click', () => {
  if (state.currentSticker) searchRelated(state.currentSticker);
  closePreview();
});

// ESC 关闭
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePreview();
});

// ====== 右键菜单 ======
function openContextMenu(card, x, y) {
  const s = getStickerData(card);
  state.currentSticker = s;

  // 定位菜单位置（防止溢出）
  const w = 160, h = 132;
  const left = Math.min(x, window.innerWidth - w);
  const top = Math.min(y, window.innerHeight - h);

  $ctxMenu.style.left = `${left}px`;
  $ctxMenu.style.top = `${top}px`;
  $ctxMenu.classList.add('show');

  // 点击其他地方关闭
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
  });
}

function closeContextMenu() {
  $ctxMenu.classList.remove('show');
}

// 右键菜单选项
$ctxMenu.addEventListener('click', e => {
  const action = e.target.closest('.cm-item')?.dataset.action;
  if (!action || !state.currentSticker) return;

  const s = state.currentSticker;
  switch (action) {
    case 'view':
      // 需要在 card 列表中找回对应元素来打开预览
      openPreviewBySticker(s);
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

function openPreviewBySticker(s) {
  $previewImg.src = s.url;
  $previewImg.alt = s.tags;
  $previewInfo.textContent = `${s.filename} · ${s.category}`;
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
  showToast(`✅ 已下载: ${s.filename}<br>位置: C:\\Users\\asd19\\Downloads (按 Ctrl+J 查看)`);
}

// ====== 搜索关联（按分类筛选） ======
function searchRelated(s) {
  if (s.category) {
    state.currentCat = s.category;
    state.searchQuery = '';
    $search.value = '';
    // 更新分类按钮状态
    document.querySelectorAll('.cat-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.cat === s.category);
    });
    filterStickers();
    showToast(`🔗 已筛选: ${s.category}`);
  } else {
    showToast('该表情包没有分类信息');
  }
}

// ====== Toast ======
function showToast(msg) {
  $toast.innerHTML = msg.replace(/\n/g, '<br>');
  $toast.classList.add('show');
  clearTimeout($toast._timer);
  $toast._timer = setTimeout(() => $toast.classList.remove('show'), 2500);
}

// ====== 启动 ======
init();
