/* 后台登录页 */

(function () {
  'use strict';

  const { api, toast, toggleTheme, loadSite } = window.App;

  const form = document.getElementById('loginForm');
  const errBox = document.getElementById('err');
  const btn = document.getElementById('loginBtn');

  document.querySelector('[data-theme-toggle]').addEventListener('click', toggleTheme);

  function showError(message) {
    errBox.hidden = false;
    errBox.querySelector('div').textContent = message;
  }

  // 已登录就直接进后台
  api
    .get('/api/admin/me')
    .then(() => location.replace('/admin'))
    .catch(() => {});

  // 顺手把站点名显示出来
  loadSite()
    .then((site) => {
      document.title = `登录 · ${site.name}`;
      document.getElementById('loginSub').textContent =
        `${site.name} · 登录后可以管理商品、卡密、订单和收款设置`;
      const mark = document.querySelector('.login-card .mark');
      if (site.logo) mark.innerHTML = `<img src="${site.logo}" alt="" style="width:100%;height:100%;object-fit:cover">`;
      else mark.textContent = (site.name || '店').charAt(0);
    })
    .catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) return showError('请填写账号和密码');

    btn.disabled = true;
    btn.textContent = '登录中…';

    try {
      await api.post('/api/admin/login', { username, password });
      toast('登录成功', 'ok');
      location.replace('/admin');
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = '登录';
      document.getElementById('password').select();
    }
  });
})();
