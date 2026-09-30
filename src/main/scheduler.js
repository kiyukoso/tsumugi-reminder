'use strict';

/**
 * 提醒调度。
 *
 * 刻意不用 setTimeout 去累加计时 —— 那样在系统休眠、或者用户改了系统时间
 * 之后会漂移，甚至整段漏掉。这里只跑一个 250ms 的心跳，每次都用壁钟
 * (Date.now()) 和目标时间直接比大小。电脑睡了两小时再醒来，下一拍立刻
 * 就能算出「早就该响了」，不会因为计时器被挂起而永久错过。
 *
 * 触发中（firing）是运行时状态，不进 data.json —— 应用重启后待办若仍在
 * 到点状态会自动重新触发一次，这正是提醒应用该有的行为。
 */

const TICK_MS = 250;

const UNIT_MS = { min: 60000, hour: 3600000, day: 86400000, week: 604800000 };

/**
 * 从 from 开始，按周期往后找到第一个**严格晚于** now 的时间点。
 *
 * 直接解出「第几格」而不是先加一格再追赶 —— 后者在目标时刻恰好等于
 * now 时会算出 0 格偏移，把函数原地返回一个已经过去的时间，导致周期
 * 待办的 dueAt 卡死不动、下一拍立刻又触发。
 *
 * 用除法一次算准，也不做 while 循环：否则「每 1 分钟重复」的待办在
 * 关机一周后重启，需要循环一百万次才能追上。
 */
function nextOccurrence(from, repeat, now) {
  const step = UNIT_MS[repeat.unit];
  if (!step) return null;
  const ms = repeat.every * step;
  const k = Math.max(1, Math.floor((now - from) / ms) + 1);
  return from + k * ms;
}

class Scheduler {
  /**
   * @param {object} store   store 模块
   * @param {(todo:object, kind:'due'|'repeat')=>void} onFire  该弹提醒了
   * @param {()=>void} onChanged  待办状态有变（完成/推进周期），通知界面刷新
   */
  constructor(store, onFire, onChanged) {
    this.store = store;
    this.onFire = onFire;
    this.onChanged = onChanged || (() => {});
    this.timer = null;
    this.runtime = new Map();   // id -> { firing, lastFireAt }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 系统休眠唤醒、或用户改了系统时间之后，立刻重新对表 */
  resync() {
    this.tick();
  }

  rt(id) {
    let r = this.runtime.get(id);
    if (!r) { r = { firing: false, lastFireAt: 0 }; this.runtime.set(id, r); }
    return r;
  }

  /** 待办被删掉时顺手清掉运行时状态，免得 Map 无限增长 */
  forget(id) { this.runtime.delete(id); }

  tick() {
    const now = Date.now();
    for (const t of this.store.get().todos) {
      if (!t.enabled || t.done || t.muted || !t.dueAt) continue;

      // 还没到点，或者到点了但这轮已经响过、且没配重复间隔
      if (now < t.dueAt) continue;

      const r = this.rt(t.id);

      if (!r.firing) {
        // 第一次到点
        r.firing = true;
        r.lastFireAt = now;
        this.onFire(t, 'due');
      } else if (t.intervalMin > 0 && now - r.lastFireAt >= t.intervalMin * 60000) {
        // 用户一直没处理，按「提醒间隔」再响一次
        r.lastFireAt = now;
        this.onFire(t, 'repeat');
      }
    }
  }

  /** 用户点了「完成」 */
  complete(id) {
    const t = this.store.get().todos.find(x => x.id === id);
    if (!t) return null;
    const r = this.rt(id);
    r.firing = false;
    r.lastFireAt = 0;

    if (t.repeat) {
      // 周期性待办：这次算完成，但整条继续活着，排下一次
      t.dueAt = nextOccurrence(t.dueAt || Date.now(), t.repeat, Date.now());
      t.done = false;
    } else {
      t.done = true;
      t.dueAt = null;
      t.enabled = false;
    }
    this.store.save();
    this.onChanged();
    return t;
  }

  /** 用户点了「停止」——本次不再自动重响，但待办本身还在 */
  dismiss(id) {
    const t = this.store.get().todos.find(x => x.id === id);
    if (!t) return null;
    const r = this.rt(id);
    r.firing = false;
    r.lastFireAt = 0;
    t.muted = true;

    if (t.repeat) {
      t.dueAt = nextOccurrence(t.dueAt || Date.now(), t.repeat, Date.now());
      t.muted = false;
    }
    this.store.save();
    this.onChanged();
    return t;
  }

  /** 用户点了「稍后提醒」，默认推迟 5 分钟 */
  snooze(id, minutes) {
    const t = this.store.get().todos.find(x => x.id === id);
    if (!t) return null;
    const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : this.store.get().snoozeMin;
    const r = this.rt(id);
    r.firing = false;
    r.lastFireAt = 0;
    t.muted = false;
    t.dueAt = Date.now() + mins * 60000;
    this.store.save();
    this.onChanged();
    return t;
  }
}

module.exports = { Scheduler, nextOccurrence };
