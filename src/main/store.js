'use strict';

/**
 * 数据持久化。全部塞进 %APPDATA%/Reminder/data.json。
 *
 * 写入用「先写临时文件再 rename」的方式 —— rename 在同一分区上是原子的，
 * 这样即使写到一半断电/崩溃，也不会留下一个被截断的 data.json 把用户
 * 攒了几个月的待办全毁掉。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 1,
  todos: [],
  sound: {
    mode: 'default',   // 'default' | 'custom'
    file: null,        // sounds/ 下的文件名
    name: null,        // 用户看到的原始文件名
    volume: 0.8,
  },
  pet: {
    x: null,
    y: null,
    visible: false,
    height: 460,
  },
  // 自定义图片。每一项要么是内置图 { source:'builtin', key }，
  // 要么是导入进来的自定义图 { source:'custom', file }。
  // splashPos / mainPos 是铺满时的裁切位置（百分比，50 为居中）。
  images: {
    splash: { source: 'builtin', key: 'default' },
    main: { source: 'builtin', key: 'default' },
    pet: { source: 'builtin', key: 'default' },
    splashPos: { x: 50, y: 50 },
    mainPos: { x: 50, y: 50 },
  },
  // 背景音乐。默认关闭 —— 需求就是「初始无音乐」，用户自己在设置里加。
  music: {
    enabled: false,
    mode: 'sequential',      // 'one' 单曲循环 | 'sequential' 顺序 | 'shuffle' 随机
    volume: 0.5,
    pauseWhenHidden: false,  // 藏到托盘/桌宠时是否暂停
    tracks: [],              // [{ file, name, size }]
    current: 0,              // 当前曲目下标
  },
  snoozeMin: 5,        // 「稍后提醒」推迟多少分钟
};

const IMAGE_KEYS = ['splash', 'main', 'pet'];
const MUSIC_MODES = ['one', 'sequential', 'shuffle'];

let dir = null;
let file = null;
let soundsDir = null;
let data = null;

function init(userDataPath) {
  dir = userDataPath;
  file = path.join(dir, 'data.json');
  soundsDir = path.join(dir, 'sounds');
  fs.mkdirSync(soundsDir, { recursive: true });
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** 把磁盘上读来的 todo 补全成完整形状，容忍旧版本缺字段 */
function normalizeTodo(t) {
  return {
    id: t.id || newId(),
    text: typeof t.text === 'string' ? t.text : '',
    dueAt: Number.isFinite(t.dueAt) ? t.dueAt : null,
    intervalMin: Number.isFinite(t.intervalMin) ? t.intervalMin : 0,
    repeat: t.repeat && Number.isFinite(t.repeat.every) && t.repeat.every > 0
      ? { every: t.repeat.every, unit: ['min', 'hour', 'day', 'week'].includes(t.repeat.unit) ? t.repeat.unit : 'day' }
      : null,
    enabled: t.enabled !== false,
    done: t.done === true,
    muted: t.muted === true,
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
  };
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 音乐配置容错：脏数据不能让整个歌单消失 */
function normalizeMusic(raw) {
  const out = clone(DEFAULTS.music);
  if (!raw || typeof raw !== 'object') return out;

  out.enabled = raw.enabled === true;
  out.pauseWhenHidden = raw.pauseWhenHidden === true;
  if (MUSIC_MODES.includes(raw.mode)) out.mode = raw.mode;
  if (Number.isFinite(raw.volume)) out.volume = Math.min(1, Math.max(0, raw.volume));

  if (Array.isArray(raw.tracks)) {
    out.tracks = raw.tracks
      .filter(t => t && typeof t.file === 'string' && t.file)
      .map(t => ({
        file: t.file,
        name: typeof t.name === 'string' && t.name ? t.name : t.file,
        size: Number.isFinite(t.size) ? t.size : 0,
      }));
  }

  const cur = Number.isFinite(raw.current) ? Math.round(raw.current) : 0;
  out.current = out.tracks.length ? Math.min(Math.max(0, cur), out.tracks.length - 1) : 0;
  return out;
}

/** 图片配置容错：坏值一律退回内置默认，别让一张脏数据把界面搞白 */
function normalizeImages(raw) {
  const out = clone(DEFAULTS.images);
  if (!raw || typeof raw !== 'object') return out;

  for (const key of IMAGE_KEYS) {
    const spec = raw[key];
    if (!spec || typeof spec !== 'object') continue;
    if (spec.source === 'custom' && typeof spec.file === 'string' && spec.file) {
      out[key] = { source: 'custom', file: spec.file };
    } else if (spec.source === 'builtin') {
      out[key] = { source: 'builtin', key: typeof spec.key === 'string' ? spec.key : 'default' };
    }
  }

  for (const key of ['splashPos', 'mainPos']) {
    const p = raw[key];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      out[key] = {
        x: Math.min(100, Math.max(0, p.x)),
        y: Math.min(100, Math.max(0, p.y)),
      };
    }
  }
  return out;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...clone(DEFAULTS), ...raw };
    data.sound = { ...DEFAULTS.sound, ...(raw.sound || {}) };
    data.pet = { ...DEFAULTS.pet, ...(raw.pet || {}) };
    data.images = normalizeImages(raw.images);
    data.music = normalizeMusic(raw.music);
    data.todos = Array.isArray(raw.todos) ? raw.todos.map(normalizeTodo) : [];
    if (!Number.isFinite(data.snoozeMin) || data.snoozeMin <= 0) data.snoozeMin = DEFAULTS.snoozeMin;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 文件坏了也不能让应用起不来：把坏文件挪到一边留证，然后从默认值开始
      console.error('[store] data.json 读取失败:', err.message);
      try { fs.renameSync(file, file + '.broken-' + Date.now()); } catch { /* 尽力而为 */ }
    }
    data = clone(DEFAULTS);
  }
  return data;
}

function save() {
  if (!data) return;
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[store] 保存失败:', err.message);
  }
}

function get() { return data; }
function getSoundsDir() { return soundsDir; }

// ------------------------------------------------------------------ 待办

function addTodo(fields) {
  const todo = normalizeTodo({ ...fields, id: newId(), createdAt: Date.now() });
  data.todos.push(todo);
  save();
  return todo;
}

function updateTodo(id, patch) {
  const t = data.todos.find(x => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  // 时间/内容变了就重新武装，让调度器能再次触发
  if ('dueAt' in patch || 'enabled' in patch || 'intervalMin' in patch) t.muted = false;
  save();
  return t;
}

function removeTodo(id) {
  const i = data.todos.findIndex(x => x.id === id);
  if (i === -1) return false;
  data.todos.splice(i, 1);
  save();
  return true;
}

// ------------------------------------------------------------------ 提示音

function setSound(patch) {
  Object.assign(data.sound, patch);
  save();
  return data.sound;
}

// ------------------------------------------------------------------ 桌宠

function setPet(patch) {
  Object.assign(data.pet, patch);
  save();
  return data.pet;
}

// ------------------------------------------------------------------ 音乐

function setMusic(patch) {
  Object.assign(data.music, patch);
  // 歌单变短之后 current 可能越界，顺手夹一下
  const n = data.music.tracks.length;
  data.music.current = n ? Math.min(Math.max(0, data.music.current), n - 1) : 0;
  save();
  return data.music;
}

// ------------------------------------------------------------------ 图片

function setImage(key, spec) {
  if (!IMAGE_KEYS.includes(key)) return null;
  data.images[key] = spec;
  save();
  return data.images[key];
}

function setImagePos(key, patch) {
  const k = key + 'Pos';
  if (!['splashPos', 'mainPos'].includes(k)) return null;
  const cur = data.images[k];
  // 夹到 0..100：界面传上来的滑块值不该直接落盘，越界会让背景整块跑出可视区
  const clamp = (v, fallback) => Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : fallback;
  cur.x = clamp(patch.x, cur.x);
  cur.y = clamp(patch.y, cur.y);
  save();
  return cur;
}

module.exports = {
  init, load, save, get, getSoundsDir,
  addTodo, updateTodo, removeTodo,
  setSound, setPet, setImage, setImagePos, setMusic,
  newId,
  DEFAULTS, IMAGE_KEYS, MUSIC_MODES,
};
