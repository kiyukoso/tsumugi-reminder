'use strict';

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, ipcMain, Menu, Tray, dialog,
  nativeImage, screen, powerMonitor, shell,
} = require('electron');

const store = require('./store');
const sound = require('./sound');
const images = require('./images');
const updater = require('./updater');
const { Scheduler } = require('./scheduler');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.js');

const MAIN_W = 1280;
const MAIN_H = 713;

const DEV = process.argv.includes('--dev');

/** @type {BrowserWindow|null} */ let mainWin = null;
/** @type {BrowserWindow|null} */ let petWin = null;
/** @type {BrowserWindow|null} */ let promptWin = null;
/** @type {Tray|null} */ let tray = null;
/** @type {Scheduler} */ let scheduler = null;

let petSize = null;          // 桌宠窗口尺寸，按 pet.png 的宽高比算
let reallyQuitting = false;  // 区分「用户要退出」和「关窗口只是藏起来」
let petDrag = null;          // 拖动桌宠时的起点记录

// ==================================================================== 小工具

const pad = n => String(n).padStart(2, '0');

function fmtDateTime(ms) {
  if (!ms) return '未设置';
  const d = new Date(ms);
  const w = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${w} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtInterval(min) {
  if (!min) return '不重复';
  if (min % 60 === 0) return `${min / 60} 小时`;
  return `${min} 分钟`;
}

const UNIT_LABEL = { min: '分钟', hour: '小时', day: '天', week: '周' };
function fmtRepeat(r) {
  return r ? `每 ${r.every} ${UNIT_LABEL[r.unit]}` : '不重复';
}

/** 桌宠菜单操作的目标：最近一个还没到期的待办 */
function contextTodo() {
  const now = Date.now();
  const live = store.get().todos.filter(t => !t.done && t.enabled && t.dueAt);
  if (!live.length) return null;
  return live.sort((a, b) => a.dueAt - b.dueAt)[0];
}

// ==================================================================== 主窗口

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: MAIN_W,
    height: MAIN_H,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: '#ffffff',
    title: 'tsumugi-reminder',
    icon: path.join(ASSETS, 'tray.png'),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium 默认会拦截「没有用户手势」的音频播放。不关掉的话，
      // 应用在后台待机、提醒到点时窗口会亮但没有声音 —— 恰好是最需要
      // 它响的那种场景。
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());

  // 关窗口不等于退出：先问用户想怎么处理
  mainWin.on('close', (e) => {
    if (reallyQuitting) return;
    e.preventDefault();
    mainWin.webContents.send('quit:ask');
  });

  mainWin.on('closed', () => { mainWin = null; });

  if (DEV) mainWin.webContents.openDevTools({ mode: 'detach' });

  return mainWin;
}

/** 把主窗口拽到最前。最小化状态和「被其他窗口盖住」都要能翻上来。 */
function summonMainWindow() {
  if (!mainWin) { createMainWindow(); return; }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  // show()+focus() 在 Windows 上未必能压过当前前台窗口，
  // 短暂置顶一次是最省事又可靠的抢焦点办法。
  mainWin.setAlwaysOnTop(true);
  mainWin.focus();
  setTimeout(() => { if (mainWin && !mainWin.isDestroyed()) mainWin.setAlwaysOnTop(false); }, 400);
}

// ==================================================================== 桌宠窗口

// 桌宠窗口刻意比立绘本身宽一圈、高出一截，多出来的全是透明区域，
// 专门给提醒气泡留位置 —— 否则气泡会直接糊在角色脸上。
// 因为渲染进程做了逐像素点击穿透，这些空白不会挡住底下窗口的点击，
// 所以把窗口开大是零代价的。（气泡高度同时写在 pet.html 的 --bubble-h）
const PET_BUBBLE_W = 300;
const PET_BUBBLE_H = 92;

const PET_MIN_H = 160;
const PET_MAX_H = 900;

/** 取某项图片的配置，并补上 kind —— images 模块靠它去查内置图表 */
const specFor = (kind) => ({ ...store.get().images[kind], kind });

/** 按当前立绘的宽高比和设定的高度，算出桌宠窗口该多大 */
function computePetSize() {
  const s = images.spriteSize(specFor('pet')) || { width: 794, height: 1775 };
  const h = Math.min(PET_MAX_H, Math.max(PET_MIN_H, Math.round(store.get().pet.height || 460)));
  const spriteW = Math.round(s.width * h / s.height);
  return {
    width: Math.max(spriteW, PET_BUBBLE_W),
    height: h + PET_BUBBLE_H,
    spriteW,
    spriteH: h,
  };
}

/** 把桌宠窗口收回到屏幕可见范围内（换立绘、改尺寸、改分辨率之后都要做） */
function clampPetPosition() {
  if (!petWin || petWin.isDestroyed()) return null;
  const area = screen.getPrimaryDisplay().workArea;
  const [x, y] = petWin.getPosition();
  const nx = Math.min(Math.max(x, area.x - petSize.width + 80), area.x + area.width - 80);
  const ny = Math.min(Math.max(y, area.y), area.y + area.height - 80);
  if (nx !== x || ny !== y) petWin.setPosition(nx, ny);
  return { x: nx, y: ny };
}

// setSize 期间置位，用来把「程序自己改尺寸」和「用户拖边缘」区分开
let petSizing = false;

/**
 * 改桌宠窗口尺寸。
 *
 * 这里绕了个弯：窗口不能建成 resizable:false。
 * Windows 会把不可调整大小的窗口按**当前尺寸**锁住最大/最小跟踪尺寸，
 * 于是 setSize 只能把它改大、改不小 —— 实测设 700→300→900→460 这一串里，
 * 只有 700 和 900（变大）生效，300 和 460 被系统默默忽略，窗口永久停在
 * 最大的那个尺寸上。这正是用户报的「长按之后变大、松手也不恢复」。
 *
 * 而「在同一 tick 里 setResizable(true) → setSize → setResizable(false)」
 * 也不行：第二次切换会把尺寸改动整个吞掉，实测变成完全改不动。
 *
 * 所以窗口始终 resizable: true（setSize 双向有效），改用 will-resize 事件
 * 把**用户拖动边缘**拦掉，只放行程序自己的改动。
 */
function setPetWindowSize(w, h) {
  if (!petWin || petWin.isDestroyed()) return;
  petSizing = true;
  petWin.setSize(w, h);
  petSizing = false;
}

let petResizeFix = null;

/**
 * 桌宠窗口的尺寸只应该由 applyPetSize 决定。
 *
 * 实测遇到过窗口被外部改成 1026x942（预期 300x552）并保持不放的情况 ——
 * 立绘跟着变大，用户看到的就是「长按桌宠之后它变大了、松手也不恢复」。
 * 全项目只有 applyPetSize 一处 setSize，算出来的也对不上那个数字，
 * 所以是 Windows 那边干的（贴靠、缩放或窗口管理器的介入），不是应用自己改的。
 *
 * 与其去堵一个看不到的源头，不如加一道自愈：发现尺寸对不上就改回去，
 * 顺便把是谁改的记进日志 —— 下次再出现就能直接定位。
 */
function watchPetResize() {
  if (!petWin || petWin.isDestroyed()) return;

  petWin.on('resize', () => {
    if (!petSize) return;
    // 等一下再检查：applyPetSize 自己触发的 resize 事件也在路上，
    // 立刻比对会把正常改动误判成外部干预
    clearTimeout(petResizeFix);
    petResizeFix = setTimeout(() => {
      if (!petWin || petWin.isDestroyed()) return;
      const [w, h] = petWin.getSize();

      // 容差 2px：Windows 会把窗口尺寸按 DPI 缩放四舍五入。
      // 比如 313 DIP 在 150% 下是 469.5 物理像素，取整回来就变成 314。
      // 不容差的话这里会把正常的舍入当成外部干预，而且因为设 313 又会被
      // 舍回 314，会变成一次一次改不完的死循环。
      if (Math.abs(w - petSize.width) <= 2 && Math.abs(h - petSize.height) <= 2) return;

      const msg = `[pet] 窗口尺寸被外部改成 ${w}x${h}，预期 ${petSize.width}x${petSize.height}，已改回`;
      console.warn(msg);
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'pet-resize.log'),
          `${new Date().toISOString()}  ${msg}\n`
        );
      } catch { /* 记不上就算了，不能因此影响主流程 */ }
      setPetWindowSize(petSize.width, petSize.height);
    }, 250);
  });
}

/** 立绘或大小变了之后重新应用，并让渲染进程重新取图 */
function applyPetSize() {
  petSize = computePetSize();

  if (petWin && !petWin.isDestroyed()) {
    setPetWindowSize(petSize.width, petSize.height);
    const pos = clampPetPosition();
    if (pos) store.setPet(pos);
    petWin.webContents.send('pet:spriteChanged');
  }
  return petSize;
}

/** 托盘图标和主窗口图标跟着立绘走，否则换了角色托盘里还留着旧角色的头 */
function refreshIcons() {
  const icon = images.iconFrom(specFor('pet'), 64);
  const fallback = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));

  if (tray && !tray.isDestroyed()) {
    tray.setImage((icon || fallback).resize({ width: 16, height: 16 }));
  }
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setIcon(icon || fallback);
  }
  if (petWin && !petWin.isDestroyed()) {
    petWin.setIcon(icon || fallback);
  }
}

function createPetWindow() {
  if (petWin && !petWin.isDestroyed()) return petWin;
  if (!petSize) petSize = computePetSize();

  const p = store.get().pet;
  const area = screen.getPrimaryDisplay().workArea;

  // 首次出现时贴右下角，之后都用记住的位置
  let x = Number.isFinite(p.x) ? p.x : area.x + area.width - petSize.width - 24;
  let y = Number.isFinite(p.y) ? p.y : area.y + area.height - petSize.height - 12;

  // 分辨率变了、或者窗口尺寸改了（比如给气泡加高），存下来的旧坐标
  // 可能把桌宠整个甩到屏幕外 —— 那样用户会以为它消失了。收回来，
  // 保证至少大半个身子留在可见区域里。
  x = Math.min(Math.max(x, area.x - petSize.width + 80), area.x + area.width - 80);
  y = Math.min(Math.max(y, area.y), area.y + area.height - 80);

  petWin = new BrowserWindow({
    width: petSize.width,
    height: petSize.height,
    x, y,
    frame: false,
    transparent: true,
    resizable: true,      // 必须为 true，否则 Windows 会把窗口尺寸锁死（见 setPetWindowSize）
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: '桌宠',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  petWin.loadFile(path.join(RENDERER, 'pet.html'));
  petWin.once('ready-to-show', () => petWin.showInactive());

  // 浮在普通窗口之上，但不至于盖住全屏游戏之外的所有东西
  petWin.setAlwaysOnTop(true, 'floating');

  if (DEV) petWin.webContents.openDevTools({ mode: 'detach' });

  // 拦住用户拖边缘改尺寸。桌宠的大小只该由设置里的滑块决定，
  // 否则用户会不小心把窗口拖成一个奇怪的尺寸 —— 而且那种改动还会
  // 和他自己的立绘比例对不上。程序自己调 setSize 时 petSizing 为 true，放行。
  petWin.on('will-resize', (e) => {
    if (!petSizing) e.preventDefault();
  });

  watchPetResize();

  petWin.on('closed', () => { petWin = null; });
  return petWin;
}

function showPet() {
  createPetWindow();
  if (!petWin.isVisible()) petWin.showInactive();
  store.setPet({ visible: true });
}

function hidePet() {
  if (petWin && !petWin.isDestroyed()) petWin.hide();
  store.setPet({ visible: false });
}

function togglePet() {
  const visible = petWin && !petWin.isDestroyed() && petWin.isVisible();
  if (visible) hidePet(); else showPet();
  refreshTrayMenu();
  return !visible;
}

function petBubble(todo) {
  if (petWin && !petWin.isDestroyed() && petWin.isVisible()) {
    petWin.webContents.send('pet:bubble', { id: todo.id, text: todo.text });
  }
}

// ==================================================================== 轻量编辑窗

/**
 * 桌宠右键菜单里点「待办 / 时间 / 间隔」时弹出的小窗。
 * Electron 没有原生 prompt()，而且这里要的是贴着背景图风格的卡片，
 * 所以自己画一个。
 */
function openPrompt(mode) {
  const todo = contextTodo();
  if (!todo && mode !== 'new') {
    // 没有任何在跑的待办 —— 直接让用户建一条
    mode = 'new';
  }

  if (promptWin && !promptWin.isDestroyed()) promptWin.close();

  let init = '';
  if (todo) {
    if (mode === 'text') init = todo.text;
    else if (mode === 'due') init = todo.dueAt ? toLocalInput(todo.dueAt) : '';
    else if (mode === 'interval') init = String(todo.intervalMin || 0);
    else if (mode === 'repeat') init = todo.repeat ? `${todo.repeat.every}:${todo.repeat.unit}` : '';
  }

  // 按各模式的内容量给高度：带说明文字的要多留一截
  const PROMPT_H = { text: 196, due: 200, interval: 220, repeat: 220, new: 268 };

  promptWin = new BrowserWindow({
    width: 400,
    height: PROMPT_H[mode] || 200,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  promptWin.loadFile(path.join(RENDERER, 'prompt.html'), {
    query: { mode, init, text: todo ? todo.text : '' },
  });
  promptWin.once('ready-to-show', () => promptWin.show());
  promptWin.on('closed', () => { promptWin = null; });

  const parent = mainWin && !mainWin.isDestroyed() ? mainWin : null;
  if (parent) parent.focus();
  return promptWin;
}

function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ==================================================================== 托盘

function buildTrayMenu() {
  const todos = store.get().todos.filter(t => !t.done);
  const upcoming = todos
    .filter(t => t.enabled && t.dueAt)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, 6);

  const items = [];

  for (const t of upcoming) {
    const label = (t.text || '(无内容)').slice(0, 24);
    items.push({
      label: `${label}   —   ${fmtDateTime(t.dueAt)}`,
      click: () => { summonMainWindow(); mainWin.webContents.send('ui:focusTodo', t.id); },
    });
  }
  if (upcoming.length) items.push({ type: 'separator' });

  items.push(
    { label: '打开主界面', click: () => summonMainWindow() },
    { label: '暂停全部提醒', enabled: todos.some(t => t.enabled), click: () => {
        for (const t of store.get().todos) t.enabled = false;
        store.save(); broadcastTodos(); refreshTrayMenu();
      } },
    {
      label: petWin && petWin.isVisible() ? '隐藏桌宠' : '显示桌宠',
      click: () => { togglePet(); },
    },
    { type: 'separator' },
    {
      label: '完全退出',
      click: () => { reallyQuitting = true; app.quit(); },
    },
  );

  return Menu.buildFromTemplate(items);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('tsumugi-reminder');
  tray.on('click', () => summonMainWindow());
  tray.on('double-click', () => summonMainWindow());
  refreshTrayMenu();
  return tray;
}

// ==================================================================== 广播

function broadcastTodos() {
  const todos = store.get().todos;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('todos:changed', todos);
  }
  refreshTrayMenu();
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** 图片改动之后要连带处理的事：桌宠换图要重算窗口，换立绘还要重刷图标 */
function afterImagesChanged(key, result) {
  if (key === 'pet') {
    applyPetSize();
    refreshIcons();
  }
  broadcast('images:changed', { key, result: result || {} });
  refreshTrayMenu();
}

function sendSound() {
  const cfg = store.get().sound;
  let data = null;
  if (cfg.mode === 'custom' && cfg.file) {
    const buf = sound.readSound(store.getSoundsDir(), cfg.file);
    if (buf) data = buf;
  }
  return { config: cfg, data };
}

// ==================================================================== 提醒触发

function onFire(todo, kind) {
  summonMainWindow();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('alert:fire', { todo, kind });
  }
  petBubble(todo);
}

// ==================================================================== IPC

function wireIpc() {
  // ---- 待办
  ipcMain.handle('todos:list', () => store.get().todos);

  ipcMain.handle('todos:add', (_e, fields) => {
    const t = store.addTodo(fields);
    broadcastTodos();
    return t;
  });

  ipcMain.handle('todos:update', (_e, id, patch) => {
    const t = store.updateTodo(id, patch);
    broadcastTodos();
    return t;
  });

  ipcMain.handle('todos:remove', (_e, id) => {
    scheduler.forget(id);
    const ok = store.removeTodo(id);
    broadcastTodos();
    return ok;
  });

  ipcMain.handle('todos:action', (_e, id, action, arg) => {
    let t = null;
    if (action === 'complete') t = scheduler.complete(id);
    else if (action === 'dismiss') t = scheduler.dismiss(id);
    else if (action === 'snooze') t = scheduler.snooze(id, arg);
    broadcastTodos();
    return t;
  });

  // ---- 设置
  ipcMain.handle('settings:get', () => ({
    sound: store.get().sound,
    snoozeMin: store.get().snoozeMin,
    petHeight: store.get().pet.height,
  }));

  ipcMain.handle('settings:snoozeMin', (_e, v) => {
    const n = Math.max(1, Math.min(120, Math.round(Number(v) || 5)));
    store.get().snoozeMin = n;
    store.save();
    return n;
  });

  // ---- 自动更新
  ipcMain.handle('update:status', () => updater.getStatus());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => updater.install());

  // ---- 主窗口控制
  ipcMain.handle('window:minimize', () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.minimize();
  });

  ipcMain.handle('window:close', () => {
    // 走 close() 而不是直接退出 —— 这样主进程的 close 拦截才会
    // 弹出「完全退出 / 留在后台」那个选择框
    if (mainWin && !mainWin.isDestroyed()) mainWin.close();
  });

  // ---- 提示音
  ipcMain.handle('sound:get', () => sendSound());

  ipcMain.handle('sound:pick', async () => {
    const parent = mainWin && !mainWin.isDestroyed() ? mainWin : undefined;
    const res = await dialog.showOpenDialog(parent, {
      title: '选择提示音',
      properties: ['openFile'],
      filters: sound.FILTERS,
    });
    if (res.canceled || !res.filePaths.length) return null;

    let imported;
    try {
      imported = sound.importSound(store.getSoundsDir(), res.filePaths[0]);
    } catch (err) {
      dialog.showMessageBox(parent, { type: 'error', title: '无法添加', message: err.message });
      return null;
    }
    if (!imported) return null;

    const old = store.get().sound.file;
    const cfg = store.setSound({ mode: 'custom', file: imported.file, name: imported.name });
    if (old && old !== imported.file) sound.deleteSound(store.getSoundsDir(), old);
    return sendSound();
  });

  ipcMain.handle('sound:setMode', (_e, mode) => {
    store.setSound({ mode: mode === 'custom' && store.get().sound.file ? 'custom' : 'default' });
    return sendSound();
  });

  ipcMain.handle('sound:setVolume', (_e, v) => {
    const vol = Math.max(0, Math.min(1, Number(v) || 0));
    store.setSound({ volume: vol });
    return vol;
  });

  // ---- 图片
  ipcMain.handle('images:get', () => {
    const out = { src: {}, spec: {}, size: {}, pos: {}, builtin: images.BUILTIN };
    for (const key of store.IMAGE_KEYS) {
      const r = images.readImage(specFor(key));
      out.spec[key] = store.get().images[key];
      out.size[key] = r ? { width: r.width, height: r.height } : null;
      out.src[key] = r ? { mime: r.mime, data: r.data } : null;
    }
    out.pos.splash = store.get().images.splashPos;
    out.pos.main = store.get().images.mainPos;
    out.petHeight = store.get().pet.height;
    out.petRange = [PET_MIN_H, PET_MAX_H];
    out.sprite = { width: petSize.spriteW, height: petSize.spriteH };
    return out;
  });

  ipcMain.handle('images:getOne', (_e, key) => {
    if (!store.IMAGE_KEYS.includes(key)) return null;
    const r = images.readImage(specFor(key));
    return r ? { mime: r.mime, width: r.width, height: r.height, data: r.data } : null;
  });

  ipcMain.handle('images:pick', async (_e, key, opts) => {
    if (!store.IMAGE_KEYS.includes(key)) return { ok: false, error: '未知的图片位置' };

    const parent = mainWin && !mainWin.isDestroyed() ? mainWin : undefined;
    const res = await dialog.showOpenDialog(parent, {
      title: key === 'pet' ? '选择桌宠立绘' : '选择背景图',
      properties: ['openFile'],
      filters: images.FILTERS,
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };

    try {
      const result = key === 'pet'
        ? images.importSprite(res.filePaths[0], !(opts && opts.cutout === false))
        : images.importBackground(res.filePaths[0]);

      const old = store.get().images[key];
      if (old && old.source === 'custom' && old.file !== result.file) {
        images.removeImage(old.file);
      }
      store.setImage(key, { source: 'custom', file: result.file });
      afterImagesChanged(key, result);
      return { ok: true, ...result };
    } catch (err) {
      dialog.showMessageBox(parent, { type: 'error', title: '无法使用这张图', message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('images:setBuiltin', (_e, key, builtinKey) => {
    if (!store.IMAGE_KEYS.includes(key)) return null;
    const table = images.BUILTIN[key] || {};
    const old = store.get().images[key];
    if (old && old.source === 'custom') images.removeImage(old.file);
    store.setImage(key, { source: 'builtin', key: table[builtinKey] ? builtinKey : 'default' });
    afterImagesChanged(key, {});
    return store.get().images[key];
  });

  ipcMain.handle('images:setPos', (_e, key, patch) => {
    const v = store.setImagePos(key, patch);
    if (v) broadcast('images:changed', { key, posOnly: true });
    return v;
  });

  ipcMain.handle('pet:setHeight', (_e, px) => {
    const h = Math.min(PET_MAX_H, Math.max(PET_MIN_H, Math.round(Number(px) || 460)));
    store.setPet({ height: h });
    applyPetSize();
    broadcast('images:changed', { key: 'pet', sizeOnly: true });
    return { height: h, size: petSize };
  });

  // ---- 桌宠
  ipcMain.handle('pet:show', () => { showPet(); return true; });
  ipcMain.handle('pet:hide', () => { hidePet(); return false; });
  ipcMain.handle('pet:toggle', () => togglePet());

  // 逐像素点击穿透：鼠标划到立绘透明区域时把窗口放行给底下的窗口
  ipcMain.handle('pet:ignoreMouse', (_e, ignore) => {
    if (!petWin || petWin.isDestroyed()) return;
    petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.handle('pet:dragStart', (_e, sx, sy) => {
    if (!petWin || petWin.isDestroyed()) return;
    const [wx, wy] = petWin.getPosition();
    petDrag = { sx, sy, wx, wy };
  });

  ipcMain.handle('pet:dragMove', (_e, sx, sy) => {
    if (!petDrag || !petWin || petWin.isDestroyed()) return;
    const nx = Math.round(petDrag.wx + sx - petDrag.sx);
    const ny = Math.round(petDrag.wy + sy - petDrag.sy);

    // 拖的时候也要收敛，否则能把桌宠整个拖出屏幕外，用户就再也找不回来了。
    // 允许留 80px 露在外面，方便往边缘塞。
    const area = screen.getPrimaryDisplay().workArea;
    petWin.setPosition(
      Math.min(Math.max(nx, area.x - petSize.width + 80), area.x + area.width - 80),
      Math.min(Math.max(ny, area.y), area.y + area.height - 80)
    );
  });

  ipcMain.handle('pet:dragEnd', () => {
    if (petWin && !petWin.isDestroyed()) {
      const [x, y] = petWin.getPosition();
      store.setPet({ x, y });
    }
    petDrag = null;
  });

  ipcMain.handle('pet:openMain', () => { summonMainWindow(); });

  ipcMain.handle('pet:contextMenu', () => { showPetMenu(); });

  // ---- 轻量编辑窗
  ipcMain.handle('prompt:open', (_e, mode) => { openPrompt(mode); });
  ipcMain.handle('prompt:close', () => { if (promptWin && !promptWin.isDestroyed()) promptWin.close(); });

  ipcMain.handle('prompt:submit', (_e, mode, value) => {
    let todo = contextTodo();

    if (mode === 'new') {
      const text = String(value.text || '').trim();
      if (!text) return null;
      todo = store.addTodo({
        text,
        dueAt: value.dueAt ? new Date(value.dueAt).getTime() : Date.now() + 3600000,
        intervalMin: Number(value.intervalMin) || 0,
      });
      broadcastTodos();
      return todo;
    }

    if (!todo) return null;
    const patch = {};
    if (mode === 'text') {
      patch.text = String(value).trim();
      if (!patch.text) return null;
    } else if (mode === 'due') {
      const ms = new Date(value).getTime();
      if (!Number.isFinite(ms)) return null;
      patch.dueAt = ms;
      patch.done = false;
    } else if (mode === 'interval') {
      patch.intervalMin = Math.max(0, Math.round(Number(value) || 0));
    } else if (mode === 'repeat') {
      const [every, unit] = String(value).split(':');
      patch.repeat = Number(every) > 0 ? { every: Number(every), unit } : null;
    }
    const t = store.updateTodo(todo.id, patch);
    // 改完时间要让调度器重新武装，否则这次修改可能被当成已经响过
    scheduler.forget(todo.id);
    broadcastTodos();
    return t;
  });

  // ---- 退出
  ipcMain.handle('quit:choose', (_e, choice) => {
    if (choice === 'exit') {
      reallyQuitting = true;
      app.quit();
      return;
    }
    createTray();
    if (choice === 'pet') showPet(); else hidePet();
    if (mainWin && !mainWin.isDestroyed()) mainWin.hide();
    refreshTrayMenu();
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    petVisible: !!(petWin && !petWin.isDestroyed() && petWin.isVisible()),
    petHeight: store.get().pet.height,
    snoozeMin: store.get().snoozeMin,
    platforms: process.platform,
  }));
}

// ==================================================================== 桌宠右键菜单

function showPetMenu() {
  if (!petWin || petWin.isDestroyed()) return;
  const todo = contextTodo();

  const intervalItems = [0, 5, 10, 15, 30, 60].map(min => ({
    label: fmtInterval(min),
    type: 'radio',
    checked: (todo ? todo.intervalMin : 0) === min,
    click: () => {
      if (!todo) return;
      store.updateTodo(todo.id, { intervalMin: min });
      scheduler.forget(todo.id);
      broadcastTodos();
    },
  }));

  const repeatItems = [
    { label: '不重复', type: 'radio', checked: !todo || !todo.repeat,
      click: () => setRepeat(todo, null) },
    ...[['1:hour', '每小时'], ['1:day', '每天'], ['1:week', '每周'], ['1:min', '每分钟']].map(([v, label]) => ({
      label,
      type: 'radio',
      checked: !!todo && todo.repeat && `${todo.repeat.every}:${todo.repeat.unit}` === v,
      click: () => { const [e, u] = v.split(':'); setRepeat(todo, { every: Number(e), unit: u }); },
    })),
  ];

  const template = [
    {
      label: todo ? `待办：${(todo.text || '(无内容)').slice(0, 20)}` : '待办：（暂无进行中的）',
      click: () => openPrompt('text'),
    },
    {
      label: `提醒时间：${todo ? fmtDateTime(todo.dueAt) : '——'}`,
      click: () => openPrompt('due'),
    },
    {
      label: `提醒间隔：${todo ? fmtInterval(todo.intervalMin) : '——'}`,
      submenu: intervalItems,
    },
    {
      label: `周期重复：${todo ? fmtRepeat(todo.repeat) : '——'}`,
      submenu: repeatItems,
    },
    { type: 'separator' },
    { label: todo ? '完成这条' : '新建待办…', click: () => {
        if (todo) scheduler.complete(todo.id); else openPrompt('new');
        broadcastTodos();
      } },
    { label: '稍后提醒 5 分钟', enabled: !!todo, click: () => { if (todo) { scheduler.snooze(todo.id, store.get().snoozeMin); broadcastTodos(); } } },
    { type: 'separator' },
    { label: '打开主界面', click: () => summonMainWindow() },
    { label: '隐藏桌宠', click: () => { hidePet(); refreshTrayMenu(); } },
    { label: '完全退出', click: () => { reallyQuitting = true; app.quit(); } },
  ];

  Menu.buildFromTemplate(template).popup({ window: petWin });
}

function setRepeat(todo, repeat) {
  if (!todo) return;
  store.updateTodo(todo.id, { repeat });
  scheduler.forget(todo.id);
  broadcastTodos();
}

// ==================================================================== 启动

if (!app.requestSingleInstanceLock()) {
  // 已经有了一个实例在跑（很可能就缩在托盘里），把它叫出来就行了
  app.quit();
} else {
  app.on('second-instance', () => summonMainWindow());

  app.setAppUserModelId('com.ys.reminder');

  app.whenReady().then(() => {
    store.init(app.getPath('userData'));
    store.load();
    images.init(ASSETS, path.join(app.getPath('userData'), 'images'));
    petSize = computePetSize();

    scheduler = new Scheduler(store, onFire, broadcastTodos);
    scheduler.start();

    wireIpc();
    createMainWindow();

    // 更新状态一路推给界面，用户不用自己去点「检查更新」也能看到
    updater.init((st) => broadcast('update:status', st));

    // 上次退出时选择了留在后台，这次启动就把桌宠一并还原
    if (store.get().pet.visible) {
      createTray();
      showPet();
    }

    // 睡眠唤醒 / 解锁之后立刻重新对表：心跳虽然一直在跑，但唤醒瞬间
    // 补一拍能让「睡觉期间到点的提醒」立即弹出，而不用等下一个 250ms。
    powerMonitor.on('resume', () => scheduler.resync());
    powerMonitor.on('unlock-screen', () => scheduler.resync());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      else summonMainWindow();
    });
  });

  app.on('before-quit', () => { reallyQuitting = true; });

  // 关掉主窗口不代表退出 —— 可能还要在托盘/桌宠里继续提醒
  app.on('window-all-closed', () => { /* 故意留空 */ });
}
