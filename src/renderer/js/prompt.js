'use strict';

/* ==========================================================================
   桌宠右键菜单弹出来的轻量编辑窗。
   Electron 没有原生 prompt()，而且这里要的是能和背景图风格对上的卡片，
   所以自己画一个：只带当前要改的那一个字段。
   ========================================================================== */

const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'text';
const init = params.get('init') || '';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

const TITLES = {
  text: '待办内容',
  due: '提醒时间',
  interval: '提醒间隔',
  repeat: '周期重复',
  new: '新建待办',
};

function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const body = $('body');
let primaryInput = null;

$('title').textContent = TITLES[mode] || '编辑';

if (mode === 'text' || mode === 'new') {
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 120;
  input.placeholder = '要做什么…';
  input.value = mode === 'new' ? '' : init;
  body.appendChild(input);
  primaryInput = input;
}

if (mode === 'due' || mode === 'new') {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.value = mode === 'new'
    ? toLocalInput(Date.now() + 3600000)
    : (init || toLocalInput(Date.now() + 3600000));
  wrap.appendChild(input);
  body.appendChild(wrap);
  if (!primaryInput) primaryInput = input;
  input.id = 'dueInput';

  if (mode === 'new') {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '提醒间隔和周期重复可以先留空，之后再改。';
    body.appendChild(hint);
  }
}

if (mode === 'interval') {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = '1440';
  input.step = '1';
  input.value = init || '0';
  body.appendChild(input);
  primaryInput = input;

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = '到点后如果没处理，每隔这么多分钟再响一次。填 0 表示只响一次。';
  body.appendChild(hint);
}

if (mode === 'repeat') {
  const wrap = document.createElement('div');
  wrap.className = 'row';

  const every = document.createElement('input');
  every.type = 'number';
  every.min = '1';
  every.max = '99';
  every.step = '1';

  const unit = document.createElement('select');
  for (const [v, label] of [['min', '分钟'], ['hour', '小时'], ['day', '天'], ['week', '周']]) {
    unit.appendChild(new Option(label, v));
  }

  const [e0, u0] = (init || '1:day').split(':');
  every.value = e0 || '1';
  unit.value = u0 || 'day';

  wrap.append(every, unit);
  body.appendChild(wrap);
  primaryInput = every;

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = '完成后自动排下一次提醒。';
  body.appendChild(hint);
}

// ------------------------------------------------------------------ 取值

function collect() {
  if (mode === 'text') return $('body').querySelector('input').value;

  if (mode === 'due') {
    const v = $('dueInput').value;
    return v || '';
  }

  if (mode === 'interval') return String(Number($('body').querySelector('input').value) || 0);

  if (mode === 'repeat') {
    const [every, unit] = $('body').querySelectorAll('input, select');
    return `${Number(every.value) || 1}:${unit.value}`;
  }

  if (mode === 'new') {
    const text = $('body').querySelector('input[type="text"]').value.trim();
    const dueAt = $('dueInput').value;
    return { text, dueAt: dueAt ? new Date(dueAt).getTime() : null, intervalMin: 0 };
  }

  return init;
}

async function submit() {
  const value = collect();

  if (mode === 'text' && !String(value).trim()) return;      // 空内容不接受
  if (mode === 'new' && !value.text) { primaryInput.focus(); return; }
  if (mode === 'due' && !value) return;

  await window.api.promptSubmit(mode, value);
  window.api.promptClose();
}

// ------------------------------------------------------------------ 交互

$('ok').onclick = submit;
$('cancel').onclick = () => window.api.promptClose();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submit(); }
  else if (e.key === 'Escape') { e.preventDefault(); window.api.promptClose(); }
});

if (primaryInput) {
  primaryInput.focus();
  if (primaryInput.select) primaryInput.select();
}
