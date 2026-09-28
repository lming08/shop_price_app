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
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 }, height: { ideal: 1080 },
        // 连续对焦：安卓生效，iOS 忽略；能显著改善近距离条码的清晰度
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

  /** 启动后尽力把摄像头分辨率定到 720p（EAN-13 够用又不会拖慢 JS 解码）；失败无所谓 */
  function bumpResolution(elementId) {
    try {
      const video = document.querySelector('#' + elementId + ' video');
      const track = video && video.srcObject && video.srcObject.getVideoTracks
        ? video.srcObject.getVideoTracks()[0]
        : null;
      if (track && typeof track.applyConstraints === 'function') {
        track.applyConstraints({
          width: { ideal: 1280 },
          height: { ideal: 720 },
          focusMode: 'continuous'
        }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  /** 当前生效画面分辨率（用于状态提示与远程诊断） */
  function videoSize(videoEl) {
    if (!videoEl || !videoEl.videoWidth) return '';
    return videoEl.videoWidth + '×' + videoEl.videoHeight;
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
    videoSize,

    /**
     * 从图片文件里识别条码（相册兜底：拍好的照片直接识别）。
     * 三轮尝试，尽量兜住各种手机照片：
     *   ① 摆正并限制尺寸后的整图（防超大原图超 iOS canvas 上限）
     *   ② 居中裁剪并放大（条码在画面里占比较小时，相当于数码变焦）
     *   ③ 原始文件直接解码（防 canvas 环节在个别机型上异常）
     * @returns {Promise<{code: string|null, info: object}>}
     */
    async decodeImage(file) {
      const MAX_DIM = 2400;
      const info = { type: String(file.type || '未知').replace('image/', ''), size: '读取失败', tried: [] };

      const nativeFmtsCache = { value: null };
      async function nativeFmtsOnce() {
        if (nativeFmtsCache.value === null) nativeFmtsCache.value = await nativeFormats();
        return nativeFmtsCache.value;
      }
      async function tryNative(source) {
        if (typeof window.BarcodeDetector !== 'function') return null;
        const fmts = await nativeFmtsOnce();
        if (!fmts.length) return null;
        try {
          const det = new window.BarcodeDetector({ formats: fmts });
          const codes = await det.detect(source);
          return (codes && codes.length) ? (String(codes[0].rawValue || '').trim() || null) : null;
        } catch (e) { return null; }
      }
      async function tryZXing(source) {
        // 每次都用全新的容器：html5-qrcode 的状态管理器按元素共享，失败后残留状态会影响下一次
        const elId = 'scan-file-decode-' + Math.random().toString(36).slice(2, 7);
        const el = document.createElement('div');
        el.id = elId;
        el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px';
        document.body.appendChild(el);
        try {
          let f = source;
          if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
            const blob = await new Promise(res => source.toBlob(res, 'image/jpeg', 0.92));
            if (!blob) return null;
            f = new File([blob], 'scan.jpg', { type: 'image/jpeg' });
          }
          const h5 = new Html5Qrcode(elId, { formatsToSupport: H5_FORMATS, verbose: false });
          const raw = await h5.scanFile(f, false);
          const text = String(raw || '').trim() || null;
          try { await h5.clear(); } catch (e) { /* ignore */ }
          return text;
        } catch (e) {
          return null;
        } finally {
          el.remove();
        }
      }
      /** 居中裁剪并适度放大（数码变焦），帮助识别画面里较小的条码 */
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

      // 统一加载：按 EXIF 摆正 + 限尺寸
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

      // ① 整图
      if (base) {
        info.tried.push('整图');
        let code = await tryNative(base);
        if (code) return { code, info };
        code = await tryZXing(base);
        if (code) return { code, info };

        // ② 居中裁剪 + 放大（数码变焦）：条码占画面较小时靠它救回
        for (const [ratio, zoomLabel] of [[0.6, '居中放大60%'], [0.4, '居中放大40%']]) {
          try {
            info.tried.push(zoomLabel);
            const zoomed = centerCropZoom(base, ratio, 2000, 3);
            code = await tryNative(zoomed);
            if (code) return { code, info };
            code = await tryZXing(zoomed);
            if (code) return { code, info };
          } catch (e) { /* 忽略，继续兜底 */ }
        }
      }

      // ③ 原始文件直解（防 canvas 环节异常）
      info.tried.push('原始文件');
      const code = await tryZXing(file);
      return { code, info };
    },

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
