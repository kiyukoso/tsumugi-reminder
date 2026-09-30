'use strict';

/* ==========================================================================
   桌面桌宠
   ========================================================================== */

const img = document.getElementById('pet');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubbleText');

// ------------------------------------------------------------------ 逐像素命中

/**
 * 立绘被裁到角色包围盒，但框里仍有大约三成是空的 —— 主要是双马尾之间、
 * 裙摆两侧。不处理的话这些区域会挡住底下窗口的点击，桌面宠物会变得很碍事。
 *
 * 做法：把立绘缩到 1/4 画进离屏 canvas，取一份 alpha 表。鼠标移动时查表，
 * 落在透明处就把整个窗口设为「穿透」，交给底下的窗口处理。
 *
 * 穿透时用 forward: true，这样即使窗口已经不听点击了，mousemove 依然会
 * 转发过来 —— 否则鼠标一旦滑出去就再也收不回来，桌宠会永久失去交互。
 */
const MASK_SCALE = 4;
let mask = null, maskW = 0, maskH = 0;
let ignoring = null;

function buildMask() {
  // 按立绘「实际画出来的尺寸」建表，而不是窗口尺寸 —— 窗口比立绘宽一圈
  // 也高出一截（头顶那块是留给气泡的），两者不能混为一谈。
  const r = img.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const w = Math.max(1, Math.round(r.width / MASK_SCALE));
  const h = Math.max(1, Math.round(r.height / MASK_SCALE));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = d[i * 4 + 3];
  mask = m; maskW = w; maskH = h;
}

// 阈值放宽一点，让贴着轮廓的一圈也算「在角色上」，
// 免得边缘像素让鼠标一抖一抖地在穿透/不穿透之间跳
const ALPHA_MIN = 46;

function alphaAt(clientX, clientY) {
  if (!mask) return 255;
  const r = img.getBoundingClientRect();
  const x = Math.floor((clientX - r.left) / r.width * maskW);
  const y = Math.floor((clientY - r.top) / r.height * maskH);
  if (x < 0 || y < 0 || x >= maskW || y >= maskH) return 0;
  return mask[y * maskW + x];
}

/** 鼠标是否落在该由桌宠接收的区域：立绘不透明处，或正在显示的提醒气泡 */
function isInteractive(clientX, clientY) {
  if (bubble.classList.contains('show')) {
    const br = bubble.getBoundingClientRect();
    if (clientX >= br.left && clientX <= br.right &&
        clientY >= br.top && clientY <= br.bottom) return true;
  }
  return alphaAt(clientX, clientY) >= ALPHA_MIN;
}

function setIgnore(next) {
  if (next === ignoring) return;
  ignoring = next;
  window.api.petIgnoreMouse(next);
  document.body.classList.toggle('over', !next);
}

document.addEventListener('mousemove', (e) => {
  if (dragging) { setIgnore(false); return; }
  setIgnore(!isInteractive(e.clientX, e.clientY));
});

// 鼠标离开窗口时恢复成可交互，否则下次移回来会因为还是穿透状态而收不到事件
document.addEventListener('mouseleave', () => setIgnore(false));

// ------------------------------------------------------------------ 拖动 / 单击

// 阈值区分「拖动窗口」和「点一下进应用」：按住后移动超过 4px 才算拖，
// 原地松手才算点。
const DRAG_THRESHOLD = 4;

let pressed = false;
let dragging = false;
let startX = 0, startY = 0;

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  pressed = true;
  dragging = false;
  startX = e.screenX;
  startY = e.screenY;
  window.api.petDragStart(e.screenX, e.screenY);
});

document.addEventListener('mousemove', (e) => {
  if (!pressed || dragging) {
    if (dragging) window.api.petDragMove(e.screenX, e.screenY);
    return;
  }
  if (Math.abs(e.screenX - startX) > DRAG_THRESHOLD || Math.abs(e.screenY - startY) > DRAG_THRESHOLD) {
    dragging = true;
    window.api.petDragMove(e.screenX, e.screenY);
  }
});

document.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !pressed) return;
  pressed = false;
  if (dragging) {
    window.api.petDragEnd();
    dragging = false;
  } else {
    // 原地单击 = 打开主界面
    window.api.petOpenMain();
  }
});

// 拖动过程中鼠标跑出窗口，仍然要收尾并保存位置
window.addEventListener('blur', () => {
  if (dragging) { window.api.petDragEnd(); dragging = false; }
  pressed = false;
});

// ------------------------------------------------------------------ 右键菜单

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.petContextMenu();
});

// ------------------------------------------------------------------ 提醒气泡

let bubbleTimer = null;

function showBubble(text) {
  bubbleText.textContent = text || '(无内容)';
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 9000);
}

window.api.onPetBubble((payload) => showBubble(payload.text));

// 无需单独给气泡绑点击：气泡区域已被 isInteractive 判为可交互，
// 而 mousedown/mouseup 是挂在 document 上的，点它自然会走「打开主界面」。

// ------------------------------------------------------------------ 初始化

// 立绘是从主进程取来的（可能是用户自定义的），用 blob URL 交给 <img>。
// 不用 file:// 是因为用户选的文件名很可能是中文，路径编码容易出岔子。
let spriteUrl = null;
let staleUrl = null;

async function loadSprite() {
  const r = await window.api.getImage('pet');
  if (!r) return;
  const url = URL.createObjectURL(new Blob([r.data], { type: r.mime }));
  staleUrl = spriteUrl;
  spriteUrl = url;
  img.src = url;
}

img.addEventListener('load', () => {
  buildMask();
  // 新图加载完成之后再释放旧的 blob，避免出现空白帧
  if (staleUrl) { URL.revokeObjectURL(staleUrl); staleUrl = null; }
});

// 主进程改窗口大小之后，布局要等一帧才稳定，那时再重建 alpha 表
let resizePending = false;
window.addEventListener('resize', () => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => { resizePending = false; buildMask(); });
});

window.addEventListener('beforeunload', () => {
  if (spriteUrl) URL.revokeObjectURL(spriteUrl);
});

window.api.onPetSpriteChanged(loadSprite);
loadSprite();
