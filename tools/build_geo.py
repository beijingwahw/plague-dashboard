# -*- coding: utf-8 -*-
"""简化上海行政区划 GeoJSON → vendor/shanghai-districts.js（Douglas-Peucker，保留主要轮廓）"""
import json

SRC = 'shanghai_tmp.json'
DST = 'vendor/shanghai-districts.js'
EPS = 0.0015          # 简化容差（经纬度，约 150m）
KEEP_RATIO = 0.995    # 保留面积占比（丢弃零碎小岛）


def dp(points, eps):
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = points[i]
        bx, by = points[j]
        dx, dy = bx - ax, by - ay
        dmax, idx = -1.0, -1
        for k in range(i + 1, j):
            px, py = points[k]
            if dx == 0 and dy == 0:
                d = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
                cx, cy = ax + t * dx, ay + t * dy
                d = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
            if d > dmax:
                dmax, idx = d, k
        if dmax > eps:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(points, keep) if k]


def ring_area(ring):
    s = 0.0
    for i in range(len(ring) - 1):
        s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(s / 2)


data = json.load(open(SRC, encoding='utf-8'))
out = []
for f in data['features']:
    geom = f['geometry']
    polys = [geom['coordinates']] if geom['type'] == 'Polygon' else list(geom['coordinates'])
    polys.sort(key=lambda p: ring_area(p[0]), reverse=True)
    total = sum(ring_area(p[0]) for p in polys)
    kept, acc = [], 0.0
    for p in polys:
        kept.append(p)
        acc += ring_area(p[0])
        if total and acc / total >= KEEP_RATIO:
            break
    simp = []
    for p in kept:
        outer = dp(p[0], EPS)          # 丢弃内孔（洞）
        outer = [[round(x, 4), round(y, 4)] for x, y in outer]
        if outer[0] != outer[-1]:
            outer.append(outer[0])
        simp.append([outer])
    gtype = 'Polygon' if len(simp) == 1 else 'MultiPolygon'
    coord = simp[0] if gtype == 'Polygon' else simp
    out.append({
        'type': 'Feature',
        'properties': {'adcode': f['properties']['adcode'], 'name': f['properties']['name']},
        'geometry': {'type': gtype, 'coordinates': coord},
    })

res = {'type': 'FeatureCollection', 'features': out}
js = 'window.SHANGHAI_GEO=' + json.dumps(res, separators=(',', ':'), ensure_ascii=False) + ';\n'
open(DST, 'w', encoding='utf-8').write(js)

n_pts = sum(len(p[0][0]) for f in out for p in ([f['geometry']['coordinates']] if f['geometry']['type'] == 'Polygon' else f['geometry']['coordinates']))
import os
print('features:', len(out), 'points:', n_pts, 'size:', os.path.getsize(DST), 'bytes')
