"""DoboXの危険範囲（土砂災害警戒区域・洪水／津波／高潮の浸水想定）を、地図で軽く読めるよう小さなマス目のファイルに分ける

  出力: data/hazard/index.json と data/hazard/{dosha,flood,tsunami,surge}/{マスの番号}.json
  マス目は緯度・経度0.05度ごと。番号は「緯度×20の切り捨て_経度×20の切り捨て」
  1つの面は [輪, 輪, ...]、輪は [緯度, 経度, 差の緯度, 差の経度, ...]（10万分の1度の整数）

  使い方: python tools/convert_hazard.py （shapely, pyshp, pyproj が必要）
"""
import io
import json
import math
import os
import sys
import zipfile
from collections import defaultdict

import numpy as np
import shapefile
import shapely
from pyproj import Transformer
from shapely.geometry import box, shape

SRC = r'C:\Users\hiroyuki\dobox-infra\data\元データ\00.危険範囲'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'hazard')
CELL = 20                  # 1度を20マス（0.05度）に分ける
SCALE = 100000             # 座標は10万分の1度（約1m）
DOSHA = {                  # ファイル → 区分（y: 警戒区域, r: 特別警戒区域）
    r'土砂災害\土石流\73_031dy_34_20261026.shp': 'y',
    r'土砂災害\急傾斜地\73_031ky_34_20261026.shp': 'y',
    r'土砂災害\地すべり\73_031jy_34_20261026.shp': 'y',
    r'土砂災害\土石流\73_031drp_34_20261026.shp': 'r',
    r'土砂災害\急傾斜地\73_031krp_34_20261026.shp': 'r',
}
FLOOD = r'河川浸水範囲\shinsui_souteisaidai.shp'
TSUNAMI = r'津波\340006_tsunami_inundation_assumption_map_20260403\浸水メッシュ_送付_260212_rectangle.shp'
TSUNAMI_BINS = [0.3, 1, 2, 5, 10, 20]   # 区分1: 0.3m未満 … 区分7: 20m以上
SURGE_ZIP = r'高潮\340006_storm_surge_inundation_assumption_map_max_20210803.zip'
TSUNAMI_TOL = 0.00005     # 津波の形を簡単にする幅（度、約5m。10mのマスの段々をならす）
PLANE_TOL = 5              # 平面直角座標で形を簡単にする幅（m）
DOSHA_TOL = 0.00002        # 形を簡単にする幅（度、約2m）
FLOOD_TOL = 6              # 同じく（Webメルカトルの単位、広島で約5m）
MIN_AREA = 2e-9            # これより小さいかけらは捨てる（約20平方m）


def cells_of(bounds):
    x0, y0, x1, y1 = bounds
    for i in range(math.floor(y0 * CELL), math.floor(y1 * CELL) + 1):
        for j in range(math.floor(x0 * CELL), math.floor(x1 * CELL) + 1):
            yield i, j


def cell_box(i, j):
    return box(j / CELL, i / CELL, (j + 1) / CELL, (i + 1) / CELL)


def add_clipped(store, geom, key):
    """geom をマスごとに切って store[(i, j)][key] にためる"""
    for i, j in cells_of(geom.bounds):
        part = shapely.intersection(geom, cell_box(i, j))
        if not part.is_empty and part.area > MIN_AREA:
            store[(i, j)][key].append(part)


def polygons(geom):
    out = []
    for g in shapely.get_parts(geom):
        if g.geom_type == 'Polygon':
            out.append(g)
        elif g.geom_type in ('MultiPolygon', 'GeometryCollection'):
            out += polygons(g)
    return out


def encode_ring(coords):
    out, plat, plng = [], 0, 0
    for lng, lat, *_ in coords[:-1]:
        a, b = round(lat * SCALE), round(lng * SCALE)
        if out and a == plat and b == plng:
            continue
        out += [a - plat, b - plng] if out else [a, b]
        plat, plng = a, b
    return out if len(out) >= 6 else None


def encode(geom):
    result = []
    for p in polygons(geom):
        if p.area < MIN_AREA:
            continue
        rings = [encode_ring(list(p.exterior.coords))] + [encode_ring(list(r.coords)) for r in p.interiors]
        if rings[0]:
            result.append([r for r in rings if r])
    return result


def write_cells(name, store, order, tol):
    folder = os.path.join(OUT, name)
    os.makedirs(folder, exist_ok=True)
    keys, total = [], 0
    for (i, j), groups in sorted(store.items()):
        merged = {k: shapely.make_valid(shapely.union_all(groups[k])) for k in order if groups.get(k)}
        out, upper = {}, None
        for k in reversed(order):           # 上の区分（危ない方）を先に決め、下の区分から差し引く
            if k not in merged:
                continue
            g = merged[k] if upper is None else shapely.difference(merged[k], upper)
            upper = merged[k] if upper is None else shapely.union(upper, merged[k])
            enc = encode(shapely.simplify(g, tol, preserve_topology=True))
            if enc:
                out[k] = enc
        if out:
            key = f'{i}_{j}'
            path = os.path.join(folder, key + '.json')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(out, f, separators=(',', ':'))
            keys.append(key)
            total += os.path.getsize(path)
    print(f'{name}: {len(keys)}マス、合計 {total / 1e6:.1f}MB、最大 '
          f'{max(os.path.getsize(os.path.join(folder, k + ".json")) for k in keys) / 1e6:.2f}MB', flush=True)
    return keys


def read_shapes(path=None, reader=None):
    r = reader or shapefile.Reader(os.path.join(SRC, path), encoding='utf-8')
    for sr in r.iterShapeRecords():
        if sr.shape.shapeType == shapefile.NULL:
            continue
        g = shape(sr.shape.__geo_interface__)
        yield shapely.make_valid(g) if not g.is_valid else g, sr.record


def convert_dosha():
    store = defaultdict(lambda: defaultdict(list))
    for path, cls in DOSHA.items():
        n = 0
        for g, _ in read_shapes(path):
            add_clipped(store, g, cls)
            n += 1
        print(f'  {path}: {n}件', flush=True)
    return write_cells('dosha', store, ['y', 'r'], DOSHA_TOL)


def convert_flood():
    to_ll = Transformer.from_crs(3857, 4326, always_xy=True)
    store = defaultdict(lambda: defaultdict(list))
    n = 0
    for g, rec in read_shapes(FLOOD):
        g = shapely.force_2d(g)
        g = shapely.simplify(g, FLOOD_TOL, preserve_topology=True)
        g = shapely.transform(g, lambda xy: np.column_stack(to_ll.transform(xy[:, 0], xy[:, 1])))
        if not g.is_valid:
            g = shapely.make_valid(g)
        add_clipped(store, g, str(rec['rank']))
        n += 1
        if n % 50 == 0:
            print(f'  洪水 {n}件', flush=True)
    return write_cells('flood', store, [str(r) for r in range(10, 90, 10)], DOSHA_TOL)


def plane_to_store(store, geom, key, to_ll):
    """平面直角座標の形を、簡単にしてから緯度経度に直してマスに分ける"""
    g = shapely.simplify(shapely.force_2d(geom), PLANE_TOL, preserve_topology=True)
    g = shapely.transform(g, lambda xy: np.column_stack(to_ll.transform(xy[:, 0], xy[:, 1])))
    if not g.is_valid:
        g = shapely.make_valid(g)
    add_clipped(store, g, key)


def convert_tsunami():
    """10m四方のマスの最大浸水深を区分に分け、区分ごとにつないで面にする"""
    r = shapefile.Reader(os.path.join(SRC, TSUNAMI), encoding='cp932')
    xs, ys, ds = [], [], []
    for rec in r.iterRecords():
        xs.append(rec[0]); ys.append(rec[1]); ds.append(rec[2])
    xs, ys, ds = np.array(xs, float), np.array(ys, float), np.array(ds, float)
    cls = np.digitize(ds, TSUNAMI_BINS) + 1
    print(f'  津波 {len(ds)}マス、最大 {ds.max():.2f}m、区分ごと {np.bincount(cls)[1:].tolist()}', flush=True)
    to_ll = Transformer.from_crs(6671, 4326, always_xy=True)
    store = defaultdict(lambda: defaultdict(list))
    for c in range(1, len(TSUNAMI_BINS) + 2):
        m = cls == c
        if not m.any():
            continue
        # 横に続くマスを1本の長方形にまとめてから、全部をつなぐ
        ix, iy = np.round((xs[m] - 5) / 10).astype(np.int64), np.round((ys[m] - 5) / 10).astype(np.int64)
        order = np.lexsort((ix, iy))
        ix, iy = ix[order], iy[order]
        brk = np.flatnonzero((np.diff(iy) != 0) | (np.diff(ix) != 1)) + 1
        starts, ends = np.r_[0, brk], np.r_[brk, len(ix)] - 1
        boxes = shapely.box(ix[starts] * 10, iy[starts] * 10, ix[ends] * 10 + 10, iy[starts] * 10 + 10)
        # 長方形をかかるマス目すべてに入れ、平面の座標のままつないでから緯度経度に直し、マス目で切る
        # （緯度経度に直してからつなぐと、長方形の境目にすきまのすじが残るため）
        lb = shapely.bounds(shapely.transform(boxes, lambda xy: np.column_stack(to_ll.transform(xy[:, 0], xy[:, 1]))))
        per_cell = defaultdict(list)
        for k in range(len(boxes)):
            for cell in cells_of(lb[k]):
                per_cell[cell].append(boxes[k])
        for (i, j), items in per_cell.items():
            g = shapely.union_all(items)
            g = shapely.transform(g, lambda xy: np.column_stack(to_ll.transform(xy[:, 0], xy[:, 1])))
            part = shapely.intersection(shapely.make_valid(g), cell_box(i, j))
            if not part.is_empty and part.area > MIN_AREA:
                store[(i, j)][str(c)].append(part)
        print(f'  津波 区分{c} 長方形 {len(boxes)}本', flush=True)
    return write_cells('tsunami', store, [str(c) for c in range(1, len(TSUNAMI_BINS) + 2)], TSUNAMI_TOL)


def convert_surge():
    z = zipfile.ZipFile(os.path.join(SRC, SURGE_ZIP))
    get = lambda ext: io.BytesIO(z.read('takashio_max' + ext))
    r = shapefile.Reader(shp=get('.shp'), dbf=get('.dbf'), shx=get('.shx'), encoding='cp932')
    to_ll = Transformer.from_crs(2445, 4326, always_xy=True)
    store = defaultdict(lambda: defaultdict(list))
    to_plane = Transformer.from_crs(4326, 2445, always_xy=True)
    for sr in r.iterShapeRecords():
        rank = str(int(sr.record['SINSUIRANK']))
        g = shape(sr.shape.__geo_interface__)
        # 大きな面を、まずマス目を囲む四角で速く切ってから、小さくなった形を整える
        lng0, lat0 = to_ll.transform(g.bounds[0], g.bounds[1])
        lng1, lat1 = to_ll.transform(g.bounds[2], g.bounds[3])
        for i, j in cells_of((lng0 - 0.01, lat0 - 0.01, lng1 + 0.01, lat1 + 0.01)):
            xs_, ys_ = to_plane.transform([j / CELL, (j + 1) / CELL, j / CELL, (j + 1) / CELL],
                                          [i / CELL, i / CELL, (i + 1) / CELL, (i + 1) / CELL])
            piece = shapely.clip_by_rect(g, min(xs_) - 20, min(ys_) - 20, max(xs_) + 20, max(ys_) + 20)
            if piece.is_empty:
                continue
            if not piece.is_valid:
                piece = shapely.make_valid(piece)
            piece = shapely.simplify(piece, PLANE_TOL, preserve_topology=True)
            piece = shapely.transform(piece, lambda xy: np.column_stack(to_ll.transform(xy[:, 0], xy[:, 1])))
            part = shapely.intersection(shapely.make_valid(piece), cell_box(i, j))
            if not part.is_empty and part.area > MIN_AREA:
                store[(i, j)][rank].append(part)
        print(f'  高潮 区分{rank} 終わり', flush=True)
    return write_cells('surge', store, [str(c) for c in range(1, 8)], DOSHA_TOL)


if __name__ == '__main__':
    which = sys.argv[1:] or ['dosha', 'flood', 'tsunami', 'surge']
    index_path = os.path.join(OUT, 'index.json')
    index = json.load(open(index_path, encoding='utf-8')) if os.path.exists(index_path) else {}
    index['cell'] = CELL
    index['scale'] = SCALE
    if 'dosha' in which:
        index['dosha'] = convert_dosha()
    if 'flood' in which:
        index['flood'] = convert_flood()
    if 'tsunami' in which:
        index['tsunami'] = convert_tsunami()
    if 'surge' in which:
        index['surge'] = convert_surge()
    os.makedirs(OUT, exist_ok=True)
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(index, f, separators=(',', ':'))
