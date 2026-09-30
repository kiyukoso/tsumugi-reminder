'use strict';

/**
 * 自定义图片：内置图解析、外部图导入、以及桌宠立绘的抠图。
 *
 * 全程只用 Electron 自带的 nativeImage，不引入任何原生依赖 ——
 * 它能读 JPG/PNG/WEBP/BMP，toBitmap() 给出 BGRA 原始像素，
 * createFromBitmap().toPNG() 再编码回去，足够做完整个抠图流程。
 *
 * 抠图这里比 tools/cutout.js 更通用。那个脚本是给一张已知的图写的，
 * 判定写死成「灰阶 + 高亮」（棋盘格长那样）；这里是任意用户图片，
 * 所以改成先从四边采样聚类出背景调色板，再按调色板洪泛 ——
 * 棋盘格的两个色、纯色底的一个色都能覆盖。
 */

const fs = require('fs');
const path = require('path');

/**
 * 懒加载 electron。
 *
 * 目的是把纯像素处理（调色板采样、洪泛抠图、裁剪）从 Electron 运行时里
 * 解耦出来 —— 抠图是整个应用里最容易出错、也最值得测的一块，这样
 * tools/_selftest.js 就能在纯 Node 下直接跑它，不用起界面。
 */
let _ni = null;
function ni() {
  if (!_ni) ({ nativeImage: _ni } = require('electron'));
  return _ni;
}

// 内置图。key 是给界面用的稳定标识，值是 assets 下的文件名。
const BUILTIN = {
  splash: { default: { file: '背景图2.jpg', label: '背景图2' } },
  main: {
    default: { file: '背景图1.jpg', label: '背景图1' },
    alt: { file: '替换图1.jpg', label: '替换图1' },
  },
  pet: { default: { file: 'pet.png', label: '初始立绘' } },
};

const FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' };

const MAX_BYTES = 20 * 1024 * 1024;   // 20MB：再大解码会明显卡顿

const FILTERS = [
  { name: '图片', extensions: FORMATS },
  { name: '全部文件', extensions: ['*'] },
];

let assetsDir = null;
let imagesDir = null;

function init(a, i) {
  assetsDir = a;
  imagesDir = i;
  fs.mkdirSync(imagesDir, { recursive: true });
}

function mimeOf(file) {
  return MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
}

// ------------------------------------------------------------------ 解析

/**
 * 把 store 里的 spec 解析成实际文件路径。
 * spec 形如 { source:'builtin', key:'alt' } 或 { source:'custom', file:'xxx.png' }
 */
function resolvePath(spec) {
  if (!spec || typeof spec !== 'object') return null;

  if (spec.source === 'custom' && spec.file) {
    // 防目录穿越：只接受纯文件名
    if (path.basename(spec.file) !== spec.file) return null;
    const p = path.join(imagesDir, spec.file);
    return fs.existsSync(p) ? p : null;
  }

  const table = BUILTIN[spec.kind] || {};
  const entry = table[spec.key] || table.default;
  if (!entry) return null;
  const p = path.join(assetsDir, entry.file);
  return fs.existsSync(p) ? p : null;
}

/** 读出图片字节交给渲染进程（走字节而不是 file:// ，中文路径不会出岔子） */
function readImage(spec) {
  const p = resolvePath(spec);
  if (!p) return null;
  const size = ni().createFromPath(p).getSize();
  return {
    data: fs.readFileSync(p),
    mime: mimeOf(p),
    width: size.width,
    height: size.height,
  };
}

function spriteSize(spec) {
  const p = resolvePath(spec);
  if (!p) return null;
  const s = ni().createFromPath(p).getSize();
  return s.width && s.height ? s : null;
}

// ------------------------------------------------------------------ 抠图

/**
 * 从四边采样，聚类出背景色（棋盘格会得到两个色，纯色底得到一个）。
 *
 * 判定条件有两条，第二条是踩过坑才加的：
 *
 *   1. 在整圈边缘里占比够大；
 *   2. **至少出现在两条边上**。
 *
 * 只按占比筛会出事：人物立绘的某条边有一圈 JPEG 压缩伪影，中灰 (136,135,135)
 * 堪堪过了 2% 的门槛混进调色板。而它的亮度窗口 [112,160] 正好套住裙子上低彩度的
 * 褶皱阴影，于是整条裙子被啃出一片透明的洞 —— 而 tools/cutout.js 里写死的
 * 「灰阶 + 够亮(min>=208)」从来没这个问题，因为那个亮度下限天然排除了中灰。
 *
 * 真正的背景是铺满画面的，会跨越所有边；边缘伪影只会出现在一条边上。
 * 加这一条就能把后者挡在外面。
 */
const MIN_PALETTE_SHARE = 0.03;   // 占整圈边缘的比例
const MIN_PALETTE_EDGES = 2;      // 至少在几条边上「站得住」
const MIN_EDGE_COVERAGE = 0.1;    // 「站得住」= 占该条边长度的这个比例

function backgroundPalette(bmp, W, H) {
  const buckets = new Map();
  const edgeLen = { T: W, B: W, L: H, R: H };

  const add = (i, edge) => {
    const o = i << 2;
    const b = bmp[o], g = bmp[o + 1], r = bmp[o + 2];
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);   // 量化到 16 级，抗噪
    let e = buckets.get(k);
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0, edges: new Map() }; buckets.set(k, e); }
    e.n++; e.r += r; e.g += g; e.b += b;
    e.edges.set(edge, (e.edges.get(edge) || 0) + 1);
  };

  for (let x = 0; x < W; x++) { add(x, 'T'); add((H - 1) * W + x, 'B'); }
  for (let y = 0; y < H; y++) { add(y * W, 'L'); add(y * W + W - 1, 'R'); }

  const total = 2 * (W + H);
  return [...buckets.values()]
    .filter(e => {
      if (e.n / total < MIN_PALETTE_SHARE) return false;
      // 「出现在这条边上」必须按长度算，不能按有没有算 ——
      // 人物立绘.jpg 的右边缘整列偏暗，同时在左上/右下各有一个孤立的角像素，
      // 按「有没有」计数就是 3 条边，直接蒙混过关。
      let strong = 0;
      for (const [edge, cnt] of e.edges) {
        if (cnt >= edgeLen[edge] * MIN_EDGE_COVERAGE) strong++;
      }
      return strong >= MIN_PALETTE_EDGES;
    })
    .map(e => [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)]);
}

const luma = (r, g, b) => (r * 299 + g * 587 + b * 114) / 1000;

/** 把调色板编译成一个「这个像素算不算背景」的判定函数 */
function makeMatcher(palette) {
  const entries = palette.map(c => {
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    return { c, chroma: mx - mn, lum: luma(c[0], c[1], c[2]) };
  });

  return (bmp, o) => {
    const b = bmp[o], g = bmp[o + 1], r = bmp[o + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = mx - mn;
    const lum = luma(r, g, b);

    for (const e of entries) {
      if (e.chroma <= NEUTRAL_CHROMA) {
        // 中性背景（棋盘格、灰白底）：像素也必须中性，否则裙子/皮肤会被误吞
        if (chroma <= NEUTRAL_CHROMA && Math.abs(lum - e.lum) <= TOL_LUMA) return true;
      } else {
        if (Math.abs(chroma - e.chroma) > TOL_CHROMA) continue;
        const dr = r - e.c[0], dg = g - e.c[1], db = b - e.c[2];
        if (dr * dr + dg * dg + db * db <= TOL_COLOR * TOL_COLOR) return true;
      }
    }
    return false;
  };
}

/**
 * 判定「这个像素是不是背景」。
 *
 * 这里的关键不是色差多大，而是**中性色背景必须只跟中性色像素匹配**。
 *
 * 用 RGB 欧氏距离直接比会翻车：棋盘格含一个灰 (237,237,237)，而角色那条
 * 浅蓝裙摆是 (230,235,250)，在 RGB 空间里离灰色只有 15 —— 于是裙摆、
 * 白领子、浅肤色全被判成背景，角色的腿和手被整块吃掉。
 *
 * tools/cutout.js 之所以没这问题，是因为它写死了「必须接近中性灰」这个
 * 条件。这里把它正式泛化：调色板颜色是中性（低彩度）时，目标像素也必须
 * 低彩度，只比亮度；调色板颜色本身有彩度（比如纯色底）时，才按色相聚类比。
 *
 * 另外刻意不做「跟邻居像素比」的蔓延。加过想兼容渐变底，结果在水彩风格的
 * 立绘上翻车：那种画边缘是软的，从背景到角色每一步色差都不到 10，洪泛
 * 顺着边缘一路啃进角色内部，包围盒从 794x1775 缩到 119x515。
 *
 * 代价不对称：漏抠（背景残留）用户看得见、关掉开关就能救；误抠（角色
 * 被吃掉）是静默损坏，只会让人觉得这功能很烂。宁可少抠。
 */
const NEUTRAL_CHROMA = 14;   // 彩度低于此值算「中性色」
const TOL_LUMA = 24;         // 中性色之间只比亮度
const TOL_COLOR = 46;        // 有彩色之间的 RGB 距离阈值
const TOL_CHROMA = 60;       // 有彩色之间还要彩度相近

/**
 * 对 BGRA 缓冲做边缘连通域抠图，返回新的 BGRA 缓冲与内容包围盒。
 * 只删和画布四边连通的背景，所以角色内部的同色区域（白领子、高光）不会被打穿。
 */
function cutoutBitmap(bmp, W, H) {
  const N = W * H;
  const palette = backgroundPalette(bmp, W, H);
  if (!palette.length) return null;

  const isBg = new Uint8Array(N);
  const stack = [];
  const isBackground = makeMatcher(palette);

  const seed = (i) => {
    if (isBg[i]) return;
    if (isBackground(bmp, i << 2)) { isBg[i] = 1; stack.push(i); }
  };

  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }

  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i / W) | 0;
    const neigh = [
      x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1,
      y > 0 ? i - W : -1, y < H - 1 ? i + W : -1,
    ];
    for (const j of neigh) {
      if (j < 0 || isBg[j]) continue;
      if (isBackground(bmp, j << 2)) { isBg[j] = 1; stack.push(j); }
    }
  }

  let bgCount = 0;
  for (let i = 0; i < N; i++) bgCount += isBg[i];
  // 几乎没有背景可抠 —— 多半是张满幅照片，别硬抠，交给调用方提示
  if (bgCount / N < 0.05) return null;

  // ---- 腐蚀 1px：角色边缘那圈是被背景色污染过的过渡色，留着会有一圈描边
  const keep = new Uint8Array(N);
  for (let i = 0; i < N; i++) keep[i] = isBg[i] ? 0 : 1;

  const eroded = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!keep[i]) continue;
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!keep[i + dy * W + dx]) { all = 0; break; }
        }
      }
      eroded[i] = all;
    }
  }

  // ---- 丢掉碎屑，但保留**所有够大的**连通块
  //
  // 不要只留最大的一块：角色的腿、飘起来的裙摆碎布在腐蚀之后可能和主体
  // 并不连通，只留最大块会把它们整个删掉（实测右腿和半条裙子就是这么没的）。
  // 这里只按尺寸过滤，小于阈值的才当作 JPEG 噪点碎屑丢掉。
  const MIN_KEEP = Math.max(64, Math.round(N * 0.00005));

  const label = new Int32Array(N).fill(-1);
  const sizes = [];
  const st2 = [];
  for (let s = 0; s < N; s++) {
    if (!eroded[s] || label[s] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    label[s] = id; st2.push(s);
    while (st2.length) {
      const i = st2.pop();
      size++;
      const x = i % W, y = (i / W) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) if (j >= 0 && eroded[j] && label[j] === -1) { label[j] = id; st2.push(j); }
    }
    sizes.push(size);
  }
  if (!sizes.length) return null;

  const keepOnly = new Uint8Array(N);
  let kept = 0;
  for (let i = 0; i < N; i++) {
    if (eroded[i] && sizes[label[i]] >= MIN_KEEP) { keepOnly[i] = 1; kept++; }
  }
  if (!kept) return null;

  // ---- alpha 羽化（3x3 高斯核），把硬边磨柔一点
  const a0 = new Float32Array(N);
  for (let i = 0; i < N; i++) a0[i] = keepOnly[i] ? 1 : 0;

  const K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const a1 = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        for (let dx = -1; dx <= 1; dx++, k++) {
          const xx = x + dx;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          acc += a0[yy * W + xx] * K[k];
        }
      }
      a1[y * W + x] = acc / 16;
    }
  }

  // ---- 回写：透明区域顺便把颜色也刷成邻居色，减轻缩放时的暗边
  const out = Buffer.from(bmp);
  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i << 2;
      const a = a1[i];
      out[o + 3] = Math.round(a * 255);
      if (a > 0.02) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  return { bmp: out, box: { minX, maxX, minY, maxY } };
}

/** 裁掉内容之外的透明边，缩到合适大小能省很多内存 */
function cropBitmap(bmp, W, H, box, pad) {
  const x0 = Math.max(0, box.minX - pad), x1 = Math.min(W - 1, box.maxX + pad);
  const y0 = Math.max(0, box.minY - pad), y1 = Math.min(H - 1, box.maxY + pad);
  const CW = x1 - x0 + 1, CH = y1 - y0 + 1;

  const out = Buffer.alloc(CW * CH * 4);
  for (let y = 0; y < CH; y++) {
    const src = ((y + y0) * W + x0) << 2;
    bmp.copy(out, (y * CW) << 2, src, src + (CW << 2));
  }
  return { bmp: out, width: CW, height: CH };
}

// ------------------------------------------------------------------ 导入

function checkSource(srcPath) {
  if (!srcPath) throw new Error('没有选择文件');
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!FORMATS.includes(ext)) {
    throw new Error(`不支持的格式 .${ext}；可用：${FORMATS.join(' / ')}`);
  }
  const st = fs.statSync(srcPath);
  if (!st.isFile()) throw new Error('选择的不是一个文件');
  if (st.size > MAX_BYTES) {
    throw new Error(`图片超过 ${MAX_BYTES / 1024 / 1024}MB（当前 ${(st.size / 1024 / 1024).toFixed(1)}MB）`);
  }
  return { ext, size: st.size };
}

function stamp(base) {
  return `${Date.now().toString(36)}-${base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 48)}`;
}

/** 背景图：不需要处理，原样复制进来即可（保留原始质量） */
function importBackground(srcPath) {
  checkSource(srcPath);
  const img = ni().createFromPath(srcPath);
  if (img.isEmpty()) throw new Error('这个文件读不出图像内容，可能已损坏');

  const ext = path.extname(srcPath).slice(1).toLowerCase();
  const base = path.basename(srcPath, path.extname(srcPath));
  const file = `${stamp(base)}.${ext}`;
  fs.copyFileSync(srcPath, path.join(imagesDir, file));

  const s = img.getSize();
  return { file, width: s.width, height: s.height };
}

/**
 * 桌宠立绘：可能带棋盘格或纯色底，需要抠。
 * wantCutout=false 表示用户明确要原样使用。
 */
function importSprite(srcPath, wantCutout) {
  checkSource(srcPath);
  const img = ni().createFromPath(srcPath);
  if (img.isEmpty()) throw new Error('这个文件读不出图像内容，可能已损坏');

  const { width: W, height: H } = img.getSize();
  const file = `${stamp(path.basename(srcPath, path.extname(srcPath)))}.png`;
  const dest = path.join(imagesDir, file);

  let applied = false;
  if (wantCutout) {
    const bmp = img.toBitmap();
    // 本来就有透明通道的图（PNG）直接拿来用，再抠一遍只会把边缘啃坏
    const alreadyTransparent = hasMeaningfulAlpha(bmp, W, H);
    if (!alreadyTransparent) {
      const cut = cutoutBitmap(bmp, W, H);
      if (cut) {
        const cropped = cropBitmap(cut.bmp, W, H, cut.box, 8);
        const png = ni()
          .createFromBitmap(cropped.bmp, { width: cropped.width, height: cropped.height })
          .toPNG();
        fs.writeFileSync(dest, png);
        applied = true;
        return { file, width: cropped.width, height: cropped.height, cutout: true };
      }
      // 抠不动（多半是满幅照片）——退回原样保存，让界面去提示
      fs.writeFileSync(dest, img.toPNG());
      return { file, width: W, height: H, cutout: false, failed: true };
    }
  }

  fs.writeFileSync(dest, img.toPNG());
  return { file, width: W, height: H, cutout: applied };
}

/** 四边有大片真透明像素，说明这张图本来就有 alpha，不需要再抠 */
function hasMeaningfulAlpha(bmp, W, H) {
  let n = 0, clear = 0;
  const probe = (i) => { n++; if (bmp[(i << 2) + 3] < 250) clear++; };
  for (let x = 0; x < W; x++) { probe(x); probe((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { probe(y * W); probe(y * W + W - 1); }
  return clear / n > 0.5;
}

// ------------------------------------------------------------------ 图标

/**
 * 从立绘头部裁一张小图当托盘图标。
 * 取顶部 24% 那块（头 + 双马尾）的包围盒，居中裁正方形再缩到 dst。
 */
function iconFrom(spec, dst) {
  const p = resolvePath(spec);
  if (!p) return null;
  const img = ni().createFromPath(p);
  if (img.isEmpty()) return null;

  const { width: W, height: H } = img.getSize();
  const bmp = img.toBitmap();
  const bandY = Math.max(1, Math.round(H * 0.24));

  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < bandY; y++) {
    for (let x = 0; x < W; x++) {
      if (bmp[((y * W + x) << 2) + 3] > 128) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 * 1.06;
  const x0 = Math.round(cx - half), y0 = Math.round(cy - half);
  const side = Math.max(1, Math.round(half * 2));

  // alpha 加权重采样，避免透明区域把边缘拉黑
  const out = Buffer.alloc(dst * dst * 4);
  for (let y = 0; y < dst; y++) {
    for (let x = 0; x < dst; x++) {
      const bx0 = x0 + Math.floor(x * side / dst), bx1 = x0 + Math.floor((x + 1) * side / dst);
      const by0 = y0 + Math.floor(y * side / dst), by1 = y0 + Math.floor((y + 1) * side / dst);
      let r = 0, g = 0, b = 0, acc = 0, n = 0;
      for (let sy = by0; sy < Math.max(by1, by0 + 1); sy++) {
        for (let sx = bx0; sx < Math.max(bx1, bx0 + 1); sx++, n++) {
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          const o = ((sy * W + sx) << 2);
          const a = bmp[o + 3] / 255;
          r += bmp[o + 2] * a; g += bmp[o + 1] * a; b += bmp[o] * a;
          acc += a;
        }
      }
      const o = (y * dst + x) << 2;
      if (acc > 0.001) {
        out[o] = Math.round(b / acc);
        out[o + 1] = Math.round(g / acc);
        out[o + 2] = Math.round(r / acc);
        out[o + 3] = Math.round(Math.min(1, acc / Math.max(1, n)) * 255);
      }
    }
  }
  return ni().createFromBitmap(out, { width: dst, height: dst });
}

function removeImage(file) {
  if (!file || path.basename(file) !== file) return;
  try { fs.unlinkSync(path.join(imagesDir, file)); } catch { /* 不在就算了 */ }
}

module.exports = {
  init, BUILTIN, FORMATS, FILTERS, MAX_BYTES,
  resolvePath, readImage, spriteSize,
  importBackground, importSprite,
  iconFrom, removeImage,
  // 导出给单测用
  _internal: { backgroundPalette, makeMatcher, cutoutBitmap, cropBitmap, hasMeaningfulAlpha },
};
