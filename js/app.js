/* =========================================================================
 * app.js —— 总装配：生成数据 → 启动引擎 → 装配视图 → 定时刷新
 * ========================================================================= */
(function (root) {
'use strict';

const $ = id => document.getElementById(id);

function boot() {
  /* 随机种子（URL ?seed= 指定，便于复现同一场疫情） */
  const mSeed = location.search.match(/[?&]seed=(\d+)/);
  const seed = mSeed ? parseInt(mSeed[1], 10) : 20261010;

  const data = PD.generate(seed, Date.now());

  /* 后台操作持久化（按场景种子隔离）：登记/变更记录，刷新后重放 */
  const adminStore = {
    key: 'pd-ops-' + seed,
    ops: [],
    load() { try { this.ops = JSON.parse(localStorage.getItem(this.key)) || []; } catch (e) { this.ops = []; } },
    save() { try { localStorage.setItem(this.key, JSON.stringify(this.ops.slice(-500))); } catch (e) { /* 隐私模式等场景忽略 */ } },
    clear() { this.ops = []; try { localStorage.removeItem(this.key); } catch (e) {} },
  };
  adminStore.load();
  PD.replayAdminOps(data, adminStore.ops);

  const engine = new Engine(data);

  const mapView = new MapView($('map')).init();

  const charts = initCharts();
  const patientById = id => data.patients.find(p => p.id === id);

  const ctx = { engine, mapView, charts, patientById, lastState: null };
  const ui = createUI(ctx);
  ui.init();
  const regionCtl = createRegionController({ engine, data, refresh: () => refresh(), ui, mapView, toast: ui.toast });
  regionCtl.init();
  mapView.opts.onRegionClick = region => regionCtl.drill(region);
  mapView.opts.onViewChange = () => {
    refreshViewportRegions();
    refresh();
  };
  const admin = createAdmin({ engine, data, refresh: () => refresh(), toast: ui.toast, patientById, store: adminStore });
  admin.init();

  /* 视图选项（着色指标 / 图层开关 / 风险矩阵日期） */
  const view = {
    visibleIds: null,                      // 当前地图视野内的区域（null = 全部）
    focusRegion: null,                     // 放大聚焦的具体区域（聚焦链末端）
    focusChain: [],                        // 聚焦链（如 上海市 › 徐汇区 › 田林街道）
    childRegions: null,                    // 聚焦链末端的下级区域（矩阵显示其内部各区域）
    matrixRows: null,                      // 矩阵覆盖行（聚焦下钻时由真实位置归集计算）
    metric: $('choro-metric').value,
    layers: {
      districts: $('lyr-districts').checked,
      cases: $('lyr-cases').checked,
      heat: $('lyr-heat').checked,
      traj: $('lyr-traj').checked,
    },
  };
  let matrixDay = 0;

  /* ---------- 地图视野 → 可见区域（风险矩阵联动） ---------- */
  function regionBBox(r) {
    if (r._bbox) return r._bbox;
    let bb;
    if (r.rings && r.rings.length) {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const ring of r.rings) for (const c of ring) {
        if (c[0] < minLng) minLng = c[0];
        if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      }
      bb = [minLng, minLat, maxLng, maxLat];
    } else {
      const e = 0.004;
      bb = [r.centroid[0] - e, r.centroid[1] - e, r.centroid[0] + e, r.centroid[1] + e];
    }
    r._bbox = bb;
    return bb;
  }

  /* 视野 → 区域集合 + 聚焦区域：
   * 视野中心所在区域若占据视口主体（面积交叠 ≥ 35%），判定为"聚焦区域"，
   * 矩阵仅显示该区域，与用户放大到的具体区域保持一致；
   * 街道等点区域在深放大（视野跨度 ≤ 0.08°）时按最近中心聚焦。 */
  function computeViewportRegions(regionSet) {
    const regions = regionSet || PD.DISTRICTS;
    let b;
    try { b = mapView.map.getBounds(); } catch (e) { return { ids: null, focus: null }; }
    if (!b) return { ids: null, focus: null };
    const sw = b.getSouthWest(), ne = b.getNorthEast(), c = b.getCenter();
    const spanLng = ne.lng - sw.lng, spanLat = ne.lat - sw.lat;
    const vpArea = Math.max(1e-12, spanLng * spanLat);
    const ids = [];
    let centerRegion = null, centerRatio = 0;
    let nearestPoint = null, nearestD = Infinity;
    for (const r of regions) {
      const bb = regionBBox(r);
      const inter = !(bb[2] < sw.lng || bb[0] > ne.lng || bb[3] < sw.lat || bb[1] > ne.lat);
      if (inter) ids.push(r.id);
      if (r.rings && r.rings.length) {
        if (r.rings.some(ring => PD.pointInRing(c.lng, c.lat, ring))) {
          const ox = Math.min(ne.lng, bb[2]) - Math.max(sw.lng, bb[0]);
          const oy = Math.min(ne.lat, bb[3]) - Math.max(sw.lat, bb[1]);
          const ratio = Math.max(0, ox) * Math.max(0, oy) / vpArea;
          if (!centerRegion || ratio > centerRatio) { centerRegion = r; centerRatio = ratio; }
        }
      } else {
        const d = Math.hypot(r.centroid[0] - c.lng, r.centroid[1] - c.lat);
        if (d < nearestD) { nearestD = d; nearestPoint = r; }
      }
    }
    let focus = null;
    if (centerRegion && centerRatio >= 0.35) focus = centerRegion;
    else if (!centerRegion && nearestPoint && Math.max(spanLng, spanLat) <= 0.08 &&
             nearestD <= Math.max(spanLng, spanLat) * 0.6) focus = nearestPoint;
    return { ids: ids.length ? ids : null, focus };
  }

  let chainReq = 0;                        // 聚焦链请求代号（防陈旧）
  const childRowsCache = new Map();        // 聚焦链矩阵行缓存（key = 链›日期›病例数）

  function computeChildRows(chainKey, children, day) {
    const key = chainKey + '|' + day + '|' + data.patients.length;
    if (childRowsCache.has(key)) return childRowsCache.get(key);
    const dayTs = PD.dayStart(engine.simNow) + day * PD.DAY;
    const rows = PD.computeRegionRiskMatrix(data.patients, children, dayTs, engine.simNow);
    if (childRowsCache.size > 60) childRowsCache.clear();
    childRowsCache.set(key, rows);
    return rows;
  }

  /* 聚焦链：从当前层级起逐级判定聚焦区域并下钻——
   * 全国层放大到上海市 → 矩阵=其16区县；再放大到徐汇区 → 矩阵=其街道；
   * 再放大到田林街道（叶级）→ 矩阵=该街道单行。任一级未形成聚焦即停在该层下级。 */
  function refreshViewportRegions() {
    const myReq = ++chainReq;
    walkChain(myReq).catch(() => {});
  }

  async function walkChain(myReq) {
    const vpr1 = computeViewportRegions(PD.DISTRICTS);
    view.visibleIds = vpr1.focus ? [vpr1.focus.id] : vpr1.ids;
    if (!vpr1.focus) {
      view.focusRegion = null; view.focusChain = []; view.childRegions = null; view.matrixRows = null;
      refresh();
      return;
    }
    const chain = [vpr1.focus];
    view.focusRegion = vpr1.focus; view.focusChain = chain; view.childRegions = null; view.matrixRows = null;
    refresh();
    while (true) {
      if (myReq !== chainReq) return;
      const last = chain[chain.length - 1];
      if (last.pointOnly || last.level === 'street') break;          // 叶级（街道）
      const children = await regionCtl.childrenOf(last);
      if (myReq !== chainReq) return;
      if (!children || !children.length) break;
      const deeper = computeViewportRegions(children).focus;
      if (deeper) {
        chain.push(deeper);
        view.focusRegion = deeper; view.focusChain = chain;
        view.childRegions = null; view.matrixRows = null;
        refresh();                                                   // 逐级刷新（渐进）
      } else {
        view.childRegions = children;                                // 停在该层：显示下级集合
        refresh();
        break;
      }
    }
    refresh();
  }

  function updateMatrixScope() {
    const el = $('matrix-scope');
    if (!el) return;
    const total = PD.DISTRICTS.length;
    if (view.focusRegion) {
      const path = (view.focusChain || [view.focusRegion]).map(r => r.name).join(' › ');
      el.textContent = view.childRegions
        ? `（聚焦：${path} · 下辖 ${view.childRegions.length} 个区域）`
        : `（聚焦：${path}）`;
      return;
    }
    const n = view.visibleIds ? view.visibleIds.length : total;
    el.textContent = n >= total ? `（全部 ${total} 个区域）` : `（当前视野 ${n}/${total}）`;
  }

  /* ---------- 全量刷新 ---------- */
  function refresh() {
    const state = engine.state();
    ctx.lastState = state;
    /* 聚焦下级就绪 → 矩阵行 = 聚焦链末端区域内部各区域（真实位置归集） */
    view.matrixRows = view.childRegions
      ? computeChildRows(view.focusChain.map(r => r.id).join('>'), view.childRegions, matrixDay)
      : null;
    const rows = view.matrixRows ? view.matrixRows.length
      : (view.visibleIds && view.visibleIds.length ? view.visibleIds.length : PD.DISTRICTS.length);
    const rh = Math.min(1200, Math.max(view.focusRegion ? 240 : 320, rows * 26 + 96));
    if ($('chart-risk').style.height !== rh + 'px') {
      $('chart-risk').style.height = rh + 'px';
      charts.resize();
    }
    ui.updateKpis(state.kpis);
    ui.updateTable(state);
    charts.update(state, matrixDay, view.visibleIds, view.matrixRows);
    mapView.update(state, view);
    updateMatrixScope();
  }

  /* ---------- 轨迹回放入口 ---------- */
  root.App = {
    /* 行政区划下钻/上钻（亦供外部调用） */
    drill(adcode) { const r = PD.DIST_BY_ID[adcode]; if (r) regionCtl.drill(r); },
    up() { regionCtl.up(); },
    setView(zoom, lng, lat) { mapView.map.setZoomAndCenter(zoom, [lng, lat]); },
    showTrajectory(pid) {
      const p = patientById(pid);
      if (!p) return;
      const state = engine.state();
      mapView.showTrajectory(p, state.risk);
      mapView._traj.onProgress = i => ui.onTrajProgress(i);
      mapView._traj.onEnd = () => ui.syncPlayBtn(false);
      ui.openDrawer(p, state.risk);
      mapView.seekTrajectory(0);
      ui.updateTable(state);
    },
  };

  /* ---------- 初始化：快进历史 → 预填播报 ---------- */
  refreshViewportRegions();
  const hist = engine.prime();
  ui.pushFeed(hist.slice(-24), true);
  ui.updateClock(engine.simNow);
  refresh();

  /* 引擎事件 → 实时播报 */
  engine.on('event', ev => ui.pushFeed([ev], false));

  /* ---------- 时钟循环（250ms）：与现实时间保持同步 ---------- */
  setInterval(() => {
    engine.tick();
    ui.updateClock(engine.simNow);
  }, 250);
  setInterval(refresh, 1000);

  /* ---------- 视图控件 ---------- */
  $('choro-metric').addEventListener('change', e => { view.metric = e.target.value; refresh(); });
  [['lyr-districts', 'districts'], ['lyr-cases', 'cases'], ['lyr-heat', 'heat'], ['lyr-traj', 'traj']].forEach(([id, key]) => {
    $(id).addEventListener('change', e => { view.layers[key] = e.target.checked; refresh(); });
  });
  $('matrix-day-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    matrixDay = parseInt(b.dataset.day, 10);
    document.querySelectorAll('#matrix-day-chips .chip').forEach(c => c.classList.toggle('active', c === b));
    const state = engine.state();
    charts.update(state, matrixDay);
  });

  window.addEventListener('resize', () => charts.resize());

  console.log('[肺鼠疫监测平台] 就绪：病例仅经后台登记手动输入（本次重放', data.patients.length, '例）· seed =', seed);
}

document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})(typeof window !== 'undefined' ? window : globalThis);
