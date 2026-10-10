/* =========================================================================
 * data.js —— 区域模型（全国 34 个省级行政区真实边界 + 各省真实地标）/ 手工登记病例 / 区域×时段暴露风险模型
 * 省级行政区划边界来自阿里云 DataV.GeoAtlas（vendor/china-provinces.js，本地化简化）。
 * ========================================================================= */
(function (root) {
'use strict';

const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const SLOT_MS = 2 * HOUR;

/* ---------------- 随机数（确定性） ---------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function makeRng(seed) {
  const r = mulberry32(seed >>> 0);
  return {
    f: r,
    int: (a, b) => a + Math.floor(r() * (b - a + 1)),
    pick: arr => arr[Math.floor(r() * arr.length)],
    norm: (m, s) => {
      let u = 0, v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    chance: p => r() < p,
    shuffle: arr => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    weighted: (items, wfn) => {
      const ws = items.map(wfn);
      const s = ws.reduce((x, y) => x + y, 0);
      let x = r() * s;
      for (let i = 0; i < items.length; i++) { x -= ws[i]; if (x <= 0) return items[i]; }
      return items[items.length - 1];
    }
  };
}

/* ---------------- 时间工具 ---------------- */
const pad = n => String(n).padStart(2, '0');
function fmtDT(t) { const d = new Date(t); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtD(t)  { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtT(t)  { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function hourOfDay(t) { return new Date(t).getHours(); }
function slotIdxOf(t) { const d = new Date(t); return Math.floor(d.getHours() / 2); }
function slotStartOf(t) { const d = new Date(t); d.setHours(Math.floor(d.getHours() / 2) * 2, 0, 0, 0); return d.getTime(); }
function slotLabel(i) { return `${pad(i * 2)}-${pad(i * 2 + 2)}时`; }

/* ---------------- 城市模型：上海市 16 个区（真实行政区划边界） ----------------
 * 边界来自阿里云 DataV.GeoAtlas，经简化后本地化于 vendor/shanghai-districts.js
 */
const CN_POP = { 110000: 2189, 120000: 1387, 130000: 7461, 140000: 3492, 150000: 2400, 210000: 4259, 220000: 2407, 230000: 3185, 310000: 2487, 320000: 8475, 330000: 6456, 340000: 6103, 350000: 4154, 360000: 4518, 370000: 10153, 410000: 9937, 420000: 5775, 430000: 6644, 440000: 12601, 450000: 5013, 460000: 1008, 500000: 3205, 510000: 8367, 520000: 3856, 530000: 4721, 540000: 365, 610000: 3953, 620000: 2502, 630000: 592, 640000: 720, 650000: 2585, 710000: 2360, 810000: 748, 820000: 68 };  // 常住人口（万，七普约数，仅展示用）

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
}

/* 由 GeoJSON 要素构建区域：保留全部外环（含岛屿），坐标保持 [lng,lat]（高德序） */
function buildRegionsFromFeatures(features, level) {
  return features.filter(f => f.properties && f.properties.name).map(f => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const rings = polys.map(pl => pl[0]);                 // 各多边形外环
    let largest = rings[0], bestA = -1;
    for (const r of rings) { const a = ringArea(r); if (a > bestA) { bestA = a; largest = r; } }
    const n = largest.length;
    return {
      id: String(f.properties.adcode),
      name: f.properties.name,
      level: f.properties.level || level || 'province',   // 优先 DataV 自带层级（city/district/street）
      pop: CN_POP[f.properties.adcode] || null,
      rings,
      poly: largest,                                     // 最大环（兼容旧引用）
      centroid: [largest.reduce((s, c) => s + c[0], 0) / n, largest.reduce((s, c) => s + c[1], 0) / n],
    };
  });
}

const DISTRICTS = buildRegionsFromFeatures(
  (typeof window !== 'undefined' && window.CHINA_GEO) ? window.CHINA_GEO.features : [], 'province');
const DIST_BY_ID = {}; DISTRICTS.forEach(d => { DIST_BY_ID[d.id] = d; });

/* 动态切换当前层级区域集合（行政区划下钻用），并保持 DIST_BY_ID 同步 */
function setRegions(regions) {
  DISTRICTS.length = 0;
  regions.forEach(r => DISTRICTS.push(r));
  Object.keys(DIST_BY_ID).forEach(k => delete DIST_BY_ID[k]);
  DISTRICTS.forEach(d => { DIST_BY_ID[d.id] = d; });
}

/* 射线法：点是否在环内（坐标 [lng,lat]） */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function regionOfPoint(lng, lat, regions) {
  for (const r of regions) {
    if (!r.rings) continue;                    // 点区域（村镇层）走最近中心回退
    for (const ring of r.rings) if (pointInRing(lng, lat, ring)) return r;
  }
  /* 不在任何环内（边界误差/海域）：回退最近区域中心 */
  let best = regions[0], bd = Infinity;
  for (const r of regions) {
    const d = (r.centroid[0] - lng) ** 2 + (r.centroid[1] - lat) ** 2;
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

/* ---------------- 场所模型：上海真实地标（同属上海市域，大致坐标） ---------------- */
const PLACES = [
  // 黄浦区
  { name: '外滩', type: '户外', d: '310101', loc: [121.4903, 31.2397] },
  { name: '南京东路步行街', type: '商场', d: '310101', loc: [121.4798, 31.2360] },
  { name: '豫园商城', type: '商场', d: '310101', loc: [121.4922, 31.2271] },
  { name: '人民广场', type: '户外', d: '310101', loc: [121.4737, 31.2304] },
  { name: '瑞金医院（总院）', type: '医院', d: '310101', loc: [121.4651, 31.2113] },
  { name: '上海第九人民医院', type: '医院', d: '310101', loc: [121.4830, 31.2120] },
  { name: '老西门社区', type: '居住', d: '310101', loc: [121.4860, 31.2180] },
  // 徐汇区
  { name: '徐家汇商圈', type: '商场', d: '310104', loc: [121.4380, 31.1946] },
  { name: '上海南站', type: '交通', d: '310104', loc: [121.4315, 31.1563] },
  { name: '中山医院', type: '医院', d: '310104', loc: [121.4439, 31.2086] },
  { name: '徐汇滨江（西岸）', type: '户外', d: '310104', loc: [121.4570, 31.1830] },
  { name: '田林社区', type: '居住', d: '310104', loc: [121.4110, 31.1830] },
  // 长宁区
  { name: '中山公园商圈', type: '商场', d: '310105', loc: [121.4146, 31.2205] },
  { name: '古北新区', type: '居住', d: '310105', loc: [121.3900, 31.1970] },
  { name: '虹桥开发区', type: '办公', d: '310105', loc: [121.4010, 31.2060] },
  // 静安区
  { name: '静安寺商圈', type: '商场', d: '310106', loc: [121.4451, 31.2249] },
  { name: '上海火车站', type: '交通', d: '310106', loc: [121.4560, 31.2494] },
  { name: '华山医院', type: '医院', d: '310106', loc: [121.4410, 31.2190] },
  { name: '大宁国际商业广场', type: '商场', d: '310106', loc: [121.4590, 31.2660] },
  { name: '大宁社区', type: '居住', d: '310106', loc: [121.4630, 31.2680] },
  { name: '吴江路休闲街', type: '餐饮', d: '310106', loc: [121.4580, 31.2335] },
  // 普陀区
  { name: '长风公园', type: '户外', d: '310107', loc: [121.3950, 31.2220] },
  { name: '上海西站', type: '交通', d: '310107', loc: [121.4110, 31.2530] },
  { name: '中远两湾城', type: '居住', d: '310107', loc: [121.4600, 31.2440] },
  { name: '环球港', type: '商场', d: '310107', loc: [121.4200, 31.2380] },
  // 虹口区
  { name: '四川北路商圈', type: '商场', d: '310109', loc: [121.4800, 31.2510] },
  { name: '虹口足球场', type: '户外', d: '310109', loc: [121.4770, 31.2720] },
  { name: '上海市第一人民医院', type: '医院', d: '310109', loc: [121.4830, 31.2560] },
  { name: '曲阳社区', type: '居住', d: '310109', loc: [121.4930, 31.2760] },
  // 杨浦区
  { name: '五角场商圈', type: '商场', d: '310110', loc: [121.5140, 31.2970] },
  { name: '复旦大学邯郸校区', type: '学校', d: '310110', loc: [121.5030, 31.2980] },
  { name: '新华医院', type: '医院', d: '310110', loc: [121.5290, 31.2810] },
  { name: '长海医院', type: '医院', d: '310110', loc: [121.5260, 31.2970] },
  { name: '鞍山新村', type: '居住', d: '310110', loc: [121.5130, 31.2865] },
  { name: '杨浦滨江', type: '户外', d: '310110', loc: [121.4960, 31.2540] },
  // 闵行区
  { name: '莘庄枢纽', type: '交通', d: '310112', loc: [121.3860, 31.1130] },
  { name: '七宝老街', type: '餐饮', d: '310112', loc: [121.3560, 31.1470] },
  { name: '闵行区中心医院', type: '医院', d: '310112', loc: [121.3900, 31.1100] },
  { name: '龙柏社区', type: '居住', d: '310112', loc: [121.3650, 31.1880] },
  { name: '上海交通大学闵行校区', type: '学校', d: '310112', loc: [121.4360, 31.0350] },
  // 宝山区
  { name: '吴淞口国际邮轮港', type: '交通', d: '310113', loc: [121.4990, 31.3980] },
  { name: '江杨农产品批发市场', type: '市场', d: '310113', loc: [121.4660, 31.3950] },
  { name: '顾村公园', type: '户外', d: '310113', loc: [121.4150, 31.3430] },
  { name: '大华社区', type: '居住', d: '310113', loc: [121.4100, 31.2990] },
  // 嘉定区
  { name: '江桥批发市场', type: '市场', d: '310114', loc: [121.3400, 31.2530] },
  { name: '瑞金医院北院', type: '医院', d: '310114', loc: [121.2590, 31.3720] },
  { name: '嘉定新城社区', type: '居住', d: '310114', loc: [121.2620, 31.3500] },
  { name: '州桥老街', type: '户外', d: '310114', loc: [121.2650, 31.3760] },
  // 浦东新区
  { name: '陆家嘴金融区', type: '办公', d: '310115', loc: [121.4998, 31.2397] },
  { name: '浦东国际机场', type: '交通', d: '310115', loc: [121.8083, 31.1443] },
  { name: '上海迪士尼乐园', type: '户外', d: '310115', loc: [121.6570, 31.1434] },
  { name: '世纪公园', type: '户外', d: '310115', loc: [121.5510, 31.2190] },
  { name: '仁济医院东院', type: '医院', d: '310115', loc: [121.5280, 31.2197] },
  { name: '张江科学城', type: '办公', d: '310115', loc: [121.5860, 31.2040] },
  { name: '联洋社区', type: '居住', d: '310115', loc: [121.5450, 31.2200] },
  { name: '上海农产品中心批发市场', type: '市场', d: '310115', loc: [121.5300, 31.1600] },
  { name: '世博源', type: '商场', d: '310115', loc: [121.4890, 31.1810] },
  // 金山区
  { name: '复旦大学附属金山医院', type: '医院', d: '310116', loc: [121.3420, 30.7230] },
  { name: '金山卫社区', type: '居住', d: '310116', loc: [121.3380, 30.7290] },
  { name: '枫泾古镇', type: '户外', d: '310116', loc: [121.0170, 30.8940] },
  { name: '金山城市沙滩', type: '户外', d: '310116', loc: [121.3380, 30.7130] },
  // 松江区
  { name: '松江大学城', type: '学校', d: '310117', loc: [121.2180, 31.0350] },
  { name: '松江区中心医院', type: '医院', d: '310117', loc: [121.2220, 31.0160] },
  { name: '松江新城社区', type: '居住', d: '310117', loc: [121.2190, 31.0330] },
  { name: '泰晤士小镇', type: '户外', d: '310117', loc: [121.2120, 31.0260] },
  // 青浦区
  { name: '国家会展中心', type: '办公', d: '310118', loc: [121.3180, 31.1950] },
  { name: '朱家角古镇', type: '户外', d: '310118', loc: [121.0550, 31.1070] },
  { name: '中山医院青浦分院', type: '医院', d: '310118', loc: [121.1250, 31.1560] },
  { name: '青浦新城社区', type: '居住', d: '310118', loc: [121.1230, 31.1500] },
  // 奉贤区
  { name: '奉贤区中心医院', type: '医院', d: '310120', loc: [121.4720, 30.9230] },
  { name: '南桥社区', type: '居住', d: '310120', loc: [121.4780, 30.9180] },
  { name: '碧海金沙', type: '户外', d: '310120', loc: [121.6550, 30.8410] },
  { name: '百联南桥购物中心', type: '商场', d: '310120', loc: [121.4740, 30.9160] },
  // 崇明区
  { name: '崇明区中心医院', type: '医院', d: '310151', loc: [121.4100, 31.6250] },
  { name: '崇明新城社区', type: '居住', d: '310151', loc: [121.3970, 31.6220] },
  { name: '东滩湿地', type: '户外', d: '310151', loc: [121.9700, 31.5200] },
  // ===== 各省级行政区（省会/首府真实地标，大致坐标） =====
  // 北京市
  { name: '北京站', type: '交通', d: '110000', loc: [116.4270, 39.9023] },
  { name: '北京协和医院', type: '医院', d: '110000', loc: [116.4170, 39.9127] },
  { name: '王府井步行街', type: '商场', d: '110000', loc: [116.4109, 39.9097] },
  { name: '新发地农产品批发市场', type: '市场', d: '110000', loc: [116.3400, 39.8130] },
  { name: '望京社区', type: '居住', d: '110000', loc: [116.4740, 39.9960] },
  // 天津市
  { name: '天津站', type: '交通', d: '120000', loc: [117.2110, 39.1460] },
  { name: '天津医科大学总医院', type: '医院', d: '120000', loc: [117.1900, 39.1270] },
  { name: '南市食品街', type: '餐饮', d: '120000', loc: [117.1790, 39.1430] },
  { name: '华苑社区', type: '居住', d: '120000', loc: [117.1510, 39.0830] },
  // 河北省
  { name: '石家庄站', type: '交通', d: '130000', loc: [114.4680, 38.0220] },
  { name: '河北医科大学第二医院', type: '医院', d: '130000', loc: [114.4690, 38.0450] },
  { name: '南三条批发市场', type: '市场', d: '130000', loc: [114.4900, 38.0410] },
  { name: '长安社区', type: '居住', d: '130000', loc: [114.5100, 38.0340] },
  // 山西省
  { name: '太原南站', type: '交通', d: '140000', loc: [112.5640, 37.7900] },
  { name: '山西医科大学第一医院', type: '医院', d: '140000', loc: [112.5290, 37.8530] },
  { name: '柳巷商圈', type: '商场', d: '140000', loc: [112.5620, 37.8720] },
  { name: '平阳社区', type: '居住', d: '140000', loc: [112.5520, 37.8360] },
  // 内蒙古自治区
  { name: '呼和浩特东站', type: '交通', d: '150000', loc: [111.8010, 40.8510] },
  { name: '内蒙古医科大学附属医院', type: '医院', d: '150000', loc: [111.6520, 40.8420] },
  { name: '维多利商圈', type: '商场', d: '150000', loc: [111.7500, 40.8420] },
  { name: '赛罕社区', type: '居住', d: '150000', loc: [111.7100, 40.8100] },
  // 辽宁省
  { name: '沈阳北站', type: '交通', d: '210000', loc: [123.4300, 41.8260] },
  { name: '中国医科大学附属第一医院', type: '医院', d: '210000', loc: [123.4270, 41.7930] },
  { name: '中街商圈', type: '商场', d: '210000', loc: [123.4550, 41.7960] },
  { name: '铁西社区', type: '居住', d: '210000', loc: [123.3600, 41.7750] },
  // 吉林省
  { name: '长春站', type: '交通', d: '220000', loc: [125.3270, 43.8620] },
  { name: '吉林大学第一医院', type: '医院', d: '220000', loc: [125.3170, 43.8250] },
  { name: '重庆路商圈', type: '商场', d: '220000', loc: [125.3570, 43.8660] },
  { name: '朝阳社区', type: '居住', d: '220000', loc: [125.3400, 43.8520] },
  // 黑龙江省
  { name: '哈尔滨站', type: '交通', d: '230000', loc: [126.6290, 45.7740] },
  { name: '哈尔滨医科大学附属第一医院', type: '医院', d: '230000', loc: [126.6250, 45.7420] },
  { name: '中央大街', type: '商场', d: '230000', loc: [126.6170, 45.7780] },
  { name: '道里社区', type: '居住', d: '230000', loc: [126.6340, 45.7830] },
  // 江苏省
  { name: '南京南站', type: '交通', d: '320000', loc: [118.7970, 31.9680] },
  { name: '江苏省人民医院', type: '医院', d: '320000', loc: [118.7700, 32.0620] },
  { name: '新街口商圈', type: '商场', d: '320000', loc: [118.7810, 32.0430] },
  { name: '仙林社区', type: '居住', d: '320000', loc: [118.9140, 32.1040] },
  // 浙江省
  { name: '杭州东站', type: '交通', d: '330000', loc: [120.2130, 30.2900] },
  { name: '浙江大学医学院附属第一医院', type: '医院', d: '330000', loc: [120.1830, 30.2660] },
  { name: '湖滨步行街', type: '商场', d: '330000', loc: [120.1630, 30.2490] },
  { name: '滨江社区', type: '居住', d: '330000', loc: [120.2110, 30.2080] },
  // 安徽省
  { name: '合肥南站', type: '交通', d: '340000', loc: [117.3230, 31.7640] },
  { name: '安徽医科大学第一附属医院', type: '医院', d: '340000', loc: [117.2690, 31.8500] },
  { name: '淮河路步行街', type: '商场', d: '340000', loc: [117.2830, 31.8200] },
  { name: '瑶海社区', type: '居住', d: '340000', loc: [117.3160, 31.8610] },
  // 福建省
  { name: '福州站', type: '交通', d: '350000', loc: [119.3150, 26.0840] },
  { name: '福建医科大学附属协和医院', type: '医院', d: '350000', loc: [119.3000, 26.0890] },
  { name: '三坊七巷', type: '商场', d: '350000', loc: [119.2930, 26.0870] },
  { name: '仓山社区', type: '居住', d: '350000', loc: [119.3100, 26.0460] },
  // 江西省
  { name: '南昌站', type: '交通', d: '360000', loc: [115.8940, 28.6720] },
  { name: '南昌大学第一附属医院', type: '医院', d: '360000', loc: [115.8900, 28.6830] },
  { name: '万寿宫历史文化街区', type: '商场', d: '360000', loc: [115.8790, 28.6780] },
  { name: '红谷滩社区', type: '居住', d: '360000', loc: [115.8310, 28.6880] },
  // 山东省
  { name: '济南站', type: '交通', d: '370000', loc: [117.0010, 36.7260] },
  { name: '山东大学齐鲁医院', type: '医院', d: '370000', loc: [117.0260, 36.6660] },
  { name: '泉城路商圈', type: '商场', d: '370000', loc: [117.0210, 36.6670] },
  { name: '历下社区', type: '居住', d: '370000', loc: [117.0600, 36.6640] },
  // 河南省
  { name: '郑州东站', type: '交通', d: '410000', loc: [113.7740, 34.7470] },
  { name: '郑州大学第一附属医院', type: '医院', d: '410000', loc: [113.6770, 34.7600] },
  { name: '二七商圈', type: '商场', d: '410000', loc: [113.6700, 34.7520] },
  { name: '金水社区', type: '居住', d: '410000', loc: [113.6700, 34.8000] },
  // 湖北省
  { name: '武汉站', type: '交通', d: '420000', loc: [114.3200, 30.6050] },
  { name: '华中科技大学同济医学院附属同济医院', type: '医院', d: '420000', loc: [114.2660, 30.5780] },
  { name: '江汉路步行街', type: '商场', d: '420000', loc: [114.2880, 30.5810] },
  { name: '光谷社区', type: '居住', d: '420000', loc: [114.4000, 30.5060] },
  // 湖南省
  { name: '长沙南站', type: '交通', d: '430000', loc: [113.0700, 28.1450] },
  { name: '中南大学湘雅医院', type: '医院', d: '430000', loc: [112.9860, 28.2220] },
  { name: '五一广场', type: '商场', d: '430000', loc: [112.9810, 28.2280] },
  { name: '芙蓉社区', type: '居住', d: '430000', loc: [113.0300, 28.2000] },
  // 广东省
  { name: '广州南站', type: '交通', d: '440000', loc: [113.2660, 22.9890] },
  { name: '中山大学附属第一医院', type: '医院', d: '440000', loc: [113.2850, 23.1360] },
  { name: '北京路步行街', type: '商场', d: '440000', loc: [113.2680, 23.1270] },
  { name: '猎德社区', type: '居住', d: '440000', loc: [113.3320, 23.1180] },
  // 广西壮族自治区
  { name: '南宁东站', type: '交通', d: '450000', loc: [108.3970, 22.8260] },
  { name: '广西医科大学第一附属医院', type: '医院', d: '450000', loc: [108.3200, 22.8160] },
  { name: '中山路美食街', type: '餐饮', d: '450000', loc: [108.3200, 22.8100] },
  { name: '青秀社区', type: '居住', d: '450000', loc: [108.3660, 22.7860] },
  // 海南省
  { name: '海口东站', type: '交通', d: '460000', loc: [110.3180, 19.9200] },
  { name: '海南省人民医院', type: '医院', d: '460000', loc: [110.3420, 20.0310] },
  { name: '骑楼老街', type: '商场', d: '460000', loc: [110.3360, 20.0320] },
  { name: '龙华社区', type: '居住', d: '460000', loc: [110.3200, 20.0300] },
  // 重庆市
  { name: '重庆北站', type: '交通', d: '500000', loc: [106.5530, 29.5820] },
  { name: '陆军军医大学西南医院', type: '医院', d: '500000', loc: [106.4660, 29.5230] },
  { name: '解放碑步行街', type: '商场', d: '500000', loc: [106.5780, 29.5580] },
  { name: '江北社区', type: '居住', d: '500000', loc: [106.5710, 29.5810] },
  // 四川省
  { name: '成都东站', type: '交通', d: '510000', loc: [104.1410, 30.6300] },
  { name: '四川大学华西医院', type: '医院', d: '510000', loc: [104.0450, 30.6380] },
  { name: '春熙路', type: '商场', d: '510000', loc: [104.0810, 30.6600] },
  { name: '武侯社区', type: '居住', d: '510000', loc: [104.0430, 30.6300] },
  // 贵州省
  { name: '贵阳北站', type: '交通', d: '520000', loc: [106.6280, 26.7930] },
  { name: '贵州医科大学附属医院', type: '医院', d: '520000', loc: [106.6800, 26.8520] },
  { name: '大十字商圈', type: '商场', d: '520000', loc: [106.7170, 26.8660] },
  { name: '南明社区', type: '居住', d: '520000', loc: [106.7200, 26.8380] },
  // 云南省
  { name: '昆明站', type: '交通', d: '530000', loc: [102.7190, 25.0150] },
  { name: '昆明医科大学第一附属医院', type: '医院', d: '530000', loc: [102.6830, 25.0500] },
  { name: '南屏步行街', type: '商场', d: '530000', loc: [102.7160, 25.0360] },
  { name: '五华社区', type: '居住', d: '530000', loc: [102.7020, 25.0560] },
  // 西藏自治区
  { name: '拉萨站', type: '交通', d: '540000', loc: [91.1130, 29.6360] },
  { name: '西藏自治区人民医院', type: '医院', d: '540000', loc: [91.1420, 29.6520] },
  { name: '八廓街', type: '商场', d: '540000', loc: [91.1390, 29.6540] },
  { name: '城关社区', type: '居住', d: '540000', loc: [91.1300, 29.6480] },
  // 陕西省
  { name: '西安北站', type: '交通', d: '610000', loc: [108.9360, 34.3720] },
  { name: '西安交通大学第一附属医院', type: '医院', d: '610000', loc: [108.9440, 34.2270] },
  { name: '回民街', type: '餐饮', d: '610000', loc: [108.9410, 34.2650] },
  { name: '雁塔社区', type: '居住', d: '610000', loc: [108.9480, 34.2220] },
  // 甘肃省
  { name: '兰州站', type: '交通', d: '620000', loc: [103.8380, 36.0410] },
  { name: '兰州大学第一医院', type: '医院', d: '620000', loc: [103.8390, 36.0570] },
  { name: '张掖路步行街', type: '商场', d: '620000', loc: [103.8260, 36.0620] },
  { name: '城关社区', type: '居住', d: '620000', loc: [103.8500, 36.0520] },
  // 青海省
  { name: '西宁站', type: '交通', d: '630000', loc: [101.8050, 36.6300] },
  { name: '青海省人民医院', type: '医院', d: '630000', loc: [101.7630, 36.6270] },
  { name: '水井巷', type: '商场', d: '630000', loc: [101.7820, 36.6220] },
  { name: '城中社区', type: '居住', d: '630000', loc: [101.7700, 36.6250] },
  // 宁夏回族自治区
  { name: '银川站', type: '交通', d: '640000', loc: [106.2290, 38.4870] },
  { name: '宁夏医科大学总医院', type: '医院', d: '640000', loc: [106.2780, 38.4690] },
  { name: '鼓楼步行街', type: '商场', d: '640000', loc: [106.2740, 38.4720] },
  { name: '金凤社区', type: '居住', d: '640000', loc: [106.2330, 38.4740] },
  // 新疆维吾尔自治区
  { name: '乌鲁木齐站', type: '交通', d: '650000', loc: [87.5490, 43.8290] },
  { name: '新疆医科大学第一附属医院', type: '医院', d: '650000', loc: [87.6010, 43.7970] },
  { name: '大巴扎步行街', type: '商场', d: '650000', loc: [87.6170, 43.7960] },
  { name: '沙依巴克社区', type: '居住', d: '650000', loc: [87.5700, 43.7900] },
  // 台湾省
  { name: '台北车站', type: '交通', d: '710000', loc: [121.5170, 25.0470] },
  { name: '台大医院', type: '医院', d: '710000', loc: [121.5150, 25.0420] },
  { name: '西门町', type: '商场', d: '710000', loc: [121.5080, 25.0420] },
  { name: '大安社区', type: '居住', d: '710000', loc: [121.5430, 25.0330] },
  // 香港特别行政区
  { name: '香港西九龙站', type: '交通', d: '810000', loc: [114.1590, 22.3030] },
  { name: '玛丽医院', type: '医院', d: '810000', loc: [114.1320, 22.2700] },
  { name: '中环商圈', type: '商场', d: '810000', loc: [114.1580, 22.2820] },
  { name: '太子社区', type: '居住', d: '810000', loc: [114.1690, 22.3230] },
  // 澳门特别行政区
  { name: '关闸广场', type: '交通', d: '820000', loc: [113.5480, 22.2160] },
  { name: '镜湖医院', type: '医院', d: '820000', loc: [113.5440, 22.1900] },
  { name: '议事亭前地', type: '商场', d: '820000', loc: [113.5390, 22.1930] },
  { name: '黑沙环社区', type: '居住', d: '820000', loc: [113.5490, 22.2100] },
];
const SH_DIST_NAMES = { 310101: '黄浦区', 310104: '徐汇区', 310105: '长宁区', 310106: '静安区', 310107: '普陀区', 310109: '虹口区', 310110: '杨浦区', 310112: '闵行区', 310113: '宝山区', 310114: '嘉定区', 310115: '浦东新区', 310116: '金山区', 310117: '松江区', 310118: '青浦区', 310120: '奉贤区', 310151: '崇明区' };
PLACES.forEach((p, i) => {
  p.id = i;
  const d = DIST_BY_ID[p.d];
  p.district = d ? d.name : (SH_DIST_NAMES[p.d] || p.d);   // 上海市场所按真实区县绑定（下钻后精确到区县）
  p.districtId = p.d;
});

const PLACES_BY_D = {};
DISTRICTS.forEach(d => { PLACES_BY_D[d.id] = PLACES.filter(p => p.districtId === d.id); });

/* 场所人群密度系数 & 停留时长（小时） */
const CROWD = { '居住': 0.6, '市场': 1.6, '交通': 1.8, '商场': 1.4, '医院': 1.2, '户外': 0.7, '餐饮': 1.5, '学校': 1.7, '办公': 1.1 };
const DUR_RANGE = { '市场': [0.5, 1.5], '交通': [0.3, 0.8], '商场': [0.7, 2.2], '医院': [1, 2.5], '户外': [0.8, 2.0], '餐饮': [0.7, 1.8], '学校': [3, 6], '办公': [4, 9], '居住': [0.7, 1.5] };

/* ---------------- 严重程度 ---------------- */
const SEV = {
  '轻型':   { idx: 1, w: 1.0, color: '#4ade80' },
  '普通型': { idx: 2, w: 2.0, color: '#facc15' },
  '重型':   { idx: 3, w: 3.2, color: '#fb923c' },
  '危重型': { idx: 4, w: 4.5, color: '#f87171' },
};
const SEV_ORDER = ['轻型', '普通型', '重型', '危重型'];

/* ---------------- 风险等级 ---------------- */
/* 风险分 = Σ（场所人群密度系数 × 传染性系数 × 停留时长）按 2 小时时段归集 */
const RISK_THRESH = [2.5, 6, 11, 18];
const RISK_LEVELS = [
  { lv: 0, name: '无',  color: '#233043' },
  { lv: 1, name: '低',  color: '#15803d' },
  { lv: 2, name: '中',  color: '#ca8a04' },
  { lv: 3, name: '较高', color: '#ea580c' },
  { lv: 4, name: '高',  color: '#dc2626' },
  { lv: 5, name: '极高', color: '#991b1b' },
];
function levelOfScore(s) {
  if (s <= 0.01) return 0;
  if (s <= RISK_THRESH[0]) return 1;
  if (s <= RISK_THRESH[1]) return 2;
  if (s <= RISK_THRESH[2]) return 3;
  if (s <= RISK_THRESH[3]) return 4;
  return 5;
}

/* =========================================================================
 * 模拟数据生成（仅城市静态模型；病例数据一律由后台手动登记）
 * ========================================================================= */
function generate(seed, now) {
  const T0 = dayStart(now);
  const START = T0 - 14 * DAY;
  const END = T0 + 7 * DAY;
  /* 病人病例只能由后台手动输入：系统不自动生成任何病例（含历史疫情）；
   * 已登记病例持久化于 localStorage，启动时经 replayAdminOps 重放。 */
  const patients = [];

  const events = [];
  return { patients, events, START, END, T0 };
}

/* ---------------- 模块级工具：收治医院 / 轨迹构建 ---------------- */
function nearestHospital(loc) {
  let best = null, bd = Infinity;
  for (const pl of PLACES) {
    if (pl.type !== '医院') continue;
    const d = (pl.loc[0] - loc[0]) ** 2 + (pl.loc[1] - loc[1]) ** 2;
    if (d < bd) { bd = d; best = pl; }
  }
  return best;
}

function stopOf(pl) {
  return { name: pl.name, type: pl.type, loc: pl.loc, districtId: pl.districtId, district: pl.district };
}

function buildStops(rng, p) {
  const stops = [];
  const home = { name: p.homeName || (p.homePlaceId != null ? PLACES[p.homePlaceId].name : p.district), type: '居住', loc: p.homeLoc, districtId: p.districtId, district: p.district };
  let t = p.onset - rng.int(10, 26) * HOUR;
  let visitedHosp = false, last = null;

  while (t < p.report - 20 * MIN) {
    const h = hourOfDay(t);
    let place, durMs;
    if (h >= 22 || h < 6) {                       /* 夜间在家 */
      place = home;
      const toMorning = (7 - h + 24) % 24;
      durMs = Math.max(0.8, toMorning + (rng.f() - 0.5)) * HOUR;
    } else if (t > p.report - 9 * HOUR && !visitedHosp && rng.chance(0.55)) {
      place = stopOf(p.hospital);                  /* 报告前就诊 */
      visitedHosp = true;
      durMs = rng.int(60, 150) * MIN;
    } else {
      let pl = null;
      for (let tries = 0; tries < 4; tries++) {
        pl = rng.weighted(PLACES, x => {
          let w = x.districtId === p.districtId ? 12 : 0.01;   // 全国尺度：轨迹高度集中于所在区域（省/市/区县/街镇）
          if (x.type === '居住') w *= (x.id === p.homePlaceId ? 0.5 : 0.25);
          if (x.type === '医院') w *= 0.15;
          return w;
        });
        if (!(last && last.type === '居住' && pl.type === '居住')) break;
      }
      place = stopOf(pl);
      const range = DUR_RANGE[pl.type] || [0.5, 1.5];
      durMs = (range[0] + rng.f() * (range[1] - range[0])) * HOUR;
      if (pl.type === '居住') durMs = rng.int(40, 100) * MIN;
    }
    durMs = Math.min(durMs, p.report - t);
    if (durMs < 15 * MIN) break;
    stops.push({ t, tEnd: t + durMs, name: place.name, type: place.type, loc: place.loc, districtId: place.districtId, district: place.district });
    last = place;
    t = t + durMs + rng.int(6, 26) * MIN;
  }
  if (stops.length < 3) { stops.unshift({ t: t - 6 * HOUR, tEnd: t, ...home }); }
  /* 末站：报告收治医院 */
  stops.push({
    t: p.report, tEnd: p.report + 4 * HOUR,
    name: p.hospital.name, type: '医院', loc: p.hospital.loc,
    districtId: p.hospital.districtId, district: p.hospital.district,
    isReport: true
  });
  return stops;
}

/* ---------------- 手工登记病例（后台入口） ----------------
 * 结构与生成病例完全一致；轨迹默认自动生成（也可最简化为 居家→收治）。
 */
function createManualPatient(input, now) {
  const rng = makeRng((Math.random() * 2 ** 31) >>> 0);
  const district = DIST_BY_ID[input.districtId] || DISTRICTS[0];
  /* 居住锚点 = 该区域真实住宅小区 POI；若无（POI 未覆盖），以区域中心（真实地理点）兜底 */
  const homes = (PLACES_BY_D[district.id] || []).filter(x => x.type === '居住');
  const homePlace = homes.length ? rng.pick(homes) : null;
  const jitter = { street: 0.0012, district: 0.003, city: 0.012, province: 0.04 }[district.level] || 0.003;
  const anchor = homePlace ? homePlace.loc : district.centroid;
  const homeLoc = [anchor[0] + (rng.f() - .5) * 2 * jitter, anchor[1] + (rng.f() - .5) * 2 * jitter];
  const p = {
    id: input.id, gender: input.gender, age: input.age,
    districtId: district.id, district: district.name,
    homePlaceId: homePlace ? homePlace.id : null,
    homeName: homePlace ? homePlace.name : district.name + '（区域中心）', homeLoc,
    onset: input.onset, report: now,
    confirm: input.status === '确诊' ? now : null,   /* null = 待确诊，由后台手动确认 */
    cluster: input.cluster || null, source: input.source || null,
    manual: true, note: input.note || '',
    hospital: nearestHospital(homeLoc),
    sevEvs: [{ t: input.onset, sev: input.sev }],
    outcome: null,
  };
  /* 链式传染路径：环节 = 时间 + 该时段所在具体区域（+可选备注），按时间升序 */
  p.chainPath = (input.chainPath || [])
    .map(l => {
      const d = DIST_BY_ID[l.districtId] || DISTRICTS[0];
      return { t: l.t, districtId: d.id, district: d.name, note: l.note || null };
    })
    .sort((a, b) => a.t - b.t);
  if (input.withTrajectory === false) {
    p.stops = [
      { t: Math.max(input.onset - 12 * HOUR, now - 14 * HOUR), tEnd: now - 20 * MIN, name: homePlace.name, type: '居住', loc: homeLoc, districtId: district.id, district: district.name },
      { t: now, tEnd: now + 4 * HOUR, name: p.hospital.name, type: '医院', loc: p.hospital.loc, districtId: p.hospital.districtId, district: p.hospital.district, isReport: true },
    ];
  } else {
    p.stops = buildStops(rng, p);
  }
  return p;
}

/* 就地移除某病例在 t 之后、指定类型的预生成事件（后台手工处置覆盖自动演变）。
 * 仅删除未消费的未来事件，不影响引擎事件流指针。 */
function stripFutureEvents(events, pid, t, kinds) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.pid === pid && ev.t > t && kinds.includes(ev.kind)) events.splice(i, 1);
  }
}

/* 重放后台操作（localStorage 持久化，按场景种子隔离），并把手报病例事件并入事件流 */
function replayAdminOps(data, ops) {
  for (const op of ops) {
    if (op.type === 'create' && op.patient) {
      const p = op.patient;
      const hosp = PLACES.find(x => x.name === (p.hospital && p.hospital.name));
      p.hospital = hosp || nearestHospital(p.homeLoc);
      p.manual = true;
      data.patients.push(p);
    } else if (op.pid) {
      const p = data.patients.find(x => x.id === op.pid);
      if (!p) continue;
      if (op.type === 'sev') {
        p.sevEvs = p.sevEvs.filter(e => e.t <= op.t);
        p.sevEvs.push({ t: op.t, sev: op.value });
        stripFutureEvents(data.events, op.pid, op.t, ['sev']);
      } else if (op.type === 'confirm') {
        p.confirm = op.t;
        stripFutureEvents(data.events, op.pid, op.t, ['confirm']);
      } else if (op.type === 'cure') {
        p.outcome = { t: op.t, type: '治愈' };
        stripFutureEvents(data.events, op.pid, op.t, ['sev', 'confirm', 'cured', 'dead']);
      } else if (op.type === 'dead') {
        p.outcome = { t: op.t, type: '死亡' };
        stripFutureEvents(data.events, op.pid, op.t, ['sev', 'confirm', 'cured', 'dead']);
      }
    }
  }
  for (const p of data.patients) {
    if (!p.manual) continue;
    data.events.push({ t: p.report, kind: 'report', pid: p.id });
    if (p.confirm != null) data.events.push({ t: p.confirm, kind: 'confirm', pid: p.id });
    for (let i = 1; i < p.sevEvs.length; i++) {
      data.events.push({ t: p.sevEvs[i].t, kind: 'sev', pid: p.id, from: p.sevEvs[i - 1].sev, to: p.sevEvs[i].sev });
    }
    if (p.outcome) data.events.push({ t: p.outcome.t, kind: p.outcome.type === '死亡' ? 'dead' : 'cured', pid: p.id });
  }
  data.events.sort((a, b) => a.t - b.t);
}

/* 链式传染路径展示文本：紧凑版（表格用，超长截断）与完整版（提示/搜索用） */
function chainText(p, max) {
  const links = p.chainPath || [];
  if (!links.length) return '';
  max = max || 2;
  const seg = l => `${fmtDT(l.t)}·${l.district}`;
  if (links.length <= max) return links.map(seg).join(' → ');
  return links.slice(0, max).map(seg).join(' → ') + ` → …（共 ${links.length} 环节）`;
}
function chainFullText(p) {
  const links = p.chainPath || [];
  return links.map(l => `${fmtDT(l.t)} ${l.district}${l.note ? '（' + l.note + '）' : ''}`).join(' → ');
}

/* =========================================================================
 * 病例状态查询
 * ========================================================================= */
function sevAt(p, t) {
  let s = '轻型';
  for (const e of p.sevEvs) { if (e.t <= t) s = e.sev; else break; }
  return s;
}
function statusAt(p, now) {
  if (now < p.report) return '未报告';
  if (p.outcome && now >= p.outcome.t) return p.outcome.type;   /* 结局优先：覆盖疑似/确诊 */
  if (p.confirm == null || now < p.confirm) return '疑似';      /* confirm=null：手报待确诊 */
  return '确诊';
}
const isReported = (p, now) => p.report <= now;
const isActive = (p, now) => { const s = statusAt(p, now); return s === '疑似' || s === '确诊'; };

/* =========================================================================
 * 风险指数：基于已报告病例轨迹的区域×2小时时段暴露风险
 * ========================================================================= */
class RiskIndex {
  constructor(patients) {
    this.map = new Map();
    this.patients = patients;
    for (const p of patients) {
      for (const s of p.stops) {
        if (s.isReport) continue;
        const tm = (s.t + s.tEnd) / 2;
        if (tm < p.onset - 12 * HOUR) continue;      // 发病前 12h 起视为有传染性
        const inf = tm < p.onset ? 0.35 : 1 + Math.min(2.2, (tm - p.onset) / (14 * HOUR));
        const w = (CROWD[s.type] || 1) * inf * Math.min((s.tEnd - s.t) / HOUR, 2.5);
        if (w <= 0) continue;
        s._w = w;
        let ss = slotStartOf(s.t);
        for (; ss < s.tEnd; ss += SLOT_MS) {
          const ov = Math.min(s.tEnd, ss + SLOT_MS) - Math.max(s.t, ss);
          if (ov <= 0) continue;
          const k2 = s.districtId + '|' + fmtD(ss) + '|' + slotIdxOf(ss);
          this.map.set(k2, (this.map.get(k2) || 0) + w * (ov / (s.tEnd - s.t)));
        }
      }
    }
  }
  /* 某区域在某时刻所处 2h 时段的风险分 */
  score(districtId, t) {
    return this.map.get(districtId + '|' + fmtD(t) + '|' + slotIdxOf(t)) || 0;
  }
  level(districtId, t) { return levelOfScore(this.score(districtId, t)); }
  /* 某天的风险矩阵（slots 0..11）；now 之后（未到）的时段为 null */
  matrix(dayTs, now) {
    const rows = [];
    for (const d of DISTRICTS) {
      const cells = [];
      for (let i = 0; i < 12; i++) {
        const st = dayTs + i * SLOT_MS;
        cells.push(st > now ? null : this.map.get(d.id + '|' + fmtD(st) + '|' + i) || 0);
      }
      rows.push({ district: d, cells });
    }
    return rows;
  }
  /* 近 window 时段内轨迹点 → 热力图层 */
  heatPoints(now, windowMs) {
    const pts = [];
    let mx = 0.001;
    for (const p of this.patients) {
      for (const s of p.stops) {
        if (s.isReport || s._w === undefined) continue;
        if (s.t > now || s.tEnd < now - windowMs) continue;
        pts.push([s.loc[0], s.loc[1], s._w]);
        if (s._w > mx) mx = s._w;
      }
    }
    return pts.map(x => [x[0], x[1], x[2] / mx]);
  }
}

/* 任意区域集合的区域×时段风险矩阵：按停留点真实位置（点包含/最近中心）
 * 归集到各区域计算，与 RiskIndex 同一权重模型（用于聚焦区域下钻一层）。 */
function computeRegionRiskMatrix(patients, regions, dayTs, now) {
  const rows = regions.map(r => ({ district: r, cells: new Array(12).fill(0) }));
  for (const p of patients) {
    for (const s of p.stops) {
      if (s.isReport) continue;
      const tm = (s.t + s.tEnd) / 2;
      if (tm < p.onset - 12 * HOUR) continue;
      const inf = tm < p.onset ? 0.35 : 1 + Math.min(2.2, (tm - p.onset) / (14 * HOUR));
      const w = (CROWD[s.type] || 1) * inf * Math.min((s.tEnd - s.t) / HOUR, 2.5);
      if (w <= 0) continue;
      let idx = -1;
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        if (r.rings && r.rings.some(ring => pointInRing(s.loc[0], s.loc[1], ring))) { idx = i; break; }
      }
      if (idx < 0) {
        let bd = Infinity;
        regions.forEach((r, i) => {
          const d = (r.centroid[0] - s.loc[0]) ** 2 + (r.centroid[1] - s.loc[1]) ** 2;
          if (d < bd) { bd = d; idx = i; }
        });
      }
      const row = rows[idx];
      for (let ss = slotStartOf(s.t); ss < s.tEnd; ss += SLOT_MS) {
        if (ss < dayTs || ss >= dayTs + DAY) continue;
        const ov = Math.min(s.tEnd, ss + SLOT_MS) - Math.max(s.t, ss);
        if (ov > 0) row.cells[Math.floor((ss - dayTs) / SLOT_MS)] += w * (ov / (s.tEnd - s.t));
      }
    }
  }
  rows.forEach(row => {
    for (let i = 0; i < 12; i++) if (dayTs + i * SLOT_MS > now) row.cells[i] = null;
  });
  return rows;
}

/* ---------------- 聚合统计 ---------------- */
function reportedList(patients, now) { return patients.filter(p => isReported(p, now)); }
function activeList(patients, now) { return patients.filter(p => isReported(p, now) && isActive(p, now)); }

function computeKpis(patients, now, riskIdx) {
  const rep = reportedList(patients, now);
  let active = 0, suspect = 0, severe = 0, today = 0, cured = 0, dead = 0;
  const todayKey = fmtD(now);
  for (const p of rep) {
    const st = statusAt(p, now);
    if (st === '疑似') { suspect++; active++; }
    else if (st === '确诊') {
      active++;
      const sv = sevAt(p, now);
      if (sv === '重型' || sv === '危重型') severe++;
    } else if (st === '治愈') cured++;
    else if (st === '死亡') dead++;
    if (fmtD(p.report) === todayKey) today++;
  }
  let hotZones = 0;
  if (riskIdx) for (const d of DISTRICTS) { if (riskIdx.level(d.id, now) >= 4) hotZones++; }
  return { total: rep.length, active, suspect, severe, today, cured, dead, hotZones };
}

function severityMix(patients, now) {
  const mix = { '疑似': 0, '轻型': 0, '普通型': 0, '重型': 0, '危重型': 0 };
  for (const p of activeList(patients, now)) {
    const st = statusAt(p, now);
    if (st === '疑似') mix['疑似']++;
    else mix[sevAt(p, now)]++;
  }
  return mix;
}

function districtStats(patients, now) {
  const stats = {};
  for (const d of DISTRICTS) stats[d.id] = { district: d, cum: 0, active: 0, sev: { '轻型': 0, '普通型': 0, '重型': 0, '危重型': 0 } };
  for (const p of reportedList(patients, now)) {
    const st = stats[p.districtId];
    st.cum++;
    if (isActive(p, now)) {
      st.active++;
      const s = statusAt(p, now);
      if (s === '确诊') st.sev[sevAt(p, now)]++;
    }
  }
  return stats;
}

/* 近 n 天每日新增（按发病日期、按当前严重程度） */
function trendByDay(patients, now, n) {
  const days = [];
  const end = dayStart(now);
  for (let i = n - 1; i >= 0; i--) {
    const ds = end - i * DAY;
    days.push({ ts: ds, label: fmtDT(ds).slice(0, 5), counts: { '轻型': 0, '普通型': 0, '重型': 0, '危重型': 0 } });
  }
  const idx = {};
  days.forEach((d, i) => { idx[fmtD(d.ts)] = i; });
  for (const p of reportedList(patients, now)) {
    const i = idx[fmtD(p.onset)];
    if (i !== undefined) days[i].counts[sevAt(p, now)]++;
  }
  return days;
}

/* ---------------- 导出 ---------------- */
root.PD = {
  DAY, HOUR, MIN, SLOT_MS,
  SEV, SEV_ORDER, RISK_LEVELS, RISK_THRESH,
  CROWD, DISTRICTS, DIST_BY_ID, PLACES, PLACES_BY_D,
  generate, RiskIndex, createManualPatient, replayAdminOps, stripFutureEvents,
  chainText, chainFullText,
  setRegions, buildRegionsFromFeatures, regionOfPoint, pointInRing, computeRegionRiskMatrix,
  sevAt, statusAt, isReported, isActive, reportedList, activeList,
  computeKpis, severityMix, districtStats, trendByDay, levelOfScore,
  fmtDT, fmtD, fmtT, dayStart, slotIdxOf, slotLabel,
};
})(typeof window !== 'undefined' ? window : globalThis);
