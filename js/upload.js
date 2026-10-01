/**
 * 表情包上传 —— 两步弹窗
 *
 *   ① 选图 + 输入「作品名称」
 *   ② 询问「是否单角色」
 *        是 → 一个输入框，提示「请输入角色名」
 *        否 → 一个输入框 + 〔＋〕按钮，点一下加一行
 *   提交 → POST 到 Worker
 *
 * 依赖：页面里有一个 id="upload-entry" 的容器（没有就自动插到主导航后面）。
 */
(function () {
  // API 就在同一个域名下（Cloudflare Pages Functions）：
  //   sticker-store-uzo.pages.dev  → 同源，直接用相对路径
  //   guozhande.github.io          → 那边没有 Functions，走绝对地址
  const API =
    window.STICKER_API ??
    (location.hostname.endsWith('.pages.dev') ? '' : 'https://sticker-store-uzo.pages.dev');

  const MAX_FILE_MB = 8;
  const OK_MIME = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'];

  // ---------- 状态 ----------
  let file = null;
  let work = '';
  let step = 1;          // 1=作品名  2=是否单角色  3=填角色名
  let single = null;     // true / false
  let charInputs = ['']; // 角色名输入框的值

  // ---------- DOM ----------
  const root = document.createElement('div');
  root.className = 'up-overlay';
  root.innerHTML = `
    <div class="up-dialog" role="dialog" aria-modal="true">
      <button class="up-close" type="button" aria-label="关闭">&times;</button>
      <div class="up-body"></div>
      <div class="up-actions">
        <button class="up-btn up-cancel" type="button">取消</button>
        <button class="up-btn up-primary" type="button"></button>
      </div>
    </div>`;

  const $body = root.querySelector('.up-body');
  const $primary = root.querySelector('.up-primary');
  const $cancel = root.querySelector('.up-cancel');
  const $close = root.querySelector('.up-close');

  // ---------- 入口按钮 ----------
  function mountEntry() {
    const host = document.getElementById('upload-entry');
    const btn = document.createElement('button');
    btn.className = 'upload-entry-btn';
    btn.type = 'button';
    btn.textContent = '＋ 上传表情';
    btn.addEventListener('click', open);
    if (host) host.appendChild(btn);
    else {
      const nav = document.querySelector('.primary-nav');
      nav ? nav.after(btn) : document.body.prepend(btn);
    }
  }

  function open() {
    file = null; work = ''; step = 1; single = null; charInputs = [''];
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('show'));
    render();
  }

  function close() {
    root.classList.remove('show');
    setTimeout(() => root.remove(), 150);
  }

  // ---------- 各步骤渲染 ----------
  function render() {
    if (step === 1) renderStep1();
    else if (step === 2) renderStep2();
    else renderStep3();
  }

  function renderStep1() {
    $primary.textContent = '下一步';
    $primary.disabled = !(file && work.trim());
    $body.innerHTML = `
      <h3 class="up-title">上传表情包</h3>
      <label class="up-field">
        <span class="up-label">选择图片（GIF / JPG / PNG / WebP，不超过 ${MAX_FILE_MB}MB）</span>
        <input class="up-file" type="file" accept="image/gif,image/jpeg,image/png,image/webp">
      </label>
      <div class="up-picked"></div>
      <label class="up-field">
        <span class="up-label">输入作品名称</span>
        <input class="up-text" type="text" maxlength="60" placeholder="例如：原神" value="${esc(work)}">
      </label>`;

    const $file = $body.querySelector('.up-file');
    const $text = $body.querySelector('.up-text');
    const $picked = $body.querySelector('.up-picked');

    $file.addEventListener('change', () => {
      const f = $file.files && $file.files[0];
      if (!f) return;
      if (!OK_MIME.includes(f.type)) { toast('只支持 GIF / JPG / PNG / WebP'); $file.value = ''; return; }
      if (f.size > MAX_FILE_MB * 1024 * 1024) { toast(`图片不能超过 ${MAX_FILE_MB}MB`); $file.value = ''; return; }
      file = f;
      $picked.innerHTML = `<img class="up-thumb" src="${URL.createObjectURL(f)}" alt="预览">`;
      $primary.disabled = !work.trim();
    });

    $text.addEventListener('input', () => {
      work = $text.value;
      $primary.disabled = !(file && work.trim());
    });
  }

  function renderStep2() {
    $primary.textContent = '';
    $primary.classList.add('hidden');
    $body.innerHTML = `
      <h3 class="up-title">是否单角色？</h3>
      <p class="up-hint">这张图里是只有一个角色，还是多个？</p>
      <div class="up-choices">
        <button class="up-choice" data-v="yes" type="button">是</button>
        <button class="up-choice" data-v="no" type="button">否</button>
      </div>`;

    $body.querySelectorAll('.up-choice').forEach((b) => {
      b.addEventListener('click', () => {
        single = b.dataset.v === 'yes';
        charInputs = [''];
        step = 3;
        render();
      });
    });
  }

  function renderStep3() {
    $primary.textContent = '提交';
    $primary.classList.remove('hidden');
    $primary.disabled = false;

    const rows = charInputs.map((v, i) => `
      <div class="up-char-row">
        <input class="up-text up-char" type="text" maxlength="40"
               placeholder="${i === 0 ? '请输入角色名' : '再输入一个角色名'}"
               value="${esc(v)}" data-i="${i}">
        ${single ? '' : '<button class="up-remove" type="button" data-i="' + i + '" aria-label="删除这一行">&times;</button>'}
      </div>`).join('');

    $body.innerHTML = `
      <h3 class="up-title">${single ? '请输入角色名' : '请输入角色名（可多个）'}</h3>
      <div class="up-char-list">${rows}</div>
      ${single ? '' : '<button class="up-add" type="button">＋ 添加角色</button>'}`;

    $body.querySelectorAll('.up-char').forEach((inp) => {
      inp.addEventListener('input', () => { charInputs[+inp.dataset.i] = inp.value; });
    });
    $body.querySelectorAll('.up-remove').forEach((b) => {
      b.addEventListener('click', () => {
        charInputs.splice(+b.dataset.i, 1);
        if (!charInputs.length) charInputs = [''];
        render();
      });
    });
    const $add = $body.querySelector('.up-add');
    if ($add) $add.addEventListener('click', () => {
      if (charInputs.length >= 12) return toast('最多 12 个角色');
      charInputs.push('');
      render();
      const all = $body.querySelectorAll('.up-char');
      all[all.length - 1]?.focus();
    });
    $body.querySelector('.up-char')?.focus();
  }

  // ---------- 提交 ----------
  async function submit() {
    const characters = charInputs.map((s) => s.trim()).filter(Boolean);
    if (characters.length === 0) return toast('请至少填一个角色名');

    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('work', work.trim());
    fd.append('characters', JSON.stringify(characters));

    $primary.disabled = true;
    $primary.textContent = '上传中…';
    try {
      const res = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      $body.innerHTML = `
        <h3 class="up-title">上传成功 🎉</h3>
        <p class="up-hint">「${esc(work)}」· ${characters.map(esc).join('、')}</p>`;
      $primary.classList.add('hidden');
      $cancel.textContent = '关闭';
      setTimeout(close, 1800);
    } catch (err) {
      toast(`上传失败：${err.message}`);
      $primary.disabled = false;
      $primary.textContent = '提交';
    }
  }

  // ---------- 事件 ----------
  $primary.addEventListener('click', () => {
    if (step === 1 && file && work.trim()) { step = 2; render(); }
    else if (step === 3) submit();
  });
  $cancel.addEventListener('click', close);
  $close.addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.isConnected) close(); });

  // ---------- 工具 ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('up-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'up-toast';
      el.className = 'up-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  mountEntry();
})();
