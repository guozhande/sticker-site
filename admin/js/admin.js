/**
 * 上传审核后台（管理口令门面 + 待审核队列 + 通过/下架 + 运行日志 tab）
 *
 * 口令门面模式照搬 ai.js 骨架，但键完全独立（localStorage 'adminPass' ≠ 'aiPass'），
 * 且不支持 ?pass= URL 直入——AI 页的 URL 直入是为了分享，管理口令进 URL 会留在
 * 浏览器历史/访问日志，安全上刻意不做。
 *
 * 列表：POST /api/admin/list?limit=&offset=（FIFO 待审核队列，口令走 body.pass；
 * 浏览器禁止 GET 携带 body，故查询也走 POST，与 approve/reject 同模式）；
 * 操作：POST /api/admin/approve | /api/admin/reject（{id, pass}）。
 * 日志：POST /api/admin/logs?limit=&offset=&platform=（口令走 body.pass；tab 共存，
 * 首次切到日志 tab 懒加载；顶栏「刷新」按当前 tab 分发）。
 * 任何接口 403/503 统一走 clearPassToGate 回门面，不落列表状态区。
 *
 * XSS 铁律：全部 createElement + textContent，文件名/作品名/角色名/时间/错误文案
 * 永不进 innerHTML；缩略图只通过 img.src 属性赋值（url 是服务端从 r2_key 拼的，仍不走 HTML 字符串）。
 * 日志消息来自任意用户设备，同一条铁律：绝不 innerHTML。
 *
 * 依赖：js/config.js（window.STICKER_API_BASE），必须在 admin.js 之前加载。
 */
(function () {
  'use strict';

  const API = window.STICKER_API_BASE ?? '';
  const PAGE_LIMIT = 60;   // 对齐 functions/admin.js ADMIN_LIST_DEFAULT_LIMIT（首屏/每页条数）
  const LOG_PAGE_LIMIT = 50;   // 对齐 functions/admin.js ADMIN_LOGS_DEFAULT_LIMIT

  const $ = (id) => document.getElementById(id);

  // ---------- 状态 ----------
  // 管理口令：localStorage 记忆（与 AI 页 'aiPass' 完全独立）；空 = 门面态
  let adminPass = localStorage.getItem('adminPass') ?? '';
  let offset = 0;               // 下一页 offset（成功加载后 +PAGE_LIMIT）
  let total = 0;                // 待审核总数（顶栏计数）
  let loading = false;          // 列表在途锁（防重复加载）
  const inflight = new Set();   // 卡片级在途锁：审批请求中的条目 id（防连点）

  let currentTab = 'review';    // 'review' | 'logs'
  let logOffset = 0;            // 日志下一页 offset（成功加载后 +LOG_PAGE_LIMIT）
  let logTotal = 0;             // 日志总数（「共 N 条」）
  let logLoading = false;       // 日志列表在途锁（防重复加载）
  let logPlatform = '';         // '' | 'web' | 'app'
  let logsLoaded = false;       // 首次切到日志 tab 懒加载标记

  // ---------- DOM ----------
  const $main = $('ad-main');
  const $gate = $('ad-pass-gate');
  const $passInput = $('ad-pass-input');
  const $passErr = $('ad-pass-err');
  const $total = $('ad-total');
  const $list = $('ad-list');
  const $loadMore = $('ad-load-more');
  const $loadingBox = $('ad-status-loading');
  const $errorBox = $('ad-status-error');
  const $errorText = $('ad-status-error-text');
  const $emptyBox = $('ad-status-empty');
  const $review = $('ad-review');
  const $logs = $('ad-logs');
  const $tabReview = $('ad-tab-review');
  const $tabLogs = $('ad-tab-logs');
  const $logTotal = $('ad-log-total');
  const $logList = $('ad-log-list');
  const $logMore = $('ad-log-more');
  const $logLoadingBox = $('ad-log-status-loading');
  const $logErrorBox = $('ad-log-status-error');
  const $logErrorText = $('ad-log-status-error-text');
  const $logEmptyBox = $('ad-log-status-empty');

  // ---------- 工具 ----------
  let toastTimer = null;
  function toast(msg) {
    const el = $('ad-toast');
    el.textContent = msg;   // textContent：不进 innerHTML
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function updateTotal() {
    $total.textContent = String(total);
  }

  /** 状态区四态：loading / error / empty / list（列表态三块全隐）。 */
  function setStatus(state, message = '') {
    $loadingBox.hidden = state !== 'loading';
    $errorBox.hidden = state !== 'error';
    $emptyBox.hidden = state !== 'empty';
    if (state === 'error') $errorText.textContent = message;
  }

  function updateLoadMore() {
    // offset 已达/超过总数 → 全部加载完；列表为空（empty/error 初始态）也不显示
    $loadMore.hidden = offset >= total || $list.childElementCount === 0;
  }

  // ---------- 口令门面（照搬 ai.js 骨架，键独立）----------
  /** 按 adminPass 切换门面与主界面：无口令 → 只显门面；有口令 → 显主界面并自动加载列表。 */
  function applyPassGate() {
    const ok = adminPass !== '';
    $main.hidden = !ok;
    $gate.hidden = ok;
    if (ok) loadPage(true);   // 服务端验证：本地存的不一定有效
  }

  /**
   * 统一出口：清口令回门面。403 → 口令不正确（服务端不认本地存的）；
   * 503 → 后台未配置（冻结设计第 1 条：页面区分「未配置提示」，与 AI 页统一文案不同）。
   */
  function clearPassToGate(httpStatus) {
    adminPass = '';
    localStorage.removeItem('adminPass');
    logsLoaded = false;   // 重新进门后首次切日志 tab 再懒加载
    $passErr.textContent = httpStatus === 503
      ? '后台未配置：请先在 Cloudflare Pages 环境变量中设置 ADMIN_PASS'
      : '口令不正确，请重试';
    $passErr.hidden = false;
    applyPassGate();
  }

  /** 退出：清口令回门面（借人机器不留门），不显示错误行。 */
  function exitToGate() {
    adminPass = '';
    localStorage.removeItem('adminPass');
    $passErr.hidden = true;
    applyPassGate();
  }

  // ---------- 列表 ----------
  /**
   * 拉取一页待审核队列。clearFirst=true → 从 offset 0 重载（首载/刷新/整表重载）；
   * false → 「加载更多」按当前 offset 追加。403/503 不落状态区，走 clearPassToGate。
   */
  async function loadPage(clearFirst) {
    if (loading) return;
    loading = true;
    if (clearFirst) {
      offset = 0;
      $list.textContent = '';   // 清空（子节点全由 renderItem 创建，textContent 清空安全）
    }
    setStatus('loading');
    try {
      // POST 携带 JSON body（口令走 body.pass；浏览器禁止 GET 带 body，查询接口一律 POST）
      const res = await fetch(`${API}/api/admin/list?limit=${PAGE_LIMIT}&offset=${offset}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: adminPass }),
      });
      if (res.status === 403 || res.status === 503) { clearPassToGate(res.status); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      total = data.total ?? 0;
      updateTotal();
      for (const item of data.items ?? []) $list.append(renderItem(item));
      offset += PAGE_LIMIT;   // 设计口径：offset+=limit（队列状态变化导致的页漂移见设计风险清单）

      if ($list.childElementCount === 0) setStatus('empty');
      else setStatus('list');
    } catch (err) {
      setStatus('error', err.message || '加载失败，请重试');
    } finally {
      loading = false;
      updateLoadMore();
    }
  }

  /**
   * 渲染一条待审核卡片：缩略图（GIF 加「动图」角标）+ 作品名/角色名/文件名·大小·时间 + 通过/下架。
   * 全 createElement + textContent；loading=lazy；onerror 显示占位。
   */
  function renderItem(item) {
    const card = document.createElement('article');
    card.className = 'ad-card';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'ad-thumb-wrap';
    const thumb = document.createElement('img');
    thumb.className = 'ad-thumb';
    thumb.loading = 'lazy';
    thumb.alt = '';
    thumb.src = `${API}${item.url}`;
    thumb.addEventListener('error', () => {
      thumb.classList.add('ad-thumb-fail');
      thumb.removeAttribute('src');   // 移除 src 防 error 循环重试
    }, { once: true });
    thumbWrap.append(thumb);
    if (item.mime === 'image/gif') {
      const badge = document.createElement('span');
      badge.className = 'ad-badge';
      badge.textContent = '动图';
      thumbWrap.append(badge);
    }

    const info = document.createElement('div');
    info.className = 'ad-info';

    const work = document.createElement('div');
    work.className = 'ad-work';
    work.textContent = item.work;

    const chars = document.createElement('div');
    chars.className = 'ad-chars';
    chars.textContent = (item.characters ?? []).join('，');

    const meta = document.createElement('div');
    meta.className = 'ad-meta';
    const when = new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false });
    meta.textContent = `${item.filename} · ${Math.ceil(item.size / 1024)}KB · ${when}`;

    const actions = document.createElement('div');
    actions.className = 'ad-actions';
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'ad-act ad-approve';
    approveBtn.textContent = '通过';
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'ad-act ad-reject';
    rejectBtn.textContent = '下架';
    approveBtn.addEventListener('click', () => actOnItem('approve', item.id, card, approveBtn, rejectBtn));
    rejectBtn.addEventListener('click', () => actOnItem('reject', item.id, card, approveBtn, rejectBtn));
    actions.append(approveBtn, rejectBtn);

    info.append(work, chars, meta);
    card.append(thumbWrap, info, actions);
    return card;
  }

  /**
   * 通过/下架一条。单条在途锁（两按钮 disabled + 文案「处理中…」防连点）：
   * 成功 → 卡片移除 + 计数-1 + toast；404/409 → 该条目已被他人处理，整表重载；
   * 403/503 → clearPassToGate；网络错误 → 保留卡片与在途锁（点「刷新」恢复）。
   */
  async function actOnItem(action, id, card, approveBtn, rejectBtn) {
    if (inflight.has(id)) return;
    inflight.add(id);
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    approveBtn.textContent = '处理中…';
    try {
      const res = await fetch(`${API}/api/admin/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, pass: adminPass }),
      });
      if (res.status === 403 || res.status === 503) { clearPassToGate(res.status); return; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 404 || res.status === 409) {
        toast('该条目已处理');
        await loadPage(true);   // 他人已审/并发竞态：静默整表重载，不报错
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      card.remove();
      total = Math.max(0, total - 1);
      updateTotal();
      if ($list.childElementCount === 0) setStatus('empty');
      if (action === 'approve') {
        toast(data.credited ? '已通过，+5 分已发' : '已通过（存量行，无积分）');
      } else {
        toast('已下架');
      }
      updateLoadMore();
    } catch (err) {
      // 网络错误：请求可能根本没到达服务器 —— 卡片保留、在途锁保留防连点，点「刷新」重载
      toast(`操作失败：${err.message}`);
    } finally {
      inflight.delete(id);
    }
  }

  // ---------- tab 切换（待审核 / 运行日志）----------
  /** 互斥切换：active 高亮 + 两区块 hidden 互切；首次切到日志 tab 懒加载。 */
  function setTab(tab) {
    currentTab = tab;
    $tabReview.classList.toggle('active', tab === 'review');
    $tabLogs.classList.toggle('active', tab === 'logs');
    $review.hidden = tab !== 'review';
    $logs.hidden = tab !== 'logs';
    if (tab === 'logs' && !logsLoaded) {
      logsLoaded = true;
      loadLogs(true);
    }
  }

  // ---------- 运行日志 ----------
  /** 日志状态区四态：loading / error / empty / list（与审核页同款 .ad-status 类）。 */
  function setLogStatus(state, message = '') {
    $logLoadingBox.hidden = state !== 'loading';
    $logErrorBox.hidden = state !== 'error';
    $logEmptyBox.hidden = state !== 'empty';
    if (state === 'error') $logErrorText.textContent = message;
  }

  function updateLogMore() {
    $logMore.hidden = logOffset >= logTotal || $logList.childElementCount === 0;
  }

  /**
   * 拉取一页运行日志。clearFirst=true → 从 offset 0 重载（首载/刷新/切平台筛选）；
   * false → 「加载更多」按当前 offset 追加。403/503 走 clearPassToGate（与审核列表同模式）。
   */
  async function loadLogs(clearFirst) {
    if (logLoading) return;
    logLoading = true;
    if (clearFirst) {
      logOffset = 0;
      $logList.textContent = '';   // 清空（子节点全由 renderLogItem 创建，textContent 清空安全）
    }
    setLogStatus('loading');
    try {
      // POST 携带 JSON body（口令走 body.pass，与 admin/list 同模式）
      const res = await fetch(`${API}/api/admin/logs?limit=${LOG_PAGE_LIMIT}&offset=${logOffset}&platform=${encodeURIComponent(logPlatform)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: adminPass }),
      });
      if (res.status === 403 || res.status === 503) { clearPassToGate(res.status); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      logTotal = data.total ?? 0;
      $logTotal.textContent = String(logTotal);
      for (const item of data.items ?? []) $logList.append(renderLogItem(item));
      logOffset += LOG_PAGE_LIMIT;

      if ($logList.childElementCount === 0) setLogStatus('empty');
      else setLogStatus('list');
    } catch (err) {
      setLogStatus('error', err.message || '加载失败，请重试');
    } finally {
      logLoading = false;
      updateLogMore();
    }
  }

  /**
   * 渲染一条日志卡片：时间 + 平台徽标 + 页面 + 消息摘要（单行省略）+「堆栈」折叠按钮。
   * 全 createElement + textContent——错误消息来自任意用户设备，XSS 铁律：绝不 innerHTML。
   */
  function renderLogItem(item) {
    const card = document.createElement('article');
    card.className = 'ad-log-card';

    const head = document.createElement('div');
    head.className = 'ad-log-head';

    const when = document.createElement('span');
    when.className = 'ad-log-time';
    when.textContent = new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false });

    const platform = item.platform === 'web' || item.platform === 'app' ? item.platform : 'unknown';
    const badge = document.createElement('span');
    badge.className = `ad-log-badge ad-log-badge-${platform}`;
    badge.textContent = item.platform;

    const page = document.createElement('span');
    page.className = 'ad-log-page';
    page.textContent = item.page || '—';

    head.append(when, badge, page);

    const msg = document.createElement('div');
    msg.className = 'ad-log-msg';
    msg.textContent = item.message;

    card.append(head, msg);

    if (item.stack) {
      const stackBlock = document.createElement('pre');
      stackBlock.className = 'ad-log-stack';
      stackBlock.hidden = true;
      stackBlock.textContent = item.stack;

      const stackBtn = document.createElement('button');
      stackBtn.type = 'button';
      stackBtn.className = 'ad-btn ad-btn-ghost ad-log-stack-btn';
      stackBtn.textContent = '堆栈';
      stackBtn.addEventListener('click', () => {
        stackBlock.hidden = !stackBlock.hidden;
        stackBtn.textContent = stackBlock.hidden ? '堆栈' : '收起堆栈';
      });

      const body = document.createElement('div');
      body.className = 'ad-log-body';
      body.append(stackBlock, stackBtn);
      card.append(body);
    }

    return card;
  }

  // ---------- 事件绑定 ----------
  $('ad-pass-ok').addEventListener('click', () => {
    const v = $passInput.value.trim();
    if (!v) return;
    adminPass = v;
    localStorage.setItem('adminPass', v);   // 记住口令，下次免输
    $passErr.hidden = true;
    applyPassGate();   // 切主界面 + 自动加载（服务端验证口令）
  });
  $passInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('ad-pass-ok').click();   // 回车提交
  });

  $tabReview.addEventListener('click', () => setTab('review'));
  $tabLogs.addEventListener('click', () => setTab('logs'));

  $('ad-refresh').addEventListener('click', () => {
    // 顶栏刷新按当前 tab 分发：审核=loadPage(true) / 日志=loadLogs(true)
    if (currentTab === 'logs') loadLogs(true);
    else loadPage(true);
  });
  $('ad-retry').addEventListener('click', () => loadPage(true));
  $loadMore.addEventListener('click', () => loadPage(false));
  $('ad-exit').addEventListener('click', exitToGate);

  // 日志：平台筛选切换 → 从 offset 0 重载；日志专用刷新/重试/加载更多
  document.querySelectorAll('.ad-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      const platform = btn.dataset.platform ?? '';
      if (logPlatform === platform) return;
      logPlatform = platform;
      document.querySelectorAll('.ad-filter').forEach((b) => b.classList.toggle('active', b === btn));
      loadLogs(true);
    });
  });
  $('ad-log-refresh').addEventListener('click', () => loadLogs(true));
  $('ad-log-retry').addEventListener('click', () => loadLogs(true));
  $logMore.addEventListener('click', () => loadLogs(false));

  applyPassGate();   // 启动即按口令状态切换门面/主界面
})();
