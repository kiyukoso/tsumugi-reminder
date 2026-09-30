'use strict';

/**
 * 背景音乐的文件管理。
 *
 * 和提示音、自定义图片一样：用户选中的音乐会被**复制**进
 * %APPDATA%/Reminder/music/，而不是记一个原路径。
 *
 * 这里复制比图片那边更值得：歌单是长期攒起来的，而人整理音乐目录是常态
 * ——移动一下文件夹、改个文件名、把歌从 U 盘挪到硬盘，只记路径的话整个
 * 歌单会一夜之间变成一串点不动的条目。
 *
 * 代价是占双倍磁盘，所以界面上的「移除」只从歌单里去掉，会同步删掉副本，
 * 原文件不动。
 */

const fs = require('fs');
const path = require('path');

// Chromium 能解码的格式。注意**不含** mid / wma / ape / dsf：
// mid 是乐谱指令不是音频，需要合成器才能发声；其余几个 Chromium 没有解码器。
const FORMATS = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'weba'];

const FILTERS = [
  { name: '音频文件', extensions: FORMATS },
  { name: '全部文件', extensions: ['*'] },
];

const MAX_BYTES = 50 * 1024 * 1024;

let musicDir = null;

function init(dir) {
  musicDir = dir;
  fs.mkdirSync(musicDir, { recursive: true });
}

function getDir() {
  return musicDir;
}

function safeJoin(file) {
  // 防目录穿越：只接受纯文件名
  if (!file || path.basename(file) !== file) return null;
  return path.join(musicDir, file);
}

const stripExt = (n) => n.slice(0, n.length - path.extname(n).length);

/**
 * 把外部音乐收进 music/，返回 { file, name, size }。
 * 拿不到合法文件就抛错，调用方据此提示用户。
 */
function importTrack(srcPath) {
  if (!srcPath) throw new Error('没有选择文件');

  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!FORMATS.includes(ext)) {
    throw new Error(
      `不支持的格式 .${ext}。可用：${FORMATS.join(' / ')}` +
      (ext === 'mid' || ext === 'midi' ? '；MIDI 是乐谱不是音频，需要先转成 mp3 或 wav' : '')
    );
  }

  const st = fs.statSync(srcPath);
  if (!st.isFile()) throw new Error('选择的不是一个文件');
  if (st.size > MAX_BYTES) {
    throw new Error(`文件超过 ${MAX_BYTES / 1024 / 1024}MB（当前 ${(st.size / 1024 / 1024).toFixed(1)}MB）`);
  }

  const base = stripExt(path.basename(srcPath)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const file = `${Date.now().toString(36)}-${base}.${ext}`;
  fs.copyFileSync(srcPath, path.join(musicDir, file));

  return { file, name: path.basename(srcPath), size: st.size };
}

/** 读出音乐原始字节交给渲染进程做 blob。文件没了返回 null。 */
function readTrack(file) {
  const p = safeJoin(file);
  if (!p) return null;
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function removeTrack(file) {
  const p = safeJoin(file);
  if (!p) return;
  try { fs.unlinkSync(p); } catch { /* 本来就不在就算了 */ }
}

/** 歌单里指向的文件是否都还在，不在的挑出来（用户手动删过目录的情况） */
function missing(tracks) {
  return (tracks || []).filter(t => !safeJoin(t.file) || !fs.existsSync(safeJoin(t.file)));
}

module.exports = {
  init, getDir, importTrack, readTrack, removeTrack, missing,
  FORMATS, FILTERS, MAX_BYTES,
};
