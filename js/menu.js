// 主页汉堡菜单：开关/外部点击/Escape 关闭 + 制作子菜单手风琴
(function () {
  'use strict';
  const btn = document.getElementById('menu-btn');
  const drawer = document.getElementById('menu-drawer');
  const backdrop = document.getElementById('menu-backdrop');
  const groupManual = document.getElementById('menu-group-manual');
  const subManual = document.getElementById('menu-sub-manual');

  function setOpen(open) {
    drawer.classList.toggle('open', open);
    backdrop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }
  btn.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
  backdrop.addEventListener('click', () => setOpen(false));
  document.addEventListener('click', (e) => {
    if (drawer.classList.contains('open') && !e.target.closest('#menu-drawer') && !e.target.closest('#menu-btn')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) setOpen(false);
  });
  groupManual.addEventListener('click', () => {
    const open = !subManual.classList.contains('open');
    subManual.classList.toggle('open', open);
    groupManual.setAttribute('aria-expanded', String(open));
  });
  document.getElementById('menu-tpl').addEventListener('click', () => { setOpen(false); showToast('敬请期待'); });
  // 「AI 制作」已是 <a href="ai/">，走原生跳转；模板制作仍占位 toast 敬请期待。
  setOpen(false);   // 载入兜底：背板 hidden（HTML 已带 hidden 属性，双保险）
})();
