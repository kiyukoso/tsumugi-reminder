'use strict';

/**
 * 渲染进程与主进程之间唯一的通道。
 *
 * contextIsolation 是开着的，渲染进程拿不到 Node，只能用这里显式列出的
 * 这些方法 —— 页面里跑的任何东西都没法直接碰文件系统。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程推来的事件，返回一个取消订阅的函数 */
function sub(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  // ---------------------------------------------------------- 待办
  listTodos: () => ipcRenderer.invoke('todos:list'),
  addTodo: (fields) => ipcRenderer.invoke('todos:add', fields),
  updateTodo: (id, patch) => ipcRenderer.invoke('todos:update', id, patch),
  removeTodo: (id) => ipcRenderer.invoke('todos:remove', id),
  action: (id, action, arg) => ipcRenderer.invoke('todos:action', id, action, arg),

  // ---------------------------------------------------------- 窗口控制
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowClose: () => ipcRenderer.invoke('window:close'),

  // ---------------------------------------------------------- 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSnoozeMin: (v) => ipcRenderer.invoke('settings:snoozeMin', v),

  // ---------------------------------------------------------- 提示音
  getSound: () => ipcRenderer.invoke('sound:get'),
  pickSound: () => ipcRenderer.invoke('sound:pick'),
  setSoundMode: (mode) => ipcRenderer.invoke('sound:setMode', mode),
  setVolume: (v) => ipcRenderer.invoke('sound:setVolume', v),

  // ---------------------------------------------------------- 自定义图片
  getImages: () => ipcRenderer.invoke('images:get'),
  getImage: (key) => ipcRenderer.invoke('images:getOne', key),
  pickImage: (key, opts) => ipcRenderer.invoke('images:pick', key, opts),
  setBuiltinImage: (key, builtinKey) => ipcRenderer.invoke('images:setBuiltin', key, builtinKey),
  setImagePos: (key, patch) => ipcRenderer.invoke('images:setPos', key, patch),
  setPetHeight: (px) => ipcRenderer.invoke('pet:setHeight', px),

  onImagesChanged: (cb) => sub('images:changed', cb),
  onPetSpriteChanged: (cb) => sub('pet:spriteChanged', cb),

  // ---------------------------------------------------------- 桌宠
  petShow: () => ipcRenderer.invoke('pet:show'),
  petHide: () => ipcRenderer.invoke('pet:hide'),
  petToggle: () => ipcRenderer.invoke('pet:toggle'),
  petIgnoreMouse: (ignore) => ipcRenderer.invoke('pet:ignoreMouse', ignore),
  petDragStart: (sx, sy) => ipcRenderer.invoke('pet:dragStart', sx, sy),
  petDragMove: (sx, sy) => ipcRenderer.invoke('pet:dragMove', sx, sy),
  petDragEnd: () => ipcRenderer.invoke('pet:dragEnd'),
  petOpenMain: () => ipcRenderer.invoke('pet:openMain'),
  petContextMenu: () => ipcRenderer.invoke('pet:contextMenu'),

  // ---------------------------------------------------------- 轻量编辑窗
  promptOpen: (mode) => ipcRenderer.invoke('prompt:open', mode),
  promptClose: () => ipcRenderer.invoke('prompt:close'),
  promptSubmit: (mode, value) => ipcRenderer.invoke('prompt:submit', mode, value),

  // ---------------------------------------------------------- 自动更新
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => sub('update:status', cb),

  // ---------------------------------------------------------- 退出
  quitChoose: (choice) => ipcRenderer.invoke('quit:choose', choice),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // ---------------------------------------------------------- 主进程 → 渲染进程
  onTodosChanged: (cb) => sub('todos:changed', cb),
  onAlert: (cb) => sub('alert:fire', cb),
  onQuitAsk: (cb) => sub('quit:ask', cb),
  onPetBubble: (cb) => sub('pet:bubble', cb),
  onFocusTodo: (cb) => sub('ui:focusTodo', cb),
});
