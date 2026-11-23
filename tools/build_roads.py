"""OpenStreetMapから歩ける道を取り出し、危険範囲の印を付けて、ルート検索用に小さなマス目のファイルに分ける

  出力: data/roads/index.json と data/roads/{マスの番号}.json（マス目は data/hazard と同じ0.05度）
  1マスのファイル: {"s": [[始点の番号, 終点の番号, 危険の印, 緯度, 経度, 差の緯度, 差の経度, ...], ...]}
    ・番号は県全体で通しの、道の分かれ目（交差点や道の端）の番号
    ・危険の印は4けたの数: 千の位=土砂災害(0なし,1警戒,2特別警戒) 百の位=洪水の深さの区分(0〜8)
      十の位=津波の深さの区分(0〜7) 一の位=高潮の深さの区分(0〜7)。区間が少しでもかかれば印を付ける
    ・座標は10万分の1度の整数

  使い方: python tools/build_roads.py 地図.osm.pbf （osmium, shapely が必要。先に convert_hazard.py を動かしておく）
  Japanese のパスを osmium が開けないことがあるので、pbf は英数字だけの場所に置いて渡す
"""
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np
import osmium
import shapely

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
HAZARD_DIR = os.path.join(ROOT, 'data', 'hazard')
OUT = os.path.join(ROOT, 'data', 'roads')
SHELTERS = os.path.join(ROOT, 'data', 'shelters.json')
CELL, SCALE = 20, 100000
MAX_SEG_M = 150            # これより長い区間は途中で切る（危険の印を細かく付けるため）
WALK = {'footway', 'path', 'pedestrian', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'track',
        'cycleway', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link',
        'trunk', 'trunk_link', 'road'}
HAZARD_KINDS = [('dosha', 1000, {'y': 1, 'r': 2}), ('flood', 100, None), ('tsunami', 10, None), ('surge', 1, None)]


def cell_of(lat, lng):
    return math.floor(lat * CELL), math.floor(lng * CELL)


def wanted_cells():
    """避難所のあるマスと、その周り1マス（約5km）だけを対象にする"""
    cells = set()
    for s in json.load(open(SHELTERS, encoding='utf-8')):
        i, j = cell_of(s['lat'], s['lng'])
        cells |= {(i + di, j + dj) for di in (-1, 0, 1) for dj in (-1, 0, 1)}
    return cells


def walkable(tags):
    hw = tags.get('highway')
    if hw not in WALK or tags.get('area') == 'yes':
        return False
    foot = tags.get('foot')
    if foot == 'no':
        return False
    if tags.get('access') in ('no', 'private') and foot not in ('yes', 'designated', 'permissive'):
        return False
    return True


def read_ways(pbf, cells):
    ways = []
    fp = osmium.FileProcessor(pbf).with_locations().with_filter(osmium.filter.KeyFilter('highway'))
    for obj in fp:
        if not obj.is_way() or not walkable(obj.tags):
            continue
        pts = []
        for n in obj.nodes:
            if not n.location.valid():
                pts = None
                break
            pts.append((n.ref, n.location.lat, n.location.lon))
        if pts and len(pts) >= 2 and any(cell_of(p[1], p[2]) in cells for p in pts):
            ways.append(pts)
    return ways


def dist(a, b):
    dy = (a[1] - b[1]) * 111320
    dx = (a[2] - b[2]) * 111320 * math.cos(math.radians(a[1]))
    return math.hypot(dx, dy)


def split_segments(ways):
    """交差点や道の端で道を区間に分け、長い区間はさらに切る"""
    use = defaultdict(int)
    for w in ways:
        for k, p in enumerate(w):
            use[p[0]] += 2 if k in (0, len(w) - 1) else 1
    segs = []
    for w in ways:
        cur, length = [w[0]], 0
        for p in w[1:]:
            length += dist(cur[-1], p)
            cur.append(p)
            if use[p[0]] >= 2 or length >= MAX_SEG_M or p is w[-1]:
                segs.append(cur)
                cur, length = [p], 0
    return segs


def decode_ring(ring):
    pts, lat, lng = [], 0, 0
    for k in range(0, len(ring), 2):
        lat += ring[k]; lng += ring[k + 1]
        pts.append((lng / SCALE, lat / SCALE))
    return pts


def load_hazard(kind, classes):
    """作っておいた危険範囲のマスを読み、面と区分の一覧にする"""
    folder = os.path.join(HAZARD_DIR, kind)
    geoms, levels = [], []
    if not os.path.isdir(folder):
        return None, None
    for name in os.listdir(folder):
        data = json.load(open(os.path.join(folder, name), encoding='utf-8'))
        for cls, polys in data.items():
            level = classes[cls] if classes else int(cls) // (10 if kind == 'flood' else 1)
            for poly in polys:
                rings = [decode_ring(r) for r in poly]
                if len(rings[0]) >= 3:
                    geoms.append(shapely.Polygon(rings[0], [r for r in rings[1:] if len(r) >= 3]))
                    levels.append(level)
    return np.array(geoms), np.array(levels)


def hazard_marks(lines):
    marks = np.zeros(len(lines), dtype=np.int64)
    for kind, digit, classes in HAZARD_KINDS:
        geoms, levels = load_hazard(kind, classes)
        if geoms is None or len(geoms) == 0:
            print(f'  {kind}: データなし', flush=True)
            continue
        tree = shapely.STRtree(geoms)
        li, gi = tree.query(lines, predicate='intersects')
        best = np.zeros(len(lines), dtype=np.int64)
        np.maximum.at(best, li, levels[gi])
        marks += best * digit
        print(f'  {kind}: 面 {len(geoms)}、かかる区間 {(best > 0).sum()}', flush=True)
    return marks


def main(pbf):
    cells = wanted_cells()
    ways = read_ways(pbf, cells)
    print(f'歩ける道 {len(ways)}本', flush=True)
    segs = split_segments(ways)
    print(f'区間 {len(segs)}', flush=True)
    node_id = {}
    for s in segs:
        for p in (s[0], s[-1]):
            node_id.setdefault(p[0], len(node_id))
    lines = np.array([shapely.LineString([(p[2], p[1]) for p in s]) for s in segs])
    marks = hazard_marks(lines)

    by_cell = defaultdict(list)
    for s, mark in zip(segs, marks):
        mid = s[len(s) // 2]
        row, plat, plng = [node_id[s[0][0]], node_id[s[-1][0]], int(mark)], 0, 0
        for k, p in enumerate(s):
            a, b = round(p[1] * SCALE), round(p[2] * SCALE)
            row += [a, b] if k == 0 else [a - plat, b - plng]
            plat, plng = a, b
        by_cell[cell_of(mid[1], mid[2])].append(row)
    os.makedirs(OUT, exist_ok=True)
    keys, total = [], 0
    for (i, j), rows in sorted(by_cell.items()):
        key = f'{i}_{j}'
        path = os.path.join(OUT, key + '.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'s': rows}, f, separators=(',', ':'))
        keys.append(key)
        total += os.path.getsize(path)
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'cell': CELL, 'scale': SCALE, 'cells': keys, 'nodes': len(node_id)}, f, separators=(',', ':'))
    print(f'道の分かれ目 {len(node_id)}、{len(keys)}マス、合計 {total / 1e6:.1f}MB、最大 '
          f'{max(os.path.getsize(os.path.join(OUT, k + ".json")) for k in keys) / 1e6:.2f}MB', flush=True)


if __name__ == '__main__':
    main(sys.argv[1])
