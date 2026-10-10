/* =========================================================================
 * map-view.js —— 高德地图 JS API 2.0 视图
 * 官方深色矢量底图（村镇级地名）+ 行政区划多环边界（支持下钻）
 * + 病例点 / 风险热力 / 轨迹回放 / 链式传染路径
 * ========================================================================= */
(function (root) {
'use strict';

const AMAP_KEY = '651f5554ee92d8a57b8bccc7d19da8cf';   // 高德开放平台 JS API Key
const RISK_FILL = ['#233043', '#15803d', '#ca8a04', '#ea580c', '#dc2626', '#991b1b'];
const BLUE_SCALE = ['#16233f', '#173e63', '#1a5d94', '#1f83c2', '#38bdf8'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function scoreColor(v, max) {
  if (max <= 0) return BLUE_SCALE[0];
  const t = Math.min(1, v / max);
  return BLUE_SCALE[Math.min(BLUE_SCALE.length - 1, Math.floor(t * BLUE_SCALE.length))];
}

class MapView {
  constructor(el) { this.el = el; }

  init(opts) {
    this.opts = opts || {};
    this.map = new AMap.Map(this.el, {
      zoom: 4, center: [105, 36], zooms: [3, 20],
      mapStyle: 'amap://styles/dark',       // 官方深色样式（矢量，含村镇级地名）
      viewMode: '2D',
    });

    /* 区域图层（多环 Polygon + 名称标注） */
    this.districtOverlays = [];              // {region, polys:[Polygon], label:Text}
    this.hoverWin = new AMap.InfoWindow({ isCustom: false, autoMove: false, closeWhenClickMap: true });

    /* 病例点 */
    this.caseMarkers = new Map();            // pid → CircleMarker

    /* 热力图层（插件异步加载） */
    this.heat = null;
    this._heatVisible = true;
    AMap.plugin('AMap.HeatMap', () => {
      this.heat = new AMap.HeatMap(this.map, {
        radius: 26, opacity: [0, .5],
        gradient: { 0.3: '#0e7490', 0.55: '#65a30d', 0.75: '#facc15', 0.9: '#fb923c', 1.0: '#ef4444' },
      });
      if (this._pendingHeat) { this.heat.setDataSet(this._pendingHeat); this._pendingHeat = null; }
      if (!this._heatVisible) this.heat.hide();
    });

    /* 轨迹 / 链式路径 */
    this.trajOverlays = [];
    this._traj = null;
    this._savedView = null;

    /* 视野变化（缩放/平移，防抖）：驱动风险矩阵联动 */
    this._viewTimer = null;
    const onView = () => {
      clearTimeout(this._viewTimer);
      this._viewTimer = setTimeout(() => {
        if (this.opts.onViewChange) this.opts.onViewChange();
      }, 280);
    };
    this.map.on('moveend', onView);
    this.map.on('zoomend', onView);
    return this;
  }

  /* ---------- 自适应当前区域范围 ---------- */
  fitRegions() {
    const ovs = this.districtOverlays.flatMap(d => d.polys.length ? d.polys : [d.label]);
    if (ovs.length) this.map.setFitView(ovs, false, [42, 42, 42, 42]);
  }

  /* ---------- 总刷新 ---------- */
  update(state, view) {
    this._last = { state, view };
    this._updateDistricts(state, view.metric);
    this._updateCases(state);
    this._updateHeat(state);
    this._applyLayerVisibility(view.layers);
    this._renderLegend(view.metric);
  }

  _applyLayerVisibility(layers) {
    const setMap = (ov, on) => { if (on && ov.getMap() !== this.map) ov.setMap(this.map); if (!on && ov.getMap()) ov.setMap(null); };
    for (const d of this.districtOverlays) {
      d.polys.forEach(p => setMap(p, layers.districts));
      setMap(d.label, layers.districts);
    }
    for (const m of this.caseMarkers.values()) setMap(m, layers.cases);
    if (this.heat) { if (layers.heat) this.heat.show(); else this.heat.hide(); }
    this._heatVisible = layers.heat;
    this.trajOverlays.forEach(o => setMap(o, layers.traj));
  }

  /* ---------- 区域边界（当前层级：省 / 市 / 区县 / 乡镇街道） ---------- */
  _updateDistricts(state, metric) {
    const curIds = new Set(PD.DISTRICTS.map(d => d.id));
    for (const d of this.districtOverlays.slice()) {
      if (!curIds.has(d.region.id)) {
        d.polys.forEach(p => p.setMap(null));
        d.label.setMap(null);
        this.districtOverlays.splice(this.districtOverlays.indexOf(d), 1);
      }
    }
    for (const region of PD.DISTRICTS) {
      let entry = this.districtOverlays.find(d => d.region.id === region.id);
      if (!entry) {
        /* 村镇层（点区域）：不绘制辅助图形，仅保留可交互的名称标注（点击查看详情） */
        if (region.pointOnly) {
          const label = this._makeRegionLabel(region, true);
          label.on('click', () => {
            if (!this._last) return;
            this.hoverWin.setContent(this._regionHtml(region, this._last.state));
            this.hoverWin.open(this.map, region.centroid);
          });
          this.districtOverlays.push({ region, polys: [], label, labelBase: this._labelStyle(region, true), isNew: true });
          continue;
        }
        const polys = region.rings.map(ring => {
          const poly = new AMap.Polygon({
            path: ring.map(c => [c[0], c[1]]),
            strokeColor: '#3d5f92', strokeWeight: 1.4, strokeOpacity: .8,
            fillColor: '#16233f', fillOpacity: .22, zIndex: 10,
          });
          poly.on('mouseover', e => {
            poly.setOptions({ fillOpacity: .4, strokeWeight: 2.2 });
            this.hoverWin.setContent(this._regionHtml(region, state));
            this.hoverWin.open(this.map, e.lnglat);
          });
          poly.on('mouseout', () => poly.setOptions({ fillOpacity: this._regionFillOpacity || .22, strokeWeight: 1.4 }));
          poly.on('click', () => { if (this.opts.onRegionClick) this.opts.onRegionClick(region); });
          return poly;
        });
        const label = this._makeRegionLabel(region);
        entry = { region, polys, label, labelBase: this._labelStyle(region), isNew: true };
        this.districtOverlays.push(entry);
      }
    }
    /* 着色 */
    const risk = state.risk;
    const stById = state.distStats;
    let vals = null, max = 1;
    if (metric !== 'risk') {
      vals = {};
      for (const x of PD.DISTRICTS) {
        const st = stById[x.id] || { active: 0, cum: 0 };
        vals[x.id] = metric === 'active' ? st.active : st.cum;
        max = Math.max(max, vals[x.id]);
      }
    }
    for (const entry of this.districtOverlays) {
      if (!curIds.has(entry.region.id)) continue;
      const r = entry.region;
      if (r.pointOnly) {
        /* 街道层：名称标注按当前指标着色（风险等级 / 病例量） */
        let color = 'rgba(219,228,243,.85)';
        if (metric === 'risk') {
          const lv = risk.level(r.id, state.now);
          if (lv > 0) color = PD.RISK_LEVELS[lv].color === '#15803d' ? '#4ade80' : (lv >= 3 ? '#fca5a5' : '#fde68a');
        } else {
          const v = vals[r.id] || 0;
          if (v > 0) color = '#7dd3fc';
        }
        if (entry._labelColor !== color) {
          entry._labelColor = color;
          entry.label.setStyle(Object.assign({}, entry.labelBase, { color }));
        }
      } else {
        let fill = '#16233f', opacity = .16;
        if (metric === 'risk') {
          const lv = risk.level(r.id, state.now);
          fill = RISK_FILL[lv];
          opacity = lv === 0 ? .16 : .38;
        } else {
          fill = scoreColor(vals[r.id] || 0, max);
          opacity = .38;
        }
        entry.polys.forEach(p => p.setOptions({ fillColor: fill, fillOpacity: opacity }));
      }
      if (entry.isNew) { entry.isNew = false; this._fadeIn(entry); }
    }
  }

  _labelStyle(region, interactive) {
    return {
      'background-color': 'transparent', 'border': 'none', 'box-shadow': 'none',
      'font-size': '12px', 'font-weight': '600',
      'color': 'rgba(219,228,243,.85)',
      'text-shadow': '0 0 4px rgba(10,15,28,.95), 0 0 8px rgba(10,15,28,.8)',
      'padding': interactive ? '2px 6px' : '0',
      'cursor': interactive ? 'pointer' : 'default',
      'pointer-events': interactive ? 'auto' : 'none',
    };
  }

  _makeRegionLabel(region, interactive) {
    return new AMap.Text({
      text: region.name, position: region.centroid, anchor: 'center',
      style: this._labelStyle(region, interactive),
    });
  }

  /* 新建区域图形/标注淡入，配合相机飞行动画获得平滑的下钻观感 */
  _fadeIn(entry) {
    const t0 = performance.now(), dur = 480;
    entry.polys.forEach(p => {
      const o = p.getOptions();
      const fTarget = o.fillOpacity, sTarget = o.strokeOpacity || .8;
      p.setOptions({ fillOpacity: 0, strokeOpacity: 0 });
      const step = now => {
        const k = Math.min(1, (now - t0) / dur);
        p.setOptions({ fillOpacity: fTarget * k, strokeOpacity: sTarget * k });
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const base = entry.labelBase;
    entry.label.setStyle(Object.assign({}, base, { opacity: 0 }));
    setTimeout(() => entry.label.setStyle(Object.assign({}, base, { opacity: 1, transition: 'opacity .45s ease' })), 40);
  }

  _regionHtml(r, state) {
    const st = (state.distStats && state.distStats[r.id]) || { cum: 0, active: 0 };
    const lv = state.risk.level(r.id, state.now);
    const L = PD.RISK_LEVELS[lv];
    const pop = r.pop != null ? `（人口 ${r.pop} 万）` : '';
    return `<div class="amap-region-tip"><b>${esc(r.name)}</b>${pop}<br>` +
      `累计报告 ${st.cum} 例 · 现有在治 ${st.active} 例<br>` +
      `当前时段风险：<b style="color:${lv >= 4 ? '#fca5a5' : '#a5f3fc'}">${L.name}</b>（风险分 ${state.risk.score(r.id, state.now).toFixed(1)}）` +
      (r.level !== 'street' ? '<br><span style="color:#7c8db0">点击下钻至下级区划</span>' : '') + '</div>';
  }

  /* ---------- 病例点（现有在治） ---------- */
  _updateCases(state) {
    const alive = new Set();
    for (const p of state.reported) {
      const st = PD.statusAt(p, state.now);
      if (st !== '疑似' && st !== '确诊') continue;
      alive.add(p.id);
      const sev = PD.sevAt(p, state.now);
      const conf = st === '确诊';
      let m = this.caseMarkers.get(p.id);
      if (!m) {
        m = new AMap.CircleMarker({
          center: p.homeLoc, radius: 5, strokeWeight: 1.6, strokeOpacity: .9,
          cursor: 'pointer', zIndex: 60,
        });
        m.on('click', () => this._popupFor(p));
        this.caseMarkers.set(p.id, m);
      }
      m.setCenter(p.homeLoc);
      m.setOptions({
        radius: 3.5 + PD.SEV[sev].idx * 1.3,
        fillColor: PD.SEV[sev].color,
        strokeColor: conf ? '#e2e8f0' : '#94a3b8',
        strokeStyle: conf ? 'solid' : 'dashed',
      });
    }
    for (const [id, m] of this.caseMarkers) {
      if (!alive.has(id)) { m.setMap(null); this.caseMarkers.delete(id); }
    }
  }

  _popupFor(p) {
    if (!this._last) return;
    const { state } = this._last;
    const sev = PD.sevAt(p, state.now);
    const st = PD.statusAt(p, state.now);
    const html =
      `<div class="amap-case-tip"><b>${p.id}</b>　${p.gender} ${p.age} 岁<br>` +
      `严重程度：<b style="color:${PD.SEV[sev].color}">${sev}</b> · 状态：${st}<br>` +
      `现住：${esc(p.district)} · 报告：${PD.fmtDT(p.report)}<br>` +
      (p.chainPath && p.chainPath.length ? `传染链：共 ${p.chainPath.length} 环节<br>` : (p.cluster ? `传播链：${esc(p.cluster)}<br>` : '')) +
      `<button class="popup-btn" onclick="App.showTrajectory('${p.id}')">▶ 查看行动轨迹与风险</button></div>`;
    new AMap.InfoWindow({ content: html, offset: new AMap.Pixel(0, -12) })
      .open(this.map, p.homeLoc);
  }

  /* ---------- 热力 ---------- */
  _updateHeat(state) {
    const pts = state.risk.heatPoints(state.now, 6 * PD.HOUR);   // [[lng,lat,w(0..1)], ...]
    const ds = { max: 1, data: pts.map(([lng, lat, w]) => ({ lng, lat, count: w })) };
    if (this.heat) this.heat.setDataSet(ds);
    else this._pendingHeat = ds;
  }

  /* ---------- 图例 ---------- */
  _renderLegend(metric) {
    const el = document.getElementById('map-legend');
    if (!el) return;
    let html;
    if (metric === 'risk') {
      html = PD.RISK_LEVELS.slice(1).map(l =>
        `<span class="lg"><span class="sw" style="background:${l.color}"></span>${l.name}风险</span>`).join('');
    } else {
      html = `<span class="lg"><span class="sw" style="background:${BLUE_SCALE[0]}"></span>少</span>` +
        `<span class="lg"><span class="sw" style="background:${BLUE_SCALE[4]}"></span>多</span>`;
    }
    html += `<span class="lg">◎ 病例点大小=严重程度，虚线圈=疑似</span>`;
    el.innerHTML = html;
  }

  /* =========================================================
   * 轨迹回放 + 链式传染路径
   * ========================================================= */
  showTrajectory(p, riskIdx) {
    this.clearTrajectory(false);
    const stops = p.stops;
    const latlngs = stops.map(s => s.loc);
    this._savedView = { zoom: this.map.getZoom(), center: this.map.getCenter() };

    const glow = new AMap.Polyline({ path: latlngs, strokeColor: '#0ea5e9', strokeWeight: 9, strokeOpacity: .18, zIndex: 40 });
    const line = new AMap.Polyline({ path: latlngs, strokeColor: '#38bdf8', strokeWeight: 3, strokeOpacity: .85, strokeStyle: 'dashed', strokeDasharray: [8, 8], zIndex: 41 });
    this.trajOverlays.push(glow, line);

    const ways = stops.map((s, i) => {
      const lv = riskIdx.level(s.districtId, s.t);
      const m = new AMap.Marker({
        position: s.loc, anchor: 'center', zIndex: 120,
        content: `<div class="waypoint-label">${i + 1}</div>`,
      });
      m.on('click', () => {
        new AMap.InfoWindow({
          content: `<div class="amap-case-tip"><b>${i + 1}. ${esc(s.name)}</b>（${esc(s.district)}）<br>` +
            `${PD.fmtDT(s.t)} – ${PD.fmtT(s.tEnd)} · ${s.type}${s.isReport ? ' · <b style="color:#fca5a5">报告收治</b>' : ''}<br>` +
            `该时段${esc(s.district)}疫情风险：` + this._riskTag(lv) + '</div>',
          offset: new AMap.Pixel(0, -14),
        }).open(this.map, s.loc);
      });
      this.trajOverlays.push(m);
      return m;
    });

    const moving = new AMap.Marker({
      position: latlngs[0], anchor: 'center', zIndex: 200,
      content: '<div class="traj-dot pulse"></div>',
    });
    this.trajOverlays.push(moving);

    /* 链式传染路径（时间 + 区域 → 下一环节） */
    if (p.chainPath && p.chainPath.length) {
      const pos = p.chainPath.map(l => {
        const r = PD.DIST_BY_ID[l.districtId];
        return r ? r.centroid : l.centroid || (PD.DISTRICTS[0] && PD.DISTRICTS[0].centroid) || [105, 36];
      });
      if (pos.length > 1) {
        this.trajOverlays.push(new AMap.Polyline({
          path: pos, strokeColor: '#f87171', strokeWeight: 2.5,
          strokeOpacity: .85, strokeStyle: 'dashed', strokeDasharray: [3, 10], zIndex: 42,
        }));
      }
      p.chainPath.forEach((l, i) => {
        const lv = riskIdx.level(l.districtId, l.t);
        const m = new AMap.Marker({ position: pos[i], anchor: 'center', zIndex: 130, content: `<div class="chain-marker">${i + 1}</div>` });
        m.on('click', () => {
          new AMap.InfoWindow({
            content: `<div class="amap-case-tip"><b>链式传染 ${i + 1}/${p.chainPath.length}</b><br>` +
              `${PD.fmtDT(l.t)} · ${esc(l.district)}${l.note ? ' · ' + esc(l.note) : ''}<br>` +
              `该时段该区域疫情风险：` + this._riskTag(lv) + '</div>',
            offset: new AMap.Pixel(0, -14),
          }).open(this.map, pos[i]);
        });
        this.trajOverlays.push(m);
      });
    }

    this._traj = {
      patient: p, riskIdx, stops, ways, moving,
      p: 0, playing: false, lastTs: null, raf: null,
      segDur: this._segDurations(stops),
      onProgress: null, onEnd: null,
    };
    this.map.setZoomAndCenter(13, latlngs[0]);
  }

  _segDurations(stops) {
    const gaps = [];
    let total = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const g = Math.max(PD.MIN, stops[i + 1].t - stops[i].t);
      gaps.push(g); total += g;
    }
    const scale = Math.min(20, Math.max(8, total / PD.HOUR)) / Math.max(1, total);
    return gaps.map(g => Math.max(.6, g * scale));
  }

  _riskTag(lv) {
    const l = PD.RISK_LEVELS[lv];
    return `<b style="color:${lv >= 4 ? '#fca5a5' : '#a5f3fc'}">${l.name}</b>`;
  }

  playTrajectory() {
    const tr = this._traj;
    if (!tr || tr.playing) return;
    tr.playing = true;
    tr.lastTs = null;
    const step = (ts) => {
      if (!this._traj || !this._traj.playing) return;
      if (tr.lastTs == null) tr.lastTs = ts;
      const dt = (ts - tr.lastTs) / 1000;
      tr.lastTs = ts;
      tr.p = Math.min(tr.stops.length - 1, tr.p + dt);
      this._renderPos();
      if (tr.p >= tr.stops.length - 1) {
        tr.playing = false;
        if (tr.onEnd) tr.onEnd();
        return;
      }
      tr.raf = requestAnimationFrame(step);
    };
    tr.raf = requestAnimationFrame(step);
  }

  pauseTrajectory() {
    const tr = this._traj;
    if (!tr) return;
    tr.playing = false;
    if (tr.raf) cancelAnimationFrame(tr.raf);
  }

  seekTrajectory(p) {
    const tr = this._traj;
    if (!tr) return;
    this.pauseTrajectory();
    tr.p = Math.max(0, Math.min(tr.stops.length - 1, p));
    this._renderPos();
  }

  _renderPos() {
    const tr = this._traj;
    if (!tr) return;
    const i = Math.floor(tr.p), frac = tr.p - i;
    const stops = tr.stops;
    let pos;
    if (i >= stops.length - 1) pos = stops[stops.length - 1].loc;
    else {
      const a = stops[i].loc, b = stops[i + 1].loc;
      pos = [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
    }
    tr.moving.setPosition(pos);
    this._fireProgress(i);
  }

  _fireProgress(i) {
    const tr = this._traj;
    if (!tr) return;
    if (this._lastProg === i + '|' + tr.patient.id) return;
    this._lastProg = i + '|' + tr.patient.id;
    if (tr.onProgress) tr.onProgress(i, tr);
    const s = tr.stops[i];
    const lv = tr.riskIdx.level(s.districtId, s.t);
    tr.moving.setLabel({
      content: `<span style="color:#cfe8ff;font-size:12px;text-shadow:0 0 3px #000,0 0 6px #000">${i + 1}. ${esc(s.name)} ${PD.fmtT(s.t)} · ${esc(s.district)}风险：${PD.RISK_LEVELS[lv].name}</span>`,
      direction: 'top', offset: new AMap.Pixel(0, -6),
    });
  }

  clearTrajectory(flyBack = true) {
    this.pauseTrajectory();
    this._traj = null;
    this._lastProg = null;
    this.trajOverlays.forEach(o => o.setMap(null));
    this.trajOverlays = [];
    if (flyBack && this._savedView) {
      this.map.setZoomAndCenter(this._savedView.zoom, this._savedView.center);
    }
    this._savedView = null;
  }
}

/* 兜底加载高德 JS API（index.html 已先引入时直接通过） */
function ensureAMap() {
  if (typeof AMap !== 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + AMAP_KEY;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('高德地图 JS API 加载失败（需联网）'));
    document.head.appendChild(s);
  });
}

root.MapView = MapView;
root.ensureAMap = ensureAMap;
})(typeof window !== 'undefined' ? window : globalThis);
