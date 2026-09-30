'use strict';

/**
 * 提示音播放。
 *
 * 两种来源：
 *   默认 —— 用 Web Audio 现场合成，不依赖任何音频文件，也就不会被误删；
 *   自定义 —— 主进程把音频字节读出来交到这里，用 decodeAudioData 解码。
 *
 * 走 decodeAudioData 而不是 <audio src="file://..."> 是有意的：用户选的
 * 文件名很可能是中文，file:// URL 在编码上很容易出岔子，而且没解码成功
 * 时是静默失败的 —— 直到某天提醒该响却没响才会发现。
 */

const Sound = (() => {
  let ctx = null;
  let master = null;
  let customBuffer = null;
  let config = { mode: 'default', file: null, name: null, volume: 0.8 };

  function ac() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.connect(ctx.destination);
      applyVolume();
    }
    // 长时间没声音之后浏览器会把 AudioContext 挂起，响之前先唤醒
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function applyVolume() {
    if (master) master.gain.value = config.volume;
  }

  /** 默认提示音：A 大三和弦的琶音，软起音 + 长衰减，柔和但听得见 */
  function playDefault() {
    const c = ac();
    const t0 = c.currentTime + 0.02;
    const NOTES = [880, 1108.73, 1318.51];   // A5 · C#6 · E6
    NOTES.forEach((freq, i) => {
      const t = t0 + i * 0.095;
      const osc = c.createOscillator();
      const gain = c.createGain();
      const lp = c.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.value = freq;

      // 砍掉高频泛音，避免在笔记本小喇叭上听起来发尖
      lp.type = 'lowpass';
      lp.frequency.value = 4200;

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.30, t + 0.014);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.55);

      osc.connect(gain).connect(lp).connect(master);
      osc.start(t);
      osc.stop(t + 1.7);
    });
  }

  function playCustom() {
    if (!customBuffer) return false;
    const c = ac();
    const src = c.createBufferSource();
    src.buffer = customBuffer;
    src.connect(master);
    src.start();
    return true;
  }

  return {
    /** 用主进程发来的配置刷新本地状态；data 是自定义音频的原始字节 */
    setConfig(cfg, data) {
      config = { ...config, ...cfg };
      applyVolume();
      if (data && data.byteLength) {
        const c = ac();
        // decodeAudioData 会「吞掉」传进去的 ArrayBuffer，所以拷一份
        const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        return c.decodeAudioData(copy)
          .then(buf => { customBuffer = buf; return true; })
          .catch(err => {
            console.error('[sound] 解码失败，将退回默认提示音:', err.message);
            customBuffer = null;
            return false;
          });
      }
      if (!cfg || cfg.mode !== 'custom') customBuffer = null;
      return Promise.resolve(false);
    },

    setVolume(v) { config.volume = v; applyVolume(); },

    play() {
      // 自定义音没解码出来（格式不支持、文件损坏）也要退回默认音 ——
      // 宁可音色不对，也不能不响。
      if (config.mode === 'custom' && customBuffer) return playCustom();
      playDefault();
      return true;
    },
  };
})();
