/**
 * 纯 Node 自测：覆盖调度器状态机、持久化、提示音文件处理。
 *
 * 这三块都不依赖 Electron，可以直接跑，不用起界面：
 *   node tools/_selftest.js
 *
 * 调度器是整个应用里最容易出错的部分（贪睡重复、周期推进、跨休眠补触发），
 * 这里用假的 Date.now 把时间捏在手里，逐条验证状态转移。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/main/store');
const sound = require('../src/main/sound');
const images = require('../src/main/images');
const { Scheduler, nextOccurrence } = require('../src/main/scheduler');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `实际 ${a}，期望 ${e}`);
}

/** 把 Date.now 钉死在某个时刻，跑完恢复 */
function atTime(t, fn) {
  const real = Date.now;
  Date.now = () => t;
  try { return fn(); } finally { Date.now = real; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-selftest-'));
const T0 = 1_700_000_000_000;   // 固定的假起点，避免依赖真实时间

// ==================================================================== 周期推进

console.log('\n[周期推进 nextOccurrence]');
{
  const MIN = 60000;
  atTime(T0, () => {
    eq('每 30 分钟，从当前点往后推一格',
      nextOccurrence(T0, { every: 30, unit: 'min' }, T0), T0 + 30 * MIN);

    // 关机一周后重启：不能一格一格往前挪，要一步跳到最近的未来
    const weekLater = T0 + 7 * 24 * 60 * MIN;
    const n = atTime(weekLater, () => nextOccurrence(T0, { every: 1, unit: 'min' }, weekLater));
    ok('落后一周后一步追上（不靠循环）', n > weekLater && n - weekLater <= MIN,
      `得到 ${n - weekLater}ms 后`);

    // 边界：恰好落在当前时刻，应该推到下一格而不是停在原地空转
    const exact = atTime(T0 + 5 * MIN, () => nextOccurrence(T0, { every: 5, unit: 'min' }, T0 + 5 * MIN));
    ok('恰好重合时推进到下一格', exact === T0 + 10 * MIN, `得到 ${exact}`);
  });
}

// ==================================================================== 调度器

console.log('\n[调度器状态机]');

function makeSched(todos, now) {
  const data = { todos, snoozeMin: 5 };
  const fake = { get: () => data, save: () => {} };
  const fired = [];
  const s = new Scheduler(fake, (t, kind) => fired.push({ id: t.id, kind }), () => {});
  return { s, fired, data, fake };
}

function todo(over) {
  return Object.assign({
    id: 'a', text: 'x', dueAt: T0, intervalMin: 0, repeat: null,
    enabled: true, done: false, muted: false, createdAt: T0 - 1000,
  }, over);
}

{
  // --- 到点触发一次，且不会在同一拍里重复触发
  const { s, fired } = makeSched([todo({})], T0);
  atTime(T0, () => { s.tick(); s.tick(); s.tick(); });
  eq('到点只触发一次', fired, [{ id: 'a', kind: 'due' }]);

  // --- 没到点不触发
  const notYet = makeSched([todo({ dueAt: T0 + 10000 })], T0);
  atTime(T0, () => notYet.s.tick());
  eq('未到点不触发', notYet.fired, []);
}

{
  // --- 贪睡重复：到点后每隔 intervalMin 再响
  const { s, fired } = makeSched([todo({ intervalMin: 10 })], T0);
  atTime(T0, () => s.tick());
  atTime(T0 + 9 * 60000, () => s.tick());
  eq('间隔未满不重响', fired.length, 1);
  atTime(T0 + 10 * 60000, () => s.tick());
  eq('间隔到了重响一次', fired.map(f => f.kind), ['due', 'repeat']);
  atTime(T0 + 20 * 60000, () => s.tick());
  eq('继续按间隔重响', fired.map(f => f.kind), ['due', 'repeat', 'repeat']);
}

{
  // --- 未开启 / 已完成 / 已静音的待办都不该触发
  const a = makeSched([todo({ enabled: false })], T0);
  atTime(T0, () => a.s.tick());
  eq('已停用不触发', a.fired, []);

  const b = makeSched([todo({ done: true })], T0);
  atTime(T0, () => b.s.tick());
  eq('已完成不触发', b.fired, []);

  const c = makeSched([todo({ muted: true })], T0);
  atTime(T0, () => c.s.tick());
  eq('已静音不触发', c.fired, []);
}

{
  // --- 非周期待办点「完成」：整条结束
  const { s, data } = makeSched([todo({})], T0);
  atTime(T0, () => { s.tick(); s.complete('a'); });
  const t = data.todos[0];
  eq('完成（无周期）→ 标记完成、停用、清空时间',
    [t.done, t.enabled, t.dueAt], [true, false, null]);
  atTime(T0 + 60000, () => s.tick());
  eq('完成后不再触发', s.runtime.get('a').firing, false);
}

{
  // --- 周期待办点「完成」：这条继续活着，排下一次
  const { s, data } = makeSched([todo({ repeat: { every: 1, unit: 'day' } })], T0);
  atTime(T0, () => { s.tick(); s.complete('a'); });
  const t = data.todos[0];
  eq('完成（有周期）→ 未完成、保持启用', [t.done, t.enabled], [false, true]);
  eq('下次时间推后一天', t.dueAt, T0 + 86400000);

  const day = T0 + 86400000;
  atTime(day, () => s.tick());
  eq('第二天会再次触发', s.runtime.get('a').firing, true);
}

{
  // --- 停止：本次不再自动重响
  const { s, data } = makeSched([todo({ intervalMin: 5 })], T0);
  atTime(T0, () => { s.tick(); s.dismiss('a'); });
  eq('停止后进入静音', data.todos[0].muted, true);
  atTime(T0 + 60 * 60000, () => s.tick());
  eq('静音后即便过了间隔也不再响', s.runtime.get('a').firing, false);
}

{
  // --- 稍后提醒：推迟到 N 分钟后
  const { s, data } = makeSched([todo({})], T0);
  atTime(T0, () => { s.tick(); s.snooze('a', 5); });
  eq('稍后提醒推到 5 分钟后', data.todos[0].dueAt, T0 + 5 * 60000);
  eq('稍后提醒解除静音', data.todos[0].muted, false);
}

// ==================================================================== 持久化

console.log('\n[持久化]');
{
  const dir = path.join(tmpRoot, 'data');
  store.init(dir);
  store.load();

  const t = store.addTodo({ text: '写论文', dueAt: T0, intervalMin: 15 });
  ok('新增返回带 id 的待办', !!t.id && t.text === '写论文');

  store.updateTodo(t.id, { text: '改过' });
  eq('更新生效', store.get().todos[0].text, '改过');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  eq('确实落盘', onDisk.todos[0].text, '改过');

  store.removeTodo(t.id);
  eq('删除生效', store.get().todos.length, 0);

  // ---- 图片配置的容错：脏数据不能把界面搞白
  store.setImage('main', { source: 'custom', file: 'abc-bg.jpg' });
  eq('自定义图片写入生效', store.get().images.main, { source: 'custom', file: 'abc-bg.jpg' });

  store.setImage('pet', { source: 'builtin', key: 'default' });
  eq('切回内置生效', store.get().images.pet.source, 'builtin');

  eq('未知的图片位置被拒绝', store.setImage('nope', { source: 'builtin' }), null);
  eq('未知的位置字段被拒绝', store.setImagePos('nope', { x: 1 }), null);

  store.setImagePos('main', { x: 999, y: -50 });
  eq('位置被夹到 0..100', store.get().images.mainPos, { x: 100, y: 0 });

  // 文件损坏时不能把应用带崩，且要把坏文件留证
  const dir2 = path.join(tmpRoot, 'broken');
  store.init(dir2);
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'data.json'), '{这不是合法 JSON');
  store.load();
  eq('坏文件回退到默认值', store.get().todos.length, 0);
  ok('坏文件被改名留证',
    fs.readdirSync(dir2).some(f => f.includes('.broken-')));
}

// ==================================================================== 提示音

console.log('\n[提示音文件处理]');
{
  const soundsDir = path.join(tmpRoot, 'sounds');
  const srcDir = path.join(tmpRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const wavPath = path.join(srcDir, '我的提示音.wav');
  fs.writeFileSync(wavPath, Buffer.from('RIFF....WAVEfmt '));

  const imported = sound.importSound(soundsDir, wavPath);
  ok('导入后返回文件名与原名', !!imported.file && imported.name === '我的提示音.wav');
  ok('原文件被复制进 sounds 目录', fs.existsSync(path.join(soundsDir, imported.file)));

  // 关键行为：源文件删掉之后，提醒依然要能响
  fs.unlinkSync(wavPath);
  const bytes = sound.readSound(soundsDir, imported.file);
  ok('源文件删除后仍能读到音频（复制而非引用）',
    bytes && bytes.length > 0);

  // 目录穿越防护
  eq('拒绝目录穿越', sound.readSound(soundsDir, '../../../etc/passwd'), null);

  let rejected = false;
  try {
    const bad = path.join(srcDir, 'x.txt');
    fs.writeFileSync(bad, 'nope');
    sound.importSound(soundsDir, bad);
  } catch { rejected = true; }
  ok('拒绝不支持的格式', rejected);

  sound.deleteSound(soundsDir, imported.file);
  ok('删除音频生效', !fs.existsSync(path.join(soundsDir, imported.file)));
  ok('删除不存在的文件不抛错', (() => {
    try { sound.deleteSound(soundsDir, '不存在.wav'); return true; } catch { return false; }
  })());
}

// ==================================================================== 抠图

console.log('\n[抠图]');
{
  const { cutoutBitmap, cropBitmap, backgroundPalette, makeMatcher, hasMeaningfulAlpha } = images._internal;

  /** 造一张 BGRA 缓冲；fn 返回 [r,g,b] 或 [r,g,b,a] */
  function makeBmp(W, H, fn) {
    const buf = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = fn(x, y);
        const o = (y * W + x) << 2;
        buf[o] = px[2]; buf[o + 1] = px[1]; buf[o + 2] = px[0];
        buf[o + 3] = px.length > 3 ? px[3] : 255;
      }
    }
    return buf;
  }
  const alphaAt = (b, W, x, y) => b[((y * W + x) << 2) + 3];

  const W = 200, H = 200;

  // ---- 白色背景 + 黑环 + 环内白色
  // 这条是整个抠图最要紧的性质：环内的白与背景同色，但它够不到画布边缘，
  // 所以必须活下来。写死「接近白就透明」的做法会在这里把角色打穿。
  const ring = makeBmp(W, H, (x, y) => {
    const r = Math.hypot(x - 100, y - 100);
    if (r < 40) return [255, 255, 255];   // 环内白 —— 必须保住
    if (r < 70) return [0, 0, 0];         // 黑环
    return [255, 255, 255];               // 背景白 —— 必须抠掉
  });

  const cutRing = cutoutBitmap(ring, W, H);
  ok('白底黑环：能抠出结果', !!cutRing);
  if (cutRing) {
    eq('  背景被抠掉', alphaAt(cutRing.bmp, W, 2, 2), 0);
    eq('  黑环保留', alphaAt(cutRing.bmp, W, 100, 45), 255);
    eq('  环内的白没被打穿（封闭区域免疫）', alphaAt(cutRing.bmp, W, 100, 100), 255);
    ok('  包围盒贴着黑环',
      cutRing.box.minX > 20 && cutRing.box.minX < 40 && cutRing.box.maxX > 160,
      JSON.stringify(cutRing.box));
  }

  // ---- 棋盘格底（就是 人物立绘.jpg 那种）
  const check = makeBmp(W, H, (x, y) => {
    const r = Math.hypot(x - 100, y - 100);
    if (r < 60) return [0, 0, 0];
    return ((Math.floor(x / 20) + Math.floor(y / 20)) % 2) ? [255, 255, 255] : [237, 237, 237];
  });
  const pal = backgroundPalette(check, W, H);
  ok('棋盘格能从四边采出背景色', pal.length >= 1, `拿到 ${pal.length} 个`);

  const cutCheck = cutoutBitmap(check, W, H);
  ok('棋盘格底：能抠出结果', !!cutCheck);
  if (cutCheck) {
    eq('  棋盘格被抠掉', alphaAt(cutCheck.bmp, W, 2, 2), 0);
    eq('  主体保留', alphaAt(cutCheck.bmp, W, 100, 100), 255);
  }

  // ---- 纯色底
  const solid = makeBmp(W, H, (x, y) => (Math.hypot(x - 100, y - 100) < 60 ? [200, 30, 40] : [16, 200, 90]));
  const cutSolid = cutoutBitmap(solid, W, H);
  ok('纯色底：能抠出结果', !!cutSolid);
  if (cutSolid) {
    eq('  底色被抠掉', alphaAt(cutSolid.bmp, W, 2, 2), 0);
    eq('  主体保留', alphaAt(cutSolid.bmp, W, 100, 100), 255);
  }

  // ---- 浅蓝色主体 vs 中性棋盘格底
  // 回归测试：曾经用 RGB 欧氏距离直接比调色板，棋盘格里的灰 (237,237,237)
  // 和这种浅蓝 (230,235,250) 只差 15，裙子、白领、浅肤色全被当成背景吃掉。
  // 正确做法是中性色背景只跟中性色像素匹配。
  const paleBlue = makeBmp(W, H, (x, y) => {
    const r = Math.hypot(x - 100, y - 100);
    if (r < 60) return [230, 235, 250];        // 浅蓝主体：彩度 20，离灰很近
    return ((Math.floor(x / 20) + Math.floor(y / 20)) % 2) ? [255, 255, 255] : [237, 237, 237];
  });
  const cutPale = cutoutBitmap(paleBlue, W, H);
  ok('浅蓝主体 + 中性棋盘格底：能抠出结果', !!cutPale);
  if (cutPale) {
    eq('  棋盘格被抠掉', alphaAt(cutPale.bmp, W, 2, 2), 0);
    eq('  浅蓝主体没被当成背景吃掉', alphaAt(cutPale.bmp, W, 100, 100), 255);
  }

  // ---- 互不相连的主体部分都要留住
  // 回归测试：曾经写成「只保留最大的连通块」，结果角色的腿和飘起来的裙摆
  // 碎布因为跟主体不连通被整块删掉。按尺寸过滤才是对的。
  const twoParts = makeBmp(W, H, (x, y) => {
    const left = Math.hypot(x - 60, y - 100) < 30;
    const right = Math.hypot(x - 140, y - 100) < 30;
    return (left || right) ? [0, 0, 0] : [255, 255, 255];
  });
  const cutTwo = cutoutBitmap(twoParts, W, H);
  ok('两块互不相连的主体：能抠出结果', !!cutTwo);
  if (cutTwo) {
    eq('  左边那块保留', alphaAt(cutTwo.bmp, W, 60, 100), 255);
    eq('  右边那块也保留（没有只留最大块）', alphaAt(cutTwo.bmp, W, 140, 100), 255);
    eq('  背景仍被抠掉', alphaAt(cutTwo.bmp, W, 100, 20), 0);
  }

  // ---- 边缘伪影不该混进背景调色板
  // 回归测试：人物立绘.jpg 的右边缘整列偏暗（135,134,134），同时在左上/右下
  // 各有一个孤立角像素，于是按「出现在几条边上」计数就是 3 条边，蒙混进了调色板。
  // 而那个中灰的亮度窗口正好套住裙子的褶皱阴影，整条裙子被啃成透明的洞。
  // 正确做法是按「在某条边上占了多大比例」判定，孤立的角像素不算数。
  // 主体色要和伪影色差得够开（量化是 16 级）：差得太近两者会并进同一个桶，
  // 主体在上下边的占比会把这个桶「撑」成强边，测试就失去意义了。
  const edgeArtifact = makeBmp(W, H, (x, y) => {
    if (x === W - 1) return [135, 134, 134];          // 整列边缘伪影（只在右边站得住）
    if (x > 60 && x < 140) return [118, 117, 117];    // 偏暗的中灰主体，贯穿上下边
    return [255, 255, 255];
  });
  const palEA = backgroundPalette(edgeArtifact, W, H);
  ok('只有一条边站得住的颜色不进调色板',
    !palEA.some(c => Math.abs(c[0] - 135) < 8 && Math.abs(c[2] - 134) < 8),
    `调色板 ${JSON.stringify(palEA)}`);

  // 再直接验判定函数本身。这里手工给一个「只含白色」的调色板，
  // 而不是拿上面那张图去跑 —— 那张图的主体贯穿上下边，从边缘看它本身
  // 就够格当背景，是另一种固有歧义，会把这条测试的意思搅浑。
  //
  // 要验的性质：中性白底不该吞掉亮度差得远的偏暗像素。
  // 之前中灰伪影混进调色板时，它的亮度窗口 [112,160] 正好罩住裙子的褶皱阴影。
  const mPlain = makeMatcher([[255, 255, 255]]);
  eq('中性白底不吞亮度 117 的偏暗像素', mPlain(Buffer.from([117, 117, 118, 255]), 0), false);
  eq('中性白底不吞亮度 200 的偏暗像素', mPlain(Buffer.from([200, 200, 200, 255]), 0), false);
  eq('中性白底正确识别白色', mPlain(Buffer.from([255, 255, 255, 255]), 0), true);

  // ---- 满幅杂色（照片）：没有可识别的背景，应当明确放弃而不是乱抠
  const noisy = makeBmp(W, H, (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * y) % 256]);
  eq('满幅杂色图返回 null（不硬抠）', cutoutBitmap(noisy, W, H), null);

  // ---- 已经有透明通道的图不该被再抠一遍
  const withAlpha = makeBmp(W, H, (x, y) => (Math.hypot(x - 100, y - 100) < 60 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  ok('四边透明 -> 判定为已有 alpha', hasMeaningfulAlpha(withAlpha, W, H));
  ok('实心图 -> 判定为没有 alpha', !hasMeaningfulAlpha(solid, W, H));

  // ---- 裁剪
  const cropped = cropBitmap(solid, W, H, { minX: 50, maxX: 150, minY: 50, maxY: 150 }, 8);
  eq('裁剪尺寸含 padding', [cropped.width, cropped.height], [117, 117]);
  eq('裁剪后字节数对得上', cropped.bmp.length, 117 * 117 * 4);
}

// ==================================================================== 模块健全性

console.log('\n[模块健全性]');
{
  // images.js 里除了懒加载那一行，不该再出现裸的 nativeImage 引用。
  // 曾经用正则批量替换 nativeImage. -> ni().，漏掉了跨行链式调用的那一处，
  // 结果「导入立绘」在运行时直接 ReferenceError。纯 Node 下测不到，
  // 所以这里退而求其次做一次源码扫描当网兜。
  const file = path.join(__dirname, '..', 'src', 'main', 'images.js');
  const src = fs.readFileSync(file, 'utf8');
  const stray = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(x =>
      /\bnativeImage\b/.test(x.line) &&
      !/^\s*[*/]/.test(x.line) &&              // 注释行
      !/nativeImage:\s*_ni/.test(x.line)       // 懒加载那行
    );
  eq('images.js 无裸的 nativeImage 引用', stray.map(x => `${x.n}: ${x.line.trim()}`), []);

  ok('images.js 能脱离 Electron 被加载', typeof images._internal.cutoutBitmap === 'function');
}

// ==================================================================== 收尾

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
