// 避難の地図：避難所の絞り込み、危険範囲、自分で引く経路
const WALK_M_PER_MIN = 60;
const GOOGLE_MAX_WAYPOINTS = 8;
const BOUSAI_WEB = 'https://www.bousai.pref.hiroshima.lg.jp/';
const evacLayer = L.layerGroup();
const routeLayer = L.layerGroup();
const shelterRenderer = L.canvas({ padding: 0.3 });
let shelters = null;
let drawing = false;
let draft = { points: [], goal: null };

function escapeHtml(text) {
  const el = document.createElement('div');
  el.textContent = text ?? '';
  return el.innerHTML;
}

function escapeXml(text) {
  return String(text ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function buildShelterPopup(s) {
  const types = s.types.length > 0 ? s.types.join('、') : '記載なし';
  const capacity = s.capacity == null ? '記載なし' : `${s.capacity}人`;
  return `<b>${escapeHtml(s.name)}</b><br>${escapeHtml(s.address)}<br>対応する災害：${types}<br>定員：${capacity}` +
    `<br><a href="${BOUSAI_WEB}" target="_blank" rel="noopener">開いているか・混み具合を見る（広島県防災Web）</a>`;
}

function selectedTypes() {
  return [...document.querySelectorAll('.evac-check:checked')].map(c => c.value);
}

function updateShelters() {
  evacLayer.clearLayers();
  const count = document.getElementById('evac-count');
  if (!shelters) return;
  const types = selectedTypes();
  document.getElementById('route-start').disabled = types.length === 0;
  if (types.length === 0) {
    count.textContent = '何から避難するかを選んでください';
    return;
  }
  const matched = shelters.filter(s => types.every(t => s.types.includes(t)));
  matched.forEach(s => {
    const marker = L.circleMarker([s.lat, s.lng], {
      renderer: shelterRenderer, radius: 5, color: 'white', weight: 1, fillColor: '#2f9e62', fillOpacity: 0.95, bubblingMouseEvents: false
    }).bindPopup(() => buildShelterPopup(s));
    marker.on('popupopen', () => {
      if (autoPick(s)) {
        marker.closePopup();
        return;
      }
      if (!drawing) return;
      marker.closePopup();
      setGoal(s);
    });
    marker.addTo(evacLayer);
  });
  count.textContent = matched.length > 0
    ? `${matched.length}か所`
    : '該当する避難所がありません。チェックを減らしてください';
  if (drawing && draft.goal && !types.every(t => draft.goal.types.includes(t))) {
    draft.goal = null;
    updateDraft();
  }
}

async function loadShelters() {
  if (shelters) return;
  document.getElementById('evac-count').textContent = '読み込み中…';
  try {
    shelters = await fetch('data/shelters.json').then(res => res.json());
  } catch {
    document.getElementById('evac-count').textContent = '避難所を読み込めませんでした';
    return;
  }
  updateShelters();
}

// ------ 経路の計算と表示 ------
function routeLine(route) {
  return route.goal ? [...route.points, [route.goal.lat, route.goal.lng]] : route.points;
}

function routeLength(route) {
  const line = routeLine(route);
  let total = 0;
  for (let i = 1; i < line.length; i++) total += calcDistance(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
  return total;
}

function routeSummary(route) {
  const length = Math.round(routeLength(route));
  return `約${length}m ／ 徒歩 約${Math.max(1, Math.round(length / WALK_M_PER_MIN))}分`;
}

function drawRoute(route) {
  routeLayer.clearLayers();
  const line = routeLine(route);
  if (line.length > 1) {
    L.polyline(line, { color: 'white', weight: 8, opacity: 0.9, interactive: false }).addTo(routeLayer);
    L.polyline(line, { color: '#1f78b4', weight: 4, interactive: false }).addTo(routeLayer);
  }
  route.points.forEach((p, i) => {
    if (i > 0 && route.points.length > 30) return;   // 自動で出した道は点が多いので、出発地だけ出す
    L.circleMarker(p, {
      radius: i === 0 ? 8 : 4, color: 'white', weight: 2, fillColor: i === 0 ? '#e74c3c' : '#1f78b4', fillOpacity: 1, interactive: false
    }).addTo(routeLayer);
  });
  if (route.goal) {
    L.circleMarker([route.goal.lat, route.goal.lng], { radius: 10, color: 'white', weight: 3, fillColor: '#2f9e62', fillOpacity: 1, interactive: false })
      .bindTooltip(escapeHtml(route.goal.name), { permanent: true, direction: 'top', offset: [0, -8] }).addTo(routeLayer);
  }
}

// ------ 経路を引く ------
function updateDraft() {
  drawRoute(draft);
  const status = document.getElementById('route-status');
  if (draft.points.length === 0) status.textContent = '出発地をタップしてください';
  else if (!draft.goal) status.textContent = `通りたい道を順にタップして、最後に緑の避難所を押してください（${routeSummary(draft)}）`;
  else status.textContent = `ゴール：${draft.goal.name}（${routeSummary(draft)}）`;
  document.getElementById('route-undo').disabled = draft.points.length === 0;
  document.getElementById('route-save-box').hidden = !draft.goal;
  if (draft.goal && !document.getElementById('route-name').value) document.getElementById('route-name').value = `${draft.goal.name}まで`;
}

function setGoal(s) {
  if (draft.points.length === 0) {
    document.getElementById('route-status').textContent = '先に出発地をタップしてください';
    return;
  }
  draft.goal = { name: s.name, lat: s.lat, lng: s.lng, types: s.types };
  updateDraft();
}

function startDrawing() {
  drawing = true;
  draft = { points: [], goal: null };
  document.getElementById('route-name').value = '';
  document.getElementById('route-idle').hidden = true;
  document.getElementById('route-draw').hidden = false;
  document.getElementById('evac-note').hidden = true;
  updateDraft();
}

function stopDrawing() {
  drawing = false;
  document.getElementById('route-idle').hidden = false;
  document.getElementById('route-draw').hidden = true;
  document.getElementById('evac-note').hidden = false;
}

document.getElementById('route-start').addEventListener('click', startDrawing);
document.getElementById('route-undo').addEventListener('click', () => {
  if (draft.goal) draft.goal = null;
  else draft.points.pop();
  updateDraft();
});
document.getElementById('route-cancel').addEventListener('click', () => {
  stopDrawing();
  routeLayer.clearLayers();
});
map.on('click', e => {
  if (!drawing || draft.goal) return;
  draft.points.push([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]);
  updateDraft();
});

// ------ お気に入り（この端末だけに保存する） ------
function getRoutes() {
  try {
    return JSON.parse(localStorage.getItem('infraRoutes') || '[]');
  } catch {
    return [];
  }
}

function setRoutes(routes) {
  localStorage.setItem('infraRoutes', JSON.stringify(routes));
  renderRoutes();
}

document.getElementById('route-save').addEventListener('click', () => {
  const name = document.getElementById('route-name').value.trim() || `${draft.goal.name}まで`;
  const route = { id: String(Date.now()), name, types: selectedTypes(), points: draft.points, goal: draft.goal, date: new Date().toLocaleDateString('sv-SE') };
  try {
    setRoutes([route, ...getRoutes()]);
  } catch {
    document.getElementById('route-status').textContent = '保存できませんでした。ブラウザの設定を確かめてください';
    return;
  }
  stopDrawing();
  drawRoute(route);
});

function googleUrl(route) {
  const fmt = p => `${p[0]},${p[1]}`;
  const [origin, ...rest] = route.points;
  const step = Math.max(1, rest.length / GOOGLE_MAX_WAYPOINTS);
  const via = [];
  for (let i = 0; i < rest.length && via.length < GOOGLE_MAX_WAYPOINTS; i += step) via.push(rest[Math.floor(i)]);
  const params = new URLSearchParams({ api: '1', origin: fmt(origin), destination: fmt([route.goal.lat, route.goal.lng]), travelmode: 'walking' });
  if (via.length > 0) params.set('waypoints', via.map(fmt).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}

function routeKml(route) {
  const coord = p => `${p[1]},${p[0]},0`;
  const line = routeLine(route).map(coord).join(' ');
  const desc = `${route.types.join('・')}用 ／ ${routeSummary(route)} ／ ${route.date} 作成`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(route.name)}</name>
    <Style id="route"><LineStyle><color>ffb4781f</color><width>5</width></LineStyle></Style>
    <Placemark><name>${escapeXml(route.name)}</name><description>${escapeXml(desc)}</description><styleUrl>#route</styleUrl><LineString><tessellate>1</tessellate><coordinates>${line}</coordinates></LineString></Placemark>
    <Placemark><name>出発地</name><Point><coordinates>${coord(route.points[0])}</coordinates></Point></Placemark>
    <Placemark><name>${escapeXml(route.goal.name)}</name><description>${escapeXml(route.goal.types.join('・'))}</description><Point><coordinates>${coord([route.goal.lat, route.goal.lng])}</coordinates></Point></Placemark>
  </Document>
</kml>
`;
}

function saveKml(route) {
  const url = URL.createObjectURL(new Blob([routeKml(route)], { type: 'application/vnd.google-earth.kml+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${route.name.replace(/[\\/:*?"<>|]/g, '_')}.kml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderRoutes() {
  const box = document.getElementById('route-list');
  const routes = getRoutes();
  box.innerHTML = '';
  box.hidden = routes.length === 0;
  routes.forEach(route => {
    const row = document.createElement('div');
    row.className = 'route-item';
    row.innerHTML = `<b>${escapeHtml(route.name)}</b><span>${escapeHtml(route.types.join('・'))} ／ ${routeSummary(route)}</span>` +
      `<div class="route-actions"><button type="button" data-act="show">地図で見る</button>` +
      `<a href="${escapeHtml(googleUrl(route))}" target="_blank" rel="noopener">Googleマップで開く</a>` +
      `<button type="button" data-act="kml">マイマップ用に保存</button><button type="button" data-act="del">削除</button></div>`;
    row.querySelector('[data-act="show"]').addEventListener('click', () => {
      drawRoute(route);
      map.fitBounds(L.latLngBounds(routeLine(route)), { padding: [40, 40], maxZoom: 17 });
    });
    row.querySelector('[data-act="kml"]').addEventListener('click', () => saveKml(route));
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      routeLayer.clearLayers();
      setRoutes(getRoutes().filter(r => r.id !== route.id));
    });
    box.appendChild(row);
  });
}

// ------ 危険範囲（拡大したときだけ、見えているマスを読み込む） ------
const HAZARD_MIN_ZOOM = 13;
const FLOOD_COLORS = ['#d6ecf8', '#b0d8f1', '#86c0e7', '#5ca5da', '#3a88ca', '#236bb2', '#164e92', '#0d3470'];
const TSUNAMI_COLORS = ['#ece4f5', '#d3c2ea', '#b79ddb', '#9a77ca', '#7b52b4', '#5e3196', '#401a73'];
const SURGE_COLORS = ['#d8f2ee', '#ace2da', '#7dcdc2', '#52b5a8', '#30998d', '#1d7970', '#105953'];
const HAZARD = {
  dosha: {
    type: '土砂災害', zIndex: 360, legend: 'legend-dosha',
    style: { y: { fillColor: '#f2c94c', fillOpacity: 0.45 }, r: { fillColor: '#e0322b', fillOpacity: 0.5 } }
  },
  flood: { type: '洪水', zIndex: 350, legend: 'legend-flood', opacity: 0.55, colors: FLOOD_COLORS, first: 10, step: 10 },
  surge: { type: '高潮', zIndex: 352, legend: 'legend-surge', opacity: 0.6, colors: SURGE_COLORS, first: 1, step: 1 },
  tsunami: { type: '津波', zIndex: 354, legend: 'legend-tsunami', opacity: 0.6, colors: TSUNAMI_COLORS, first: 1, step: 1 }
};
let hazardIndex = null;
Object.entries(HAZARD).forEach(([kind, h]) => {
  if (h.colors) h.style = Object.fromEntries(h.colors.map((c, i) => [String(h.first + i * h.step), { fillColor: c, fillOpacity: h.opacity }]));
  map.createPane('hazard-' + kind).style.zIndex = h.zIndex;
  h.renderer = L.canvas({ pane: 'hazard-' + kind, padding: 0.2 });
  h.group = L.layerGroup();
  h.cells = {};          // マスの番号 → 'loading' | 'error' | レイヤー
});

function decodeRing(ring, scale) {
  const points = [];
  let lat = 0, lng = 0;
  for (let i = 0; i < ring.length; i += 2) {
    lat += ring[i];
    lng += ring[i + 1];
    points.push([lat / scale, lng / scale]);
  }
  return points;
}

function buildCell(kind, data) {
  const h = HAZARD[kind];
  const layer = L.layerGroup();
  Object.keys(h.style).forEach(cls => {
    if (!data[cls]) return;
    const shapes = data[cls].map(poly => poly.map(ring => decodeRing(ring, hazardIndex.scale)));
    L.polygon(shapes, { ...h.style[cls], renderer: h.renderer, stroke: false, interactive: false }).addTo(layer);
  });
  return layer;
}

function loadCell(kind, key) {
  const h = HAZARD[kind];
  h.cells[key] = 'loading';
  fetch(`data/hazard/${kind}/${key}.json`)
    .then(res => res.json())
    .then(data => { h.cells[key] = buildCell(kind, data); updateHazards(); })
    .catch(() => { h.cells[key] = 'error'; });
}

function visibleCells() {
  const b = map.getBounds().pad(0.1), n = hazardIndex.cell, keys = [];
  for (let i = Math.floor(b.getSouth() * n); i <= Math.floor(b.getNorth() * n); i++) {
    for (let j = Math.floor(b.getWest() * n); j <= Math.floor(b.getEast() * n); j++) keys.push(`${i}_${j}`);
  }
  return keys;
}

async function loadHazardIndex() {
  if (hazardIndex) return;
  hazardIndex = 'loading';
  try {
    const index = await fetch('data/hazard/index.json').then(res => res.json());
    Object.keys(HAZARD).forEach(kind => { index[kind] = new Set(index[kind] || []); });
    hazardIndex = index;
  } catch {
    hazardIndex = null;
    return;
  }
  updateHazards();
}

function updateHazards() {
  const types = selectedTypes();
  const kinds = Object.keys(HAZARD).filter(kind => types.includes(HAZARD[kind].type));
  const zoomed = map.getZoom() >= HAZARD_MIN_ZOOM;
  document.getElementById('hazard-legend').hidden = kinds.length === 0;
  document.getElementById('hazard-zoom').hidden = zoomed;
  Object.entries(HAZARD).forEach(([kind, h]) => {
    document.getElementById(h.legend).hidden = !kinds.includes(kind);
    if (!kinds.includes(kind) || !zoomed) {
      h.group.remove();
      return;
    }
    if (!hazardIndex) loadHazardIndex();
    if (!hazardIndex || hazardIndex === 'loading') return;
    const want = visibleCells().filter(key => hazardIndex[kind].has(key));
    h.group.eachLayer(layer => { if (!want.includes(layer.cellKey)) h.group.removeLayer(layer); });
    want.forEach(key => {
      const cell = h.cells[key];
      if (cell === undefined) loadCell(kind, key);
      else if (typeof cell === 'object' && !h.group.hasLayer(cell)) {
        cell.cellKey = key;
        h.group.addLayer(cell);
      }
    });
    h.group.addTo(map);
  });
}

map.on('moveend', updateHazards);

// ------ 始めに ------
evacLayer.addTo(map);
routeLayer.addTo(map);
loadShelters();
renderRoutes();
document.querySelectorAll('.evac-check').forEach(c => c.addEventListener('change', () => {
  updateShelters();
  updateHazards();
}));
