#!/usr/bin/env node
'use strict';

/**
 * 把安装包和一份说明打成一个 zip，方便通过微信 / QQ 发送
 * —— 这两个都经常直接拦 .exe，包成 zip 就能过。
 *
 * 用法：npm run zip
 * 产物：项目根目录下的 tsumugi-reminder-<版本>.zip
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const appName = pkg.build.productName;

const SETUP = path.join(DIST, `${appName}-${version}-setup.exe`);
const OUT = path.join(ROOT, `${appName}-${version}.zip`);

// 说明文件用 ASCII 名。中文文件名在 zip 里是个老坑：
// zip 的条目名编码有历史遗留（Windows 资源管理器长期按 OEM 代码页解读），
// 中文名容易在对方解压后变成乱码。文件名用 ASCII、内容用中文最稳。
const README_NAME = 'README.txt';

const README = `tsumugi-reminder —— 带桌面桌宠的待办提醒应用
================================================================

【怎么装】
  1. 双击 ${appName}-${version}-setup.exe
  2. Windows 可能弹出蓝色的「已保护你的电脑」提示。这是因为安装包没有买
     代码签名证书，不是病毒。点「更多信息」→「仍要运行」即可。
  3. 安装时可以自己选目录。装完桌面和开始菜单会有快捷方式。

【怎么卸载】
  设置 → 应用 → 已安装的应用 → 找到 tsumugi-reminder → 卸载。
  待办和设置不会被删（存在 %APPDATA%\\reminder），想彻底清干净就手动删掉那个文件夹。

【功能】
  · 待办事项 —— 可以建多条，勾选完成、编辑、删除
  · 提醒时间 —— 到点弹出提醒卡片
  · 提醒间隔 —— 到点后如果没处理，每隔 N 分钟再响一次，防止漏看
  · 周期重复 —— 每天 / 每周 / 每小时自动重复
  · 实时时钟 —— 右上角显示系统时间，精确到秒
  · 桌面桌宠
      左键按住拖动 = 挪位置
      左键点一下   = 打开主界面
      右键         = 快捷改待办、提醒时间、提醒间隔
      到点时桌宠头顶会冒气泡
  · 退出方式可选 —— 完全退出 / 最小化到托盘 / 转入后台（桌宠留在桌面继续提醒）
  · 自定义
      进入界面图和主界面背景可以换成任意本地图片，还能调裁切位置
      桌宠立绘可以换成你自己的图，会自动抠掉纯色或棋盘格背景
      桌宠大小 160~900 像素可调
      提示音可以用默认的，也可以选自己的音频文件，带试听和音量调节
  · 自动更新 —— 有新版本会在后台自动下载，设置里点「重启并安装」即可

【数据存在哪】
  %APPDATA%\\reminder
  待办、设置、自定义图片、提示音都在这里。重装或更新都不会丢。

【遇到问题】
  · 桌宠不见了 —— 主界面右上角的圆圈按钮可以重新显示
  · 听不到提示音 —— 设置 → 提醒 → 点一下「▶」试听，顺便确认音量不是 0
  · 更新失败 —— 多半是网络连不上 GitHub，可以手动去仓库下载新版

项目地址：https://github.com/kiyukoso/tsumugi-reminder
`;

function main() {
  if (!fs.existsSync(SETUP)) {
    console.error(`找不到安装包：${SETUP}\n先跑 npm run dist 构建。`);
    process.exit(1);
  }

  // 先在一个临时目录里摆好要打包的内容，避免把 dist 里的其他东西也裹进去
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-zip-'));
  fs.copyFileSync(SETUP, path.join(stage, path.basename(SETUP)));

  // 带 BOM 的 UTF-8：Windows 记事本对无 BOM 的 UTF-8 中文有时会显示成乱码，
  // 加了 BOM 就一定能正确识别。三种换行用 \r\n，记事本才不会挤成一行。
  const readme = '﻿' + README.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(stage, README_NAME), readme, 'utf8');

  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

  execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Compress-Archive -Path '${stage}\\*' -DestinationPath '${OUT}' -Force`,
  ], { stdio: 'inherit' });

  fs.rmSync(stage, { recursive: true, force: true });

  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`\n打包完成：${OUT}`);
  console.log(`大小：${mb} MB`);
  console.log('内含：');
  for (const f of listZip(OUT)) console.log('  ' + f);
}

/** 列一下 zip 里有什么，顺便验证条目名没被搞乱 */
function listZip(zip) {
  const r = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Add-Type -A System.IO.Compression.FileSystem;` +
    `[IO.Compression.ZipFile]::OpenRead('${zip}').Entries | % { $_.Name }`,
  ], { encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

main();
