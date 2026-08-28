/* 包姐便利店 · 查价 —— JSON 备份 / 恢复（含照片，用于换机或家人间迁移数据） */
'use strict';

const Backup = (() => {
  const MAGIC = 'baojie-price-backup';
  const VERSION = 1;

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function dateTag() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  return {
    /** 导出全部数据（照片转 base64 一并带走） */
    async exportAll(products) {
      const payload = [];
      for (const p of products) {
        payload.push({
          id: p.id,
          barcode: p.barcode,
          name: p.name,
          price: p.price,
          unit: p.unit,
          notes: p.notes,
          photo: p.photo ? await ImageUtil.blobToDataURL(p.photo) : null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt
        });
      }
      downloadJSON({ app: MAGIC, version: VERSION, exportedAt: new Date().toISOString(), products: payload },
        `包姐便利店-备份-${dateTag()}.json`);
    },

    /**
     * 解析备份文件，返回商品数组（照片转回 Blob）
     */
    async parseBackupFile(file) {
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('不是有效的备份文件');
      }
      if (!data || data.app !== MAGIC || !Array.isArray(data.products)) {
        throw new Error('不是「包姐便利店查价」的备份文件');
      }
      const list = [];
      for (const p of data.products) {
        if (!p || !p.name) continue;
        list.push({
          id: p.id,
          barcode: p.barcode || '',
          name: p.name,
          price: Number(p.price) || 0,
          unit: p.unit || '',
          notes: p.notes || '',
          photo: p.photo ? await ImageUtil.dataURLToBlob(p.photo) : null,
          createdAt: p.createdAt || Date.now(),
          updatedAt: p.updatedAt || Date.now()
        });
      }
      if (list.length === 0) throw new Error('备份文件里没有商品数据');
      return list;
    }
  };
})();
