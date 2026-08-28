/* 包姐便利店 · 查价 —— Excel 导入 / 导出（SheetJS） */
'use strict';

const ExcelIO = (() => {
  // 表头模糊匹配规则：列头包含关键词即识别为对应字段
  const HEADER_RULES = [
    { field: 'barcode', keys: ['条形码', '条码', 'barcode'] },
    { field: 'name', keys: ['名称', '品名', '商品名', 'name'] },
    { field: 'price', keys: ['价格', '单价', '售价', 'price'] },
    { field: 'unit', keys: ['单位', 'unit'] },
    { field: 'notes', keys: ['备注', '说明', 'notes'] }
  ];

  const HEADERS = ['条形码', '商品名称', '价格(元)', '单位', '备注'];

  function normalizeHeader(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/\s+/g, '');
  }

  function matchField(header) {
    const h = normalizeHeader(header);
    if (!h) return null;
    for (const rule of HEADER_RULES) {
      if (rule.keys.some(k => h.includes(k.toLowerCase()))) return rule.field;
    }
    return null;
  }

  function parsePrice(v) {
    if (v == null || v === '') return NaN;
    const n = parseFloat(String(v).replace(/[¥￥元\s,，]/g, ''));
    return isNaN(n) ? NaN : Math.round(n * 100) / 100;
  }

  /**
   * 解析 Excel 文件为商品列表
   * 返回 Promise<{products:[], errors:[], headerFound:boolean}>
   */
  async function parseImport(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let wb;
    if ((bytes[0] === 0x50 && bytes[1] === 0x4B) || (bytes[0] === 0xD0 && bytes[1] === 0xCF)) {
      // xlsx(ZIP) / xls(OLE2) 二进制格式
      wb = XLSX.read(buf, { type: 'array' });
    } else {
      // CSV 纯文本：显式 UTF-8 解码；出现乱码则回退 GB18030（国内 Excel 导出的 CSV 常为 GBK）
      // raw:true 让 SheetJS 不做数值转换——条码前导零（如 0888...）不会被吃掉
      let text = new TextDecoder('utf-8').decode(bytes);
      if (text.includes('\uFFFD')) {
        try { text = new TextDecoder('gb18030').decode(bytes); } catch (e) { /* 保持 UTF-8 结果 */ }
      }
      wb = XLSX.read(text, { type: 'string', raw: true });
    }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { products: [], errors: ['文件里没有工作表'], headerFound: false };

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
    if (rows.length === 0) return { products: [], errors: ['表格是空的'], headerFound: false };

    // 找表头行：前 5 行里命中字段最多的那一行
    let headerRowIdx = -1, colMap = null, best = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const map = {};
      let hits = 0;
      rows[i].forEach((cell, c) => {
        const field = matchField(cell);
        if (field && map[field] === undefined) { map[field] = c; hits++; }
      });
      if (hits > best) { best = hits; headerRowIdx = i; colMap = map; }
    }

    const errors = [];
    const products = [];

    if (best < 2 || !colMap || colMap.name === undefined || colMap.price === undefined) {
      // 表头无法识别 → 按固定列顺序兜底：条码|名称|价格|单位|备注
      colMap = { barcode: 0, name: 1, price: 2, unit: 3, notes: 4 };
      headerRowIdx = -1;
      errors.push('未识别到标准表头，已按「条形码|商品名称|价格|单位|备注」列顺序读取');
    }

    const dataRows = rows.slice(headerRowIdx + 1);
    dataRows.forEach((row, idx) => {
      const get = (f) => (colMap[f] !== undefined ? row[colMap[f]] : '');
      const name = String(get('name') == null ? '' : get('name')).trim();
      const barcode = String(get('barcode') == null ? '' : get('barcode')).trim();
      const price = parsePrice(get('price'));
      // 空行跳过
      if (!name && !barcode && (get('price') === '' || get('price') == null)) return;
      if (!name) { errors.push(`第 ${idx + 1} 行：缺少商品名称`); return; }
      if (isNaN(price)) { errors.push(`第 ${idx + 1} 行「${name}」：价格无效`); return; }
      if (barcode && !/^[0-9A-Za-z\-]+$/.test(barcode)) {
        errors.push(`第 ${idx + 1} 行「${name}」：条码格式异常（${barcode}）`);
        return;
      }
      products.push({
        barcode,
        name,
        price,
        unit: String(get('unit') == null ? '' : get('unit')).trim(),
        notes: String(get('notes') == null ? '' : get('notes')).trim(),
        photo: null
      });
    });

    return { products, errors, headerFound: headerRowIdx >= 0 };
  }

  function sheetFromProducts(products) {
    const aoa = [HEADERS];
    for (const p of products) {
      aoa.push([p.barcode || '', p.name, p.price, p.unit || '', p.notes || '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 16 }, { wch: 30 }, { wch: 10 }, { wch: 8 }, { wch: 24 }];
    return ws;
  }

  function downloadWorkbook(wb, filename) {
    XLSX.writeFile(wb, filename);
  }

  function dateTag() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  return {
    parseImport,
    /** 导出全部商品为价格表 Excel */
    exportAll(products) {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheetFromProducts(products), '价格表');
      downloadWorkbook(wb, `包姐便利店-价格表-${dateTag()}.xlsx`);
    },
    /** 下载导入模板（含 3 行示例） */
    downloadTemplate() {
      const demo = [
        { barcode: '6901236343104', name: '农夫山泉 550ml', price: 2, unit: '瓶', notes: '' },
        { barcode: '6920584430052', name: '可口可乐 330ml', price: 3, unit: '罐', notes: '' },
        { barcode: '', name: '茶叶蛋', price: 1.5, unit: '个', notes: '无条码，手动添加' }
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheetFromProducts(demo), '导入模板');
      downloadWorkbook(wb, '商品导入模板.xlsx');
    }
  };
})();
