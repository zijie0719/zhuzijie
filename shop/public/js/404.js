/* 404 页：只渲染页头页脚 */

(function () {
  'use strict';

  const fallback = '页面不存在';
  document.title = fallback;

  window.App.bootShell('').then((site) => {
    document.title = site ? `${fallback} · ${site.name}` : fallback;
  });
})();
