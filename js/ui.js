/* =========================================================================
 * ui.js —— DOM 交互：KPI / 播报 / 病例表 / 轨迹抽屉 / Toast / 弹窗
 * ========================================================================= */
(function (root) {
'use strict';

const $ = id => document.getElementById(id);

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function sevTag(sev) {
  return `<span class="tag tag-sev${PD.SEV[sev].idx}">${sev}</span>`;
}
function statusTag(st) {
  if (st === '疑似') return `<span class="tag tag-sus">疑似</span>`;
  if (st === '确诊') return `<span class="tag tag-sev2">确诊</span>`;
  if (st === '治愈') return `<span class="tag tag-cured">治愈</span>`;
  if (st === '死亡') return `<span class="tag tag-dead">死亡</span>`;
  return st;
}
function riskTag(lv) {
  const l = PD.RISK_LEVELS[lv];
  return `<span class="tag tag-risk${lv}">${l.name}风险</span>`;
}

/* ========================================================================= */
function createUI(ctx) {
  /* ctx: {engine, mapView, charts, getSeed} */
  const engine = ctx.engine;
  let tableLimit = 30;
  let currentTrajPid = null;

  /* ---------------- 时钟 ---------------- */
  function updateClock(now) {
    const d = new Date(now);
    $('sim-date').textContent = `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日 · 周${'日一二三四五六'[d.getDay()]}`;
    $('sim-time').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  /* ---------------- KPI ---------------- */
  function updateKpis(k) {
    $('kpi-total').querySelector('.kpi-value').textContent = k.total;
    $('kpi-active').querySelector('.kpi-value').textContent = k.active;
    $('kpi-severe').querySelector('.kpi-value').textContent = k.severe;
    $('kpi-suspect').querySelector('.kpi-value').textContent = k.suspect;
    $('kpi-today').querySelector('.kpi-value').textContent = k.today;
    $('kpi-cured').querySelector('.kpi-value').textContent = k.cured;
    $('kpi-dead').querySelector('.kpi-value').textContent = k.dead;
    $('kpi-risk').querySelector('.kpi-value').textContent = k.hotZones;
  }

  /* ---------------- 实时播报 ---------------- */
  function feedText(ev) {
    const p = ctx.patientById(ev.pid);
    if (!p) return '';
    const who = `${p.id}（${p.gender} ${p.age}岁 · ${p.district}）`;
    switch (ev.kind) {
      case 'report': {
        const sev = PD.sevAt(p, ev.t);
        return `报告疑似病例 ${who}，初步病情 <b style="color:${PD.SEV[sev].color}">${sev}</b>`;
      }
      case 'confirm': {
        const sev = PD.sevAt(p, ev.t);
        return `确诊肺鼠疫 ${who}，当前病情 <b style="color:${PD.SEV[sev].color}">${sev}</b>`;
      }
      case 'sev': {
        const up = PD.SEV[ev.to].idx > PD.SEV[ev.from].idx;
        return `病情变化 ${who}：<b style="color:${PD.SEV[ev.from].color}">${ev.from}</b> → <b style="color:${PD.SEV[ev.to].color}">${ev.to}</b>${up ? '（转重）' : '（好转）'}`;
      }
      case 'cured': return `治愈出院 ${who}`;
      case 'dead': return `<b style="color:#f87171">死亡病例</b> ${who}`;
      default: return '';
    }
  }

  function pushFeed(evs, silent) {
    const box = $('feed');
    const frag = document.createDocumentFragment();
    for (const ev of evs) {
      const html = feedText(ev);
      if (!html) continue;
      const div = document.createElement('div');
      div.className = 'feed-item' + (ev.kind === 'dead' || (ev.kind === 'sev' && ev.to === '危重型') ? ' crit' : '');
      div.innerHTML = `<span class="feed-time">${PD.fmtDT(ev.t)}</span><span>${html}</span>`;
      frag.appendChild(div);
    }
    box.insertBefore(frag, box.firstChild);
    while (box.children.length > 80) box.removeChild(box.lastChild);
    updateFeedEmpty();
    if (!silent) {
      for (const ev of evs) {
        if (ev.kind === 'dead') toast(`死亡病例：${ev.pid}`, 'danger');
        else if (ev.kind === 'sev' && ev.to === '危重型') toast(`病情转危重：${ev.pid}`, 'danger');
        else if (ev.kind === 'sev' && ev.to === '重型') toast(`病情转重型：${ev.pid}`, 'warn');
      }
    }
  }

  /* 空态占位：无任何事件时提示数据入口 */
  function updateFeedEmpty() {
    const box = $('feed');
    const real = Array.from(box.children).filter(c => !c.classList.contains('feed-empty'));
    let ph = box.querySelector('.feed-empty');
    if (real.length === 0) {
      if (!ph) {
        ph = document.createElement('div');
        ph.className = 'feed-empty';
        ph.style.cssText = 'color:var(--muted);font-size:12.5px;padding:8px 4px;';
        ph.textContent = '暂无播报事件 —— 病人病例仅能经「后台登记」手动输入';
        box.appendChild(ph);
      }
    } else if (ph) ph.remove();
  }

  /* ---------------- Toast ---------------- */
  function toast(text, kind) {
    const box = $('toasts');
    const div = document.createElement('div');
    div.className = 'toast ' + (kind || 'info');
    div.textContent = text;
    box.appendChild(div);
    setTimeout(() => div.remove(), 6000);
    while (box.children.length > 4) box.removeChild(box.firstChild);
  }

  /* ---------------- 病例表 ---------------- */
  function updateTable(state) {
    const tbody = $('case-tbody');
    const q = $('flt-search').value.trim().toUpperCase();
    const fd = $('flt-district').value;
    const fs = $('flt-sev').value;
    const fst = $('flt-status').value;
    const now = state.now;
    const rows = [];
    for (const p of state.reported) {
      const st = PD.statusAt(p, now);
      const sev = PD.sevAt(p, now);
      if (fd && p.districtId !== fd) continue;
      if (fst && st !== '疑似' && st !== '治愈' && st !== '死亡' && sev !== fs) continue;
      if (fs && st === '疑似' && fs) continue;
      if (fst && st !== fst) continue;
      if (q && !(p.id.includes(q) || (p.cluster || '').toUpperCase().includes(q) || (PD.chainFullText(p) || '').toUpperCase().includes(q))) continue;
      rows.push(p);
    }
    rows.sort((a, b) => b.report - a.report);
    $('table-count').textContent = rows.length === 0
      ? '暂无病例 · 病人病例仅能经「后台登记」手动输入'
      : `共 ${rows.length} 例 · 点击行查看行动轨迹`;
    const shown = rows.slice(0, tableLimit);
    tbody.innerHTML = shown.map(p => {
      const st = PD.statusAt(p, now);
      const sev = PD.sevAt(p, now);
      const chainCell = (p.chainPath && p.chainPath.length)
        ? `<td title="${esc(PD.chainFullText(p))}"><span class="chain-mini">${esc(PD.chainText(p))}</span></td>`
        : `<td>${p.cluster ? esc(p.cluster) : '<span class="tl-meta">散发</span>'}</td>`;
      return `<tr data-pid="${p.id}" class="${p.id === currentTrajPid ? 'active' : ''}">
        <td><b>${p.id}</b>${p.source ? `<div class="tl-meta">← ${p.source}</div>` : ''}</td>
        <td>${p.gender} / ${p.age}岁</td>
        <td>${p.district}</td>
        <td>${st === '疑似' ? '<span class="tag tag-sus">待分级</span>' : sevTag(sev)}</td>
        <td>${statusTag(st)}</td>
        <td>${PD.fmtDT(p.onset)}</td>
        <td>${PD.fmtDT(p.report)}</td>
        ${chainCell}
        <td><button class="link-btn" data-traj="${p.id}">轨迹回放 ▶</button></td>
      </tr>`;
    }).join('');
    $('btn-more').classList.toggle('hidden', rows.length <= tableLimit);
  }

  /* ---------------- 轨迹抽屉 ---------------- */
  function openDrawer(p, riskIdx) {
    currentTrajPid = p.id;
    $('drawer').classList.remove('hidden');
    const now = engine.simNow;
    const st = PD.statusAt(p, now);
    const sev = PD.sevAt(p, now);
    const stopsHtml = p.stops.map((s, i) => {
      const lv = riskIdx.level(s.districtId, s.t);
      return `<div class="tl-item" data-i="${i}">
        <div class="tl-time">${PD.fmtDT(s.t)}<br>– ${PD.fmtT(s.tEnd)}</div>
        <div class="tl-dot"></div>
        <div class="tl-body">
          <div class="tl-place">${i + 1}. ${esc(s.name)}${s.isReport ? ' <span class="tag tag-sev4">报告收治</span>' : ''}</div>
          <div class="tl-meta">${s.district} · ${s.type} · 停留 ${Math.max(10, Math.round((s.tEnd - s.t) / PD.MIN))} 分钟</div>
          <div class="tl-risk">该时段该区域疫情风险：${riskTag(lv)}</div>
        </div>
      </div>`;
    }).join('');

    /* 链式传染路径清单：每环节 时间 + 该时段具体区域 + 该时段区域风险 */
    const chainHtml = (p.chainPath && p.chainPath.length) ? `
      <div class="chain-box">
        <div class="chain-box-title">链式传染路径 · 共 ${p.chainPath.length} 环节</div>
        <div class="chain-list">
          ${p.chainPath.map((l, i) => `
          <div class="chain-item">
            <span class="chain-idx">${i + 1}</span>
            <span class="chain-time">${PD.fmtDT(l.t)}</span>
            <span class="chain-district">${esc(l.district)}${l.note ? ' · ' + esc(l.note) : ''}</span>
            <span class="tl-risk">该时段风险：${riskTag(riskIdx.level(l.districtId, l.t))}</span>
          </div>${i < p.chainPath.length - 1 ? '<div class="chain-arrow">↓</div>' : ''}`).join('')}
        </div>
      </div>` : '';

    const chainSummary = (p.chainPath && p.chainPath.length)
      ? `共 ${p.chainPath.length} 环节链式传染路径${p.cluster ? ' · ' + esc(p.cluster) : ''}${p.source ? `（传染源 ${p.source}）` : ''}`
      : (p.cluster ? esc(p.cluster) + (p.source ? `（传染源 ${p.source}）` : '（首发病例）') : '散发病例');

    $('drawer-body').innerHTML = `
      <div class="pt-summary">
        <div><span class="k">编号：</span><b>${p.id}</b></div>
        <div><span class="k">性别 / 年龄：</span>${p.gender} / ${p.age} 岁</div>
        <div><span class="k">现住区域：</span>${p.district}</div>
        <div><span class="k">状态：</span>${statusTag(st)}${st !== '疑似' ? ' ' + sevTag(sev) : ''}</div>
        <div><span class="k">发病时间：</span>${PD.fmtDT(p.onset)}</div>
        <div><span class="k">报告时间：</span>${PD.fmtDT(p.report)}</div>
        <div><span class="k">收治医院：</span>${esc(p.hospital.name)}</div>
        <div><span class="k">传播链：</span>${chainSummary}</div>
      </div>
      ${chainHtml}
      <div class="traj-ctrl">
        <button id="traj-play" class="btn btn-sm">▶ 播放</button>
        <input type="range" id="traj-slider" min="0" max="${p.stops.length - 1}" step="0.01" value="0">
        <button id="traj-export" class="btn btn-sm" title="导出轨迹 JSON">导出</button>
      </div>
      <div class="traj-note">轨迹共 ${p.stops.length} 个停留点（含发病前后活动，末点为报告收治）。播放时地图同步回放，各停留点标注该时段所在区域的疫情风险等级。</div>
      <div class="tl" id="traj-tl">${stopsHtml}</div>`;

    $('traj-play').onclick = togglePlay;
    $('traj-slider').oninput = e => { ctx.mapView.seekTrajectory(parseFloat(e.target.value)); syncPlayBtn(false); };
    $('traj-export').onclick = () => exportTrajectory(p, riskIdx);
    document.querySelectorAll('.tl-item').forEach(el => {
      el.onclick = () => { ctx.mapView.seekTrajectory(parseInt(el.dataset.i, 10)); syncPlayBtn(false); };
    });
    syncPlayBtn(false);
  }

  function togglePlay() {
    const tr = ctx.mapView._traj;
    if (!tr) return;
    if (tr.playing) { ctx.mapView.pauseTrajectory(); syncPlayBtn(false); }
    else {
      if (tr.p >= tr.stops.length - 1) ctx.mapView.seekTrajectory(0);
      ctx.mapView.playTrajectory();
      syncPlayBtn(true);
    }
  }
  function syncPlayBtn(playing) {
    const btn = $('traj-play');
    if (btn) btn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
  }

  function onTrajProgress(i) {
    const tl = $('traj-tl');
    if (!tl) return;
    tl.querySelectorAll('.tl-item').forEach(el => el.classList.toggle('active', parseInt(el.dataset.i, 10) === i));
    const cur = tl.querySelector(`.tl-item[data-i="${i}"]`);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    const slider = $('traj-slider');
    if (slider && document.activeElement !== slider) slider.value = i;
  }

  function exportTrajectory(p, riskIdx) {
    const data = {
      病例编号: p.id, 性别: p.gender, 年龄: p.age, 现住区域: p.district,
      发病时间: new Date(p.onset).toISOString(), 报告时间: new Date(p.report).toISOString(),
      声明: '模拟数据，仅用于演示',
      行动轨迹: p.stops.map((s, i) => ({
        序号: i + 1, 时间: PD.fmtDT(s.t), 结束: PD.fmtT(s.tEnd), 场所: s.name,
        区域: s.district, 场所类型: s.type, 纬度: +s.loc[1].toFixed(5), 经度: +s.loc[0].toFixed(5),
        该时段该区域疫情风险: PD.RISK_LEVELS[riskIdx.level(s.districtId, s.t)].name,
        风险分: +riskIdx.score(s.districtId, s.t).toFixed(2),
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trajectory-${p.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${p.id} 轨迹数据`, 'info');
  }

  function closeDrawer() {
    currentTrajPid = null;
    $('drawer').classList.add('hidden');
    ctx.mapView.clearTrajectory();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('drawer-close').onclick = closeDrawer;

    $('case-tbody').addEventListener('click', e => {
      const btn = e.target.closest('[data-traj]');
      if (btn) { e.stopPropagation(); root.App.showTrajectory(btn.dataset.traj); return; }
      const tr = e.target.closest('tr[data-pid]');
      if (tr) root.App.showTrajectory(tr.dataset.pid);
    });

    ['flt-search', 'flt-district', 'flt-sev', 'flt-status'].forEach(id =>
      $(id).addEventListener('change', () => { tableLimit = 30; updateTable(ctx.lastState); }));
    $('flt-search').addEventListener('input', () => { tableLimit = 30; updateTable(ctx.lastState); });
    $('btn-more').onclick = () => { tableLimit += 30; updateTable(ctx.lastState); };

  }

  function init() {
    fillRegionSelect($('flt-district'));
    fillRegionSelect($('reg-district'));
    bind();
  }

  /* 填充区域下拉（当前行政层级；保留已选值若仍存在） */
  function fillRegionSelect(sel, keep) {
    if (!sel) return;
    const prev = keep ? sel.value : null;
    sel.innerHTML = '<option value="">全部区域</option>';
    PD.DISTRICTS.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      sel.appendChild(o);
    });
    if (prev && PD.DIST_BY_ID[prev]) sel.value = prev;
  }

  /* 行政区划层级切换后刷新全部区域选择（登记表/筛选/传染链草稿） */
  function updateRegionSelects() {
    fillRegionSelect($('flt-district'), true);
    fillRegionSelect($('reg-district'));
    const rows = document.getElementById('chain-rows');
    if (rows) rows.innerHTML = '';          // 传染链草稿的区域随层级变化，清空重填
    tableLimit = 30;
    if (ctx.lastState) updateTable(ctx.lastState);
  }

  return {
    init, updateClock, updateKpis, pushFeed, toast, updateTable, openDrawer, closeDrawer, onTrajProgress, updateRegionSelects,
    get currentPid() { return currentTrajPid; },
    syncPlayBtn,
  };
}

root.createUI = createUI;
})(typeof window !== 'undefined' ? window : globalThis);
