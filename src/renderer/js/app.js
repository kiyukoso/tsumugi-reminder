'use strict';

/* ==========================================================================
   主界面
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const WEEK = '日一二三四五六';

let todos = [];
let editingId = null;
let lastSoundAt = 0;
const alertQueue = [];
let currentAlert = null;

// ------------------------------------------------------------------ 时间格式

function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDue(ms) {
  if (!ms) return '未设置时间';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const date = sameDay ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「还有 3 小时」「12 分钟前」这类相对描述，比绝对时间更容易一眼判断紧迫度 */
function fmtRelative(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  let text;
  if (min < 1) text = '不到 1 分钟';
  else if (min < 60) text = `${min} 分钟`;
  else if (min < 60 * 24) text = `${Math.floor(min / 60)} 小时`;
  else text = `${Math.floor(min / 1440)} 天`;
  return diff >= 0 ? `还有 ${text}` : `已过 ${text}`;
}

function fmtInterval(min) {
  if (!min) return '';
  return min % 60 === 0 ? `每 ${min / 60} 小时再响` : `每 ${min} 分钟再响`;
}

const UNIT_LABEL = { min: '分钟', hour: '小时', day: '天', week: '周' };
function fmtRepeat(r) {
  return r ? `每 ${r.every} ${UNIT_LABEL[r.unit]}` : '';
}

// ------------------------------------------------------------------ 实时时钟

/**
 * 每次都重新读系统时间，并把自己对齐到「下一个整秒」再排下一次，
 * 而不是用 setInterval(1000) —— 后者会累积漂移，跑一晚上就能差出好几秒。
 * 电脑时间被改动或从睡眠唤醒时，下一拍自然会读到新值。
 */
function tickClock() {
  const d = new Date();
  $('clockTime').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('clockDate').textContent =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${WEEK[d.getDay()]}`;
  setTimeout(tickClock, 1000 - (Date.now() % 1000) + 4);
}

// ------------------------------------------------------------------ 列表渲染

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;   // 一律用 textContent，待办内容是用户输入
  return e;
}

function renderTodos() {
  const list = $('todoList');
  const scroll = list.scrollTop;

  // 只在集合真的变了时才重放入场动画，否则每次勾选都会整列闪一下
  const seen = renderTodos._seen || (renderTodos._seen = new Set());
  const nowIds = new Set(todos.map(t => t.id));

  list.textContent = '';

  const live = todos.filter(t => !t.done);
  $('todoCount').textContent = live.length ? `· ${live.length} 条进行中` : '';
  $('emptyHint').classList.toggle('hidden', todos.length > 0);

  const sorted = todos.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (!a.dueAt && !b.dueAt) return b.createdAt - a.createdAt;
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt - b.dueAt;
  });

  for (const t of sorted) {
    list.appendChild(editingId === t.id ? buildEditRow(t) : buildTodoRow(t, seen.has(t.id)));
    seen.add(t.id);
  }

  // 已经消失的条目从记忆里清掉，避免 Set 无限增长
  for (const id of [...seen]) if (!nowIds.has(id)) seen.delete(id);

  list.scrollTop = scroll;
}

function buildTodoRow(t, animate) {
  const row = el('div', 'todo' + (animate ? '' : ' no-anim'));
  if (t.done) row.classList.add('done');
  if (!t.enabled && !t.done) row.classList.add('off');
  if (currentAlert && currentAlert.todo.id === t.id) row.classList.add('firing');
  row.dataset.id = t.id;

  // 勾选框
  const check = el('button', 'check', t.done ? '✓' : '');
  check.title = t.done ? '标记为未完成' : '完成';
  check.onclick = async () => {
    if (t.done) {
      await window.api.updateTodo(t.id, { done: false, enabled: true });
    } else {
      await window.api.action(t.id, 'complete');
    }
    if (currentAlert && currentAlert.todo.id === t.id) closeAlert();
  };
  row.appendChild(check);

  // 主体
  const main = el('div', 'todo-main');
  main.appendChild(el('div', 'todo-text', t.text || '(无内容)'));

  const meta = el('div', 'todo-meta');
  if (t.dueAt) {
    const soon = !t.done && t.dueAt - Date.now() < 10 * 60000;
    meta.appendChild(el('span', 'tag' + (soon ? ' due-soon' : ''), fmtDue(t.dueAt)));
    if (!t.done) meta.appendChild(el('span', 'tag plain', fmtRelative(t.dueAt)));
  } else {
    meta.appendChild(el('span', 'tag plain', '未设置时间'));
  }
  if (t.intervalMin) meta.appendChild(el('span', 'tag plain', fmtInterval(t.intervalMin)));
  if (t.repeat) meta.appendChild(el('span', 'tag plain', fmtRepeat(t.repeat)));
  if (!t.enabled && !t.done) meta.appendChild(el('span', 'tag plain', '已暂停'));
  main.appendChild(meta);
  row.appendChild(main);

  // 操作
  const actions = el('div', 'todo-actions');
  const edit = el('button', 'icon-btn', '✎');
  edit.title = '编辑';
  edit.onclick = () => { editingId = t.id; renderTodos(); };
  const del = el('button', 'icon-btn danger', '✕');
  del.title = '删除';
  del.onclick = () => {
    if (confirm(`删除「${t.text}」？`)) window.api.removeTodo(t.id);
  };
  actions.append(edit, del);
  row.appendChild(actions);

  return row;
}

function buildEditRow(t) {
  const row = el('div', 'todo no-anim');
  row.style.flexDirection = 'column';
  row.style.gap = '9px';

  const text = el('input', 'field');
  text.value = t.text;
  text.maxLength = 120;
  text.placeholder = '要做什么…';

  const r1 = el('div', 'row');
  const due = el('input', 'field');
  due.type = 'datetime-local';
  due.value = t.dueAt ? toLocalInput(t.dueAt) : toLocalInput(Date.now() + 3600000);

  const interval = el('select', 'field');
  for (const [v, label] of [['0', '不重复提醒'], ['5', '每 5 分钟再响'], ['10', '每 10 分钟再响'],
                            ['15', '每 15 分钟再响'], ['30', '每 30 分钟再响'], ['60', '每 1 小时再响']]) {
    interval.appendChild(new Option(label, v));
  }
  interval.value = String(t.intervalMin || 0);
  r1.append(due, interval);

  const r2 = el('div', 'row');
  const repeat = el('select', 'field');
  for (const [v, label] of [['', '不周期重复'], ['1:hour', '每小时'], ['1:day', '每天'], ['1:week', '每周']]) {
    repeat.appendChild(new Option(label, v));
  }
  repeat.value = t.repeat ? `${t.repeat.every}:${t.repeat.unit}` : '';
  r2.appendChild(repeat);

  const r3 = el('div', 'row');
  const save = el('button', 'btn primary small', '保存');
  save.style.flex = '1';
  save.onclick = async () => {
    const ms = due.value ? new Date(due.value).getTime() : null;
    const [ev, eu] = repeat.value.split(':');
    await window.api.updateTodo(t.id, {
      text: text.value.trim() || t.text,
      dueAt: Number.isFinite(ms) ? ms : t.dueAt,
      intervalMin: Number(interval.value) || 0,
      repeat: Number(ev) > 0 ? { every: Number(ev), unit: eu } : null,
      done: false,
      muted: false,
    });
    editingId = null;
  };
  const cancel = el('button', 'btn ghost small', '取消');
  cancel.onclick = () => { editingId = null; renderTodos(); };
  r3.append(save, cancel);

  row.append(text, r1, r2, r3);
  setTimeout(() => text.focus(), 0);
  return row;
}

// ------------------------------------------------------------------ 添加

async function addTodo() {
  const text = $('newText').value.trim();
  if (!text) { $('newText').focus(); return; }

  const dueVal = $('newDue').value;
  const dueMs = dueVal ? new Date(dueVal).getTime() : Date.now() + 3600000;

  const [ev, eu] = $('newRepeat').value.split(':');

  await window.api.addTodo({
    text,
    dueAt: Number.isFinite(dueMs) ? dueMs : Date.now() + 3600000,
    intervalMin: Number($('newInterval').value) || 0,
    repeat: Number(ev) > 0 ? { every: Number(ev), unit: eu } : null,
  });

  $('newText').value = '';
  $('newDue').value = toLocalInput(Date.now() + 3600000);
  $('newText').focus();
}

// ------------------------------------------------------------------ 提醒弹层

function pushAlert(todo, kind) {
  alertQueue.push({ todo, kind });
  // 同一拍里好几条一起到点时，别叠成一串和弦
  if (Date.now() - lastSoundAt > 900) {
    lastSoundAt = Date.now();
    Sound.play();
  }
  showNextAlert();
}

function showNextAlert() {
  if (currentAlert || !alertQueue.length) {
    updateQueueHint();
    if (!currentAlert) $('alertLayer').classList.add('hidden');
    return;
  }
  currentAlert = alertQueue.shift();
  const { todo, kind } = currentAlert;

  const badge = $('alertBadge');
  badge.textContent = kind === 'repeat' ? '再次提醒' : '提醒';
  badge.classList.toggle('repeat', kind === 'repeat');
  $('alertText').textContent = todo.text || '(无内容)';
  $('alertDue').textContent = todo.dueAt ? fmtDue(todo.dueAt) : '';

  $('alertLayer').classList.remove('hidden');
  updateQueueHint();
  renderTodos();
  Sound.play();
}

function updateQueueHint() {
  const q = $('alertQueue');
  if (alertQueue.length) {
    q.textContent = `还有 ${alertQueue.length} 条提醒在排队`;
    q.classList.remove('hidden');
  } else {
    q.classList.add('hidden');
  }
}

function closeAlert() {
  currentAlert = null;
  $('alertLayer').classList.add('hidden');
  showNextAlert();
  renderTodos();
}

// ------------------------------------------------------------------ 自定义图片

// 背景图走 blob URL 而不是 file:// —— 用户选的文件名很可能是中文，
// 拼 file:// 路径的编码很容易出岔子，而且失败时是静默的（背景变白）。
const imageUrls = {};
let imageState = null;

function setBackground(el, src, pos, slot) {
  if (src) {
    const url = URL.createObjectURL(new Blob([src.data], { type: src.mime }));
    if (imageUrls[slot]) URL.revokeObjectURL(imageUrls[slot]);
    imageUrls[slot] = url;
    el.style.backgroundImage = `url("${url}")`;
  }
  if (pos) el.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
}

function applyImageState(st) {
  imageState = st;
  setBackground($('splash'), st.src.splash, st.pos.splash, 'splash');
  setBackground($('app'), st.src.main, st.pos.main, 'main');

  // 设置面板开着的话同步刷新（换图之后下拉和缩略图都要跟着变）
  if (!$('settingsLayer').classList.contains('hidden')) populateAppearance();
}

async function refreshImages() {
  applyImageState(await window.api.getImages());
}

/** 存进来的文件名带时间戳前缀，显示时去掉 */
const shortName = (f) => String(f || '').replace(/^[a-z0-9]+-/, '').slice(0, 22);

function buildImageSelect(sel, key, st) {
  sel.textContent = '';
  const table = st.builtin[key] || {};
  for (const [k, entry] of Object.entries(table)) {
    sel.appendChild(new Option(entry.label, 'builtin:' + k));
  }
  const spec = st.spec[key];
  if (spec.source === 'custom') {
    sel.appendChild(new Option('自定义：' + shortName(spec.file), 'custom'));
  }
  sel.appendChild(new Option('选择本地图片…', 'pick'));
  sel.value = spec.source === 'custom' ? 'custom' : 'builtin:' + (spec.key || 'default');
}

function populateAppearance() {
  const st = imageState;
  if (!st) return;

  for (const key of ['splash', 'main', 'pet']) {
    buildImageSelect($('sel-' + key), key, st);

    const thumb = $('thumb-' + key);
    const src = st.src[key];
    if (thumb.dataset.url) URL.revokeObjectURL(thumb.dataset.url);
    if (src) {
      const url = URL.createObjectURL(new Blob([src.data], { type: src.mime }));
      thumb.dataset.url = url;
      thumb.src = url;
    } else {
      thumb.removeAttribute('src');
    }
  }

  $('pos-splash-x').value = st.pos.splash.x;
  $('pos-splash-y').value = st.pos.splash.y;
  $('pos-main-x').value = st.pos.main.x;
  $('pos-main-y').value = st.pos.main.y;

  $('petHeight').min = st.petRange[0];
  $('petHeight').max = st.petRange[1];
  $('petHeight').value = st.petHeight;
  $('petHeightNum').textContent = st.petHeight + 'px';
}

/** 给图片下拉接上行为：选内置图直接切，选「本地图片」走文件对话框 */
function wireImageSelect(key) {
  $('sel-' + key).addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v === 'custom') return;                    // 已经是自定义，保持原样
    if (v.startsWith('builtin:')) {
      await window.api.setBuiltinImage(key, v.slice(8));
      return;
    }
    if (v !== 'pick') return;

    const sel = e.target;
    sel.disabled = true;
    try {
      const opts = key === 'pet' ? { cutout: $('petCutout').checked } : {};
      const res = await window.api.pickImage(key, opts);
      if (res && res.ok && res.failed) {
        alert('这张图没能识别出可抠的背景（可能是一张满幅照片）。\n已经原样保存并启用，如果边缘不合适，可以取消勾选「自动抠图」再选一次。');
      }
    } finally {
      sel.disabled = false;
      await refreshImages();
    }
  });
}

// ------------------------------------------------------------------ 设置

async function openSettings() {
  const s = await window.api.getSound();
  await Sound.setConfig(s.config, s.data);
  refreshSoundUI(s.config);

  const settings = await window.api.getSettings();
  $('snoozeMin').value = settings.snoozeMin;
  $('volRange').value = s.config.volume;
  $('volNum').textContent = Math.round(s.config.volume * 100) + '%';

  const info = await window.api.appInfo();
  $('verText').textContent = 'v' + info.version;

  // 顺序要紧：applyImageState 只在面板可见时才回填控件，
  // 所以必须先把浮层显示出来再拉图片数据，否则下拉是空的。
  $('settingsLayer').classList.remove('hidden');
  await refreshImages();

  // 打开设置时同步一次更新状态：后台那次检查的结果可能早就到了
  renderUpdate(await window.api.updateStatus());
}

// ------------------------------------------------------------------ 自动更新

let updateState = null;

function renderUpdate(st) {
  if (!st) return;
  updateState = st;

  const line = $('updateLine');
  const btn = $('btnUpdate');
  const V = st.version ? 'v' + st.version : '';

  btn.classList.remove('primary');
  btn.disabled = false;

  switch (st.state) {
    case 'dev':
      line.textContent = '开发环境，不检查更新';
      btn.textContent = '检查更新';
      btn.disabled = true;
      break;

    case 'idle':
      line.textContent = '';
      btn.textContent = '检查更新';
      break;

    case 'checking':
      line.textContent = '正在检查…';
      btn.textContent = '检查中';
      btn.disabled = true;
      break;

    case 'none':
      line.textContent = '已是最新版本';
      btn.textContent = '检查更新';
      break;

    case 'available':
      line.textContent = `发现 ${V}，正在后台下载…`;
      btn.textContent = '下载中';
      btn.disabled = true;
      break;

    case 'downloading':
      line.textContent = `正在下载 ${V} — ${st.percent}%`;
      btn.textContent = st.percent + '%';
      btn.disabled = true;
      break;

    case 'downloaded':
      line.textContent = `${V} 已下载完成，重启后生效`;
      btn.textContent = '重启并安装';
      btn.classList.add('primary');
      break;

    case 'error':
      line.textContent = '更新失败：' + String(st.message || '未知原因').slice(0, 60);
      btn.textContent = '重试';
      break;
  }

  // 有更新等着装时在齿轮上点一个圆点，免得用户不打开设置就永远发现不了
  $('btnSettings').classList.toggle('has-update', st.state === 'downloaded');
}

function switchTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.tab === name);
  }
  for (const p of document.querySelectorAll('.tab-panel')) {
    p.classList.toggle('hidden', p.dataset.panel !== name);
  }
}

function refreshSoundUI(cfg) {
  const name = $('soundName');
  const custom = cfg.mode === 'custom' && cfg.file;
  name.textContent = custom ? cfg.name : '默认提示音';
  name.classList.toggle('custom', !!custom);
}

// ------------------------------------------------------------------ 启动

function enterApp() {
  const splash = $('splash');
  if (splash.classList.contains('gone')) return;
  splash.classList.add('gone');
  $('app').classList.add('on');
  setTimeout(() => splash.classList.add('hidden'), 780);
}

async function init() {
  tickClock();

  // ---- 进入界面：自动进，点击可以立刻跳过
  const autoEnter = setTimeout(enterApp, 2600);
  $('splash').addEventListener('click', () => { clearTimeout(autoEnter); enterApp(); });

  // ---- 添加待办
  $('newDue').value = toLocalInput(Date.now() + 3600000);
  $('btnAdd').onclick = addTodo;
  $('newText').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });

  // ---- 窗口按钮
  $('btnMin').onclick = () => window.api.windowMinimize();
  $('btnClose').onclick = () => window.api.windowClose();

  // ---- 设置
  $('btnSettings').onclick = openSettings;
  $('btnSettingsClose').onclick = () => $('settingsLayer').classList.add('hidden');
  $('btnPreview').onclick = () => Sound.play();

  $('btnPickSound').onclick = async () => {
    const res = await window.api.pickSound();
    if (!res) return;
    await Sound.setConfig(res.config, res.data);
    refreshSoundUI(res.config);
  };

  $('btnUseDefault').onclick = async () => {
    const res = await window.api.setSoundMode('default');
    await Sound.setConfig(res.config, res.data);
    refreshSoundUI(res.config);
  };

  $('volRange').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('volNum').textContent = Math.round(v * 100) + '%';
    Sound.setVolume(v);
    window.api.setVolume(v);
  });

  $('snoozeMin').addEventListener('change', (e) => {
    window.api.setSnoozeMin(e.target.value).then(v => { e.target.value = v; });
  });

  // ---- 自动更新
  $('btnUpdate').onclick = async () => {
    if (updateState && updateState.state === 'downloaded') await window.api.updateInstall();
    else await window.api.updateCheck();
  };
  window.api.onUpdateStatus(renderUpdate);

  // ---- 设置：标签页
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => switchTab(t.dataset.tab);
  }

  // ---- 设置：外观
  for (const key of ['splash', 'main', 'pet']) wireImageSelect(key);

  // 裁切位置：拖动时本地立刻生效，不等主进程回信，否则手感会发涩
  for (const key of ['splash', 'main']) {
    for (const axis of ['x', 'y']) {
      $(`pos-${key}-${axis}`).addEventListener('input', () => {
        const pos = { x: Number($(`pos-${key}-x`).value), y: Number($(`pos-${key}-y`).value) };
        const target = key === 'splash' ? $('splash') : $('app');
        target.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
        if (imageState) imageState.pos[key] = pos;
        window.api.setImagePos(key, pos);
      });
    }
  }

  for (const btn of document.querySelectorAll('[data-reset-pos]')) {
    btn.onclick = () => {
      const key = btn.dataset.resetPos;
      $(`pos-${key}-x`).value = 50;
      $(`pos-${key}-y`).value = 50;
      (key === 'splash' ? $('splash') : $('app')).style.backgroundPosition = '50% 50%';
      if (imageState) imageState.pos[key] = { x: 50, y: 50 };
      window.api.setImagePos(key, { x: 50, y: 50 });
    };
  }

  // 桌宠大小：拖动时只更新数字，停下来才真正改窗口（改窗口要重算尺寸 + setSize）
  let heightTimer = null;
  $('petHeight').addEventListener('input', (e) => {
    $('petHeightNum').textContent = e.target.value + 'px';
    clearTimeout(heightTimer);
    heightTimer = setTimeout(() => window.api.setPetHeight(Number(e.target.value)), 180);
  });

  // ---- 桌宠开关
  $('btnPet').onclick = async () => {
    const on = await window.api.petToggle();
    $('btnPet').style.color = on ? 'var(--accent-deep)' : '';
    $('btnPet').style.background = on ? 'var(--accent-soft)' : '';
  };
  window.api.appInfo().then(i => {
    if (i.petVisible) {
      $('btnPet').style.color = 'var(--accent-deep)';
      $('btnPet').style.background = 'var(--accent-soft)';
    }
  });

  // ---- 提醒弹层
  $('alertComplete').onclick = async () => {
    const id = currentAlert && currentAlert.todo.id;
    closeAlert();
    if (id) await window.api.action(id, 'complete');
  };
  $('alertSnooze').onclick = async () => {
    const id = currentAlert && currentAlert.todo.id;
    closeAlert();
    if (id) await window.api.action(id, 'snooze');
  };
  $('alertDismiss').onclick = async () => {
    const id = currentAlert && currentAlert.todo.id;
    closeAlert();
    if (id) await window.api.action(id, 'dismiss');
  };

  // ---- 退出选择
  // 三个选项都必须自己先把浮层收掉：主进程那边只负责隐藏窗口，
  // 不会回过来通知渲染进程。漏掉的话，用户从托盘唤回主界面时
  // 会看到这个退出对话框还杵在那儿。
  const chooseQuit = (choice) => {
    $('quitLayer').classList.add('hidden');
    window.api.quitChoose(choice);
  };
  $('quitExit').onclick = () => chooseQuit('exit');
  $('quitTray').onclick = () => chooseQuit('tray');
  $('quitPet').onclick = () => chooseQuit('pet');
  $('quitCancel').onclick = () => $('quitLayer').classList.add('hidden');

  // ---- 主进程事件
  window.api.onTodosChanged((list) => { todos = list; renderTodos(); });

  window.api.onAlert((payload) => pushAlert(payload.todo, payload.kind));

  window.api.onQuitAsk(() => {
    // 提醒卡片还在的时候先别弹退出，免得两个浮层打架
    if (currentAlert) { closeAlert(); }
    $('quitLayer').classList.remove('hidden');
  });

  window.api.onFocusTodo((id) => {
    editingId = id;
    renderTodos();
    const node = $('todoList').querySelector(`[data-id="${id}"]`);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  // 位置和大小是本地拖出来的，主进程那边只是回存，不用再拉一遍整份图片数据
  window.api.onImagesChanged((payload) => {
    if (payload && (payload.posOnly || payload.sizeOnly)) return;
    refreshImages();
  });

  // ---- 初始数据
  todos = await window.api.listTodos();
  renderTodos();
  await refreshImages();

  const s = await window.api.getSound();
  await Sound.setConfig(s.config, s.data);
  refreshSoundUI(s.config);
  $('volRange').value = s.config.volume;
  $('volNum').textContent = Math.round(s.config.volume * 100) + '%';

  $('newText').focus();

  // 最小化再还原、或从托盘唤回时，时钟和列表立刻对一次表
  window.addEventListener('focus', () => { tickClock(); renderTodos(); });
}

init();
