/* 包姐便利店 · 查价 —— 扫码封装
 * 两个引擎：
 *  1) 原生 BarcodeDetector（安卓 Chrome）—— 最快
 *  2) zxing-js（lib/zxing.min.js，@zxing/library）—— iOS Safari 等没有原生能力的浏览器
 *
 * 重要经验（血泪）：
 *  - 不要用 html5-qrcode 的内置解码做一维码：实测它对 EAN-13 实际不可用（桌面端一直是靠原生
 *    BarcodeDetector 委托通过，掩盖了问题），iPhone 上表现为"扫码毫无反应"。
 *  - zxing-js 的连续扫描默认间隔 500ms，必须显式调小（否则非常迟钝）。
 *  - 图片识别要按 EXIF 摆正并限制尺寸（手机原图可达 4800 万像素，会超 iOS canvas 面积上限）。
 */
'use strict';

const Scanner = (() => {
  // 便利店常见一维码制
  const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
  const SCAN_INTERVAL_MS = 120;   // zxing-js 连续扫描间隔

  /** 调试用：URL 加 ?engine=native 或 ?engine=zxing 可强制指定识别引擎 */
  function forcedEngine() {
    try {
      const p = new URLSearchParams(location.search).get('engine');
      return (p === 'native' || p === 'zxing') ? p : null;
    } catch (e) {
      return null;
    }
  }

  function hasNative() {
    return typeof window.BarcodeDetector === 'function';
  }

  function zxingAvailable() {
    return typeof ZXing !== 'undefined' && typeof ZXing.BrowserMultiFormatReader === 'function';
  }

  function zxingHints() {
    const F = ZXing.BarcodeFormat;
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
      [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    return hints;
  }

  /** 原生 BarcodeDetector 实际支持的码制（避免构造器因不支持某码制直接抛错） */
  async function nativeFormats() {
    if (!hasNative()) return [];
    try {
      if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        return NATIVE_FORMATS.filter(f => supported.includes(f));
      }
      return NATIVE_FORMATS.slice();
    } catch (e) {
      return [];
    }
  }

  async function openCamera(videoEl) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 }, height: { ideal: 720 },
        focusMode: 'continuous'
      },
      audio: false
    });
    videoEl.setAttribute('playsinline', 'true');
    videoEl.muted = true;
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  }

  /**
   * 原生检测循环：连续报错 > 25 次或 6 秒无帧 → onFail，调用方降级到 zxing
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
      if (!stopped) setTimeout(tick, SCAN_INTERVAL_MS);
    }
    tick();

    return { stop() { stopped = true; } };
  }

  /**
   * zxing-js 连续扫描（自建循环）
   * 注意：不能直接用库的 decodeContinuously —— 它给视频帧构造 luminance 源时传了
   * HTMLCanvasElementLuminanceSource(canvas, true)，在 0.21.x 上会导致一维码永远解不出
   * （图片路径传 false 正常）。这里自己抓帧并用 false 构造。
   */
  async function startZxingLive(videoEl, onDetected, onError) {
    let stream = null;
    try {
      stream = await openCamera(videoEl);
    } catch (e) {
      onError(e);
      return { engine: 'zxing', async stop() { /* 未能启动 */ } };
    }

    let stopped = false;
    let ctx = null;
    const canvas = document.createElement('canvas');
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(zxingHints());

    async function tick() {
      if (stopped) return;
      try {
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
          if (canvas.width !== videoEl.videoWidth || canvas.height !== videoEl.videoHeight) {
            canvas.width = videoEl.videoWidth;
            canvas.height = videoEl.videoHeight;
            ctx = canvas.getContext('2d', { willReadFrequently: true });
          }
          if (ctx) {
            ctx.drawImage(videoEl, 0, 0);
            try {
              const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas, false);
              const bin = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
              const result = reader.decode(bin);
              const text = result && result.getText ? String(result.getText()).trim() : '';
              if (text) {
                stopped = true;
                onDetected(text);
                return;
              }
            } catch (e) { /* 未识别到：继续下一帧 */ }
          }
        }
      } catch (e) { /* 忽略单帧异常 */ }
      if (!stopped) setTimeout(tick, SCAN_INTERVAL_MS);
    }
    tick();

    return {
      engine: 'zxing',
      async stop() {
        stopped = true;
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        videoEl.srcObject = null;
      }
    };
  }

  /** 当前生效画面分辨率（用于状态提示与远程诊断） */
  function videoSize(videoEl) {
    if (!videoEl || !videoEl.videoWidth) return '';
    return videoEl.videoWidth + '×' + videoEl.videoHeight;
  }

  /**
   * 用 zxing-js 解码一张图片（canvas / File / Blob）
   * canvas 直接用低层接口（快）；文件走 decodeFromImageUrl
   * @returns {Promise<string|null>}
   */
  async function zxingDecodeSource(source) {
    if (!zxingAvailable()) return null;
    try {
      if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
        const reader = new ZXing.MultiFormatReader();
        reader.setHints(zxingHints());
        const lum = new ZXing.HTMLCanvasElementLuminanceSource(source, false);
        const bin = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
        const result = reader.decode(bin);
        const text = result && result.getText ? String(result.getText()).trim() : '';
        return text || null;
      }
      if (source instanceof Blob) {
        const url = URL.createObjectURL(source);
        try {
          const reader = new ZXing.BrowserMultiFormatReader(zxingHints(), SCAN_INTERVAL_MS);
          const result = await reader.decodeFromImageUrl(url);
          const text = result && result.getText ? String(result.getText()).trim() : '';
          try { reader.reset(); } catch (e) { /* ignore */ }
          return text || null;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  return {
    videoSize,

    /**
     * 从图片文件里识别条码（相册兜底）。
     * 多轮尝试：整图 → 居中放大（数码变焦）→ 原始文件直解
     * 每轮：原生 BarcodeDetector 优先，zxing-js 兜底
     * @returns {Promise<{code: string|null, info: object}>}
     */
    async decodeImage(file) {
      const MAX_DIM = 2400;
      const force = forcedEngine();
      const info = { type: String(file.type || '未知').replace('image/', ''), size: '读取失败', tried: [] };

      async function tryNative(source) {
        if (force === 'zxing') return null;
        const fmts = await nativeFormats();
        if (!fmts.length) return null;
        try {
          const det = new window.BarcodeDetector({ formats: fmts });
          const codes = await det.detect(source);
          return (codes && codes.length) ? (String(codes[0].rawValue || '').trim() || null) : null;
        } catch (e) { return null; }
      }

      function centerCropZoom(src, ratio, targetW, maxZoom) {
        const cw = Math.max(1, Math.round(src.width * ratio));
        const ch = Math.max(1, Math.round(src.height * ratio));
        const x = Math.round((src.width - cw) / 2);
        const y = Math.round((src.height - ch) / 2);
        const zoom = Math.min(maxZoom, Math.max(1, targetW / cw));
        const out = document.createElement('canvas');
        out.width = Math.round(cw * zoom);
        out.height = Math.round(ch * zoom);
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(src, x, y, cw, ch, 0, 0, out.width, out.height);
        return out;
      }

      // 统一加载：按 EXIF 摆正 + 限制尺寸
      let base = null;
      try {
        let src = null;
        try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch (e) { src = await createImageBitmap(file); }
        base = document.createElement('canvas');
        const scale = Math.min(1, MAX_DIM / Math.max(src.width, src.height));
        base.width = Math.max(1, Math.round(src.width * scale));
        base.height = Math.max(1, Math.round(src.height * scale));
        base.getContext('2d').drawImage(src, 0, 0, base.width, base.height);
        info.size = base.width + '×' + base.height;
      } catch (e) {
        try {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.src = url;
          await img.decode();
          base = document.createElement('canvas');
          const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
          base.width = Math.max(1, Math.round(img.naturalWidth * scale));
          base.height = Math.max(1, Math.round(img.naturalHeight * scale));
          base.getContext('2d').drawImage(img, 0, 0, base.width, base.height);
          info.size = base.width + '×' + base.height;
          URL.revokeObjectURL(url);
        } catch (e2) { base = null; }
      }

      function upscale(src, factor) {
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(src.width * factor));
        out.height = Math.max(1, Math.round(src.height * factor));
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(src, 0, 0, out.width, out.height);
        return out;
      }

      const targets = [];
      if (base) {
        targets.push(['整图', base]);
        // 小图放大后 ZXing 更容易识别（实测 720p 照片靠这一轮救回）
        if (Math.max(base.width, base.height) < 1600) {
          try { targets.push(['整图放大2倍', upscale(base, 2)]); } catch (e) { /* ignore */ }
        }
        try { targets.push(['居中放大60%', centerCropZoom(base, 0.6, 2000, 3)]); } catch (e) { /* ignore */ }
        try { targets.push(['居中放大40%', centerCropZoom(base, 0.4, 2000, 3)]); } catch (e) { /* ignore */ }
      }
      targets.push(['原始文件', file]);

      for (const [label, source] of targets) {
        info.tried.push(label);
        let code = null;
        try { code = await tryNative(source); } catch (e) { code = null; }
        if (code) return { code, info };
        code = await zxingDecodeSource(source);
        if (code) return { code, info };
      }
      return { code: null, info };
    },

    /**
     * 打开摄像头开始扫码。
     * @returns {Promise<{engine: string, stop: function}>}
     */
    async start(videoEl, _html5ContainerId, onDetected, onEngineChange) {
      const force = forcedEngine();
      const notify = (engine, reason) => {
        if (typeof onEngineChange === 'function') onEngineChange(engine, reason);
      };

      // ---- 优先原生 BarcodeDetector ----
      const supported = (force === 'zxing') ? [] : await nativeFormats();
      if (supported.length > 0 && hasNative()) {
        let stream = null;
        try {
          stream = await openCamera(videoEl);
          const detector = new window.BarcodeDetector({ formats: supported });
          const state = { stop: null };
          notify('native');

          const loop = runNativeLoop(detector, videoEl, (text) => {
            state.stop = null;
            onDetected(text);
          }, async (reason) => {
            // 原生识别不可用 → 释放摄像头，切换 zxing-js 兜底
            try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
            videoEl.srcObject = null;
            notify('zxing', reason);
            const h = await startZxingLive(videoEl, onDetected, (err) => onDetected(null, err));
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
          // 权限/无摄像头/被占用：直接上报（换引擎同样打不开）
          if (e && ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(e.name)) {
            throw e;
          }
          // 其他异常：走 zxing
        }
      }

      // ---- 兼容引擎：zxing-js（iOS Safari 等） ----
      if (!zxingAvailable()) {
        throw new Error('扫码组件未加载（lib/zxing.min.js）');
      }
      notify('zxing');
      return startZxingLive(videoEl, onDetected, (err) => onDetected(null, err));
    }
  };
})();
