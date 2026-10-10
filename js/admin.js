/* =========================================================================
 * admin.js —— 后台管理：实时病例登记 / 病例状态变更 / 操作日志
 * 手工操作通过 engine.injectEvent 进入实时播报，并按场景种子持久化到
 * localStorage（刷新后由 PD.replayAdminOps 重放）。
 * ========================================================================= */
(function (root) {
'use strict';

const $ = id => document.getElementById(id);

function sevTag(sev) { return `<span class="tag tag-sev${PD.SEV[sev].idx}">${sev}</span>`; }
function statusTag(st) {
  if (st === '疑似') return '<span class="tag tag-sus">疑似</span>';
  if (st === '确诊') return '<span class="tag tag-sev2">确诊</span>';
  if (st === '治愈') return '<span class="tag tag-cured">治愈</span>';
  if (st === '死亡') return '<span class="tag tag-dead">死亡</span>';
  return st;
}

function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function createAdmin(ctx) {
  /* ctx: {engine, data, refresh, toast, patientById, store} */
  const engine = ctx.engine;
  const store = ctx.store;

  /* ---------------- 开关 ---------------- */
  function open() {
    $('admin').classList.remove('hidden');
    fillDefaults();
    renderPatients();
    renderLog();
    renderStoreInfo();
  }

  function close() {
    $('admin').classList.add('hidden');
    ctx.refresh();
  }

  /* ---------------- 链式传染路径编辑（可多填，无上限） ---------------- */
  function addChainRow() {
    const row = document.createElement('div');
    row.className = 'chain-row';
    row.innerHTML = `
      <input type="datetime-local" class="chain-t" title="该环节时间（时间段起点）">
      <select class="chain-d" title="该时间段所在具体区域"></select>
      <input type="text" class="chain-note" placeholder="场所/备注（可选）">
      <button type="button" class="btn btn-xs chain-del" title="删除该环节">✕</button>`;
    const sel = row.querySelector('.chain-d');
    PD.DISTRICTS.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      sel.appendChild(o);
    });
    sel.value = $('reg-district').value || PD.DISTRICTS[0].id;
    $('chain-rows').appendChild(row);
    row.querySelector('.chain-t').focus();
  }

  function collectChain() {
    const rows = Array.from(document.querySelectorAll('#chain-rows .chain-row'));
    const links = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const tv = r.querySelector('.chain-t').value;
      const d = r.querySelector('.chain-d').value;
      const note = r.querySelector('.chain-note').value.trim();
      if (!tv && !note) continue;                            // 整行为空则忽略
      if (!tv) return { error: `第 ${i + 1} 个传染链环节缺少时间` };
      const t = new Date(tv).getTime();
      if (!Number.isFinite(t)) return { error: `第 ${i + 1} 个传染链环节时间无效` };
      if (t > engine.simNow) return { error: `第 ${i + 1} 个传染链环节时间晚于当前时间` };
      links.push({ t, districtId: d, note: note || null });
    }
    links.sort((a, b) => a.t - b.t);
    return { links };
  }

  /* ---------------- 登记 ---------------- */
  function nextManualId() {
    const n = ctx.data.patients.filter(p => p.manual).length + 1;
    return 'P-M' + String(n).padStart(3, '0');
  }

  function fillDefaults() {
    $('reg-id').value = nextManualId();
    if (!$('reg-onset').value) $('reg-onset').value = toLocalInput(engine.simNow - 6 * PD.HOUR);
  }

  function onSubmit(e) {
    e.preventDefault();
    const age = parseInt($('reg-age').value, 10);
    const onset = new Date($('reg-onset').value).getTime();
    if (!Number.isFinite(age) || age < 1 || age > 120) { ctx.toast('登记失败：年龄需在 1–120 之间', 'warn'); return; }
    if (!Number.isFinite(onset)) { ctx.toast('登记失败：请填写发病时间', 'warn'); return; }
    if (onset > engine.simNow) { ctx.toast('登记失败：发病时间晚于当前时间', 'warn'); return; }

    const chain = collectChain();
    if (chain.error) { ctx.toast('登记失败：' + chain.error, 'warn'); return; }

    const input = {
      id: nextManualId(),
      gender: $('reg-gender').value,
      age,
      districtId: $('reg-district').value,
      onset,
      status: $('reg-status').value,
      sev: $('reg-sev').value,
      cluster: $('reg-cluster').value.trim() || null,
      source: $('reg-source').value.trim().toUpperCase() || null,
      note: $('reg-note').value.trim() || null,
      withTrajectory: $('reg-traj').checked,
      chainPath: chain.links,
    };
    if (input.source && !ctx.patientById(input.source)) {
      ctx.toast(`登记失败：传染源 ${input.source} 不存在`, 'warn');
      return;
    }

    const p = PD.createManualPatient(input, engine.simNow);
    ctx.data.patients.push(p);

    store.ops.push({
      type: 'create', t: p.report, pid: p.id,
      patient: { ...p, hospital: { name: p.hospital.name } },   // 序列化：医院仅存名，重放时重链
    });
    store.save();

    engine.injectEvent({ t: p.report, kind: 'report', pid: p.id });
    if (p.confirm != null) engine.injectEvent({ t: p.confirm, kind: 'confirm', pid: p.id });
    engine.invalidate();
    ctx.refresh();
    renderPatients();
    renderLog();
    renderStoreInfo();

    /* 重置可变字段，保留区域选择便于连续登记 */
    $('reg-age').value = 42;
    $('reg-onset').value = '';
    $('reg-cluster').value = ''; $('reg-source').value = ''; $('reg-note').value = '';
    $('chain-rows').innerHTML = '';
    fillDefaults();
    ctx.toast(`已登记并上报 ${p.id}（${p.gender} ${p.age}岁 · ${p.district} · ${input.status}${chain.links.length ? ' · 传染链 ' + chain.links.length + ' 环节' : ''}）`);
  }

  /* ---------------- 状态变更 ---------------- */
  function applyChange(pid, act, value) {
    const p = ctx.patientById(pid);
    if (!p) return;
    const t = engine.simNow;

    if (act === 'sev') {
      const from = PD.sevAt(p, t);
      if (from === value) return;
      p.sevEvs = p.sevEvs.filter(e => e.t <= t);      // 手工评估覆盖之后排定的自动演变
      p.sevEvs.push({ t, sev: value });
      PD.stripFutureEvents(ctx.data.events, pid, t, ['sev']);
      store.ops.push({ type: 'sev', t, pid, value });
      engine.injectEvent({ t, kind: 'sev', pid, from, to: value });
    } else if (act === 'confirm') {
      if (p.confirm != null && p.confirm <= t) { ctx.toast(`${pid} 已是确诊`, 'warn'); return; }
      p.confirm = t;
      PD.stripFutureEvents(ctx.data.events, pid, t, ['confirm']);
      store.ops.push({ type: 'confirm', t, pid });
      engine.injectEvent({ t, kind: 'confirm', pid });
    } else if (act === 'cure') {
      /* 结局判断须比较时间：模拟病例可能已排定"未来"的治愈/死亡 */
      if (p.outcome && p.outcome.t <= t) { ctx.toast(`${pid} 已有结局（${p.outcome.type}）`, 'warn'); return; }
      p.outcome = { t, type: '治愈' };
      PD.stripFutureEvents(ctx.data.events, pid, t, ['sev', 'confirm', 'cured', 'dead']);
      store.ops.push({ type: 'cure', t, pid });
      engine.injectEvent({ t, kind: 'cured', pid });
    } else if (act === 'dead') {
      if (p.outcome && p.outcome.t <= t) { ctx.toast(`${pid} 已有结局（${p.outcome.type}）`, 'warn'); return; }
      p.outcome = { t, type: '死亡' };
      PD.stripFutureEvents(ctx.data.events, pid, t, ['sev', 'confirm', 'cured', 'dead']);
      store.ops.push({ type: 'dead', t, pid });
      engine.injectEvent({ t, kind: 'dead', pid });
    } else return;

    store.save();
    engine.invalidate();
    ctx.refresh();
    renderPatients();
    renderLog();
  }

  /* ---------------- 列表 ---------------- */
  function renderPatients() {
    const q = $('admin-search').value.trim().toUpperCase();
    const now = engine.simNow;
    const rows = ctx.data.patients
      .filter(p => PD.isReported(p, now))
      .filter(p => !q || p.id.includes(q) || p.district.toUpperCase().includes(q) || (p.cluster || '').toUpperCase().includes(q))
      .sort((a, b) => b.report - a.report)
      .slice(0, 120);

    $('admin-find-count').textContent = `${rows.length} 例已报告${rows.length >= 120 ? '（仅显示最近 120 例）' : ''}`;
    $('admin-tbody').innerHTML = rows.map(p => {
      const st = PD.statusAt(p, now);
      const sev = PD.sevAt(p, now);
      const locked = st === '治愈' || st === '死亡';
      return `<tr>
        <td><b>${p.id}</b>${p.manual ? ' <span class="tag tag-risk1">手报</span>' : ''}</td>
        <td>${p.district}</td>
        <td>${p.gender} / ${p.age}岁</td>
        <td>${PD.fmtDT(p.onset)}</td>
        <td>${st === '疑似' ? '<span class="tag tag-sus">待分级</span>' : sevTag(sev)}</td>
        <td>${statusTag(st)}</td>
        <td class="acts">
          <select class="sev-sel" data-pid="${p.id}" ${st !== '确诊' ? 'disabled' : ''} title="变更严重程度">
            ${PD.SEV_ORDER.map(s => `<option ${s === sev ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <button class="btn btn-xs" data-act="confirm" data-pid="${p.id}" ${st !== '疑似' ? 'disabled' : ''}>确诊</button>
          <button class="btn btn-xs" data-act="cure" data-pid="${p.id}" ${locked ? 'disabled' : ''}>治愈</button>
          <button class="btn btn-xs btn-danger" data-act="dead" data-pid="${p.id}" ${locked ? 'disabled' : ''}>死亡</button>
        </td>
      </tr>`;
    }).join('');
  }

  /* ---------------- 日志 ---------------- */
  function opText(op) {
    const p = op.patient || ctx.patientById(op.pid) || {};
    const who = `${op.pid}（${p.gender || '?'} ${p.age ?? '?'}岁 · ${p.district || '?'}）`;
    switch (op.type) {
      case 'create':  return `登记上报 ${who} · ${p.sevEvs && p.sevEvs[0] ? p.sevEvs[0].sev : ''} · ${op.patient.confirm != null ? '直接确诊' : '疑似'}${op.patient.chainPath && op.patient.chainPath.length ? ' · 传染链 ' + op.patient.chainPath.length + ' 环节' : ''}`;
      case 'sev':     return `病情变更 ${op.pid} → ${op.value}`;
      case 'confirm': return `确认确诊 ${op.pid}`;
      case 'cure':    return `治愈出院 ${op.pid}`;
      case 'dead':    return `死亡登记 ${op.pid}`;
      default:        return op.type;
    }
  }

  function renderLog() {
    const items = store.ops.slice(-60).reverse().map(op =>
      `<div class="oplog-item"><span class="feed-time">${PD.fmtDT(op.t)}</span>　${opText(op)}</div>`).join('');
    $('admin-log').innerHTML = items || '<div class="hint" style="padding:6px 2px">暂无操作</div>';
  }

  function renderStoreInfo() {
    $('admin-store-info').textContent = `本场景已记录 ${store.ops.length} 条操作`;
  }

  /* ---------------- 绑定 ---------------- */
  function init() {
    $('btn-admin').addEventListener('click', open);
    $('admin-close').addEventListener('click', close);
    $('admin-clear').addEventListener('click', () => {
      if (!confirm('确定清除本场景的全部手工登记与变更记录吗？页面将刷新，手工数据将被移除。')) return;
      store.clear();
      location.reload();
    });
    $('reg-form').addEventListener('submit', onSubmit);
    $('chain-add').addEventListener('click', addChainRow);
    $('chain-rows').addEventListener('click', e => {
      const b = e.target.closest('.chain-del');
      if (b) b.closest('.chain-row').remove();
    });
    $('admin-search').addEventListener('input', renderPatients);
    $('admin-tbody').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (b && !b.disabled) applyChange(b.dataset.pid, b.dataset.act);
    });
    $('admin-tbody').addEventListener('change', e => {
      const s = e.target.closest('select.sev-sel');
      if (s) applyChange(s.dataset.pid, 'sev', s.value);
    });
  }

  return { init, open, close };
}

root.createAdmin = createAdmin;
})(typeof window !== 'undefined' ? window : globalThis);
