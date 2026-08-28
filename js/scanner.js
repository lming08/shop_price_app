/* 包姐便利店 · 查价 —— 扫码封装
 * 优先使用浏览器原生 BarcodeDetector（安卓 Chrome 支持，性能好），
 * 不支持时回退到 html5-qrcode（iOS Safari 也可用）。
 */
'use strict';

const Scanner = (() => {
  // 便利店常见一维码制
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

  function hasNative() {
    return typeof window.BarcodeDetector === 'function';
  }

  /** 原生 BarcodeDetector 扫描循环 */
  function startNative(videoEl, onDetected) {
    const detector = new window.BarcodeDetector({ formats: FORMATS });
    let stopped = false;
    let lastText = '';
    let lastAt = 0;

    async function loop() {
      if (stopped) return;
      try {
        if (videoEl.readyState >= 2) {
          const codes = await detector.detect(videoEl);
          const now = Date.now();
          for (const c of codes) {
            const text = String(c.rawValue || '').trim();
            if (text && !(text === lastText && now - lastAt < 1500)) {
              lastText = text; lastAt = now;
              onDetected(text);
              return; // 命中即停
            }
          }
        }
      } catch (e) { /* 单帧失败忽略 */ }
      if (!stopped) setTimeout(loop, 120);
    }
    loop();

    return {
      stop() { stopped = true; }
    };
  }

  /** html5-qrcode 扫描（iOS 兜底） */
  function startHtml5(elementId, onDetected) {
    const h5 = new Html5Qrcode(elementId, {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.ITF
      ]
    });
    let stopped = false;
    const config = {
      fps: 10,
      qrbox: (vw, vh) => {
        const side = Math.floor(Math.min(vw, vh) * 0.85);
        return { width: side, height: Math.floor(side * 0.55) };
      },
      aspectRatio: 1.0
    };
    h5.start(
      { facingMode: 'environment' },
      config,
      (text) => { if (!stopped) { stopped = true; onDetected(String(text).trim()); } },
      () => { /* 每帧未识别的回调，忽略 */ }
    ).catch(err => {
      if (!stopped) { stopped = true; onDetected(null, err); }
    });

    return {
      async stop() {
        stopped = true;
        try { await h5.stop(); h5.clear(); } catch (e) { /* already stopped */ }
      }
    };
  }

  return {
    /** 打开摄像头开始扫码，返回 { stop(), engine } */
    async start(videoEl, overlayElementId, onDetected) {
      if (hasNative()) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        videoEl.srcObject = stream;
        await videoEl.play();
        const engine = 'native';
        const handle = startNative(videoEl, onDetected);
        return {
          engine,
          async stop() {
            handle.stop();
            stream.getTracks().forEach(t => t.stop());
            videoEl.srcObject = null;
          }
        };
      }
      // html5-qrcode 自行管理摄像头
      const handle = startHtml5(overlayElementId, (text, err) => onDetected(text, err));
      return { engine: 'html5-qrcode', stop: handle.stop };
    }
  };
})();
