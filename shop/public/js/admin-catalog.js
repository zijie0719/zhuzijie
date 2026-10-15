/* 后台：商品管理、卡密库存、商品分类、系统设置、收款设置 */

(function () {
  'use strict';

  const A = window.Admin;
  if (!A) return;

  const { api, esc, money, toast, dateTime, confirmDialog, promptDialog, modal, emptyRow, register } = A;

  /* ================================================================ *
   * 公共小工具
   * ================================================================ */

  async function uploadImage(file) {
    if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
    if (file.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5MB');

    const res = await fetch('/api/admin/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type },
      body: file
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || '上传失败');
    return data.url;
  }

  /**
   * 图片选择控件：返回 HTML 字符串，并用 wireImagePicker 绑定行为。
   * onChange(url) 会在选图 / 填地址 / 移除时触发。
   */
  function imagePickerHtml(id, current) {
    return `
      <div class="upload-box" data-picker="${id}">
        <div class="preview" data-preview>
          ${
            current
              ? `<img src="${esc(current)}" alt="">`
              : '<span>暂无图片</span>'
          }
        </div>
        <div class="info">
          <div>支持 PNG / JPG / GIF / WEBP，不超过 5MB</div>
          <div class="row">
            <button class="btn btn-sm" type="button" data-pick>选择图片</button>
            <button class="btn btn-sm" type="button" data-url>填写图片地址</button>
            <button class="btn btn-sm btn-danger" type="button" data-clear>移除</button>
          </div>
          <input type="file" accept="image/*" hidden data-file>
          <input type="hidden" data-value value="${esc(current || '')}">
        </div>
      </div>`;
  }

  function wireImagePicker(root, onChange) {
    const box = root.querySelector('[data-picker]');
    if (!box) return;

    const fileInput = box.querySelector('[data-file]');
    const valueInput = box.querySelector('[data-value]');
    const preview = box.querySelector('[data-preview]');

    const setValue = (url) => {
      valueInput.value = url || '';
      preview.innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<span>暂无图片</span>';
      onChange(url || '');
    };

    box.querySelector('[data-pick]').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      preview.innerHTML = '<span>上传中…</span>';
      try {
        const url = await uploadImage(file);
        setValue(url);
        toast('图片上传成功', 'ok');
      } catch (err) {
        toast(err.message, 'err');
        preview.innerHTML = valueInput.value
          ? `<img src="${esc(valueInput.value)}" alt="">`
          : '<span>暂无图片</span>';
      } finally {
        fileInput.value = '';
      }
    });

    box.querySelector('[data-url]').addEventListener('click', async () => {
      const url = await promptDialog({
        title: '填写图片地址',
        label: '图片 URL',
        value: valueInput.value,
        placeholder: 'https://… 或 /uploads/xxx.png'
      });
      if (url !== null) setValue(url);
    });

    box.querySelector('[data-clear]').addEventListener('click', () => setValue(''));

    // 支持直接拖拽
    const dropTarget = box;
    ['dragenter', 'dragover'].forEach((ev) =>
      dropTarget.addEventListener(ev, (e) => {
        e.preventDefault();
        dropTarget.classList.add('dragover');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dropTarget.addEventListener(ev, (e) => {
        e.preventDefault();
        dropTarget.classList.remove('dragover');
      })
    );
    dropTarget.addEventListener('drop', async (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      preview.innerHTML = '<span>上传中…</span>';
      try {
        const url = await uploadImage(file);
        setValue(url);
        toast('图片上传成功', 'ok');
      } catch (err) {
        toast(err.message, 'err');
        preview.innerHTML = valueInput.value
          ? `<img src="${esc(valueInput.value)}" alt="">`
          : '<span>暂无图片</span>';
      }
    });
  }

  /** 开关控件 */
  function switchHtml(id, checked, title, desc) {
    return `
      <label class="switch-row" style="cursor:pointer">
        <span>
          <span class="t">${esc(title)}</span>
          ${desc ? `<span class="d">${esc(desc)}</span>` : ''}
        </span>
        <span class="switch">
          <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
          <span class="track"></span>
        </span>
      </label>`;
  }

  function productThumb(p) {
    return p.cover
      ? `<img class="thumb" src="${esc(p.cover)}" alt="">`
      : `<div class="thumb-fallback">${esc((p.name || '?').charAt(0))}</div>`;
  }

  /* ================================================================ *
   * 商品管理
   * ================================================================ */

  let productsCache = [];
  let categoriesCache = [];

  async function fetchProducts() {
    const { products } = await api.get('/api/admin/products');
    productsCache = products;
    return products;
  }

  async function fetchCategories() {
    const { categories } = await api.get('/api/admin/categories');
    categoriesCache = categories;
    return categories;
  }

  register('products', {
    title: '商品管理',
    async render() {
      const [products] = await Promise.all([fetchProducts(), fetchCategories()]);

      const table = document.getElementById('productsTable');
      table.innerHTML = `
        <thead><tr>
          <th>商品</th><th>价格</th><th>发货方式</th><th>库存</th>
          <th>销量</th><th>排序</th><th>状态</th><th style="width:1%">操作</th>
        </tr></thead>
        <tbody>${
          products.length
            ? products.map(productRow).join('')
            : emptyRow(8, '还没有商品，点右上角「发布新商品」开始', '📦')
        }</tbody>`;

      table.querySelectorAll('[data-pact]').forEach((btn) => {
        btn.addEventListener('click', () =>
          handleProductAction(btn.dataset.pact, Number(btn.dataset.id))
        );
      });
    }
  });

  function productRow(p) {
    const isAuto = p.delivery_type === 'auto';

    const stockCell = isAuto
      ? `${A.stockBar(p.cardStock)}
         <div class="muted">卡密 ${p.cardStock} 可用 / ${p.cardTotal} 总</div>`
      : `<b>${p.stock < 0 ? '充足' : p.stock}</b>`;

    return `<tr>
      <td>
        <div class="cell-product">
          ${productThumb(p)}
          <div>
            <div class="t">${esc(p.name)}</div>
            <div class="s">${esc(p.subtitle || p.categoryName || '—')}</div>
          </div>
        </div>
      </td>
      <td class="nowrap">
        <b style="color:var(--price)">¥${p.priceText}</b>
        ${p.originalPriceText ? `<div class="muted" style="text-decoration:line-through">¥${p.originalPriceText}</div>` : ''}
      </td>
      <td class="nowrap">${
        isAuto
          ? '<span class="pill paid">自动发货</span>'
          : '<span class="pill pending">人工发货</span>'
      }</td>
      <td>${stockCell}</td>
      <td>${p.sales}</td>
      <td class="muted">${p.sort}</td>
      <td class="nowrap">${
        p.status
          ? '<span class="pill delivered">已上架</span>'
          : '<span class="pill cancelled">已下架</span>'
      }</td>
      <td><div class="actions">
        <button class="btn btn-sm" data-pact="edit" data-id="${p.id}">编辑</button>
        ${
          isAuto
            ? `<button class="btn btn-sm" data-pact="cards" data-id="${p.id}">卡密</button>`
            : ''
        }
        <button class="btn btn-sm" data-pact="toggle" data-id="${p.id}">
          ${p.status ? '下架' : '上架'}
        </button>
        <button class="btn btn-sm btn-danger" data-pact="delete" data-id="${p.id}">删除</button>
      </div></td>
    </tr>`;
  }

  async function handleProductAction(action, id) {
    const p = productsCache.find((x) => x.id === id);
    if (!p) return;

    if (action === 'edit') return openProductModal(p);

    if (action === 'cards') {
      window.location.hash = '#/cards';
      setTimeout(() => {
        const sel = document.getElementById('cardProduct');
        if (sel) {
          sel.value = String(id);
          sel.dispatchEvent(new Event('change'));
        }
      }, 60);
      return;
    }

    if (action === 'toggle') {
      await api.put(`/api/admin/products/${id}`, productToPayload({ ...p, status: p.status ? 0 : 1 }));
      toast(p.status ? '商品已下架' : '商品已上架', 'ok');
      renderAgain('products');
      return;
    }

    if (action === 'delete') {
      const yes = await confirmDialog(
        `确定要删除商品「${esc(p.name)}」吗？<br><br>` +
          (p.sales > 0
            ? '该商品已有售出记录，将被改为下架处理，以保留历史订单。'
            : '该商品及其未售出的卡密都会被删除，此操作不可撤销。'),
        { okText: '删除', danger: true }
      );
      if (!yes) return;
      const res = await api.del(`/api/admin/products/${id}`);
      toast(res.message || '已删除', 'ok');
      renderAgain('products');
    }
  }

  /** 重新渲染当前区块 */
  function renderAgain(route) {
    return A.go(route);
  }

  /** 把后台商品对象转成接口需要的入参（分 → 元） */
  function productToPayload(p) {
    return {
      name: p.name,
      subtitle: p.subtitle,
      description: p.description,
      cover: p.cover,
      price: p.priceText !== undefined ? p.priceText : money(p.price),
      originalPrice: p.original_price ? money(p.original_price) : '',
      categoryId: p.category_id,
      deliveryType: p.delivery_type,
      stock: p.stock,
      sort: p.sort,
      status: p.status,
      maxPerOrder: p.max_per_order
    };
  }

  document.getElementById('addProductBtn').addEventListener('click', () => openProductModal(null));

  async function openProductModal(product) {
    if (!categoriesCache.length) await fetchCategories().catch(() => {});
    const isNew = !product;
    const p = product || {
      name: '',
      subtitle: '',
      description: '',
      cover: '',
      price: 0,
      original_price: null,
      category_id: null,
      delivery_type: 'auto',
      stock: 0,
      sort: 0,
      status: 1,
      max_per_order: 10
    };

    const catOptions = [
      '<option value="">不分类</option>',
      ...categoriesCache.map(
        (c) =>
          `<option value="${c.id}" ${String(p.category_id) === String(c.id) ? 'selected' : ''}>${esc(
            c.name
          )}</option>`
      )
    ].join('');

    const m = modal({
      title: isNew ? '发布新商品' : '编辑商品',
      size: 'wide',
      body: `
        <div class="stack">
          <div class="form-grid">
            <div class="field full">
              <label class="required">商品名称</label>
              <input class="input" id="fName" type="text" maxlength="120"
                     value="${esc(p.name)}" placeholder="例如：设计软件专业版 激活码（1年）">
            </div>
            <div class="field full">
              <label>副标题</label>
              <input class="input" id="fSubtitle" type="text" maxlength="160"
                     value="${esc(p.subtitle)}" placeholder="一句话卖点，会显示在商品卡片上">
            </div>
            <div class="field">
              <label class="required">售价（元）</label>
              <input class="input" id="fPrice" type="number" min="0" step="0.01"
                     value="${p.price ? money(p.price) : ''}" placeholder="29.90">
            </div>
            <div class="field">
              <label>划线价（元，选填）</label>
              <input class="input" id="fOriginal" type="number" min="0" step="0.01"
                     value="${p.original_price ? money(p.original_price) : ''}" placeholder="59.90">
            </div>

            <div class="field">
              <label>发货方式</label>
              <select class="select" id="fDelivery" style="width:100%">
                <option value="auto" ${p.delivery_type === 'auto' ? 'selected' : ''}>
                  自动发货（预存卡密，付款后秒发）
                </option>
                <option value="manual" ${p.delivery_type === 'manual' ? 'selected' : ''}>
                  人工发货（实物 / 需人工处理）
                </option>
              </select>
            </div>

            <div class="field" id="stockField">
              <label>库存数量</label>
              <input class="input" id="fStock" type="number" min="-1" step="1" value="${p.stock}">
              <span class="hint">填 -1 表示不限库存；自动发货商品的库存由卡密数量决定</span>
            </div>

            <div class="field" id="maxField">
              <label>每单限购</label>
              <input class="input" id="fMax" type="number" min="1" max="999" step="1"
                     value="${p.max_per_order}">
              <span class="hint">防止一次把卡密买空，默认 10</span>
            </div>

            <div class="field">
              <label>商品分类</label>
              <select class="select" id="fCategory" style="width:100%">${catOptions}</select>
            </div>

            <div class="field">
              <label>排序权重</label>
              <input class="input" id="fSort" type="number" step="1" value="${p.sort}">
              <span class="hint">数字越大越靠前</span>
            </div>

            <div class="field full">
              <label>商品封面图</label>
              ${imagePickerHtml('cover', p.cover)}
            </div>

            <div class="field full">
              <label>商品详情</label>
              <textarea class="textarea" id="fDesc" rows="8"
                placeholder="支持简单 Markdown：**粗体**、- 列表、&gt; 引用、![图片](地址)">${esc(
                  p.description
                )}</textarea>
              <span class="hint">支持 **粗体**、\`代码\`、- 列表、&gt; 引用、![图片](网址)</span>
            </div>
          </div>

          ${switchHtml('fStatus', !!p.status, '上架销售', '关掉后买家看不到这个商品，但订单和卡密都保留')}
        </div>`,
      footer: `
        <button class="btn" data-act="cancel" type="button">取消</button>
        <button class="btn btn-primary" data-act="save" type="button">
          ${isNew ? '发布商品' : '保存修改'}
        </button>`
    });

    const q = (id) => m.el.querySelector(id);

    // 发货方式切换时显示对应的库存字段
    const syncFields = () => {
      const isAuto = q('#fDelivery').value === 'auto';
      q('#stockField').style.display = isAuto ? 'none' : '';
      q('#maxField').style.display = isAuto ? '' : 'none';
    };
    q('#fDelivery').addEventListener('change', syncFields);
    syncFields();

    wireImagePicker(m.el, () => {});

    m.el.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.el.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const payload = {
        name: q('#fName').value.trim(),
        subtitle: q('#fSubtitle').value.trim(),
        price: q('#fPrice').value,
        originalPrice: q('#fOriginal').value,
        deliveryType: q('#fDelivery').value,
        stock: q('#fStock').value,
        maxPerOrder: q('#fMax').value,
        categoryId: q('#fCategory').value || null,
        sort: q('#fSort').value,
        cover: m.el.querySelector('[data-picker="cover"] [data-value]').value,
        description: q('#fDesc').value,
        status: q('#fStatus').checked ? 1 : 0
      };

      if (!payload.name) return toast('请填写商品名称', 'err');
      if (!(Number(payload.price) > 0)) return toast('请填写有效的售价', 'err');

      btn.disabled = true;
      btn.textContent = '保存中…';

      try {
        if (isNew) {
          await api.post('/api/admin/products', payload);
          toast('商品已发布', 'ok');
        } else {
          await api.put(`/api/admin/products/${product.id}`, payload);
          toast('修改已保存', 'ok');
        }
        m.close();
        renderAgain('products');
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = isNew ? '发布商品' : '保存修改';
      }
    });
  }

  /* ================================================================ *
   * 卡密库存
   * ================================================================ */

  const cardState = { productId: null, status: '' };

  register('cards', {
    title: '卡密库存',
    async render() {
      const products = await fetchProducts();
      const sel = document.getElementById('cardProduct');

      const autoProducts = products.filter((p) => p.delivery_type === 'auto');

      if (!products.length) {
        sel.innerHTML = '<option>还没有商品</option>';
        document.getElementById('cardsTable').innerHTML = emptyRow(5, '请先在「商品管理」里发布商品', '🔑');
        document.getElementById('cardHint').innerHTML = '';
        return;
      }

      sel.innerHTML = products
        .map(
          (p) =>
            `<option value="${p.id}">${esc(p.name)}${
              p.delivery_type === 'auto' ? `（可用 ${p.cardStock}）` : '（人工发货）'
            }</option>`
        )
        .join('');

      if (!cardState.productId || !products.some((p) => p.id === cardState.productId)) {
        cardState.productId = (autoProducts[0] || products[0]).id;
      }
      sel.value = String(cardState.productId);

      sel.onchange = () => {
        cardState.productId = Number(sel.value);
        loadCards();
      };

      document.getElementById('cardFilter').onchange = (e) => {
        cardState.status = e.target.value;
        loadCards();
      };

      document.getElementById('importCardsBtn').onclick = importCards;
      document.getElementById('clearCardsBtn').onclick = clearCards;

      await loadCards();
    }
  });

  async function loadCards() {
    const product = productsCache.find((p) => p.id === cardState.productId);
    const hint = document.getElementById('cardHint');
    const table = document.getElementById('cardsTable');

    if (!product) return;

    if (product.delivery_type !== 'auto') {
      hint.innerHTML = `<div class="alert alert-warn">
          <span>ℹ️</span>
          <div>「${esc(product.name)}」是人工发货商品，不需要卡密。
            如果需要自动发货，请到「商品管理」把发货方式改成自动发货。</div>
        </div>`;
    } else {
      hint.innerHTML = `<div class="alert ${
        product.cardStock === 0 ? 'alert-danger' : product.cardStock < 5 ? 'alert-warn' : 'alert-info'
      }">
          <span>${product.cardStock === 0 ? '⚠️' : '🔑'}</span>
          <div>当前商品可用卡密 <b>${product.cardStock}</b> 条。
            ${
              product.cardStock === 0
                ? '库存已空，买家付款后会发货失败，请尽快补充。'
                : '买家付款后系统会按顺序自动发放。'
            }
          </div>
        </div>`;
    }

    const params = new URLSearchParams();
    if (cardState.status !== '') params.set('status', cardState.status);
    const { cards } = await api.get(
      `/api/admin/products/${cardState.productId}/cards?${params.toString()}`
    );

    table.innerHTML = `
      <thead><tr>
        <th style="width:60px">ID</th>
        <th>卡密内容</th>
        <th style="width:100px">状态</th>
        <th style="width:170px">售出时间</th>
        <th style="width:90px">操作</th>
      </tr></thead>
      <tbody>${
        cards.length
          ? cards
              .map(
                (c) => `<tr>
                  <td class="muted">${c.id}</td>
                  <td class="mono" style="word-break:break-all">${esc(c.content)}</td>
                  <td>${
                    c.status
                      ? '<span class="pill delivered">已售出</span>'
                      : '<span class="pill paid">未售出</span>'
                  }</td>
                  <td class="muted nowrap">${c.sold_at ? dateTime(c.sold_at) : '—'}</td>
                  <td>${
                    c.status
                      ? '<span class="muted">—</span>'
                      : `<button class="btn btn-sm btn-danger" data-del-card="${c.id}">删除</button>`
                  }</td>
                </tr>`
              )
              .join('')
          : emptyRow(5, '这个商品还没有卡密，点「批量导入卡密」添加', '🔑')
      }</tbody>`;

    table.querySelectorAll('[data-del-card]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api.del(`/api/admin/cards/${btn.dataset.delCard}`);
        toast('已删除', 'ok');
        loadCards();
      });
    });
  }

  function importCards() {
    const product = productsCache.find((p) => p.id === cardState.productId);

    const m = modal({
      title: `批量导入卡密 · ${product ? product.name : ''}`,
      body: `
        <div class="stack">
          <div class="alert alert-info">
            <span>💡</span>
            <div>每行一条卡密，系统会自动跳过重复的内容。
              如需同时发账号密码，把它们写成一行即可，例如
              <code>user@example.com----pass1234</code></div>
          </div>
          <div class="field">
            <label>卡密内容</label>
            <textarea class="textarea" id="cardInput" rows="12"
              style="font-family:ui-monospace,Consolas,monospace;font-size:13px"
              placeholder="ABCD-EFGH-IJKL-MNOP&#10;QRST-UVWX-YZ23-4567&#10;…"></textarea>
            <span class="hint">单次最多 5000 条</span>
          </div>
          <div id="importResult"></div>
        </div>`,
      footer: `<button class="btn" data-act="cancel" type="button">取消</button>
               <button class="btn btn-primary" data-act="ok" type="button">开始导入</button>`
    });

    m.el.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.el.querySelector('[data-act="ok"]').addEventListener('click', async (e) => {
      const content = m.el.querySelector('#cardInput').value;
      if (!content.trim()) return toast('请粘贴卡密内容', 'err');

      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '导入中…';

      try {
        const res = await api.post(`/api/admin/products/${cardState.productId}/cards`, { content });
        m.el.querySelector('#importResult').innerHTML = `<div class="alert alert-ok">
            <span>✓</span><div>成功导入 <b>${res.added}</b> 条${
              res.skipped ? `，跳过重复 <b>${res.skipped}</b> 条` : ''
            }。</div>
          </div>`;
        toast(`已导入 ${res.added} 条卡密`, 'ok');
        fetchProducts().then(() => loadCards());
        btn.disabled = false;
        btn.textContent = '继续导入';
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = '开始导入';
      }
    });
  }

  async function clearCards() {
    const product = productsCache.find((p) => p.id === cardState.productId);
    const yes = await confirmDialog(
      `确定要清空「${esc(product ? product.name : '')}」所有<b>未售出</b>的卡密吗？<br><br>
       已售出的卡密不受影响。此操作不可撤销。`,
      { okText: '清空', danger: true }
    );
    if (!yes) return;

    const res = await api.del(`/api/admin/products/${cardState.productId}/cards`);
    toast(`已清空 ${res.removed} 条未售卡密`, 'ok');
    fetchProducts().then(() => loadCards());
  }

  /* ================================================================ *
   * 商品分类
   * ================================================================ */

  register('categories', {
    title: '商品分类',
    async render() {
      const categories = await fetchCategories();
      const table = document.getElementById('categoriesTable');

      table.innerHTML = `
        <thead><tr>
          <th style="width:60px">ID</th><th>分类名称</th><th style="width:120px">商品数</th>
          <th style="width:110px">排序</th><th style="width:1%">操作</th>
        </tr></thead>
        <tbody>${
          categories.length
            ? categories
                .map(
                  (c) => `<tr>
                    <td class="muted">${c.id}</td>
                    <td style="font-weight:600">${esc(c.name)}</td>
                    <td>${c.count} 个</td>
                    <td class="muted">${c.sort}</td>
                    <td><div class="actions">
                      <button class="btn btn-sm" data-cact="edit" data-id="${c.id}">编辑</button>
                      <button class="btn btn-sm btn-danger" data-cact="delete" data-id="${c.id}">删除</button>
                    </div></td>
                  </tr>`
                )
                .join('')
            : emptyRow(5, '还没有分类，点右上角新增', '🏷️')
        }</tbody>`;

      table.querySelectorAll('[data-cact]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const c = categories.find((x) => x.id === Number(btn.dataset.id));
          if (btn.dataset.cact === 'edit') editCategory(c);
          else deleteCategory(c);
        });
      });
    }
  });

  document.getElementById('addCategoryBtn').addEventListener('click', () => editCategory(null));

  async function editCategory(category) {
    const isNew = !category;
    const m = modal({
      title: isNew ? '新增分类' : '编辑分类',
      size: 'narrow',
      body: `
        <div class="stack">
          <div class="field">
            <label class="required">分类名称</label>
            <input class="input" id="cName" type="text" maxlength="40"
                   value="${esc(category ? category.name : '')}" placeholder="例如：软件激活码">
          </div>
          <div class="field">
            <label>排序权重</label>
            <input class="input" id="cSort" type="number" step="1"
                   value="${category ? category.sort : 0}">
            <span class="hint">数字越大越靠前</span>
          </div>
        </div>`,
      footer: `<button class="btn" data-act="cancel" type="button">取消</button>
               <button class="btn btn-primary" data-act="ok" type="button">保存</button>`
    });

    const input = m.el.querySelector('#cName');
    input.focus();
    input.select();

    m.el.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) return toast('请填写分类名称', 'err');

      const payload = { name, sort: m.el.querySelector('#cSort').value };
      try {
        if (isNew) await api.post('/api/admin/categories', payload);
        else await api.put(`/api/admin/categories/${category.id}`, payload);
        toast('已保存', 'ok');
        m.close();
        renderAgain('categories');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  async function deleteCategory(category) {
    const yes = await confirmDialog(
      `确定要删除分类「${esc(category.name)}」吗？<br><br>
       该分类下的 ${category.count} 个商品不会被删除，只会变成「未分类」。`,
      { okText: '删除', danger: true }
    );
    if (!yes) return;
    await api.del(`/api/admin/categories/${category.id}`);
    toast('分类已删除', 'ok');
    renderAgain('categories');
  }

  /* ================================================================ *
   * 系统设置
   * ================================================================ */

  let currentSettings = null;

  register('settings', {
    title: '系统设置',
    async render() {
      const { settings } = await api.get('/api/admin/settings');
      currentSettings = settings;
      renderSettingsForm(settings);
    }
  });

  function renderSettingsForm(s) {
    const host = document.getElementById('settingsForm');

    host.innerHTML = `
      <div class="field full">
        <label>店铺名称</label>
        <input class="input" id="sSiteName" type="text" maxlength="60" value="${esc(s.site_name)}">
      </div>
      <div class="field full">
        <label>副标题</label>
        <input class="input" id="sSiteSubtitle" type="text" maxlength="120"
               value="${esc(s.site_subtitle)}" placeholder="显示在首页大图上的一句话">
      </div>
      <div class="field full">
        <label>首页公告</label>
        <textarea class="textarea" id="sSiteNotice" rows="3" maxlength="300"
          placeholder="显示在页面顶部的滚动公告，留空则不显示">${esc(s.site_notice)}</textarea>
      </div>

      <div class="field full">
        <label>店铺 Logo</label>
        ${imagePickerHtml('logo', s.site_logo)}
        <span class="hint">不传则用店铺名首字自动生成图标</span>
      </div>

      <div class="field">
        <label>客服 QQ</label>
        <input class="input" id="sQQ" type="text" maxlength="40" value="${esc(s.contact_qq)}">
      </div>
      <div class="field">
        <label>客服微信</label>
        <input class="input" id="sWechat" type="text" maxlength="40" value="${esc(s.contact_wechat)}">
      </div>
      <div class="field">
        <label>客服邮箱</label>
        <input class="input" id="sEmail" type="text" maxlength="80" value="${esc(s.contact_email)}">
      </div>
      <div class="field">
        <label>客服在线时间</label>
        <input class="input" id="sHours" type="text" maxlength="60" value="${esc(s.contact_hours)}"
               placeholder="例如：每天 09:00 - 23:00">
      </div>

      <div class="field full">
        <label>页脚说明</label>
        <textarea class="textarea" id="sFooter" rows="2" maxlength="300">${esc(s.footer_text)}</textarea>
      </div>

      <div class="field">
        <label>待付款订单自动关闭（分钟）</label>
        <input class="input" id="sExpire" type="number" min="0" step="1"
               value="${esc(s.order_expire_minutes)}">
        <span class="hint">填 0 表示不自动关闭</span>
      </div>

      <div class="field full" style="gap:12px">
        ${switchHtml(
          'sRequireContact',
          s.query_require_contact === '1',
          '查询订单需要验证联系方式',
          '推荐开启。关闭后任何人拿到订单号就能看到卡密，风险较高'
        )}
        ${switchHtml(
          'sAutoConfirm',
          s.auto_confirm === '1',
          '买家点「我已付款」后自动确认并发货',
          '⚠️ 风险很高：任何人下单一键就能拿到卡密，强烈建议保持关闭，人工核对到账后再点「确认收款」'
        )}
      </div>`;

    wireImagePicker(host, () => {});

    document.getElementById('saveSettingsBtn').onclick = async () => {
      const q = (id) => document.getElementById(id);
      const payload = {
        site_name: q('sSiteName').value.trim() || '我的小店',
        site_subtitle: q('sSiteSubtitle').value.trim(),
        site_notice: q('sSiteNotice').value,
        site_logo: host.querySelector('[data-picker="logo"] [data-value]').value,
        contact_qq: q('sQQ').value.trim(),
        contact_wechat: q('sWechat').value.trim(),
        contact_email: q('sEmail').value.trim(),
        contact_hours: q('sHours').value.trim(),
        footer_text: q('sFooter').value,
        order_expire_minutes: q('sExpire').value || '30',
        query_require_contact: q('sRequireContact').checked ? '1' : '0',
        auto_confirm: q('sAutoConfirm').checked ? '1' : '0'
      };

      if (payload.auto_confirm === '1') {
        const yes = await confirmDialog(
          '<b>确定要开启自动确认发货吗？</b><br><br>' +
            '开启后，买家点击「我已完成付款」系统就会立刻发卡密，<b>不会核对是否真的到账</b>。' +
            '任何人都能白拿卡密，除非你用的是能自动回调的支付接口，否则不建议开启。',
          { okText: '我知道风险，开启', danger: true }
        );
        if (!yes) return;
        payload.auto_confirm = '1';
      }

      await saveSettings(payload, 'saveSettingsBtn');
    };

    document.getElementById('reloadSettingsBtn').onclick = () => renderAgain('settings');
  }

  async function saveSettings(payload, buttonId) {
    const btn = buttonId ? document.getElementById(buttonId) : null;
    const original = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '保存中…';
    }

    try {
      await api.put('/api/admin/settings', payload);
      toast('设置已保存', 'ok');

      // 站点名 / Logo 可能变了，重新拉一次刷新侧栏和缓存
      window.App.loadSite(true)
        .then((site) => {
          if (!site) return;
          const brand = document.getElementById('brandName');
          const mark = document.getElementById('brandMark');
          if (brand) brand.textContent = site.name;
          if (mark) {
            mark.innerHTML = site.logo
              ? `<img src="${esc(site.logo)}" alt="">`
              : esc((site.name || '店').charAt(0));
          }
        })
        .catch(() => {});
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original;
      }
    }
  }

  /* ================================================================ *
   * 收款设置
   * ================================================================ */

  register('payment', {
    title: '收款设置',
    async render() {
      const { settings } = await api.get('/api/admin/settings');
      currentSettings = settings;
      renderPaymentForm(settings);
    }
  });

  function renderPaymentForm(s) {
    const host = document.getElementById('paymentForm');

    const block = (key, title, enabled, qr, account, tip) => `
      <div class="panel" style="margin-bottom:16px">
        <div class="panel-head">
          <h3>${esc(title)}</h3>
          <span class="pill ${enabled ? 'delivered' : 'cancelled'}">${
            enabled ? '已启用' : '未启用'
          }</span>
        </div>
        <div class="panel-body stack">
          ${switchHtml(`p_${key}_enabled`, enabled, `启用${title}`, tip)}
          <div class="form-grid">
            <div class="field full">
              <label>${esc(title)}收款码</label>
              ${imagePickerHtml(`${key}_qr`, qr)}
              <span class="hint">建议上传方形收款码图片，买家扫码后直接付款</span>
            </div>
            <div class="field full">
              <label>收款账号 / 备注名</label>
              <input class="input" id="p_${key}_name" type="text" maxlength="80"
                     value="${esc(account)}" placeholder="例如：张三（**伟），会展示给买家核对">
            </div>
          </div>
        </div>
      </div>`;

    host.innerHTML = `
      <div class="alert alert-info" style="margin-bottom:18px">
        <span>💳</span>
        <div>买家下单后会看到这里启用的收款方式。
          如果一种都没启用，付款页会提示买家联系客服，不会展示任何收款信息。</div>
      </div>

      ${block(
        'wechat',
        '微信支付',
        s.pay_wechat_enabled === '1',
        s.pay_wechat_qr,
        s.pay_wechat_name,
        '上传你的微信收款码（微信 → 收付款 → 二维码收款 → 保存收款码）'
      )}

      ${block(
        'alipay',
        '支付宝',
        s.pay_alipay_enabled === '1',
        s.pay_alipay_qr,
        s.pay_alipay_name,
        '上传你的支付宝收款码（支付宝 → 收钱 → 保存图片）'
      )}

      <div class="panel">
        <div class="panel-head"><h3>支付提示文案</h3></div>
        <div class="panel-body">
          <div class="field">
            <label>展示在付款页的提示</label>
            <textarea class="textarea" id="p_note" rows="3" maxlength="300">${esc(s.pay_note)}</textarea>
            <span class="hint">提醒买家备注订单号之类的说明</span>
          </div>
        </div>
      </div>`;

    wireImagePicker(host, () => {});

    document.getElementById('savePaymentBtn').onclick = async () => {
      const q = (id) => document.getElementById(id);
      const value = (key) => host.querySelector(`[data-picker="${key}"] [data-value]`).value;

      await saveSettings({
        pay_wechat_enabled: q('p_wechat_enabled').checked ? '1' : '0',
        pay_wechat_qr: value('wechat_qr'),
        pay_wechat_name: q('p_wechat_name').value.trim(),
        pay_alipay_enabled: q('p_alipay_enabled').checked ? '1' : '0',
        pay_alipay_qr: value('alipay_qr'),
        pay_alipay_name: q('p_alipay_name').value.trim(),
        pay_note: q('p_note').value
      }, 'savePaymentBtn');
    };

    document.getElementById('reloadPaymentBtn').onclick = () => renderAgain('payment');
  }
})();
