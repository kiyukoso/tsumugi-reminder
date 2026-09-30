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

  // 歌单也要等浮层显示之后再回填，理由同图片
  const mst = await window.api.musicState();
  renderMusic(mst);
  populateMusic(mst);

  // 打开设置时同步一次更新状态：后台那次检查的结果可能早就到了
  renderUpdate(await window.api.updateStatus());
}

// ------------------------------------------------------------------ 背景音乐

/**
 * 歌单、当前曲目、播放模式都由主进程持有（桌宠右键菜单在主进程里构建，
 * 得能直接读能直接控）。这边只负责真正那个 <audio>。
 *
 * 播放走 blob URL 而不是 decodeAudioData：后者把整首歌解成未压缩 PCM，
 * 一首 10MB 的 mp3 能膨胀到几十 MB 常驻内存；<audio> 是流式解码。
 */
const audio = new Audio();
audio.preload = 'auto';

const MUSIC_MIME = {
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
  m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  opus: 'audio/ogg', weba: 'audio/webm',
};

const ICON_PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 1.6v8.8L10.4 6z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.6h2.4v8.8H3zM6.6 1.6H9v8.8H6.6z"/></svg>';
const MODE_TEXT = { one: '单曲', sequential: '顺序', shuffle: '随机' };

const stripExt = (n) => String(n || '').replace(/\.[^.]+$/, '');

let musicStateCache = null;
let currentBlobUrl = null;
let loadToken = 0;      // 连续切歌时，用来作废掉过期的加载
let loadedToken = 0;    // 最后一次真正加载完成的那个 token

function renderMusic(st) {
  if (!st) return;
  musicStateCache = st;

  const has = st.tracks.length > 0;
  const track = has ? st.tracks[st.current] : null;

  $('playerCard').classList.toggle('idle', !has);
  $('playerTitle').textContent = track ? stripExt(track.name) : '未添加音乐';
  $('playerSub').textContent = has
    ? `${st.playing ? '正在播放' : '已暂停'} · 第 ${st.current + 1}/${st.tracks.length} 首`
    : '在设置 → 音乐里添加';
  $('btnMode').textContent = MODE_TEXT[st.mode] || '顺序';
  $('btnPlay').innerHTML = st.playing ? ICON_PAUSE : ICON_PLAY;

  audio.volume = st.volume;
}

/** 把真实的播放状态回报给主进程（桌宠菜单上的「播放/暂停」靠它显示正确） */
function reportPlaying(playing) {
  if (musicStateCache) {
    musicStateCache.playing = playing;
    renderMusic(musicStateCache);
  }
  window.api.musicReport({ playing, current: musicStateCache ? musicStateCache.current : -1 });
}

function playAudio() {
  audio.play()
    .then(() => reportPlaying(true))
    .catch(err => {
      // 最常见的原因是格式解不开。别静默 —— 用户只会觉得"音乐没响"，
      // 而控制台里没有任何线索可查。
      console.warn('[music] 播放失败:', err && err.message);
      reportPlaying(false);
    });
}

function pauseAudio() {
  audio.pause();
  reportPlaying(false);
}

/** 加载第 index 首。play=true 时加载完直接开始放。 */
async function loadTrack(index, play) {
  const st = musicStateCache;
  if (!st || !st.tracks.length) return;
  const track = st.tracks[index];
  if (!track) return;

  const token = ++loadToken;
  const bytes = await window.api.musicBytes(track.file);
  if (token !== loadToken) return;     // 期间又切了歌，这次作废

  if (!bytes) {
    $('playerSub').textContent = '文件找不到了，可能在设置里被移除过';
    reportPlaying(false);
    return;
  }

  const ext = String(track.file).split('.').pop().toLowerCase();
  const url = URL.createObjectURL(new Blob([bytes], { type: MUSIC_MIME[ext] || 'audio/mpeg' }));

  // 旧的 blob 要**延迟**释放，不能立刻 revoke：切歌那一刻 audio 元素可能
  // 还在读上一首，立刻释放会让它触发一次 error 事件，状态就被误报成
  //「已暂停」——菜单和按钮显示全错，但歌其实还在放。
  const stale = currentBlobUrl;
  currentBlobUrl = url;
  loadedToken = token;
  if (stale) setTimeout(() => URL.revokeObjectURL(stale), 5000);

  audio.src = url;
  audio.volume = st.volume;
  if (play) playAudio();
  else reportPlaying(false);
}

/** 进入主界面时开始播放 */
function startMusic() {
  const st = musicStateCache;
  if (!st || !st.enabled || !st.tracks.length) return;
  if (audio.src && !audio.paused) return;    // 已经在放了，别重头开始
  loadTrack(st.current, true);
}

/** 藏到托盘/桌宠时的处理，由主进程显式通知（比赌 visibilitychange 可靠） */
function onBackground(hidden) {
  const st = musicStateCache;
  if (!st || !st.tracks.length) return;
  if (hidden) {
    if (st.pauseWhenHidden && !audio.paused) pauseAudio();
  } else if (st.enabled && audio.paused && !st.pauseWhenHidden) {
    // 回到前台接着放。之前是手动暂停的就别自作主张
    if (audio.src) playAudio();
  }
}

audio.addEventListener('ended', () => {
  window.api.musicStep(1, true);            // auto=true：单曲循环时原地重放
});

audio.addEventListener('error', () => {
  // 切歌途中上一首残留的 error 不该算数，否则会把新歌的状态报成"已暂停"
  if (loadToken !== loadedToken) return;
  console.warn('[music] 音频加载出错:', audio.error && audio.error.message);
  reportPlaying(false);
});

window.api.onMusicControl(({ action, state }) => {
  if (state) renderMusic(state);
  if (action === 'load') {
    loadTrack(state.current, true);
  } else if (action === 'toggle') {
    if (!audio.src) loadTrack(state.current, true);
    else if (audio.paused) playAudio();
    else pauseAudio();
  } else if (action === 'stop') {
    pauseAudio();
    audio.removeAttribute('src');
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
  }
});

// 主进程改了状态（切歌、调音量、切模式、歌单增删）时刷新界面
window.api.onMusicState((st) => {
  const prevCurrent = musicStateCache ? musicStateCache.current : -1;
  renderMusic(st);
  if (!$('settingsLayer').classList.contains('hidden')) renderMusicList(st);

  // 已经是启用状态但从没加载过（比如刚在设置里添加了歌），补一次
  if (st.enabled && st.tracks.length && !audio.src) loadTrack(st.current, true);
  else if (st.enabled && st.tracks.length && prevCurrent !== st.current && !audio.src) loadTrack(st.current, true);
});

// ------------------------------------------------------------------ 歌曲列表（设置面板）

function renderMusicList(st) {
  const list = $('musicList');
  list.textContent = '';
  $('musicCount').textContent = st.tracks.length ? `共 ${st.tracks.length} 首` : '';

  if (!st.tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'music-empty';
    empty.textContent = '还没有音乐。点右边「添加音乐…」选文件，可以一次选多首。';
    list.appendChild(empty);
    return;
  }

  st.tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'music-item' + (i === st.current ? ' current' : '');

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i === st.current ? '♪' : String(i + 1);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = stripExt(t.name);
    name.title = `${t.name}（点一下播这首）`;
    name.onclick = () => window.api.musicSelect(i);

    const acts = document.createElement('div');
    acts.className = 'acts';

    const mk = (text, cls, title, disabled, fn) => {
      const b = document.createElement('button');
      b.className = 'icon-btn' + (cls ? ' ' + cls : '');
      b.textContent = text;
      b.title = title;
      b.disabled = !!disabled;
      b.onclick = fn;
      return b;
    };

    acts.append(
      mk('↑', '', '上移', i === 0, () => window.api.musicMove(i, i - 1)),
      mk('↓', '', '下移', i === st.tracks.length - 1, () => window.api.musicMove(i, i + 1)),
      mk('✕', 'danger', '从歌单移除（原文件不动）', false, () => window.api.musicRemove(t.file)),
    );

    row.append(idx, name, acts);
    list.appendChild(row);
  });
}

function populateMusic(st) {
  $('musicEnabled').checked = !!st.enabled;
  $('musicMode').value = st.mode;
  $('musicVolume').value = st.volume;
  $('musicVolumeNum').textContent = Math.round(st.volume * 100) + '%';
  $('musicPauseHidden').checked = !!st.pauseWhenHidden;
  renderMusicList(st);
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

  // 音乐等进入主界面之后再起，别在进入画面上就开始放
  setTimeout(startMusic, 300);
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

  // ---- 背景音乐
  $('btnPlay').onclick = () => window.api.musicToggle();
  $('btnPrev').onclick = () => window.api.musicStep(-1, false);
  $('btnNext').onclick = () => window.api.musicStep(1, false);

  $('btnMode').onclick = async () => {
    const order = ['sequential', 'one', 'shuffle'];
    const cur = musicStateCache ? musicStateCache.mode : 'sequential';
    const res = await window.api.musicSet({ mode: order[(order.indexOf(cur) + 1) % order.length] });
    renderMusic(res);
    $('musicMode').value = res.mode;
  };

  $('btnAddMusic').onclick = async () => {
    const res = await window.api.musicAdd();
    if (res && res.ok) {
      const st = await window.api.musicState();
      renderMusic(st);
      populateMusic(st);
    }
  };

  $('musicEnabled').addEventListener('change', async (e) => {
    renderMusic(await window.api.musicSet({ enabled: e.target.checked }));
  });

  $('musicMode').addEventListener('change', async (e) => {
    renderMusic(await window.api.musicSet({ mode: e.target.value }));
  });

  // 音量拖动时本地即时生效，松手才落盘
  $('musicVolume').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('musicVolumeNum').textContent = Math.round(v * 100) + '%';
    audio.volume = v;
    if (musicStateCache) musicStateCache.volume = v;
  });
  $('musicVolume').addEventListener('change', (e) => window.api.musicSet({ volume: Number(e.target.value) }));

  $('musicPauseHidden').addEventListener('change', (e) => {
    window.api.musicSet({ pauseWhenHidden: e.target.checked });
  });

  window.api.onBackground((hidden) => onBackground(hidden));

  // ---- 全屏
  $('btnFullscreen').onclick = () => window.api.toggleFullscreen();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); window.api.toggleFullscreen(); }
    else if (e.key === 'Escape' && document.body.classList.contains('fullscreen')) {
      window.api.toggleFullscreen();
    }
  });

  window.api.onFullscreenChanged((on) => {
    document.body.classList.toggle('fullscreen', on);
    $('btnFullscreen').title = on ? '退出全屏（Esc）' : '全屏（F11）';
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

  // 音乐状态要先拿到，enterApp 里才知道该不该起播
  renderMusic(await window.api.musicState());

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
