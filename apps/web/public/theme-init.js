// Выбранная тема применяется до отрисовки, чтобы страница не мигала светлым перед тёмной
(function () {
  try {
    var t = localStorage.getItem('zapas.theme');
    if (t === 'dark' || t === 'colorful' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.setAttribute('data-theme', 'dark');
    if (localStorage.getItem('zapas.ui') === 'pro') document.documentElement.setAttribute('data-ui', 'pro');
  } catch (e) {
    /* хранилище недоступно: остаётся светлая тема */
  }
})();
