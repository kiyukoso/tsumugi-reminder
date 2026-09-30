'use strict';

/**
 * 自动更新（走 GitHub Releases）。
 *
 * 只在打包版里工作：开发时项目根没有打包出来的 app-update.yml，
 * electron-updater 一调用就抛错。所以开发环境直接报「不适用」，
 * 免得每次 npm start 都弹一条吓人的红字。
 *
 * 状态机会一路推给界面：
 *   dev → 开发环境，不检查
 *   idle → 还没查
 *   checking → 正在查
 *   none → 已是最新
 *   available → 发现新版本，开始后台下载
 *   downloading → 下载中（带百分比）
 *   downloaded → 下好了，等用户点「重启并安装」
 *   error → 出错（把原因带上，别让用户对着一个转圈猜）
 */

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

let status = { state: 'idle', version: null, percent: 0, message: '' };
let notify = () => {};

function setStatus(patch) {
  status = { ...status, ...patch };
  notify(status);
  return status;
}

function getStatus() {
  return status;
}

function init(onStatus) {
  notify = typeof onStatus === 'function' ? onStatus : () => {};

  if (!app.isPackaged) {
    return setStatus({ state: 'dev' });
  }

  // 发现新版本就直接在后台下，用户不用再点一次。
  // 下好之后不自动重启（那会打断正在做的事），交给用户决定时机；
  // 但他要是直接退出应用，退出时装上也挺好。
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // electron-updater 默认会往控制台打一堆东西，也没接日志文件
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', percent: 0, message: '' }));

  autoUpdater.on('update-available', (info) => {
    setStatus({ state: 'available', version: info.version, percent: 0, message: '' });
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'none', version: null, percent: 0, message: '' });
  });

  autoUpdater.on('download-progress', (p) => {
    setStatus({ state: 'downloading', percent: Math.round(p.percent || 0) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ state: 'downloaded', version: info.version, percent: 100 });
  });

  autoUpdater.on('error', (err) => {
    setStatus({ state: 'error', message: (err && err.message) || String(err) });
  });

  // 启动时别和其他初始化抢资源，等界面稳下来再查
  setTimeout(() => { check(); }, 8000);
}

async function check() {
  if (!app.isPackaged) return getStatus();
  if (status.state === 'downloading' || status.state === 'downloaded') return getStatus();

  setStatus({ state: 'checking', percent: 0, message: '' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', message: (err && err.message) || String(err) });
  }
  return getStatus();
}

/** 重启并安装。会走 app.quit()，所以 main.js 里拦截关窗的逻辑要放行。 */
function install() {
  if (status.state !== 'downloaded') return false;
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
}

module.exports = { init, check, install, getStatus };
