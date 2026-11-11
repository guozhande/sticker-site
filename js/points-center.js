/**
 * 主页积分中心（复用 up-overlay 弹窗体系）
 *
 * 入口：header 右上角「积分 N」胶囊（载入时静默拉一次余额填充；失败显示「积分 –」，点开弹窗时重试）。
 * 弹窗：余额卡 + 每日签到 + 积分流水 + 模拟充值。所有数据刷新收敛到单一 refresh()
 * （余额+流水顺序 await，防竞态覆盖）；请求全部走 StickerDevice.apiFetch 自动带 X-Device-Id。
 *
 * 依赖：js/config.js（window.STICKER_API_BASE）、js/device.js（window.StickerDevice），
 * 以及主页的 #toast 提示条与 .up-overlay/.up-dialog/.up-close 弹窗样式。
 */
(function () {
  'use strict';

  const API = window.STICKER_API_BASE ?? '';
  // device.js 正常先加载；极端情况（脚本被阻断）退回裸 fetch，仅丢失设备号头
  const apiFetch = window.StickerDevice ? window.StickerDevice.apiFetch : (url, options) => fetch(url, options);

  // ---- 常量（数值/文案集中，禁止散落魔法数）----
  const LOG_LIMIT = 20;                              // 流水条数（对齐后端默认 20）
  const SIGNIN_LABEL = '每日签到 +3 积分';
  const SIGNIN_BUSY_LABEL = '签到中…';
  const SIGNIN_DONE_LABEL = '今日已签到';
  const STREAK_LABEL = (n) => `已连签 ${n} 天`;
  const REASON_LABEL = {                             // 流水原因 → 中文
    signin: '签到',
    upload: '上传过审',
    recharge: '充值',
    ai_spend: 'AI 生成',
  };
  const STATUS_LABEL = {                             // 流水状态徽标（其余状态不显示）
    pending: '预扣中',
    refunded: '已退回',
  };
  const RECHARGE_OPTIONS = [                         // 充值档位：yuan=展示、cents=API 入参（单位分，1 分=1 积分）
    { yuan: 1, cents: 100 },
    { yuan: 5, cents: 500 },
    { yuan: 10, cents: 1000 },
    { yuan: 50, cents: 5000 },
  ];

  const $ = (id) => document.getElementById(id);

  // ---- DOM ----
  const $entry = $('points-entry');
  const $modal = $('points-modal');
  const $balance = $('points-balance');
  const $totalEarned = $('points-total-earned');
  const $signinBtn = $('points-signin-btn');
  const $streak = $('points-streak');
  const $log = $('points-log');
  const $chips = $('points-recharge-chips');
  const $confirm = $('points-recharge-confirm');

  // ---- 状态 ----
  let signinBusy = false;    // 签到在途锁（防连点双签）
  let rechargeBusy = false;  // 充值在途锁（防连点双充）
  let selectedCents = 0;     // 当前选中的充值档位（分）；0=未选

  // ---- 工具 ----
  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;   // textContent：后端文案/数字永不进 innerHTML
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /** 毫秒时间戳 → 「MM-DD HH:mm」（本地时区展示）。 */
  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---- 弹窗开关 ----
  function setOpen(open) {
    $modal.classList.toggle('show', open);
    if (open) {
      resetSigninState();   // 重开弹窗时签到按钮恢复可点（「今日已签到」态只在关闭前保持）
      refresh();
    }
  }

  function resetSigninState() {
    signinBusy = false;
    $signinBtn.disabled = false;
    $signinBtn.textContent = SIGNIN_LABEL;
  }

  // ---- 数据刷新（单一入口）----
  /** 余额 + 流水顺序拉取；余额失败静默（入口显示「积分 –」），流水失败清空列表。 */
  async function refresh() {
    try {
      const res = await apiFetch(`${API}/api/points/balance`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      $balance.textContent = String(data.points ?? 0);
      $totalEarned.textContent = `累计获得 ${data.totalEarned ?? 0}`;
      $entry.textContent = `积分 ${data.points ?? 0}`;
    } catch (err) {
      $balance.textContent = '–';
      $entry.textContent = '积分 –';
      console.error('积分余额拉取失败：', err?.message ?? err);   // 不吞异常：留日志，UI 静默降级
    }
    try {
      const res = await apiFetch(`${API}/api/points/log?limit=${LOG_LIMIT}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      renderLog(data.items ?? []);
    } catch (err) {
      renderLog([]);
      console.error('积分流水拉取失败：', err?.message ?? err);
    }
  }

  /** 流水渲染：变化值（+N 绿 / -N 红）+ 原因中文 + 状态徽标 + 时间。全部 createElement + textContent。 */
  function renderLog(items) {
    $log.textContent = '';   // 清空（子节点全由本函数创建，textContent 清空安全）
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'points-log-empty';
      empty.textContent = '暂无流水';
      $log.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'points-log-item';

      const change = document.createElement('span');
      change.className = `points-log-change ${item.change > 0 ? 'points-log-pos' : 'points-log-neg'}`;
      change.textContent = item.change > 0 ? `+${item.change}` : String(item.change);

      const reason = document.createElement('span');
      reason.className = 'points-log-reason';
      reason.textContent = REASON_LABEL[item.reason] ?? item.reason ?? '';

      row.append(change, reason);

      const badgeLabel = STATUS_LABEL[item.status];
      if (badgeLabel) {
        const badge = document.createElement('span');
        badge.className = `points-log-badge ${item.status === 'pending' ? 'points-badge-pending' : 'points-badge-refunded'}`;
        badge.textContent = badgeLabel;
        row.append(badge);
      }

      const time = document.createElement('span');
      time.className = 'points-log-time';
      time.textContent = formatTime(item.createdAt);
      row.append(time);

      $log.append(row);
    }
  }

  // ---- 签到 ----
  async function signin() {
    if (signinBusy) return;   // 防连点（按钮已 disabled，双保险）
    signinBusy = true;
    $signinBtn.disabled = true;
    $signinBtn.textContent = SIGNIN_BUSY_LABEL;
    try {
      const res = await apiFetch(`${API}/api/points/signin`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {   // 已签到：按钮锁定，关闭弹窗前保持
        $signinBtn.textContent = SIGNIN_DONE_LABEL;
        toast(data.error || '今天已签到，明天再来');
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const bonusText = data.bonus > 0 ? `（含连签奖励 +${data.bonus}）` : '';
      toast(`签到成功 +${data.gained} 积分${bonusText}`);
      $signinBtn.textContent = SIGNIN_DONE_LABEL;
      $streak.textContent = STREAK_LABEL(data.streak);
      $streak.hidden = false;
      await refresh();
    } catch (err) {
      toast(`签到失败：${err.message}`);
      resetSigninState();
    } finally {
      signinBusy = false;
    }
  }

  // ---- 充值 ----
  /** 充值 chips 由 RECHARGE_OPTIONS 单一来源渲染（HTML 不重复写死档位）。 */
  function renderRechargeChips() {
    $chips.textContent = '';
    for (const opt of RECHARGE_OPTIONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'points-chip';
      chip.dataset.cents = String(opt.cents);
      chip.textContent = `${opt.yuan} 元`;
      chip.addEventListener('click', () => selectRecharge(opt));
      $chips.append(chip);
    }
  }

  function selectRecharge(opt) {
    if (rechargeBusy) return;   // 在途锁期间禁止换档
    selectedCents = opt.cents;
    $chips.querySelectorAll('.points-chip').forEach((chip) => {
      chip.classList.toggle('active', Number(chip.dataset.cents) === opt.cents);
    });
    $confirm.hidden = false;
    $confirm.textContent = `确认充值 ¥${opt.yuan}（模拟支付）`;
  }

  function clearRechargeSelection() {
    selectedCents = 0;
    $chips.querySelectorAll('.points-chip').forEach((chip) => chip.classList.remove('active'));
    $confirm.hidden = true;
  }

  function setRechargeDisabled(disabled) {
    $chips.querySelectorAll('.points-chip').forEach((chip) => { chip.disabled = disabled; });
    $confirm.disabled = disabled;
  }

  async function recharge() {
    if (rechargeBusy || !selectedCents) return;   // 防连点双充
    rechargeBusy = true;
    setRechargeDisabled(true);
    try {
      const res = await apiFetch(`${API}/api/points/recharge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: selectedCents }),   // 单位分（1 分 = 1 积分）
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast(`充值成功，+${data.points} 积分`);
      clearRechargeSelection();   // 成功后清选中态，防手滑重复充值
      await refresh();
    } catch (err) {
      toast(`充值失败：${err.message}`);
    } finally {
      rechargeBusy = false;
      setRechargeDisabled(false);
    }
  }

  // ---- 事件绑定 ----
  $entry.addEventListener('click', () => setOpen(true));
  $('points-close').addEventListener('click', () => setOpen(false));
  $modal.addEventListener('click', (e) => { if (e.target === $modal) setOpen(false); });   // 背板点击关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $modal.classList.contains('show')) setOpen(false);   // Escape 关闭
  });
  $signinBtn.addEventListener('click', signin);
  $confirm.addEventListener('click', recharge);

  renderRechargeChips();

  // 页面载入：静默拉一次余额填充入口数字（失败已在 refresh 内降级为「积分 –」）
  refresh();

  // URL ?points=1 自动打开（AI 页「去积分中心」深链 ../index.html?points=1）
  if (new URLSearchParams(location.search).get('points') === '1') setOpen(true);
})();
