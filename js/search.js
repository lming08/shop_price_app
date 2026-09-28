/* 包姐便利店 · 查价 —— 商品搜索（模糊相关度匹配）
 * 用于"按商品名/条码找价格"：不要求完全一致，按相关度从高到低排序。
 *
 * 匹配层级（分越高越相关）：
 *   条码：完全一致 > 前缀 > 含于其中 > 尾号（≥4位）
 *   名称：完全一致 > 以查询开头 > 含查询 > 分词全命中 > 字符按序出现（模糊）
 *   外加：覆盖率加成、名称越短越精确的微调、备注命中
 */
'use strict';

const ProductSearch = (() => {
  /** 归一化：小写、去掉空格与常见标点，便于"农夫山泉550"匹配"农夫山泉 550ml" */
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[\s\-_·、,，.。/\\|()（）\[\]【】:：;；'"“”‘’!！?？]/g, '');
  }

  /** 按空格/逗号等切分词条（用于"农夫 550"这类查询） */
  function tokensOf(raw) {
    return String(raw || '').toLowerCase().split(/[\s,，、|/]+/).map(norm).filter(Boolean);
  }

  /** 查询字符是否按顺序出现在文本中（允许中间有别的字），越紧凑分越高 */
  function subsequenceScore(q, text) {
    if (q.length < 2) return 0;
    let ti = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < q.length; i++) {
      const idx = text.indexOf(q[i], ti);
      if (idx === -1) return 0;
      if (first === -1) first = idx;
      last = idx;
      ti = idx + 1;
    }
    const span = last - first + 1;
    return Math.round(150 * (q.length / span));
  }

  /** 单个商品的相关度得分（0 表示不匹配） */
  function score(rawQuery, p) {
    const q = norm(rawQuery);
    if (!q) return 0;
    const raw = String(rawQuery || '').trim();
    const digitsOnly = /^\d+$/.test(raw);
    const name = norm(p.name);
    const barcode = String(p.barcode || '');
    const notes = norm(p.notes);
    let s = 0;

    // ---- 条码 ----
    if (barcode) {
      if (barcode === q) s += 1000;
      else if (digitsOnly && barcode.startsWith(q)) s += 700;
      else if (digitsOnly && barcode.includes(q)) s += 450;
      else if (digitsOnly && q.length >= 4 && barcode.endsWith(q)) s += 400;
    }

    // ---- 名称 ----
    if (name) {
      const coverage = Math.round(120 * q.length / Math.max(1, name.length));
      if (name === q) s += 1500;
      else if (name.startsWith(q)) s += 700 + coverage;
      else if (name.includes(q)) s += 500 + coverage;
      else {
        const toks = tokensOf(raw);
        if (toks.length > 1 && toks.every(t => name.includes(t) || barcode.includes(t))) {
          const covered = toks.reduce((a, t) => a + t.length, 0);
          s += 350 + Math.round(60 * covered / Math.max(1, name.length));
        } else {
          const sub = subsequenceScore(q, name);
          if (sub > 0) s += 150 + sub;
        }
      }
    }

    // ---- 备注 ----
    if (notes && notes.includes(q)) s += 30;

    // 命中后：名称越短越精确，给一点加分
    if (s > 0) s += Math.max(0, 60 - name.length);
    return s;
  }

  /**
   * 按相关度搜索并排序（相关度降序；同分时名称短的在前）
   * 空查询返回原列表
   */
  function search(rawQuery, products) {
    const list = products || [];
    const q = norm(rawQuery);
    if (!q) return list.slice();
    const hits = [];
    for (const p of list) {
      const s = score(rawQuery, p);
      if (s > 0) hits.push({ p, s });
    }
    hits.sort((a, b) =>
      (b.s - a.s) ||
      (norm(a.p.name).length - norm(b.p.name).length) ||
      ((b.p.updatedAt || 0) - (a.p.updatedAt || 0)));
    return hits.map(h => h.p);
  }

  return { score, search, norm };
})();
