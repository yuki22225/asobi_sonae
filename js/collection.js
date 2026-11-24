// 大切なもの：道の途中でひろったご当地グルメ・名産品を、市町ごとに並べる
function getTreasures() {
  try {
    return JSON.parse(localStorage.getItem('sonaeTreasures') || '{}');
  } catch {
    return {};
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

fetch('data/specialties.json')
  .then(res => res.json())
  .then(data => {
    const owned = getTreasures();
    const list = document.getElementById('treasure-list');
    let total = 0, got = 0;
    data.cities.forEach(c => {
      const box = el('section', 'check-group');
      const mine = c.items.filter(it => owned[`${c.city}:${it.name}`]).length;
      total += c.items.length;
      got += mine;
      const h = el('h2', 'treasure-city');
      h.append(el('span', null, c.city), el('small', null, `${mine}/${c.items.length}`));
      box.appendChild(h);
      const grid = el('div', 'treasure-grid');
      c.items.forEach(it => {
        const rec = owned[`${c.city}:${it.name}`];
        const card = el('div', 'treasure-card' + (rec ? '' : ' locked'));
        card.append(el('span', 'treasure-icon', rec ? it.icon : '？'), el('b', null, rec ? it.name : '？？？'));
        if (rec) card.appendChild(el('small', null, rec.date));
        grid.appendChild(card);
      });
      box.appendChild(grid);
      if (c.source) {
        const p = el('p', 'check-source', '出典：');
        const a = el('a', null, c.source.name);
        a.href = c.source.url;
        a.target = '_blank';
        a.rel = 'noopener';
        p.appendChild(a);
        box.appendChild(p);
      }
      list.appendChild(box);
    });
    document.getElementById('treasure-bar').style.width = `${Math.round((got / total) * 100)}%`;
    document.getElementById('treasure-count').textContent = `${total}品中 ${got}品 ひろいました`;
  })
  .catch(() => {
    document.getElementById('treasure-count').textContent = '一覧を読み込めませんでした';
  });
