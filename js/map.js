// 地図の土台（国土地理院の淡色地図／空中写真）と、2点の距離
const map = L.map('map').setView([34.3966, 132.4596], 14);

const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>';
const BASES = {
  map: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { attribution: GSI_ATTR, maxZoom: 18 }),
  photo: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { attribution: GSI_ATTR, maxZoom: 18 })
};
const BASE_KEY = 'sonaeBase';
let baseName = 'map';
try {
  if (localStorage.getItem(BASE_KEY) === 'photo') baseName = 'photo';
} catch {
  // 保存できないブラウザでは、毎回「地図」から始める
}
BASES[baseName].addTo(map);

// 右上の「地図／写真」切り替え（Googleマップの航空写真と同じ使い方）
const BaseSwitch = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const box = L.DomUtil.create('div', 'base-switch');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '地図の種類');
    [['map', '地図'], ['photo', '写真']].forEach(([name, label]) => {
      const btn = L.DomUtil.create('button', '', box);
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.base = name;
      btn.setAttribute('aria-pressed', String(name === baseName));
      L.DomEvent.on(btn, 'click', e => {
        L.DomEvent.stop(e);
        setBase(name);
      });
    });
    L.DomEvent.disableClickPropagation(box);
    return box;
  }
});
map.addControl(new BaseSwitch());

function setBase(name) {
  if (name === baseName) return;
  map.removeLayer(BASES[baseName]);
  BASES[name].addTo(map);
  BASES[name].bringToBack();
  baseName = name;
  document.querySelectorAll('.base-switch button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.base === name)));
  document.body.classList.toggle('base-photo', name === 'photo');
  try {
    localStorage.setItem(BASE_KEY, name);
  } catch {
    // 保存できなくても切り替えは効く
  }
}
document.body.classList.toggle('base-photo', baseName === 'photo');

function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
