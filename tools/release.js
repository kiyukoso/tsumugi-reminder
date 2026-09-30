#!/usr/bin/env node
'use strict';

/**
 * 把 dist/ 里刚构建好的产物发到 GitHub Releases。
 *
 * 刻意不用 electron-builder 自带的 `--publish always`，两个原因：
 *
 *   1. 它默认建**草稿**，而草稿对 electron-updater 是不可见的 ——
 *      自动更新会永远发现不了新版本，且不会有任何报错。
 *   2. 它会并发跑多条发布流水线，每条各自判断「release 不存在」然后各建一个。
 *      实测生成了两个同标签 v1.0.0 的草稿，资源还被拆开：一个只有 latest.yml
 *      和安装包，另一个只有 blockmap。这样的 release 客户端拼不出完整下载地址。
 *
 * 这里直接调 gh，一次一条、确定性的。
 *
 * 用法：npm run release   （会先构建再上传）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** gh 不一定在 PATH 上（winget 装完之后老会话读不到新 PATH），挨个找一遍 */
function findGh() {
  const candidates = [
    process.env.GH_PATH,
    'gh',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
  ].filter(Boolean);

  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', shell: false });
    if (r.status === 0) return c;
  }
  return null;
}

function run(gh, args, opts) {
  return execFileSync(gh, args, { encoding: 'utf8', stdio: opts && opts.quiet ? 'pipe' : 'inherit' });
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = 'v' + version;

  const gh = findGh();
  if (!gh) {
    console.error('找不到 gh（GitHub CLI）。装一个：winget install GitHub.cli');
    process.exit(1);
  }

  if (!fs.existsSync(DIST)) {
    console.error('dist/ 不存在，先跑 npm run dist 构建。');
    process.exit(1);
  }

  // latest.yml 是 electron-updater 用来找新版本的清单，必须和安装包在同一个 release 里
  const files = fs.readdirSync(DIST).filter(f =>
    f.endsWith('.exe') || f === 'latest.yml' || f.endsWith('.blockmap')
  );
  if (!files.some(f => f.endsWith('.exe')) || !files.includes('latest.yml')) {
    console.error('dist/ 里缺少安装包或 latest.yml，先跑 npm run dist。');
    process.exit(1);
  }

  // 同标签的 release 已存在就停手：gh 会报错，但错误信息不如这句清楚
  const existing = spawnSync(gh, ['release', 'view', tag, '--json', 'tagName'], {
    cwd: ROOT, encoding: 'utf8', shell: false,
  });
  if (existing.status === 0) {
    console.error(`${tag} 已经发布过了。要发新版本请先 npm version patch/minor/major。`);
    process.exit(1);
  }

  const args = [
    'release', 'create', tag,
    ...files.map(f => path.join(DIST, f)),
    '--title', `${pkg.build.productName} ${version}`,
    // 不加 --draft：草稿对 electron-updater 不可见
    '--notes', [
      `自动更新已发布 ${tag}。已安装旧版本的客户端会在下次启动时检测到并后台下载。`,
      '',
      '安装方式见仓库 README。',
    ].join('\n'),
  ];

  console.log(`\n发布 ${tag}，共 ${files.length} 个文件：`);
  for (const f of files) console.log('  ' + f);
  console.log('');

  run(gh, args, { quiet: false });

  const url = spawnSync(gh, ['release', 'view', tag, '--json', 'url', '--jq', '.url'], {
    cwd: ROOT, encoding: 'utf8', shell: false,
  });
  console.log('\n发布完成：' + (url.stdout || '').trim());
}

main();
