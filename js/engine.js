/* =========================================================================
 * engine.js —— 时间引擎
 * 时间基准与现实保持一致：simNow 始终取现实当前时间，随现实推进；
 * 病例事件（仅来源于后台人工操作）按现实时刻揭示。
 * ========================================================================= */
(function (root) {
'use strict';

class Engine {
  /**
   * @param data  PD.generate() 的返回值 {patients, events, START, END}
   */
  constructor(data) {
    this.data = data;
    this.patients = data.patients;
    this.events = data.events;
    this.simNow = Date.now();          // 与现实时间保持一致
    this._ptr = 0;                      // 事件流指针
    this._listeners = { event: [], tick: [] };
    this._cache = null;                 // 聚合缓存
  }

  on(type, fn) { this._listeners[type].push(fn); }

  /* 快进到当前时刻：静默揭示全部历史事件（返回它们供初始化播报） */
  prime() {
    const hist = [];
    while (this._ptr < this.events.length && this.events[this._ptr].t <= this.simNow) {
      hist.push(this.events[this._ptr++]);
    }
    return hist;
  }

  /* 与现实时间严格同步（而非累积推进，避免节流/休眠造成漂移） */
  tick() {
    this.simNow = Date.now();
    while (this._ptr < this.events.length && this.events[this._ptr].t <= this.simNow) {
      const ev = this.events[this._ptr++];
      this._listeners.event.forEach(fn => fn(ev));
    }
    this._cache = null;
    this._listeners.tick.forEach(fn => fn(this.simNow));
  }

  /* 手工注入事件（后台登记/状态变更）：立即分发给监听者，不进入预生成事件流 */
  injectEvent(ev) { this._listeners.event.forEach(fn => fn(ev)); }
  /* 手工修改病例数据后使聚合缓存失效 */
  invalidate() { this._cache = null; }

  /* —— 以下为按当前模拟时刻计算的派生数据（每秒刷新一次即可） —— */
  state() {
    const now = this.simNow;
    if (!this._cache || this._cache.now !== now) {
      /* 风险模型采用"模拟全景视角"：基于全部病例轨迹（含尚未报告者），
       * 用于展示各区域各时段的客观疫情风险；而监测统计（KPI/表格/病例点）仅含已报告病例。 */
      const risk = new PD.RiskIndex(this.patients);
      const reported = PD.reportedList(this.patients, now);
      this._cache = {
        now,
        reported,
        risk,
        kpis: PD.computeKpis(this.patients, now, risk),
        sevMix: PD.severityMix(this.patients, now),
        distStats: PD.districtStats(this.patients, now),
        trend: PD.trendByDay(this.patients, now, 14),
      };
    }
    return this._cache;
  }
}

root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
