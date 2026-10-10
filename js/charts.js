/* =========================================================================
 * charts.js —— ECharts 图表：严重程度 / 趋势 / 区域分布 / 风险矩阵
 * ========================================================================= */
(function (root) {
'use strict';

const AXIS = { axisLine: { lineStyle: { color: '#2a3a5e' } }, axisLabel: { color: '#8294b3', fontSize: 11 }, splitLine: { lineStyle: { color: '#17203a' } } };
const LVL_NAMES = ['无', '低', '中', '较高', '高', '极高'];

function initCharts() {
  const sevChart = echarts.init(document.getElementById('chart-sev'), null, { renderer: 'canvas' });
  const trendChart = echarts.init(document.getElementById('chart-trend'));
  const distChart = echarts.init(document.getElementById('chart-district'));
  const riskChart = echarts.init(document.getElementById('chart-risk'));

  const base = {
    backgroundColor: 'transparent',
    textStyle: { color: '#8294b3', fontFamily: 'inherit' },
    grid: { left: 8, right: 16, top: 36, bottom: 4, containLabel: true },
    tooltip: { trigger: 'item', backgroundColor: '#16213a', borderColor: '#2a3a5e', textStyle: { color: '#dbe4f3', fontSize: 12 } },
  };

  function updateSev(mix) {
    sevChart.setOption({
      ...base,
      series: [{
        type: 'pie', radius: ['38%', '68%'], center: ['50%', '54%'],
        roseType: 'radius',
        itemStyle: { borderColor: '#111a2e', borderWidth: 2, borderRadius: 4 },
        label: { color: '#8294b3', fontSize: 11, formatter: '{b}\n{c} 例' },
        labelLine: { lineStyle: { color: '#2a3a5e' } },
        data: [
          { name: '疑似待排', value: mix['疑似'], itemStyle: { color: '#94a3b8' } },
          { name: '轻型', value: mix['轻型'], itemStyle: { color: PD.SEV['轻型'].color } },
          { name: '普通型', value: mix['普通型'], itemStyle: { color: PD.SEV['普通型'].color } },
          { name: '重型', value: mix['重型'], itemStyle: { color: PD.SEV['重型'].color } },
          { name: '危重型', value: mix['危重型'], itemStyle: { color: PD.SEV['危重型'].color } },
        ],
      }],
    });
  }

  function updateTrend(days) {
    trendChart.setOption({
      ...base,
      legend: { top: 4, textStyle: { color: '#8294b3', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      xAxis: { type: 'category', data: days.map(d => d.label), ...AXIS, splitLine: { show: false } },
      yAxis: { type: 'value', name: '新增发病', nameTextStyle: { color: '#8294b3' }, ...AXIS },
      series: PD.SEV_ORDER.map((sev, i) => ({
        name: sev, type: 'bar', stack: 'all', barMaxWidth: 22,
        itemStyle: { color: PD.SEV[sev].color, borderRadius: i === PD.SEV_ORDER.length - 1 ? [3, 3, 0, 0] : 0 },
        data: days.map(d => d.counts[sev]),
      })),
    }, true);
  }

  function updateDistrict(distStats) {
    const rows = Object.values(distStats).sort((a, b) => a.cum - b.cum);
    distChart.setOption({
      ...base,
      grid: { left: 8, right: 30, top: 30, bottom: 4, containLabel: true },
      legend: { top: 2, textStyle: { color: '#8294b3', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      xAxis: { type: 'value', ...AXIS },
      yAxis: { type: 'category', data: rows.map(r => r.district.name), ...AXIS, splitLine: { show: false } },
      series: PD.SEV_ORDER.map(sev => ({
        name: sev, type: 'bar', stack: 'all', barMaxWidth: 16,
        itemStyle: { color: PD.SEV[sev].color },
        data: rows.map(r => r.sev[sev]),
      })),
    }, true);
  }

  let lastMatrix = null;
  function updateRisk(state, dayOffset, visibleIds, overrideRows) {
    const dayTs = PD.dayStart(state.now) + dayOffset * PD.DAY;
    let rows;
    if (overrideRows && overrideRows.length) {
      rows = overrideRows;                        // 聚焦区域下钻一层（外部计算）
    } else {
      rows = state.risk.matrix(dayTs, state.now);
      if (visibleIds && visibleIds.length) {
        const vis = new Set(visibleIds);
        const filtered = rows.filter(r => vis.has(r.district.id));
        if (filtered.length) rows = filtered;    // 视野内无任何区域时回退全量
      }
    }
    lastMatrix = { rows, dayTs };
    const data = [];
    rows.forEach((r, yi) => r.cells.forEach((score, xi) => {
      data.push([xi, yi, score == null ? -1 : PD.levelOfScore(score)]);
    }));
    riskChart.setOption({
      ...base,
      tooltip: {
        ...base.tooltip,
        formatter: (p) => {
          const row = lastMatrix.rows[p.data[1]];
          const score = row.cells[p.data[0]];
          if (score == null) return `${row.district.name} · ${PD.slotLabel(p.data[0])}<br>未到该时段`;
          return `${row.district.name} · ${PD.slotLabel(p.data[0])}<br>` +
            `风险等级：<b>${LVL_NAMES[PD.levelOfScore(score)]}</b>　风险分：${score.toFixed(1)}`;
        },
      },
      grid: { left: 8, right: 90, top: 10, bottom: 46, containLabel: true },
      xAxis: { type: 'category', data: Array.from({ length: 12 }, (_, i) => PD.slotLabel(i)), ...AXIS, splitLine: { show: false }, axisLabel: { ...AXIS.axisLabel, interval: 0, rotate: 38 } },
      yAxis: { type: 'category', data: rows.map(r => r.district.name), ...AXIS, splitLine: { show: false } },
      visualMap: {
        type: 'piecewise', orient: 'vertical', right: 0, top: 'center',
        itemWidth: 14, itemHeight: 10, textStyle: { color: '#8294b3', fontSize: 11 },
        pieces: [
          { min: -1.5, max: -0.5, label: '未到时段', color: '#0d1526' },
          { min: -0.5, max: 0.5, label: '无暴露', color: '#1a2338' },
          ...PD.RISK_LEVELS.slice(1).map(l =>
            ({ min: l.lv - 0.5, max: l.lv + 0.5, label: l.name + '风险', color: l.color })),
        ],
      },
      series: [{
        type: 'heatmap',
        itemStyle: { borderColor: '#111a2e', borderWidth: 2, borderRadius: 3 },
        label: { show: true, fontSize: 10, color: '#e6edf8', formatter: p => p.data[2] < 0 ? '' : LVL_NAMES[p.data[2]] },
        data,
      }],
    }, true);
  }

  window.addEventListener('resize', () => {
    sevChart.resize(); trendChart.resize(); distChart.resize(); riskChart.resize();
  });

  return {
    update(state, matrixDay, visibleIds, overrideRows) {
      updateSev(state.sevMix);
      updateTrend(state.trend);
      updateDistrict(state.distStats);
      updateRisk(state, matrixDay, visibleIds, overrideRows);
    },
    resize() { sevChart.resize(); trendChart.resize(); distChart.resize(); riskChart.resize(); },
  };
}

root.initCharts = initCharts;
})(typeof window !== 'undefined' ? window : globalThis);
