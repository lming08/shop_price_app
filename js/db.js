/* 包姐便利店 · 查价 —— IndexedDB 数据层（纯单机，无后端） */
'use strict';

/**
 * 商品记录结构：
 * {
 *   id: string       主键：有条码时=条码本身；无条码时='n'+时间戳随机串
 *   barcode: string  条形码（EAN-13 等），可为空串
 *   name: string     商品名称（必填）
 *   price: number    售价（元，必填）
 *   unit: string     单位：瓶/袋/包…
 *   notes: string    备注
 *   photo: Blob|null 商品照片（压缩后的 JPEG）
 *   createdAt: number
 *   updatedAt: number
 * }
 */
const DB = (() => {
  const DB_NAME = 'baojie_price';
  const DB_VERSION = 1;
  const STORE = 'products';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('barcode', 'barcode', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function cleanRecord(p) {
    return {
      id: String(p.id || '').trim(),
      barcode: String(p.barcode || '').trim(),
      name: String(p.name || '').trim(),
      price: Number(p.price) || 0,
      unit: String(p.unit || '').trim(),
      notes: String(p.notes || '').trim(),
      photo: p.photo instanceof Blob ? p.photo : (p.photo || null),
      createdAt: Number(p.createdAt) || Date.now(),
      updatedAt: Number(p.updatedAt) || Date.now()
    };
  }

  return {
    /** 全部商品，按更新时间倒序 */
    async all() {
      const store = await tx('readonly');
      const list = await request(store.getAll());
      return (list || []).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async count() {
      const store = await tx('readonly');
      return request(store.count());
    },

    async get(id) {
      const store = await tx('readonly');
      return request(store.get(String(id)));
    },

    /** 按条码精确查找（返回最新一条） */
    async getByBarcode(code) {
      const bc = String(code || '').trim();
      if (!bc) return null;
      const store = await tx('readonly');
      const index = store.index('barcode');
      const list = await request(index.getAll(bc));
      if (!list || list.length === 0) return null;
      return list.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    },

    /** 新增或更新（自动维护 id / 时间戳） */
    async put(p) {
      const rec = cleanRecord(p);
      if (!rec.name) throw new Error('商品名称不能为空');
      if (!(rec.price > 0)) throw new Error('价格必须大于 0');
      if (!rec.id) {
        rec.id = rec.barcode || ('n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      }
      const existing = await this.get(rec.id);
      if (existing) {
        rec.createdAt = existing.createdAt;
        // 编辑时未重新拍照则保留原照片
        if (!(rec.photo instanceof Blob)) rec.photo = existing.photo || null;
      }
      rec.updatedAt = Date.now();
      const store = await tx('readwrite');
      await request(store.put(rec));
      return rec;
    },

    async delete(id) {
      const store = await tx('readwrite');
      await request(store.delete(String(id)));
    },

    async clearAll() {
      const store = await tx('readwrite');
      await request(store.clear());
    },

    /**
     * 批量合并导入（Excel / 备份恢复共用）
     * overwrite=true 时同名(id 相同)覆盖，否则跳过
     * 返回 {added, updated, skipped, failed:[{row,reason}]}
     */
    async importMerge(list, overwrite = true) {
      const result = { added: 0, updated: 0, skipped: 0, failed: [] };
      for (let i = 0; i < list.length; i++) {
        const raw = list[i];
        try {
          const rec = cleanRecord(raw);
          if (!rec.name && !rec.barcode) { result.skipped++; continue; }
          if (!rec.name) { result.failed.push({ row: i + 2, reason: '缺少商品名称' }); continue; }
          if (!(rec.price > 0)) { result.failed.push({ row: i + 2, reason: '价格无效：' + raw.price }); continue; }
          if (!rec.id) {
            rec.id = rec.barcode || ('n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + i);
          }
          const existing = await this.get(rec.id);
          if (existing && !overwrite) { result.skipped++; continue; }
          if (existing && !(rec.photo instanceof Blob)) rec.photo = existing.photo || null;
          rec.createdAt = existing ? existing.createdAt : (rec.createdAt || Date.now());
          rec.updatedAt = rec.updatedAt || Date.now();
          const store = await tx('readwrite');
          await request(store.put(rec));
          existing ? result.updated++ : result.added++;
        } catch (e) {
          result.failed.push({ row: i + 2, reason: (e && e.message) || '未知错误' });
        }
      }
      return result;
    }
  };
})();

/** 图片工具：拍照/选图后压缩为 JPEG Blob，控制 IndexedDB 体积 */
const ImageUtil = (() => {
  const MAX_DIM = 900;   // 最长边
  const QUALITY = 0.75;

  function compress(blob) {
    return new Promise((resolve) => {
      if (!blob || !(blob instanceof Blob)) return resolve(null);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((out) => {
            URL.revokeObjectURL(url);
            resolve(out || blob);
          }, 'image/jpeg', QUALITY);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve(blob);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
      img.src = url;
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      if (!blob) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function dataURLToBlob(dataURL) {
    if (!dataURL) return null;
    const resp = await fetch(dataURL);
    return resp.blob();
  }

  return { compress, blobToDataURL, dataURLToBlob };
})();
