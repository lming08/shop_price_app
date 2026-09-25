/* 包姐便利店 · 查价 —— 应用主逻辑（Vue 3，模板在 index.html 中） */
'use strict';

const RECENT_KEY = 'baojie_recent_v1';
const photoURLCache = new Map();

const App = {
  data() {
    return {
      tab: 'scan',
      loading: true,
      products: [],
      q: '',
      manualCode: '',
      scan: { active: false, engine: '', error: '', manualShow: false, manualCode: '', starting: false, ready: false, slow: false, res: '', photoBusy: false, mode: 'lookup' },
      result: { show: false, product: null, barcode: '', editingPrice: false, priceDraft: '' },
      edit: {
        show: false, id: null,
        form: { barcode: '', name: '', price: '', unit: '', notes: '' },
        photoBlob: null, photoPreview: ''
      },
      report: null,
      recent: [],
      toast: { text: '', err: false, timer: null },
      installEvt: null
    };
  },

  computed: {
    filteredProducts() {
      const q = (this.q || '').trim().toLowerCase();
      if (!q) return this.products;
      return this.products.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.barcode || '').includes(q) ||
        (p.notes || '').toLowerCase().includes(q));
    },
    barcodeCount() {
      return this.products.filter(p => p.barcode).length;
    },
    resultPhotoURL() {
      return this.photoURL(this.result.product);
    },
    isIOS() {
      const ua = navigator.userAgent || '';
      return /iphone|ipad|ipod/i.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    },
    isWeChat() {
      return /MicroMessenger/i.test(navigator.userAgent || '');
    },
    isStandalone() {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true;
    },
    appVersion() {
      return (typeof APP_BUILD !== 'undefined' && APP_BUILD.version) ? APP_BUILD.version : '未知';
    },
    appBuildDate() {
      return (typeof APP_BUILD !== 'undefined' && APP_BUILD.date) ? APP_BUILD.date : '未知';
    },
    appNote() {
      return (typeof APP_BUILD !== 'undefined' && APP_BUILD.note) ? APP_BUILD.note : '';
    },
    scanTip() {
      if (this.scan.error) return '';
      if (this.scan.photoBusy) return '正在识别图片，请稍等…';
      if (this.scan.starting) return '正在打开摄像头，请稍等…';
      if (!this.scan.ready) return '把商品条码对准方框，会自动识别';
      if (this.scan.slow) {
        return '还没识别到？把手机拿远一点（约 15 厘米）、光线亮一点，让整条条码都在画面内；也可点下面「用拍好的照片识别」';
      }
      const engine = this.scan.engine === 'native' ? '高速识别' : '兼容识别';
      return '摄像头已就绪（' + engine + (this.scan.res ? ' ' + this.scan.res : '') + '），把条码对准方框';
    }
  },

  methods: {
    /* ---------- 通用 ---------- */
    showToast(text, err = false) {
      this.toast.text = text;
      this.toast.err = err;
      clearTimeout(this.toast.timer);
      this.toast.timer = setTimeout(() => { this.toast.text = ''; }, 2800);
    },

    fmtPrice(n) {
      const s = Number(n).toFixed(2);
      return s.endsWith('.00') ? s.slice(0, -3) : s;
    },

    fmtWhen(ts) {
      if (!ts) return '未知时间';
      const d = new Date(ts);
      const now = new Date();
      const sameYear = d.getFullYear() === now.getFullYear();
      return `${sameYear ? '' : d.getFullYear() + '年'}${d.getMonth() + 1}月${d.getDate()}日`;
    },

    photoURL(p) {
      if (!p || !p.photo) return '';
      const key = p.id + ':' + (p.updatedAt || 0);
      if (photoURLCache.has(key)) return photoURLCache.get(key);
      const url = URL.createObjectURL(p.photo);
      photoURLCache.set(key, url);
      return url;
    },

    /** 单位展示：空或 "1" 视为按件卖，不显示单位后缀 */
    fmtUnit(u) {
      const s = String(u || '').trim();
      return (s && s !== '1') ? s : '';
    },

    async refresh() {
      this.products = await DB.all();
      this.loading = false;
    },

    /* ---------- 扫码 ----------
     * mode: 'lookup' 扫码查价（默认）
     *       'add'    商品页「扫码添加商品」：没建档就去新建，已建档直接显示该商品
     *       'fill'   表单里「扫条码」：只把条码填进当前表单
     */
    async openScan(mode) {
      if (!window.isSecureContext) {
        this.showToast('摄像头需要 HTTPS 环境，请通过 https:// 网址打开', true);
        return;
      }
      this.scan = {
        active: true, engine: '', error: '', manualShow: false, manualCode: '', starting: true,
        ready: false, slow: false, res: '', photoBusy: false,
        mode: typeof mode === 'string' ? mode : 'lookup'
      };
      await this.$nextTick();
      this._clearScanTimers();
      // 权限弹窗等场景可能长时间无响应：9 秒后给出兜底提示
      let timedOut = false;
      this._scanTimeoutTimer = setTimeout(() => {
        timedOut = true;
        this.scan.starting = false;
        this.scan.error = '打开摄像头超时：请在浏览器设置里允许使用相机，或点下方「手动输入」。';
      }, 9000);
      try {
        const handle = await Scanner.start(
          this.$refs.scanVideo,
          'scan-camera',
          (text, err) => this.onScanDetected(text, err),
          (engine) => { this.scan.engine = engine; }
        );
        clearTimeout(this._scanTimeoutTimer);
        this._scanTimeoutTimer = null;
        if (timedOut) { try { await handle.stop(); } catch (e) { /* ignore */ } return; }
        this._scanHandle = handle;
        this.scan.engine = handle.engine;
        this.scan.starting = false;
        this.scan.ready = true;
        // 读取实际画面分辨率（状态提示里显示，便于排查手机端问题）
        setTimeout(() => {
          try {
            const v = (handle.engine === 'native')
              ? this.$refs.scanVideo
              : document.querySelector('#scan-camera video');
            if (this.scan.active) this.scan.res = Scanner.videoSize(v);
          } catch (e) { /* ignore */ }
        }, 1200);
        // 识别几秒还没结果就给操作提示（离远一点 / 光线亮一点 / 用相册图）
        this._scanSlowTimer = setTimeout(() => { this.scan.slow = true; }, 5000);
      } catch (e) {
        clearTimeout(this._scanTimeoutTimer);
        this._scanTimeoutTimer = null;
        this.scan.starting = false;
        this.scan.error = '打不开摄像头：' + (e && e.message ? e.message : '请允许使用摄像头') +
          '。也可以点下方「手动输入」。';
      }
    },

    _clearScanTimers() {
      if (this._scanTimeoutTimer) { clearTimeout(this._scanTimeoutTimer); this._scanTimeoutTimer = null; }
      if (this._scanSlowTimer) { clearTimeout(this._scanSlowTimer); this._scanSlowTimer = null; }
    },

    async closeScan() {
      this._clearScanTimers();
      if (this._scanHandle) {
        try { await this._scanHandle.stop(); } catch (e) { /* ignore */ }
        this._scanHandle = null;
      }
      this.scan.active = false;
      this.scan.engine = '';
      this.scan.error = '';
      this.scan.manualShow = false;
      this.scan.manualCode = '';
    },

    onScanDetected(text, err) {
      if (err) {
        this.closeScan();
        this.scan.active = true;
        this.scan.error = '相机启动失败，请检查权限后重试，或改用手动输入。';
        return;
      }
      if (!text) return;
      const mode = this.scan.mode;
      // 命中即停：交由 closeScan 统一停相机、关图层
      this.closeScan();
      this.dispatchCode(mode, text);
    },

    /** 扫码层里的「手动输入」提交（按当前模式分发） */
    submitScanManual() {
      const code = String(this.scan.manualCode || '').trim();
      if (!code) { this.showToast('请先输入条形码', true); return; }
      const mode = this.scan.mode;
      this.closeScan();
      this.dispatchCode(mode, code);
    },

    /** 相册兜底：用拍好的照片识别条码 */
    pickScanImage() {
      this.$refs.scanImage.click();
    },

    async onScanImage(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      this.scan.photoBusy = true;
      let code = null;
      try { code = await Scanner.decodeImage(file); } catch (err) { code = null; }
      this.scan.photoBusy = false;
      if (!code) {
        this.showToast('图片里没找到条码：把条码拍大一点、拍清楚一点再试', true);
        return;
      }
      const mode = this.scan.mode;
      await this.closeScan();
      this.dispatchCode(mode, code);
    },

    /** 按扫码用途分发结果：查价 / 填表-建档 */
    dispatchCode(mode, rawCode) {
      const code = String(rawCode || '').trim();
      if (!code) return;
      if (mode === 'lookup') this.handleCode(code);
      else this.applyScannedCode(code);
    },

    /** 扫到条码后（添加/编辑场景）：填表或引导新建 */
    async applyScannedCode(code) {
      const bc = String(code || '').trim();
      if (!bc) return;
      const dup = await DB.getByBarcode(bc);

      // 表单已打开（在添加/编辑表单里扫的）：只填入条码
      if (this.edit.show) {
        this.edit.form.barcode = bc;
        this.showToast(dup ? '⚠️ 注意：这个条码已有商品「' + dup.name + '」' : '✅ 已扫到条码 ' + bc, !!dup);
        return;
      }
      // 已建档：直接显示该商品，避免重复建
      if (dup) {
        this.showToast('这个条码已经有商品了：' + dup.name, true);
        this.showResult(dup);
        return;
      }
      // 新商品：打开表单并把条码填好
      this.openAdd();
      this.edit.form.barcode = bc;
      this.showToast('✅ 已扫到条码 ' + bc + '，请填名称和价格');
    },

    async handleCode(code) {
      const bc = String(code || '').trim();
      if (!bc) { this.showToast('请先输入条形码', true); return; }
      await this.closeScan();
      this.manualCode = '';
      const p = await DB.getByBarcode(bc);
      if (p) {
        this.showResult(p);
      } else {
        this.result = { show: true, product: null, barcode: bc, editingPrice: false, priceDraft: '' };
      }
    },

    lookupManual() {
      this.handleCode(this.manualCode);
    },

    /* ---------- 查价结果 ---------- */
    showResult(p) {
      this.result = { show: true, product: p, barcode: p.barcode, editingPrice: false, priceDraft: '' };
      this.pushRecent(p);
    },

    closeResult() {
      this.result.show = false;
      this.result.product = null;
      this.result.editingPrice = false;
    },

    startEditPrice() {
      this.result.priceDraft = String(this.result.product.price);
      this.result.editingPrice = true;
    },

    async savePrice() {
      const n = parseFloat(this.result.priceDraft);
      if (isNaN(n) || n <= 0) { this.showToast('价格要大于 0，例如 3.5', true); return; }
      const updated = await DB.put({ ...this.result.product, price: Math.round(n * 100) / 100 });
      this.result.product = updated;
      this.result.editingPrice = false;
      await this.refresh();
      this.pushRecent(updated);
      this.showToast('✅ 价格已更新为 ' + this.fmtPrice(updated.price) + ' 元');
    },

    /* ---------- 最近查看 ---------- */
    pushRecent(p) {
      let list = [];
      try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { list = []; }
      list = list.filter(r => r.id !== p.id);
      list.unshift({ id: p.id, barcode: p.barcode, name: p.name, price: p.price, at: Date.now() });
      list = list.slice(0, 5);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
      this.recent = list;
    },

    loadRecent() {
      try { this.recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
      catch (e) { this.recent = []; }
    },

    async openRecent(r) {
      const p = await DB.get(r.id);
      if (p) this.showResult(p);
      else this.showToast('该商品可能已被删除', true);
    },

    /* ---------- 商品编辑 ---------- */
    openAdd() {
      this.edit = {
        show: true, id: null,
        form: { barcode: '', name: '', price: '', unit: '1', notes: '' },
        photoBlob: null, photoPreview: ''
      };
    },

    async editProduct(p) {
      this.closeResult();
      this.edit = {
        show: true, id: p.id,
        form: {
          barcode: p.barcode || '', name: p.name, price: String(p.price),
          unit: p.unit || '1', notes: p.notes || ''
        },
        photoBlob: p.photo || null,
        photoPreview: p.photo ? await ImageUtil.blobToDataURL(p.photo) : ''
      };
    },

    addFromScanMiss() {
      const bc = this.result.barcode;
      this.closeResult();
      this.openAdd();
      this.edit.form.barcode = bc;
    },

    closeEdit() {
      this.edit.show = false;
    },

    async onPhotoChange(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const blob = await ImageUtil.compress(file);
      this.edit.photoBlob = blob;
      this.edit.photoPreview = await ImageUtil.blobToDataURL(blob);
    },

    removePhoto() {
      this.edit.photoBlob = null;
      this.edit.photoPreview = '';
    },

    async saveProduct() {
      const f = this.edit.form;
      if (!f.name) { this.showToast('请填写商品名称', true); return; }
      const price = parseFloat(f.price);
      if (isNaN(price) || price <= 0) { this.showToast('价格要大于 0，例如 3.5', true); return; }

      // 新增时防止同条码重复建档
      if (!this.edit.id && f.barcode) {
        const dup = await DB.getByBarcode(f.barcode);
        if (dup) {
          this.closeEdit();
          this.showToast('这个条码已经有商品了：' + dup.name, true);
          this.showResult(dup);
          return;
        }
      }

      await DB.put({
        id: this.edit.id || undefined,
        barcode: f.barcode,
        name: f.name,
        price: Math.round(price * 100) / 100,
        unit: f.unit,
        notes: f.notes,
        photo: this.edit.photoBlob
      });
      this.closeEdit();
      await this.refresh();
      this.showToast(this.edit.id ? '✅ 已保存修改' : '✅ 商品已添加');
    },

    async deleteProduct() {
      const p = this.products.find(x => x.id === this.edit.id);
      if (!p) { this.closeEdit(); return; }
      if (!confirm(`确定删除「${p.name}」吗？`)) return;
      await DB.delete(p.id);
      this.closeEdit();
      await this.refresh();
      this.showToast('已删除');
    },

    /* ---------- Excel ---------- */
    pickExcel() { this.$refs.excelInput.click(); },

    async onExcelFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const { products, errors } = await ExcelIO.parseImport(file);
        if (!products.length) {
          this.showToast(errors[0] || '没有读到有效的商品数据', true);
          return;
        }
        const r = await DB.importMerge(products, true);
        this.report = {
          added: r.added, updated: r.updated, skipped: r.skipped,
          failed: [...errors.map(m => ({ row: '—', reason: m })), ...r.failed]
        };
        await this.refresh();
        this.showToast(`✅ 导入完成：新增 ${r.added} 个，更新 ${r.updated} 个` +
          (r.failed.length ? `，失败 ${r.failed.length} 个` : ''));
      } catch (err) {
        this.showToast('导入失败：' + (err && err.message ? err.message : '文件读不出来'), true);
      }
    },

    async exportExcel() {
      if (!this.products.length) { this.showToast('还没有商品可导出', true); return; }
      ExcelIO.exportAll(this.products);
      this.showToast('已导出 Excel 价格表');
    },

    downloadTemplate() {
      ExcelIO.downloadTemplate();
      this.showToast('模板已下载，按格式填写后导入');
    },

    /* ---------- 备份恢复 ---------- */
    async exportBackup() {
      if (!this.products.length) { this.showToast('还没有数据可备份', true); return; }
      await Backup.exportAll(this.products);
      this.showToast('备份文件已导出，可发送给家人或存到新手机');
    },

    pickBackup() { this.$refs.backupInput.click(); },

    async onBackupFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const list = await Backup.parseBackupFile(file);
        if (!confirm(`备份里有 ${list.length} 个商品，\n条码/编号相同的会被覆盖，继续恢复吗？`)) return;
        const r = await DB.importMerge(list, true);
        await this.refresh();
        this.showToast(`✅ 恢复完成：新增 ${r.added} 个，覆盖 ${r.updated} 个`);
      } catch (err) {
        this.showToast('恢复失败：' + (err && err.message ? err.message : ''), true);
      }
    },

    async clearAllData() {
      if (!this.products.length) { this.showToast('目前没有数据'); return; }
      if (!confirm(`确定清空全部 ${this.products.length} 个商品吗？\n此操作无法撤销，建议先导出备份！`)) return;
      if (!confirm('再确认一次：真的要清空吗？')) return;
      await DB.clearAll();
      await this.refresh();
      this.showToast('已清空全部数据');
    },

    /* ---------- 版本与更新 ---------- */
    async checkUpdate() {
      let latest = '';
      try {
        const resp = await fetch('sw.js', { cache: 'no-store' });
        const text = await resp.text();
        const m = text.match(/baojie-price-(v\d+)/);
        latest = m ? m[1] : '';
      } catch (e) { /* 下面统一处理 */ }
      if (!latest) { this.showToast('检查更新失败：网络不通，请稍后再试', true); return; }
      if (latest === this.appVersion) {
        this.showToast('✅ 已是最新版本（' + latest + '）');
        return;
      }
      // 服务器上有新版本：让 Service Worker 拉取新文件，然后自动刷新
      this.showToast('发现新版本 ' + latest + '，正在更新…');
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            await reg.update();
            await new Promise((resolve) => {
              const t = setTimeout(resolve, 3000);
              navigator.serviceWorker.addEventListener('controllerchange', () => {
                clearTimeout(t);
                resolve();
              }, { once: true });
            });
          }
        }
      } catch (e) { /* 刷新兜底 */ }
      setTimeout(() => location.reload(), 300);
    },

    /* ---------- PWA 安装 ---------- */
    installApp() {
      if (!this.installEvt) return;
      this.installEvt.prompt();
      this.installEvt.userChoice.finally(() => { this.installEvt = null; });
    }
  },

  async mounted() {
    await this.refresh();
    this.loadRecent();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 本地 file:// 调试时忽略 */ });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installEvt = e;
    });
    window.addEventListener('appinstalled', () => {
      this.showToast('🎉 安装成功，桌面见！');
    });
  }
};

Vue.createApp(App).mount('#app');
