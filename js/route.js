// 仮の現在地から、危険範囲をなるべく避けた道を探す（道：OpenStreetMap、危険範囲：DoboX）
const AUTO_START = [34.3965, 132.4752];          // 初めて置くときの仮の現在地（広島駅南口）
const NEAR_RADIUS = [0.025, 0.05];               // 近くの避難所を探す範囲（度）。見つからなければ広げる
const SNAP_M = 300;                              // 道につなぐときに許す距離
// 危険範囲を通るときに、距離を何倍に見なすか（チェックした災害だけ数える）
const HAZARD_DIGIT = { 土砂災害: 1000, 洪水: 100, 津波: 10, 高潮: 1 };
const DOSHA_WEIGHT = [0, 4, 20];
const WATER_WEIGHT = level => (level > 0 ? 3 + 2 * level : 0);

let roadIndex = null;
const roadCells = {};                            // マスの番号 → Promise<区間の配列>
let autoMode = false;
let autoMarker = null;
let autoResult = null;
const autoLayer = L.layerGroup();

function loadRoadCell(key) {
  if (!roadCells[key]) {
    roadCells[key] = fetch(`data/roads/${key}.json`).then(res => res.json()).then(data => data.s.map(row => {
      const pts = [];
      let lat = 0, lng = 0;
      for (let k = 3; k < row.length; k += 2) {
        lat += row[k];
        lng += row[k + 1];
        pts.push([lat / roadIndex.scale, lng / roadIndex.scale]);
      }
      let len = 0;
      for (let k = 1; k < pts.length; k++) len += calcDistance(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
      return { a: row[0], b: row[1], mark: row[2], pts, len };
    }));
  }
  return roadCells[key];
}

async function loadRoads(south, west, north, east) {
  if (!roadIndex) {
    roadIndex = await fetch('data/roads/index.json').then(res => res.json());
    roadIndex.cells = new Set(roadIndex.cells);
    map.attributionControl.addAttribution('道：© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors');
  }
  const n = roadIndex.cell, keys = [];
  for (let i = Math.floor(south * n); i <= Math.floor(north * n); i++) {
    for (let j = Math.floor(west * n); j <= Math.floor(east * n); j++) {
      if (roadIndex.cells.has(`${i}_${j}`)) keys.push(`${i}_${j}`);
    }
  }
  return (await Promise.all(keys.map(loadRoadCell))).flat();
}

function hazardLevels(mark, types) {
  return types.filter(t => HAZARD_DIGIT[t]).map(t => [t, Math.floor(mark / HAZARD_DIGIT[t]) % 10]);
}

function segCost(seg, types) {
  let factor = 1;
  hazardLevels(seg.mark, types).forEach(([t, level]) => {
    factor += t === '土砂災害' ? DOSHA_WEIGHT[level] || 0 : WATER_WEIGHT(level);
  });
  return seg.len * factor;
}

function buildGraph(segs) {
  const nodes = new Map();                       // 番号 → { lat, lng, edges: [[区間, 向き]] }
  const node = (id, p) => {
    if (!nodes.has(id)) nodes.set(id, { id, lat: p[0], lng: p[1], edges: [] });
    return nodes.get(id);
  };
  segs.forEach(seg => {
    node(seg.a, seg.pts[0]).edges.push([seg, 1]);
    node(seg.b, seg.pts[seg.pts.length - 1]).edges.push([seg, -1]);
  });
  return nodes;
}

function nearestNode(nodes, lat, lng) {
  let best = null, bestD = Infinity;
  const kx = Math.cos(lat * Math.PI / 180);
  nodes.forEach(nd => {
    const d = (nd.lat - lat) ** 2 + ((nd.lng - lng) * kx) ** 2;
    if (d < bestD) { bestD = d; best = nd; }
  });
  if (!best) return null;
  const meters = calcDistance(lat, lng, best.lat, best.lng);
  return meters <= SNAP_M ? { node: best, meters } : null;
}

// 小さい順に取り出せる入れ物（ダイクストラ法で使う）
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// 出発の分かれ目から、ゴールのどれかに着くまで、危険を重く見た距離が一番短い道を探す
function searchRoute(nodes, startId, goals, types) {
  const dist = new Map([[startId, 0]]), prev = new Map(), done = new Set();
  const heap = new Heap();
  heap.push([0, startId]);
  while (heap.size > 0) {
    const [d, id] = heap.pop();
    if (done.has(id)) continue;
    done.add(id);
    if (goals.has(id)) {
      const steps = [];
      for (let cur = id; prev.has(cur); cur = prev.get(cur)[0]) steps.unshift(prev.get(cur)[1]);
      return { goalId: id, steps };
    }
    nodes.get(id).edges.forEach(([seg, dir]) => {
      const next = dir === 1 ? seg.b : seg.a;
      const nd = d + segCost(seg, types);
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        prev.set(next, [id, [seg, dir]]);
        heap.push([nd, next]);
      }
    });
  }
  return null;
}

function summarize(steps, types) {
  let length = 0;
  const danger = {};
  steps.forEach(([seg]) => {
    length += seg.len;
    hazardLevels(seg.mark, types).forEach(([t, level]) => {
      if (level > 0) danger[t] = (danger[t] || 0) + seg.len;
    });
  });
  return { length, danger };
}

function routePoints(start, steps, goal) {
  const pts = [start];
  steps.forEach(([seg, dir]) => (dir === 1 ? seg.pts : [...seg.pts].reverse()).forEach(p => {
    const last = pts[pts.length - 1];
    if (last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }));
  return { points: pts.map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]), goal };
}

function setAutoStatus(text) {
  document.getElementById('auto-status').textContent = text;
}

async function findRoute(target) {
  const types = selectedTypes();
  const start = autoMarker.getLatLng();
  clearAutoResult();
  setAutoStatus('道を探しています…');
  try {
    for (const r of target ? [0.01] : NEAR_RADIUS) {
      const south = Math.min(start.lat, target ? target.lat : start.lat) - r;
      const north = Math.max(start.lat, target ? target.lat : start.lat) + r;
      const west = Math.min(start.lng, target ? target.lng : start.lng) - r;
      const east = Math.max(start.lng, target ? target.lng : start.lng) + r;
      const nodes = buildGraph(await loadRoads(south, west, north, east));
      const from = nearestNode(nodes, start.lat, start.lng);
      if (!from) {
        setAutoStatus('仮の現在地の近くに道のデータがありません。道の近くに動かしてください');
        return;
      }
      const candidates = target ? [target] : shelters.filter(s => types.every(t => s.types.includes(t)) &&
        s.lat > south && s.lat < north && s.lng > west && s.lng < east);
      const goals = new Map();
      candidates.forEach(s => {
        const to = nearestNode(nodes, s.lat, s.lng);
        if (to && !goals.has(to.node.id)) goals.set(to.node.id, s);
      });
      if (goals.size === 0) continue;
      const found = searchRoute(nodes, from.node.id, goals, types);
      if (!found) continue;
      showResult(goals.get(found.goalId), found.steps, types, [start.lat, start.lng]);
      return;
    }
    setAutoStatus(target ? 'この避難所までの道が見つかりませんでした' : '近くに、チェックした災害に対応する避難所が見つかりませんでした');
  } catch {
    setAutoStatus('道のデータを読み込めませんでした');
  }
}

function showResult(shelter, steps, types, start) {
  const { length, danger } = summarize(steps, types);
  const goal = { name: shelter.name, lat: shelter.lat, lng: shelter.lng, types: shelter.types };
  autoResult = routePoints(start, steps, goal);
  steps.forEach(([seg]) => {
    const risky = hazardLevels(seg.mark, types).some(([, level]) => level > 0);
    L.polyline(seg.pts, { color: 'white', weight: 9, opacity: 0.9, interactive: false }).addTo(autoLayer);
    L.polyline(seg.pts, { color: risky ? '#e8590c' : '#1f78b4', weight: 5, interactive: false }).addTo(autoLayer);
  });
  L.circleMarker([goal.lat, goal.lng], { radius: 10, color: 'white', weight: 3, fillColor: '#2f9e62', fillOpacity: 1, interactive: false })
    .bindTooltip(escapeHtml(goal.name), { permanent: true, direction: 'top', offset: [0, -8] }).addTo(autoLayer);
  map.fitBounds(L.latLngBounds(autoResult.points), { padding: [40, 40], maxZoom: 17 });
  const meters = Math.round(length);
  const dangerText = Object.keys(danger).length > 0
    ? 'オレンジの所は危険範囲を通ります（' + Object.entries(danger).map(([t, m]) => `${t} 約${Math.round(m)}m`).join('、') + '）'
    : 'チェックした災害の危険範囲は通りません';
  setAutoStatus(`${goal.name}まで 約${meters}m ／ 徒歩 約${Math.max(1, Math.round(meters / WALK_M_PER_MIN))}分。${dangerText}`);
  document.getElementById('auto-edit').hidden = false;
}

// ------ 画面の操作 ------
function startAuto() {
  autoMode = true;
  const center = map.getZoom() >= 13 ? map.getCenter() : L.latLng(AUTO_START);
  if (map.getZoom() < 13) map.setView(AUTO_START, 15);
  autoMarker = L.marker(center, {
    draggable: true, zIndexOffset: 1000,
    icon: L.divIcon({ className: 'auto-here', html: '<span></span><b>仮の現在地</b>', iconSize: [18, 18], iconAnchor: [9, 9] })
  }).addTo(autoLayer.addTo(map));
  autoMarker.on('dragend', clearAutoResult);
  document.getElementById('route-idle').hidden = true;
  document.getElementById('auto-box').hidden = false;
  clearAutoResult();
}

function clearAutoResult() {
  autoResult = null;
  autoLayer.eachLayer(layer => { if (layer !== autoMarker) autoLayer.removeLayer(layer); });
  document.getElementById('auto-edit').hidden = true;
  setAutoStatus('地図をタップすると仮の現在地を動かせます。「近くの避難所へ」か、緑の避難所を押してください');
}

function stopAuto() {
  autoMode = false;
  autoLayer.clearLayers();
  autoLayer.remove();
  autoMarker = null;
  autoResult = null;
  document.getElementById('auto-box').hidden = true;
  document.getElementById('route-idle').hidden = false;
}

// 避難所を押したとき（evac.js から呼ばれる）。この画面で使ったら true を返す
function autoPick(shelter) {
  if (!autoMode) return false;
  findRoute(shelter);
  return true;
}

document.getElementById('route-auto').addEventListener('click', startAuto);
document.getElementById('auto-nearest').addEventListener('click', () => findRoute(null));
document.getElementById('auto-cancel').addEventListener('click', stopAuto);
document.getElementById('auto-edit').addEventListener('click', () => {
  const result = autoResult;
  stopAuto();
  startDrawing();
  draft = result;
  updateDraft();
});
map.on('click', e => {
  if (!autoMode) return;
  autoMarker.setLatLng(e.latlng);
  clearAutoResult();
});
document.querySelectorAll('.evac-check').forEach(c => c.addEventListener('change', () => {
  document.getElementById('route-auto').disabled = selectedTypes().length === 0;
  if (autoMode) clearAutoResult();
}));
