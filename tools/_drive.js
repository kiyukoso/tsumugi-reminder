/**
 * 开发期测试辅助：通过 Chrome DevTools Protocol 驱动渲染进程。
 *
 * 手点不到的按钮用求值来点，界面状态用求值来查，截图用 CDP 自己的
 * Page.captureScreenshot —— 它直接取渲染进程的合成结果，既不受其他窗口
 * 遮挡，也不会像 PrintWindow 那样抓到过期的帧。
 *
 * 前提是应用带 --remote-debugging-port=9222 启动。
 *
 * 用法:
 *   node tools/_drive.js list
 *   node tools/_drive.js index "document.getElementById('btnSettings').click()"
 *   node tools/_drive.js shot index shot_settings.png
 *   node tools/_drive.js pet   "showBubble('测试一下')"
 *
 * window 参数匹配目标 URL 里的片段：index / pet / prompt。
 */

const http = require('http');
const fs = require('fs');

const PORT = 9222;

function getJSON(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => reject(new Error(
      `连不上 127.0.0.1:${PORT} —— 应用是否以 --remote-debugging-port=${PORT} 启动？(${e.message})`
    )));
    req.setTimeout(4000, () => req.destroy(new Error('请求超时')));
  });
}

/** 连上某个 target，返回一个 send(method, params) —— 每次调用一个来回 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error(method + ' 超时')); }, 20000);
            pending.set(id, { res, rej, timer });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() { ws.close(); },
      });
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.rej(new Error(`${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`));
      else p.res(msg.result);
    });

    ws.addEventListener('error', (e) => reject(new Error('WebSocket 错误: ' + (e.message || e))));
  });
}

async function pick(which) {
  const targets = await getJSON('/json');
  const pages = targets.filter(t => t.type === 'page');
  if (!which || which === 'list') {
    console.log(`共 ${pages.length} 个窗口:`);
    for (const p of pages) console.log(`  ${p.url.split('/').pop().padEnd(16)} ${p.title}`);
    return null;
  }
  const target = pages.find(p => p.url.includes(which));
  if (!target) {
    console.error(`没找到匹配 "${which}" 的窗口。现有:`);
    for (const p of pages) console.error(`  ${p.url.split('/').pop()}`);
    process.exit(1);
  }
  return target;
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);

  if (!cmd || cmd === 'list') { await pick('list'); return; }

  // ---------------------------------------------------------- shot
  if (cmd === 'shot') {
    const target = await pick(a);
    if (!target) return;
    const out = b || 'shot.png';
    // fromSurface: true 取的是窗口的 OS 表面，窗口被遮挡或未合成时会拿到
    // 一张几乎全白的图；false 直接取渲染进程的合成结果，更可靠。
    const fromSurface = process.argv.includes('--surface');
    const c = await connect(target.webSocketDebuggerUrl);
    try {
      const r = await c.send('Page.captureScreenshot', { format: 'png', fromSurface });
      fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      console.log(`已保存 ${out} (fromSurface=${fromSurface})`);
    } finally { c.close(); }
    return;
  }

  // ---------------------------------------------------------- 求值
  const target = await pick(cmd);
  if (!target) return;
  const c = await connect(target.webSocketDebuggerUrl);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: a,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception ? (d.exception.description || d.exception.value) : d.text);
    }
    const v = r.result ? r.result.value : undefined;
    console.log(v === undefined ? '(无返回值)' : JSON.stringify(v, null, 2));
  } finally { c.close(); }
}

main().catch((e) => { console.error('错误:', e.message); process.exit(1); });
