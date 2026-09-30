/**
 * 把 assets/人物立绘.jpg 的棋盘格底抠成真正的透明通道。
 *
 * 这张图原本是带 alpha 的 PNG，被导出成 JPG 之后透明区域被烧成了
 * 32px 的灰白棋盘格（#ffffff / #ededed）压在像素里。所以这里不能用
 * "颜色接近白就透明" 的粗暴做法 —— 角色的水手领、皮肤高光、浅蓝裙摆
 * 同样接近白色，会被一起打穿。
 *
 * 用的是「边缘连通域」判定：只有和画布四条边连通、且呈灰阶高亮的像素
 * 才算背景。角色内部的白是封闭区域，够不到边缘，因此天然免疫。
 *
 * 用法：npm run cutout
 * 输出：assets/pet.png（透明全身立绘）、assets/tray.png（托盘头像）
 * 原始的 人物立绘.jpg 不会被修改。
 */

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', '人物立绘.jpg');
const OUT_PET = path.join(ROOT, 'assets', 'pet.png');
const OUT_TRAY = path.join(ROOT, 'assets', 'tray.png');
const OUT_ICON = path.join(ROOT, 'assets', 'icon.ico');
const OUT_ICON_PNG = path.join(ROOT, 'assets', 'icon.png');

// 棋盘格判定阈值。因为只在边缘连通域里生效，可以放得比较宽，
// 这样连角色周围那圈 JPEG 压缩振铃也能一并吃掉，边缘更干净。
const GRAY_TOL = 18;   // max-min 低于此值视为灰阶
const MIN_LUM = 208;   // 最低亮度
const MIN_BLOB = 120;  // 小于这么多像素的残留块当作压缩噪点丢掉
const CROP_PAD = 8;    // 裁剪时在角色四周留的余量

function log(...a) { console.log(...a); }

// ---------------------------------------------------------------- 读取

log('读取', path.relative(ROOT, SRC));
const img = jpeg.decode(fs.readFileSync(SRC), { useTArray: true });
const W = img.width, H = img.height, N = W * H;
const src = img.data;
log(`  ${W} x ${H}  (${(N / 1e6).toFixed(2)}M 像素)`);

// ---------------------------------------------------------------- 1. 标记候选背景

const cand = new Uint8Array(N);
let candCount = 0;
for (let i = 0; i < N; i++) {
  const r = src[i * 4], g = src[i * 4 + 1], b = src[i * 4 + 2];
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  if (mx - mn <= GRAY_TOL && mn >= MIN_LUM) { cand[i] = 1; candCount++; }
}
log(`候选背景像素 ${candCount} (${(candCount / N * 100).toFixed(1)}%)`);

// ---------------------------------------------------------------- 2. 从四边洪泛，取连通域

const bg = new Uint8Array(N);       // 1 = 确认是背景
const stack = [];
function seed(x, y) {
  const i = y * W + x;
  if (!bg[i] && cand[i]) { bg[i] = 1; stack.push(i); }
}
for (let x = 0; x < W; x++) { seed(x, 0); seed(x, H - 1); }
for (let y = 0; y < H; y++) { seed(0, y); seed(W - 1, y); }

while (stack.length) {
  const i = stack.pop();
  const x = i % W, y = (i / W) | 0;
  if (x > 0) seed(x - 1, y);
  if (x < W - 1) seed(x + 1, y);
  if (y > 0) seed(x, y - 1);
  if (y < H - 1) seed(x, y + 1);
}

let bgCount = 0;
for (let i = 0; i < N; i++) bgCount += bg[i];
log(`边缘连通背景 ${bgCount} (${(bgCount / N * 100).toFixed(1)}%)`);

// ---------------------------------------------------------------- 3. 腐蚀 1px

// 角色边缘那 1px 是被棋盘格污染过的过渡色，留着会形成一圈浅灰描边。
// 直接削掉一圈，反正角色轮廓是深色头发/袜子，少 1px 肉眼看不出来。
let keep = new Uint8Array(N);
for (let i = 0; i < N; i++) keep[i] = bg[i] ? 0 : 1;

function erode(srcMask) {
  const out = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!srcMask[i]) continue;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (!srcMask[i + dy * W + dx]) { all = 0; break; }
      out[i] = all;
    }
  }
  return out;
}
keep = erode(keep);
log('腐蚀 1px 完成');

// ---------------------------------------------------------------- 4. 丢掉小块残留

// 洪泛漏不掉的压缩噪点会以孤立小块的形式留在背景里，按连通域大小过滤。
const label = new Int32Array(N).fill(-1);
const blobs = [];
const stack2 = [];
for (let start = 0; start < N; start++) {
  if (!keep[start] || label[start] !== -1) continue;
  const id = blobs.length;
  let size = 0, minx = W, maxx = -1, miny = H, maxy = -1;
  label[start] = id; stack2.push(start);
  while (stack2.length) {
    const i = stack2.pop();
    const x = i % W, y = (i / W) | 0;
    size++;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1,
                y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of nb) if (j >= 0 && keep[j] && label[j] === -1) { label[j] = id; stack2.push(j); }
  }
  blobs.push({ id, size, minx, maxx, miny, maxy });
}
const survivable = blobs.filter(b => b.size >= MIN_BLOB);
log(`连通块 ${blobs.length} 个，保留 ${survivable.length} 个（>=${MIN_BLOB}px）`);
for (const b of blobs) if (b.size < MIN_BLOB) log(`  丢弃噪点块 ${b.size}px @ (${b.minx},${b.miny})`);

const keepIds = new Set(survivable.map(b => b.id));
for (let i = 0; i < N; i++) if (keep[i] && !keepIds.has(label[i])) keep[i] = 0;

// ---------------------------------------------------------------- 5. alpha 羽化

const a0 = new Float32Array(N);
for (let i = 0; i < N; i++) a0[i] = keep[i] ? 1 : 0;

const a1 = new Float32Array(N);
const K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let acc = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      for (let dx = -1; dx <= 1; dx++, k++) {
        const xx = x + dx;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; // 越界按 0 处理
        acc += a0[yy * W + xx] * K[k];
      }
    }
    a1[y * W + x] = acc / 16;
  }
}
log('alpha 羽化完成');

// ---------------------------------------------------------------- 6. 裁剪到角色包围盒

let minx = W, maxx = -1, miny = H, maxy = -1;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (a1[y * W + x] > 0.02) {
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }

const cx0 = Math.max(0, minx - CROP_PAD), cx1 = Math.min(W - 1, maxx + CROP_PAD);
const cy0 = Math.max(0, miny - CROP_PAD), cy1 = Math.min(H - 1, maxy + CROP_PAD);
const CW = cx1 - cx0 + 1, CH = cy1 - cy0 + 1;
log(`角色包围盒 x[${minx},${maxx}] y[${miny},${maxy}]  →  裁出 ${CW} x ${CH}`);

const pet = new PNG({ width: CW, height: CH });
for (let y = 0; y < CH; y++) {
  for (let x = 0; x < CW; x++) {
    const si = (y + cy0) * W + (x + cx0);
    const di = (y * CW + x) << 2;
    pet.data[di] = src[si * 4];
    pet.data[di + 1] = src[si * 4 + 1];
    pet.data[di + 2] = src[si * 4 + 2];
    pet.data[di + 3] = Math.round(a1[si] * 255);
  }
}
fs.writeFileSync(OUT_PET, PNG.sync.write(pet));
log(`写入 ${path.relative(ROOT, OUT_PET)}  ${(fs.statSync(OUT_PET).size / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- 7. 裁一张托盘头像

// 取角色顶部约 24% 那块（头 + 双马尾）的包围盒，居中裁正方形再缩到 64px。
const headBandY1 = Math.min(CH - 1, Math.round(CH * 0.24));
let hminx = CW, hmaxx = -1, hminy = CH, hmaxy = -1;
for (let y = 0; y < headBandY1; y++)
  for (let x = 0; x < CW; x++)
    if (a1[(y + cy0) * W + (x + cx0)] > 0.5) {
      if (x < hminx) hminx = x; if (x > hmaxx) hmaxx = x;
      if (y < hminy) hminy = y; if (y > hmaxy) hmaxy = y;
    }
const hcx = (hminx + hmaxx) / 2, hcy = (hminy + hmaxy) / 2;
const half = Math.max(hmaxx - hminx, hmaxy - hminy) / 2 * 1.06;
const sx0 = Math.round(hcx - half), sy0 = Math.round(hcy - half);
const side = Math.round(half * 2);
log(`头部包围盒 x[${hminx},${hmaxx}] y[${hminy},${hmaxy}] → 托盘取 ${side}px 方形`);

/**
 * 把 pet.png 坐标系里的一块正方形区域重采样成 dst×dst 的 RGBA。
 * 先按 alpha 加权求色再反解，避免透明像素把边缘往黑里拉（直接平均的话，
 * 立绘边缘那圈 alpha=0 的像素会参与进来，缩出来一圈脏边）。
 */
function resampleSquare(px0, py0, srcSide, dst) {
  const out = Buffer.alloc(dst * dst * 4);
  for (let y = 0; y < dst; y++) {
    for (let x = 0; x < dst; x++) {
      const bx0 = px0 + Math.floor(x * srcSide / dst), bx1 = px0 + Math.floor((x + 1) * srcSide / dst);
      const by0 = py0 + Math.floor(y * srcSide / dst), by1 = py0 + Math.floor((y + 1) * srcSide / dst);
      let r = 0, g = 0, b = 0, acc = 0, n = 0;
      for (let sy = by0; sy < Math.max(by1, by0 + 1); sy++) {
        for (let sxx = bx0; sxx < Math.max(bx1, bx0 + 1); sxx++, n++) {
          if (sxx < 0 || sy < 0 || sxx >= CW || sy >= CH) continue;
          const si = (sy + cy0) * W + (sxx + cx0);
          const al = a1[si];
          r += src[si * 4] * al; g += src[si * 4 + 1] * al; b += src[si * 4 + 2] * al;
          acc += al;
        }
      }
      const di = (y * dst + x) << 2;
      if (acc > 0.0001) {
        out[di] = Math.round(r / acc);
        out[di + 1] = Math.round(g / acc);
        out[di + 2] = Math.round(b / acc);
        out[di + 3] = Math.round(Math.min(1, acc / Math.max(1, n)) * 255);
      }
    }
  }
  return out;
}

// ---- 托盘图标：透明底，只有头像
const TRAY = 64;
const tray = new PNG({ width: TRAY, height: TRAY });
resampleSquare(sx0, sy0, side, TRAY).copy(tray.data);
fs.writeFileSync(OUT_TRAY, PNG.sync.write(tray));
log(`写入 ${path.relative(ROOT, OUT_TRAY)}  ${(fs.statSync(OUT_TRAY).size / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------- 8. 应用图标

/**
 * exe 图标。Windows 要求 ICO 里至少有一张 256×256，光有托盘那张 64×64
 * 会打不出像样的图标（或者干脆报错）。
 *
 * 顺带做了个底色：纯透明头像在任务栏和桌面上会显得像张没做完的贴纸，
 * 加一层和立绘同色系的淡蓝圆角底，缩到 16px 也还认得出。
 */
function makeIcon(size) {
  const inner = Math.round(size * 0.88);
  const off = Math.round((size - inner) / 2);
  const head = resampleSquare(sx0, sy0, side, inner);
  const png = new PNG({ width: size, height: size });
  const rad = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const di = (y * size + x) << 2;
      const t = size > 1 ? y / (size - 1) : 0;
      let r = 234 + (186 - 234) * t;
      let g = 241 + (211 - 241) * t;
      let b = 255 + (240 - 255) * t;

      const hx = x - off, hy = y - off;
      if (hx >= 0 && hy >= 0 && hx < inner && hy < inner) {
        const hi = (hy * inner + hx) << 2;
        const ha = head[hi + 3] / 255;
        r = head[hi] * ha + r * (1 - ha);
        g = head[hi + 1] * ha + g * (1 - ha);
        b = head[hi + 2] * ha + b * (1 - ha);
      }

      // 圆角遮罩（带一点抗锯齿）
      const cx = Math.min(Math.max(x + 0.5, rad), size - rad);
      const cy = Math.min(Math.max(y + 0.5, rad), size - rad);
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const a = Math.min(1, Math.max(0, rad + 0.5 - Math.sqrt(dx * dx + dy * dy)));

      png.data[di] = Math.round(r);
      png.data[di + 1] = Math.round(g);
      png.data[di + 2] = Math.round(b);
      png.data[di + 3] = Math.round(a * 255);
    }
  }
  return PNG.sync.write(png);
}

/** 打包成多尺寸 ICO。Vista 之后允许直接内嵌 PNG，不用老的 BMP 格式。 */
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const e = 16 * i;
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e);      // 0 表示 256
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
    entries.writeUInt8(0, e + 2);           // 调色板数
    entries.writeUInt8(0, e + 3);           // reserved
    entries.writeUInt16LE(1, e + 4);        // 色彩平面
    entries.writeUInt16LE(32, e + 6);       // 位深
    entries.writeUInt32LE(img.buf.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.buf.length;
  });

  return Buffer.concat([header, entries, ...images.map(i => i.buf)]);
}

const SIZES = [16, 32, 48, 64, 128, 256];
const rendered = SIZES.map(size => ({ size, buf: makeIcon(size) }));
fs.writeFileSync(OUT_ICON, packIco(rendered));
log(`写入 ${path.relative(ROOT, OUT_ICON)}  ${(fs.statSync(OUT_ICON).size / 1024).toFixed(1)} KB  (${SIZES.join('/')})`);

// 再单独存一张 256 PNG，README 和非 Windows 平台都用得上
fs.writeFileSync(OUT_ICON_PNG, makeIcon(256));
log(`写入 ${path.relative(ROOT, OUT_ICON_PNG)}`);

log('\n完成。原图未被修改。');
