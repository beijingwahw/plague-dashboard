/* =========================================================================
 * regions.js —— 行政区划逐级下钻（全国 → 省级 → 市/区县 → 乡镇/街道）
 * 子级边界按需从阿里云 DataV.GeoAtlas 拉取（内存缓存），经 Douglas-Peucker
 * 简化后构建区域；病例按居住坐标（点包含 + 最近中心回退）归入当前层级；
 * 对缺少场所数据的区域合成基础场所（社区 / 医疗机构 / 农贸市场 / 商业街）。
 * ========================================================================= */
(function (root) {
'use strict';

const GEO_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json';
const SIMPLIFY_EPS = { province: 0.008, city: 0.004, district: 0.0015, street: 0.0008 };

const geoCache = new Map();      // adcode → features | null（null = 拉取失败/无子级）

/* ---------------- Douglas-Peucker（坐标 [lng,lat]） ---------------- */
function simplifyRing(points, eps) {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j <= i + 1) continue;
    const [ax, ay] = points[i], [bx, by] = points[j];
    const dx = bx - ax, dy = by - ay;
    let dmax = -1, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = points[k];
      let d;
      if (dx === 0 && dy === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > dmax) { dmax = d; idx = k; }
    }
    if (dmax > eps) { keep[idx] = true; stack.push([i, idx], [idx, j]); }
  }
  return points.filter((_, k) => keep[k]);
}

async function fetchChildFeatures(adcode) {
  if (geoCache.has(adcode)) return geoCache.get(adcode);
  let out = null;
  try {
    const resp = await fetch(GEO_URL.replace('{adcode}', adcode));
    if (resp.ok) {
      const geo = await resp.json();
      if (geo && Array.isArray(geo.features) && geo.features.length) {
        const level = geo.features[0].properties && geo.features[0].properties.level;
        const eps = SIMPLIFY_EPS[level] || 0.0015;
        for (const f of geo.features) {
          const g = f.geometry;
          if (!g) continue;
          const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
          g.type = 'MultiPolygon';
          g.coordinates = polys.map(pl => [simplifyRing(pl[0], eps)]);
        }
        out = geo.features;
      }
    }
  } catch (e) { /* 网络失败 → null */ }
  geoCache.set(adcode, out);
  return out;
}

/* 高德 WebService 关键字搜索（city 限定，精确到行政区边界） */
function placeTextCityJSONP(keyword, adcode, page) {
  return new Promise(resolve => {
    const cb = '__pd_ws' + (++wsSeq);
    const script = document.createElement('script');
    const done = pois => { delete window[cb]; script.remove(); resolve(pois || []); };
    window[cb] = d => done(d && d.status === '1' && d.pois ? d.pois : []);
    script.onerror = () => done([]);
    setTimeout(() => done([]), 15000);
    script.src = 'https://restapi.amap.com/v3/place/text?keywords=' + encodeURIComponent(keyword) +
      '&city=' + adcode + '&citylimit=true&offset=25&page=' + (page || 1) + '&key=' + AMAP_WS_KEY + '&callback=' + cb;
    document.head.appendChild(script);
  });
}

/* ---------------- 村镇层：高德 POI 检索（真实乡镇/街道位置） ----------------
 * DataV 无乡镇边界，改用高德 PlaceSearch 检索 街道办事处 / 镇(乡)人民政府，
 * 以真实中心点作为村镇级区域（点区域，按最近中心归属）。
 */
const poiCache = new Map();       // 区县 adcode → poiRegions | null

function cleanTownName(name) {
  const n = String(name);
  /* 仅接受真实乡镇/街道办事机构，剔除居委会、村委会、委员会等噪音 */
  if (!/(街道办事处|镇人民政府|乡人民政府)/.test(n)) return null;
  /* 剥离"××人民政府""××区/市"等行政前缀后提取 街道/镇/乡 名称 */
  const t = n.replace(/^[^街道镇乡]*?人民政府/, '').replace(/^[一-龥]+?[市区县](?=[一-龥]{2,6}(街道|镇|乡))/, '');
  const m = t.match(/([一-龥]{2,8}?(?:街道|镇|乡))/) || n.match(/([一-龥]{2,8}?(?:街道|镇|乡))/);
  if (!m) return null;
  return m[1].replace(/^[一-龥]{1,4}(?:市|区|县)/, '');   // 二次剥离"××区"前缀
}

function ringRadius(region) {
  if (!region.rings || !region.rings.length) return 15000;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of region.rings[0]) {
    if (c[0] < minLng) minLng = c[0];
    if (c[0] > maxLng) maxLng = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
  }
  const km = Math.hypot((maxLng - minLng) * 91, (maxLat - minLat) * 111) / 2;
  return Math.min(30000, Math.max(6000, km * 1000 * 1.2));
}

/* 高德 WebService 周边搜索（JSONP，无需安全密钥） */
const AMAP_WS_KEY = '651f5554ee92d8a57b8bccc7d19da8cf';
let wsSeq = 0;

function placeAroundJSONP(keyword, center, radius, page) {
  return new Promise(resolve => {
    const cb = '__pd_ws' + (++wsSeq);
    const script = document.createElement('script');
    const done = pois => { delete window[cb]; script.remove(); resolve(pois || []); };
    window[cb] = d => done(d && d.status === '1' && d.pois ? d.pois : []);
    script.onerror = () => done([]);
    setTimeout(() => done([]), 15000);
    const loc = center[0].toFixed(6) + ',' + center[1].toFixed(6);
    script.src = 'https://restapi.amap.com/v3/place/around?location=' + loc +
      '&radius=' + Math.round(radius) + '&offset=25&page=' + (page || 1) +
      '&keywords=' + encodeURIComponent(keyword) + '&key=' + AMAP_WS_KEY + '&callback=' + cb;
    document.head.appendChild(script);
  });
}

async function fetchTownPOIs(districtRegion) {
  if (poiCache.has(districtRegion.id)) return poiCache.get(districtRegion.id);
  let out = null;
  const center = districtRegion.centroid;
  const radius = ringRadius(districtRegion);
  try {
    /* 高德免费 Key QPS 限流：串行 + 空结果重试 */
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const groups = [];
    const kws = [['街道办事处', 1], ['镇人民政府', 1], ['乡人民政府', 1]];
    for (const [kw, page] of kws) {
      let list = await placeAroundJSONP(kw, center, radius, page);
      if (!list.length) { await sleep(500); list = await placeAroundJSONP(kw, center, radius, page); }
      groups.push(list);
      await sleep(220);
    }
    const seen = new Set();
    const pois = [];
    for (const list of groups) {
      for (const poi of list) {
        const name = cleanTownName(poi.name);
        if (!name || seen.has(name)) continue;
        const parts = String(poi.location || '').split(',');
        const lng = Number(parts[0]), lat = Number(parts[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        seen.add(name);
        pois.push({ id: 'POI' + poi.id, name, loc: [lng, lat] });
      }
    }
    /* 仅保留位于该区县内的（按点包含判定，避免邻近区县串扰） */
    const inside = pois.filter(t => {
      if (!districtRegion.rings) return true;
      return districtRegion.rings.some(ring => PD.pointInRing(t.loc[0], t.loc[1], ring));
    });
    const list = (inside.length >= 3 ? inside : pois).slice(0, 40);
    if (list.length >= 3) {
      out = list.map(t => ({
        id: t.id, name: t.name, level: 'street', pop: null,
        rings: null, poly: null,                        // 点区域：无边界
        centroid: t.loc,
        pointOnly: true,
      }));
    }
  } catch (e) { /* 保持 null */ }
  poiCache.set(districtRegion.id, out);
  return out;
}

/* ---------------- 下钻控制器 ---------------- */
function createRegionController(ctx) {
  /* ctx: {engine, data, refresh, ui, mapView, toast} */
  const rootRegions = PD.DISTRICTS.slice();          // 全国 34 省级（启动时快照）
  const stack = [{ name: '全国', regions: rootRegions }];
  let loading = false;

  function cur() { return stack[stack.length - 1]; }

  function pathNames() { return stack.map(s => s.name); }

  function renderHead() {
    const crumbs = document.getElementById('crumbs');
    const up = document.getElementById('btn-up');
    const hint = document.getElementById('level-hint');
    if (crumbs) crumbs.innerHTML = pathNames().map(n => `<span class="crumb">${n}</span>`).join('<span class="crumb-sep">›</span>');
    if (up) up.classList.toggle('hidden', stack.length === 1);
    const lv = cur().regions[0] && cur().regions[0].level;
    const lvName = { province: '省级行政区', city: '地级市', district: '区县', street: '乡镇/街道' }[lv] || '区域';
    if (hint) hint.textContent = `${lvName} · 点击区域下钻${lv === 'street' ? '（已是最细层级）' : ''}`;
  }

  /* 真实场所：按下级区域逐个精确检索高德 POI（不合成任何数据）
   * 区县/市级（有 adcode）：place/text + city 限定；街道级（点区域）：中心小半径周边搜索。
   * 分批并发加载，完成即注入（页面无需等待）。 */
  /* 全类型真实场所：核心类先行（居住/医疗/市场），扩展类随后（商业/交通/餐饮/教育/休闲/办公） */
  const CHILD_KWS_CORE = [['小区', '居住'], ['医院', '医院'], ['农贸市场', '市场']];
  const CHILD_KWS_EXT = [
    ['购物中心', '商场'], ['地铁站', '交通'], ['餐厅', '餐饮'],
    ['学校', '学校'], ['公园', '户外'], ['写字楼', '办公'],
  ];
  const MAX_PAGE = 3;      // 每类目最多翻 3 页（75 处）
  const childPlaceDone = new Set();      // 已完成场所加载的层级签名
  let placeEpoch = 0;                    // 层级切换代号：下钻/上钻后旧任务自动中止

  const placeSeen = new Map();            // 区域 id → Set(名称@坐标)，跨类目去重

  function injectPlace(region, name, type, loc) {
    const seen = placeSeen.get(region.id) || new Set();
    const key = name + '@' + loc[0].toFixed(4) + ',' + loc[1].toFixed(4);
    if (seen.has(key)) return null;
    seen.add(key);
    placeSeen.set(region.id, seen);
    const pl = { id: PD.PLACES.length, name, type, d: region.id, districtId: region.id, district: region.name, loc, poi: true };
    PD.PLACES.push(pl);
    (PD.PLACES_BY_D[region.id] = PD.PLACES_BY_D[region.id] || []).push(pl);
    return pl;
  }

  async function ensureRealPlaces(regions, parentRegion) {
    const sig = regions.map(r => r.id).join(',').slice(0, 200);
    if (childPlaceDone.has(sig)) return;
    childPlaceDone.add(sig);
    const myEpoch = ++placeEpoch;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* 行政区划边界过滤：街道级（点区域）POI 须落在被下钻区县的边界内 */
    const inParent = loc => {
      if (!parentRegion || !parentRegion.rings) return true;
      return parentRegion.rings.some(ring => PD.pointInRing(loc[0], loc[1], ring));
    };

    let loaded = 0;
    /* 高德免费 Key QPS 限流：串行 + 间隔 + 空结果重试 + 自适应翻页 */
    const runTask = async t => {
      const fetchPage = page => t.region.pointOnly
        ? placeAroundJSONP(t.kw, t.region.centroid, 2600, page)
        : placeTextCityJSONP(t.kw, t.region.id, page);
      for (let page = 1; page <= MAX_PAGE; page++) {
        if (myEpoch !== placeEpoch) return;
        let pois = await fetchPage(page);
        if (!pois.length && page === 1) {
          await sleep(600); pois = await fetchPage(page);            // 限流重试
          if (!pois.length) { await sleep(1000); pois = await fetchPage(page); }
        }
        for (const poi of pois) {
          const parts = String(poi.location || '').split(',');
          const lng = Number(parts[0]), lat = Number(parts[1]);
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
          const loc = [lng, lat];
          if (!inParent(loc)) continue;                              // 边界过滤
          if (injectPlace(t.region, poi.name, t.type, loc)) loaded++;
        }
        if (pois.length < 25) break;                                 // 未满页：无更多
        await sleep(260);
      }
    };

    /* 两轮：核心类先全部就位，再补扩展类 */
    for (const pass of [CHILD_KWS_CORE, CHILD_KWS_EXT]) {
      for (const region of regions.slice(0, 24)) {
        for (const [kw, type] of pass) {
          if (myEpoch !== placeEpoch) return;                        // 已切换层级：中止
          try {
            await runTask({ region, kw, type });
            await sleep(260);
          } catch (e) { /* 单任务失败跳过 */ }
        }
      }
    }
    if (loaded) ctx.toast(`已加载真实场所 ${loaded} 处（行政区划边界内 · 高德 POI）`, 'info');
  }

  /* 病例按居住坐标归入当前层级区域 */
  function reassign() {
    const regions = cur().regions;
    for (const p of ctx.data.patients) {
      const r = PD.regionOfPoint(p.homeLoc[0], p.homeLoc[1], regions);
      p.districtId = r.id;
      p.district = r.name;
    }
  }

  function apply(fit = true) {
    placeEpoch++;                           // 任何层级切换都中止进行中的场所加载
    PD.setRegions(cur().regions);
    reassign();
    ctx.engine.invalidate();
    ctx.refresh();
    ctx.ui.updateRegionSelects();
    renderHead();
    if (fit) ctx.mapView.fitRegions();
  }

  async function drill(region) {
    if (loading) return;
    if (region.level === 'street') { ctx.toast('已是最细层级（乡镇/街道）', 'info'); return; }
    loading = true;
    ctx.toast(`正在加载 ${region.name} 下级行政区划…`, 'info');

    /* 优先 DataV 边界（省 → 市 / 直辖市 → 区县；市 → 区县） */
    let regions = null;
    const features = await fetchChildFeatures(region.id);
    if (features && features.length) {
      regions = PD.buildRegionsFromFeatures(features);
    }

    /* 区县级：无公开乡镇边界 → 高德 POI 检索真实乡镇/街道中心点 */
    if ((!regions || !regions.length) && region.level === 'district') {
      ctx.toast(`正在检索 ${region.name} 乡镇/街道…`, 'info');
      const towns = await fetchTownPOIs(region);
      if (towns && towns.length) regions = towns;
    }

    loading = false;
    if (!regions || !regions.length) { ctx.toast(`${region.name} 暂无更细划分（或网络不可用）`, 'warn'); return; }
    stack.push({ name: region.name, regions });
    apply();
    /* 异步加载各下级区域的全类型真实场所（行政区划边界内 · 高德 POI） */
    ensureRealPlaces(regions, region).catch(() => {});
  }

  function up() {
    if (stack.length <= 1) return;
    stack.pop();
    apply();
  }

  function init() {
    const upBtn = document.getElementById('btn-up');
    if (upBtn) upBtn.addEventListener('click', up);
    renderHead();
  }

  /* 查询某区域的下级区域（不切换层级，供矩阵聚焦下钻使用）：
   * 省/市 → DataV 边界；区县 → 村镇 POI；街道 → 无 */
  async function childrenOf(region) {
    if (!region || region.pointOnly || region.level === 'street') return null;
    const features = await fetchChildFeatures(region.id);
    if (features && features.length) {
      const regions = PD.buildRegionsFromFeatures(features);
      if (regions.length) return regions;
    }
    if (region.level === 'district') {
      const towns = await fetchTownPOIs(region);
      if (towns && towns.length) return towns;
    }
    return null;
  }

  return { init, drill, up, current: cur, pathNames, childrenOf };
}

root.createRegionController = createRegionController;
})(typeof window !== 'undefined' ? window : globalThis);
