'use strict';

/**
 * 自定义提示音的文件管理。
 *
 * 用户选中的音频会被**复制**一份进 %APPDATA%/Reminder/sounds/，而不是
 * 记一个原路径 —— 否则用户之后把源文件删了或者挪个位置，提醒就变成哑巴，
 * 而且是在最需要它响的那一刻才发现。
 *
 * 文件名前面加时间戳前缀，既避免重名覆盖，也让目录里一眼能看出先后。
 */

const fs = require('fs');
const path = require('path');

const ALLOWED_EXT = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac', 'weba'];

const FILTERS = [
  { name: '音频文件', extensions: ALLOWED_EXT },
  { name: '全部文件', extensions: ['*'] },
];

function stripExt(name) { return name.slice(0, name.length - path.extname(name).length); }

/**
 * 把外部音频文件收进 sounds/，返回 { file, name }。
 * 拿不到合法文件就返回 null，调用方据此保持原设置不变。
 */
function importSound(soundsDir, srcPath) {
  if (!srcPath) return null;
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    throw new Error(`不支持的音频格式 .${ext}；可用：${ALLOWED_EXT.join(' / ')}`);
  }
  const stat = fs.statSync(srcPath);
  if (!stat.isFile()) throw new Error('选择的不是一个文件');

  const base = stripExt(path.basename(srcPath)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const file = `${Date.now().toString(36)}-${base}.${ext}`;

  fs.mkdirSync(soundsDir, { recursive: true });
  fs.copyFileSync(srcPath, path.join(soundsDir, file));

  return { file, name: path.basename(srcPath) };
}

/** 读出音频原始字节交给渲染进程解码播放；文件没了就返回 null */
function readSound(soundsDir, file) {
  if (!file) return null;
  // 防目录穿越：只接受纯文件名
  if (path.basename(file) !== file) return null;
  try {
    return fs.readFileSync(path.join(soundsDir, file));
  } catch {
    return null;
  }
}

/** 删掉已经用不上的旧音频，避免 sounds/ 越攒越大 */
function deleteSound(soundsDir, file) {
  if (!file || path.basename(file) !== file) return;
  try { fs.unlinkSync(path.join(soundsDir, file)); } catch { /* 本来就不在就算了 */ }
}

module.exports = { importSound, readSound, deleteSound, FILTERS, ALLOWED_EXT };
