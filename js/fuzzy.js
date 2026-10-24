/**
 * 模糊搜索匹配器（网站端）—— fuzzy.js
 *
 * 与 App 端 FuzzyMatcher.kt 同构（同一份规范性定义 §3：权重表、匹配表、
 * SUBSEQ 长度门、ini 长度 <3 压制、JS \s 全集空白、双侧清洗、回退总分恒 1，逐条一致）。
 * 纯函数模块：无 DOM 依赖；浏览器挂 window.FuzzySearch，node 可 require 做单测。
 *
 * 依赖预生成字段 search_keys（cat/tag 两组，每组 cn/py/ini 三个平行数组，下标一一对应），
 * 由一次性脚本 E:/biaoqingxiangmugongcheng/pixai/gen_search_keys.py（不在本仓库）写入
 * data/stickers.json。条目缺失该字段（如上传条目）时
 * 走回退路径：旧子串逻辑 + 总分恒 1（§3.6）。
 */
(function () {
  'use strict';

  // ====== 权重常量（§3.3，与 FuzzyMatcher.kt 写死同数值） ======
  const FIELD = { CAT: 3, TAG: 2, FILENAME: 1, EN_TAG: 1 };   // 字段权重
  const TYPE = { EXACT: 4, PREFIX: 3, SUBSTR: 2, SUBSEQ: 1 };  // 匹配类型权重
  const TYPE_BASE = 10;           // 单键分 = 类型×10 + 字段（类型为主序维度、字段为次序维度）
  const SUBSEQ_MIN_LEN = 4;       // §3.2a：子序列仅对清洗后长度 ≥4 的 token 开放
  // §3.2b：长度 <3 的 ASCII token 对 ini 键不开 SUBSTR（规范伪代码原写作 ==2，
  // 双端统一为 <3 读法顺带拦长度 1；实测两种读法对 §5.4/§8.1 真实快照数字一致）
  const INI_SUBSTR_MIN_LEN = 3;
  const FALLBACK_SCORE = 1;       // §3.6：回退条目总分恒 1，排在所有正常命中（≥12 分）之后
  const EN_SUBSTR_SCORE = TYPE.SUBSTR * TYPE_BASE + FIELD.FILENAME; // 21：filename/英文 tag 仅子串档的恒定分

  const CJK_RE = /[一-鿿]/;      // CJK 统一表意文字（U+4E00–U+9FFF）
  const ASCII_LETTER_RE = /[a-z]/;       // cleanText 已做小写，故只测 a-z

  // ====== 清洗与归一化（§2.2 / §3.7） ======

  /**
   * 逐字符过滤：仅保留 CJK 汉字、ASCII 字母、ASCII 数字，字母转小写，其余一律删除。
   * 查询 token 与 filename/英文 tag 键共用同一函数（§3.7 双侧清洗）——
   * 键与 token 必须同侧归一化后再比较，否则 'grey_shirt' 类查询会 0 命中。
   */
  function cleanText(raw) {
    const src = typeof raw === 'string' ? raw : String(raw ?? '');
    let out = '';
    for (const ch of src) {
      const code = ch.codePointAt(0);
      if ((code >= 0x4e00 && code <= 0x9fff) || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
        out += ch;
      } else if (ch >= 'A' && ch <= 'Z') {
        out += ch.toLowerCase();
      }
    }
    return out;
  }

  /** §3.1.5 token 分类：含 CJK → cjk；否则含 ASCII 字母 → ascii；否则（纯数字）→ digit。 */
  function classifyToken(text) {
    if (CJK_RE.test(text)) return 'cjk';
    return ASCII_LETTER_RE.test(text) ? 'ascii' : 'digit';
  }

  /**
   * §3.1 查询预处理：trim → NFC 归一化 → 按空白连续段切分 → 逐 token 清洗 + 分类。
   * 清洗后为空的 token 直接丢弃。返回 { raw, tokens: [{text, kind}] }。
   */
  function normalizeQuery(raw) {
    const trimmed = String(raw ?? '').trim();
    const tokens = [];
    for (const part of trimmed.split(/\s+/)) {
      const text = cleanText(part.normalize('NFC'));
      if (text) tokens.push({ text, kind: classifyToken(text) });
    }
    return { raw: trimmed, tokens };
  }

  /** 贪心子序列判定：needle 的字符按序出现在 hay 中即命中。输入均来自 cleanText，只含 BMP 字符。 */
  function isSubseq(needle, hay) {
    if (!needle) return true;
    let i = 0;
    for (const ch of hay) {
      if (ch === needle[i]) {
        i++;
        if (i === needle.length) return true;
      }
    }
    return false;
  }

  // ====== 单键阶梯判定（§3.2 伪代码的逐行实现） ======

  /**
   * 对单个已清洗键做 4 级阶梯判定：EXACT → PREFIX → SUBSTR → SUBSEQ 依次取最高级，不命中返回 0。
   * - isIni=true 时应用 §3.2b：长度 <3 的 ASCII token 对 ini 键不开 SUBSTR（EXACT/PREFIX 照常）；
   * - §3.2a 子序列长度门在最后一行统一生效，与 token 种类无关。
   */
  function ladderScore(key, token, fieldWeight, isIni) {
    const t = token.text;
    if (key === t) return TYPE.EXACT * TYPE_BASE + fieldWeight;
    if (key.startsWith(t)) return TYPE.PREFIX * TYPE_BASE + fieldWeight;
    if (key.includes(t) && !(isIni && token.kind === 'ascii' && t.length < INI_SUBSTR_MIN_LEN)) {
      return TYPE.SUBSTR * TYPE_BASE + fieldWeight;
    }
    if (t.length >= SUBSEQ_MIN_LEN && isSubseq(t, key)) {
      return TYPE.SUBSEQ * TYPE_BASE + fieldWeight;
    }
    return 0;
  }

  /** 在 cat/tag 组某个平行数组（cn/py/ini）上取 token 的最高单键分。键由生成器保证已清洗。 */
  function bestGroupScore(group, arrName, token, fieldWeight, isIni) {
    const keys = (group && group[arrName]) || [];
    let best = 0;
    for (const key of keys) {
      const score = ladderScore(key, token, fieldWeight, isIni);
      if (score > best) best = score;
    }
    return best;
  }

  /**
   * §8.1 口径：英文 tag = 清洗后含 ≥1 个 ASCII 字母且无 CJK 的 tag 值。
   * 清洗在匹配时现做（§3.7：键与 token 同侧归一化）。
   */
  function enTagsOf(sticker) {
    const tags = Array.isArray(sticker.tags) ? sticker.tags : [];
    const result = [];
    for (const tag of tags) {
      const text = cleanText(tag);
      if (ASCII_LETTER_RE.test(text) && !CJK_RE.test(text)) result.push(text);
    }
    return result;
  }

  // ====== 条目打分（§3.2 匹配表 / §3.4 组合 / §3.6 回退） ======

  /**
   * §3.2 匹配表：token 种类决定开放哪些键组——
   *   cjk   → 仅 cn 键（4 级阶梯）；
   *   ascii → py、ini 键（4 级阶梯）+ filename/英文 tag（仅子串）；
   *   digit → cn、py、ini 键（4 级阶梯）+ filename/英文 tag（仅子串）。
   * 返回该 token 在本条目上的最高单键分（0 = 未命中）。
   */
  function bestTokenScore(sticker, token, cleanedFilename, enTags) {
    const keys = sticker.search_keys;
    let best = 0;

    if (token.kind !== 'ascii') {
      best = Math.max(
        bestGroupScore(keys.cat, 'cn', token, FIELD.CAT),
        bestGroupScore(keys.tag, 'cn', token, FIELD.TAG)
      );
    }
    if (token.kind !== 'cjk') {
      best = Math.max(
        best,
        bestGroupScore(keys.cat, 'py', token, FIELD.CAT),
        bestGroupScore(keys.tag, 'py', token, FIELD.TAG),
        bestGroupScore(keys.cat, 'ini', token, FIELD.CAT, true),
        bestGroupScore(keys.tag, 'ini', token, FIELD.TAG, true)
      );
      // filename/英文 tag 仅子串、恒 21 分——已 ≥21 时不可能再被它们提高，跳过省计算
      if (best < EN_SUBSTR_SCORE) {
        if (cleanedFilename.includes(token.text)) best = EN_SUBSTR_SCORE;
        for (const tag of enTags) {
          if (tag.includes(token.text)) { best = EN_SUBSTR_SCORE; break; }
        }
      }
    }
    return best;
  }

  /**
   * §3.6 回退路径：仅作用于 search_keys 缺失/为 null 的条目（如上传条目）。
   * 所有 token 均须在 {filename, tags, categories, category, subcategory} 上
   * 双侧清洗后子串命中；总分恒 FALLBACK_SCORE（不随 token 数累加）。
   * 已知限制：回退条目无拼音/子序列能力；配合显示层 top-100，上传条目在
   * 命中 ≥100 条正常条目的查询中恒不可见（上传入口重开前必须先附加 search_keys）。
   */
  function fallbackScore(sticker, tokens) {
    const fields = [
      sticker.filename,
      ...(Array.isArray(sticker.tags) ? sticker.tags : []),
      ...(Array.isArray(sticker.categories) ? sticker.categories : []),
      sticker.category,
      sticker.subcategory,
    ];
    const cleaned = fields.filter(Boolean).map(cleanText);
    for (const token of tokens) {
      if (!cleaned.some(text => text.includes(token.text))) {
        return { matched: false, score: 0 };
      }
    }
    return { matched: true, score: FALLBACK_SCORE };
  }

  /**
   * 单条目打分（AND 语义）：每个 token 必须有 ≥1 个允许键命中；总分 = Σ 各 token 最高单键分。
   * 返回 { matched, score }；主路径与回退路径互斥。
   */
  function scoreEntry(sticker, tokens) {
    if (!sticker.search_keys) return fallbackScore(sticker, tokens);
    const cleanedFilename = cleanText(sticker.filename); // §3.7：比较用临时形式，不改存储
    const enTags = enTagsOf(sticker);
    let total = 0;
    for (const token of tokens) {
      const best = bestTokenScore(sticker, token, cleanedFilename, enTags);
      if (!best) return { matched: false, score: 0 };
      total += best;
    }
    return { matched: true, score: total };
  }

  // ====== 排序与入口 ======

  /**
   * §3.4/§4：rank 只打分排序，不做 top-N 截断（截断是双端显示层职责：统一取前 100）。
   * - 空查询（raw 为空）→ 原列表原顺序（返回新数组，不改原数组）；
   * - 纯标点（raw 非空但无有效 token）→ 空结果；
   * - 排序用稳定 sort（ES2019+ 保证）：同分保持数据原顺序，与 App 端 sortedWith 行为一致。
   */
  function rank(stickers, rawQuery) {
    const q = normalizeQuery(rawQuery);
    const input = Array.isArray(stickers) ? stickers : [];
    if (!q.tokens.length) return q.raw ? [] : input.slice();

    const scored = [];
    for (const sticker of input) {
      const result = scoreEntry(sticker, q.tokens);
      if (result.matched) scored.push({ sticker, score: result.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(item => item.sticker);
  }

  // ====== 搜索联想（排列改版 §1.2：buildSuggestIndex + suggest） ======

  const KIND_WORK = 0;   // 作品/分类轴（search_keys.cat 组）
  const KIND_TAG = 1;    // 中文 tag 轴（search_keys.tag 组）

  /** 无 search_keys 条目（如上传）的回退作品来源：categories 非空取 categories，否则 category 单值数组。 */
  function fallbackLabelsOf(sticker) {
    return Array.isArray(sticker.categories) && sticker.categories.length
      ? sticker.categories
      : (sticker.category ? [sticker.category] : []);
  }

  /**
   * 把一次 label 出现合并进索引 Map：
   * - 同一条目内同一 label 只计一次 count（调用方传 per-entry seen 集合）；
   * - kind 取最小（WORK=0 恒不降级）；
   * - ini/py 键集合并（导出时统一排序 + 空格连接）。
   */
  function addSuggestOccurrence(map, seen, label, iniKey, pyKey, kind) {
    let entry = map.get(label);
    if (!entry) {
      entry = { ini: new Set(), py: new Set(), kind, count: 0 };
      map.set(label, entry);
    }
    if (!seen.has(label)) {
      seen.add(label);
      entry.count += 1;
    }
    if (kind < entry.kind) entry.kind = kind;
    if (iniKey) entry.ini.add(iniKey);
    if (pyKey) entry.py.add(pyKey);
  }

  /**
   * §1.2 联想候选索引（两遍构建；输入 = 当前可见集，别名已由调用方剔除）：
   *   来源① cat 轴 kind=WORK——有键条目直接遍历 search_keys.cat.cn 逐下标取 py/ini
   *     （不用 categories 字段：cat.cn 含 categories 之外的分类词，如「二次元」）；
   *     无键条目回退 categories/category，键置空；
   *   来源② tag 轴 kind=TAG——search_keys.tag.cn 平行取；无键条目回退 tags 取含 CJK 者，键置空。
   * 逐下标读取带边界守卫（越界置空，防御未来数据错位）；返回 [{label, ini, py, kind, count}]。
   * 有意行为：候选 = 可见集条目的全部 label，不做 label 级再过滤——跨作品条目（categories 含多个
   *   作品名）会使其其他作品名出现在收窄范围的联想中，点击候选后搜索仍命中该条目（闭环自洽），
   *   勿当 bug 过滤（测试口径见 verify-pagination-suggest.js A16 数据驱动断言）。
   */
  function buildSuggestIndex(stickers) {
    const map = new Map();
    for (const sticker of Array.isArray(stickers) ? stickers : []) {
      const seen = new Set();
      const keys = sticker.search_keys;
      if (keys && keys.cat && Array.isArray(keys.cat.cn)) {
        const cn = keys.cat.cn;
        const py = keys.cat.py || [];
        const ini = keys.cat.ini || [];
        for (let i = 0; i < cn.length; i++) {
          addSuggestOccurrence(map, seen, cn[i],
            i < ini.length ? ini[i] : '',
            i < py.length ? py[i] : '',
            KIND_WORK);
        }
      } else {
        for (const label of fallbackLabelsOf(sticker)) {
          addSuggestOccurrence(map, seen, label, '', '', KIND_WORK);
        }
      }
      if (keys && keys.tag && Array.isArray(keys.tag.cn)) {
        const cn = keys.tag.cn;
        const py = keys.tag.py || [];
        const ini = keys.tag.ini || [];
        for (let i = 0; i < cn.length; i++) {
          addSuggestOccurrence(map, seen, cn[i],
            i < ini.length ? ini[i] : '',
            i < py.length ? py[i] : '',
            KIND_TAG);
        }
      } else {
        for (const tag of Array.isArray(sticker.tags) ? sticker.tags : []) {
          const label = cleanText(tag);
          if (CJK_RE.test(label)) addSuggestOccurrence(map, seen, label, '', '', KIND_TAG);
        }
      }
    }
    const index = [];
    for (const [label, entry] of map) {
      index.push({
        label,
        ini: [...entry.ini].sort().join(' '),
        py: [...entry.py].sort().join(' '),
        kind: entry.kind,
        count: entry.count,
      });
    }
    return index;
  }

  /**
   * §1.2 联想匹配：normalizeQuery 取首 token（其余忽略）按决策表过滤——
   *   cjk        → label 前缀；
   *   ascii len1 → ini 键集任一键前缀；
   *   ascii len>=2 → ini 或 py 键集任一键前缀；
   *   数字/无有效 token → 空（搜索本身不受影响）。
   * 排序：kind 升序（作品名优先）→ count 降序 → label 码点序（JS < 比较，与 App String.compareTo 一致）；
   * 上限 limit 条，返回 label 列表。
   */
  function suggest(index, rawQuery, limit = 8) {
    const tokens = normalizeQuery(rawQuery).tokens;
    const token = tokens.length ? tokens[0] : null;
    if (!token || token.kind === 'digit') return [];
    const t = token.text;
    const anyKey = (keys) => keys.some(key => key.startsWith(t));
    const matches = [];
    for (const entry of Array.isArray(index) ? index : []) {
      if (token.kind === 'cjk') {
        if (!entry.label.startsWith(t)) continue;
      } else if (t.length === 1) {
        if (!anyKey(entry.ini.split(' '))) continue;
      } else if (!anyKey(entry.ini.split(' ')) && !anyKey(entry.py.split(' '))) {
        continue;
      }
      matches.push(entry);
    }
    matches.sort((a, b) =>
      a.kind - b.kind ||
      b.count - a.count ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return matches.slice(0, limit).map(entry => entry.label);
  }

  const FuzzySearch = {
    FIELD,
    TYPE,
    TYPE_BASE,
    SUBSEQ_MIN_LEN,
    INI_SUBSTR_MIN_LEN,
    FALLBACK_SCORE,
    cleanText,
    normalizeQuery,
    isSubseq,
    scoreEntry,
    rank,
    KIND_WORK,
    KIND_TAG,
    buildSuggestIndex,
    suggest,
  };

  // 导出：浏览器挂全局；node（单测）走 module.exports——两处加载同一份实现
  if (typeof module !== 'undefined' && module.exports) module.exports = FuzzySearch;
  if (typeof window !== 'undefined') window.FuzzySearch = FuzzySearch;
})();
