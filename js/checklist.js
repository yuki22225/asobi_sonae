// チェックシート：data/checklist.json の項目を、タブごとに出す。チェックはこの端末だけに保存する
const STORE_KEY = 'sonaeChecks';
let sheet = null;
let current = null;

function loadChecks() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveChecks(checks) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(checks));
  } catch {
    // 保存できない設定のブラウザでは、画面の上だけで使えるようにする
  }
}

let checks = loadChecks();

const itemKey = (tab, gi, ii) => `${tab.id}:${gi}:${ii}`;

function countTab(tab) {
  let done = 0, total = 0;
  tab.groups.forEach((g, gi) => g.items.forEach((_, ii) => {
    total++;
    if (checks[itemKey(tab, gi, ii)]) done++;
  }));
  return { done, total };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderTabs() {
  const nav = document.getElementById('check-tabs');
  nav.innerHTML = '';
  sheet.tabs.forEach(tab => {
    const { done, total } = countTab(tab);
    const btn = el('button', 'check-tab');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(tab.id === current));
    btn.append(el('span', 'check-tab-name', tab.title), el('span', 'check-tab-count', `${done}/${total}`));
    btn.addEventListener('click', () => {
      current = tab.id;
      try { sessionStorage.setItem('sonaeTab', current); } catch { /* なくても動く */ }
      render();
    });
    nav.appendChild(btn);
    if (tab.id === current) requestAnimationFrame(() => btn.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });
}

function renderBody() {
  const tab = sheet.tabs.find(t => t.id === current);
  const body = document.getElementById('check-body');
  body.innerHTML = '';
  const { done, total } = countTab(tab);

  const head = el('section', 'check-head');
  head.append(el('p', 'check-lead', tab.lead));
  const bar = el('div', 'check-progress');
  const fill = el('span');
  fill.style.width = `${Math.round((done / total) * 100)}%`;
  bar.appendChild(fill);
  head.append(bar, el('p', 'check-progress-text', done === total ? `${total}項目すべてそろいました！` : `${total}項目中 ${done}項目チェック済み`));
  body.appendChild(head);

  tab.groups.forEach((g, gi) => {
    const box = el('section', 'check-group');
    box.appendChild(el('h2', null, g.title));
    g.items.forEach(([name, hint, link], ii) => {
      const key = itemKey(tab, gi, ii);
      const row = el('label', 'check-item');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!checks[key];
      input.addEventListener('change', () => {
        if (input.checked) checks[key] = new Date().toLocaleDateString('sv-SE');
        else delete checks[key];
        saveChecks(checks);
        render();
      });
      const text = el('span', 'check-text');
      text.appendChild(el('b', null, name));
      if (hint) text.appendChild(el('small', null, hint));
      row.append(input, text);
      box.appendChild(row);
      if (link === 'map') {
        const a = el('a', 'check-map-link', '地図で確かめる →');
        a.href = 'map.html';
        box.appendChild(a);
      }
    });
    body.appendChild(box);
  });

  const foot = el('section', 'check-foot');
  foot.appendChild(el('p', 'check-note', tab.note));
  const src = sheet.sources[tab.source];
  const p = el('p', 'check-source', '出典：');
  const a = el('a', null, src.name);
  a.href = src.url;
  a.target = '_blank';
  a.rel = 'noopener';
  p.appendChild(a);
  foot.appendChild(p);
  foot.appendChild(el('p', 'check-source', 'チェックはこの端末だけに保存します。'));
  const reset = el('button', 'check-reset', 'このタブのチェックを全部外す');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    if (!confirm(`「${tab.title}」のチェックを全部外しますか？`)) return;
    Object.keys(checks).filter(k => k.startsWith(tab.id + ':')).forEach(k => delete checks[k]);
    saveChecks(checks);
    render();
  });
  foot.appendChild(reset);
  body.appendChild(foot);
}

function render() {
  renderTabs();
  renderBody();
}

fetch('data/checklist.json')
  .then(res => res.json())
  .then(data => {
    sheet = data;
    let saved = null;
    try { saved = sessionStorage.getItem('sonaeTab'); } catch { /* なくても動く */ }
    current = sheet.tabs.some(t => t.id === saved) ? saved : sheet.tabs[0].id;
    render();
  })
  .catch(() => {
    document.getElementById('check-body').innerHTML = '<p class="coming">チェックシートを読み込めませんでした。</p>';
  });
