/**
 * 表情包存储站 — 前端逻辑
 * 纯静态，零依赖，零后端
 */

const state = {
  stickers: [],
  categories: [],
  currentCat: 'all',
  searchQuery: '',
};

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
    document.getElementById('gallery').innerHTML =
      `<div class="empty">加载失败 💀<br><small>${err.message}</small></div>`;
  }
}

// ====== 分类导航 ======
function renderCategories() {
  const nav = document.querySelector('.categories');
  nav.innerHTML = '<button class="cat-btn active" data-cat="all">全部</button>';
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
document.getElementById('search').addEventListener('input', e => {
  state.searchQuery = e.target.value.trim().toLowerCase();
  filterStickers();
});

document.getElementById('search-btn').addEventListener('click', () => {
  state.searchQuery = document.getElementById('search').value.trim().toLowerCase();
  filterStickers();
});

// ====== 过滤 ======
function filterStickers() {
  let list = state.stickers;
  if (state.currentCat !== 'all') {
    list = list.filter(s => s.category === state.currentCat);
  }
  if (state.searchQuery) {
    list = list.filter(s =>
      s.tags.some(t => t.includes(state.searchQuery)) ||
      (s.category || '').includes(state.searchQuery) ||
      (s.filename || '').includes(state.searchQuery)
    );
  }
  renderGallery(list);
}

// ====== 渲染图片列表 ======
function renderGallery(list) {
  const container = document.getElementById('gallery');
  if (!list.length) {
    container.innerHTML = '<div class="empty">😵 没找到表情包<br><small>试试换个关键词</small></div>';
    return;
  }

  container.innerHTML = list.map(s => `
    <div class="sticker-card"
         data-id="${s.id}"
         data-url="${s.url}"
         data-filename="${s.filename}">
      <img src="${s.url}"
           alt="${s.tags.join(', ')}"
           loading="lazy"
           onerror="this.parentElement.style.display='none'">
      <div class="tags">
        ${s.tags.slice(0, 3).map(t => `<span class="tag">#${t}</span>`).join('')}
      </div>
    </div>
  `).join('');

  // 绑定点击事件
  container.querySelectorAll('.sticker-card').forEach(card => {
    card.addEventListener('click', () => handleStickerClick(card));
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      handleStickerClick(card);
    });
  });
}

// ====== 图片操作 ======
function handleStickerClick(card) {
  const url = card.dataset.url;
  const filename = card.dataset.filename || 'sticker.gif';
  downloadSticker(url, filename);
}

function downloadSticker(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast(`✅ 已下载: ${filename}`);
}

// ====== Toast 提示 ======
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// ====== 启动 ======
init();
