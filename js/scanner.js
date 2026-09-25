/* 包姐便利店 · 查价 —— 扫码封装
 * 优先原生 BarcodeDetector（安卓 Chrome），不支持/异常时自动回退 html5-qrcode（iOS Safari）。
 * 注意：html5-qrcode 启动时会清空其容器内容，因此必须给它一个专用的空容器（#scan-camera），
 *      瞄准框/提示等界面元素放在容器外面，避免被清掉或与解码区域错位。
 */
'use strict';

const Scanner = (() => {
  // 便利店常见一维码制
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

  const H5_FORMATS = [
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.ITF
  ];

  /** 调试用：URL 加 ?engine=html5 或 ?engine=native 可强制指定识别引擎 */
  function forcedEngine() {
    try {
      const p = new URLSearchParams(location.search).get('engine');
      return (p === 'html5' || p === 'native') ? p : null;
    } catch (e) {
      return null;
    }
  }

  /** 原生 BarcodeDetector 实际支持的码制（避免构造器因不支持某码制直接抛错） */
  async function nativeFormats() {
    if (typeof window.BarcodeDetector !== 'function') return [];
    try {
      if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        return FORMATS.filter(f => supported.includes(f));
      }
      return FORMATS.slice();
    } catch (e) {
      return [];
    }
  }

  async function openCamera(videoEl) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    videoEl.setAttribute('playsinline', 'true');
    videoEl.muted = true;
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  }

  /**
   * 原生检测循环。
   * - 连续报错 > 25 次 → onFail('detect')，调用方降级到 html5-qrcode
   * - 6 秒内视频一帧都没出来 → onFail('no-frames')，同样降级
   */
  function runNativeLoop(detector, videoEl, onDetected, onFail) {
    let stopped = false;
    let lastText = '';
    let lastAt = 0;
    let consecutiveErrors = 0;
    let sawFrame = false;
    const startedAt = Date.now();

    async function tick() {
      if (stopped) return;
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        sawFrame = true;
        try {
          const codes = await detector.detect(videoEl);
          consecutiveErrors = 0;
          const now = Date.now();
          for (const c of codes) {
            const text = String(c.rawValue || '').trim();
            if (text && !(text === lastText && now - lastAt < 1500)) {
              stopped = true;
              onDetected(text);
              return;
            }
          }
        } catch (e) {
          consecutiveErrors++;
          if (consecutiveErrors > 25) { stopped = true; onFail('detect'); return; }
        }
      } else if (!sawFrame && Date.now() - startedAt > 6000) {
        stopped = true;
        onFail('no-frames');
        return;
      }
      if (!stopped) setTimeout(tick, 120);
    }
    tick();

    return { stop() { stopped = true; } };
  }

  /** 启动后尽力把摄像头分辨率调高（EAN-13 窄条码更易识别）；失败无所谓 */
  function bumpResolution(elementId) {
    try {
      const video = document.querySelector('#' + elementId + ' video');
      const track = video && video.srcObject && video.srcObject.getVideoTracks
        ? video.srcObject.getVideoTracks()[0]
        : null;
      if (track && typeof track.applyConstraints === 'function') {
        track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  /** html5-qrcode 路径：全画面解码（不设 qrbox，避免"看到的框"和"解码区域"错位） */
  function startHtml5(elementId, onDetected, onError) {
    const h5 = new Html5Qrcode(elementId, { formatsToSupport: H5_FORMATS });
    let stopped = false;
    // 注意：html5-qrcode 要求第一个参数是"只有 1 个键"的对象；
    // 分辨率不能通过 config.videoConstraints 传（该版本只认音频约束键，会被忽略），
    // 因此启动成功后再用 applyConstraints 提升分辨率。
    h5.start(
      { facingMode: 'environment' },
      { fps: 10 },
      (text) => {
        if (stopped) return;
        stopped = true;
        onDetected(String(text).trim());
      },
      () => { /* 每帧未识别的回调，忽略 */ }
    ).then(() => {
      bumpResolution(elementId);
    }).catch(err => {
      if (!stopped) { stopped = true; onError(err); }
    });

    return {
      engine: 'html5-qrcode',
      async stop() {
        stopped = true;
        try { await h5.stop(); h5.clear(); } catch (e) { /* already stopped */ }
      }
    };
  }

  return {
    /**
     * 打开摄像头开始扫码。
     * @returns {Promise<{engine: string, stop: function}>}
     */
    async start(videoEl, html5ContainerId, onDetected, onEngineChange) {
      const force = forcedEngine();
      const supported = force === 'html5' ? [] : await nativeFormats();
      const notify = (engine, reason) => {
        if (typeof onEngineChange === 'function') onEngineChange(engine, reason);
      };

      // ---- 优先原生 BarcodeDetector ----
      if (supported.length > 0 && force !== 'html5') {
        let stream = null;
        try {
          stream = await openCamera(videoEl);
          const detector = new window.BarcodeDetector({ formats: supported });
          const state = { engine: 'native', stop: null };
          notify('native');

          const loop = runNativeLoop(detector, videoEl, (text) => {
            state.stop = null;
            onDetected(text);
          }, async (reason) => {
            // 原生识别不可用 → 释放摄像头，切换 html5-qrcode 兜底
            try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
            videoEl.srcObject = null;
            notify('html5-qrcode', reason);
            const h = startHtml5(html5ContainerId, onDetected, (err) => onDetected(null, err));
            state.engine = 'html5-qrcode';
            state.stop = h.stop;
          });

          state.stop = async () => {
            loop.stop();
            try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
            videoEl.srcObject = null;
          };

          return {
            engine: 'native',
            async stop() { if (state.stop) await state.stop(); }
          };
        } catch (e) {
          if (stream) {
            try { stream.getTracks().forEach(t => t.stop()); } catch (e2) { /* ignore */ }
            videoEl.srcObject = null;
          }
          // 权限/无摄像头/被占用：直接上报，不再尝试兼容引擎（它同样打不开）
          if (e && ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(e.name)) {
            throw e;
          }
          // 其他异常（如 BarcodeDetector 构造失败）：走 html5-qrcode
        }
      }

      // ---- 兜底：html5-qrcode（iOS Safari 等） ----
      notify('html5-qrcode');
      return startHtml5(html5ContainerId, onDetected, (err) => onDetected(null, err));
    }
  };
})();
