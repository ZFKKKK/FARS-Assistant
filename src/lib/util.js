/**
 * src/lib/util.js —— 基础工具：数字 / 文本 / 分组计数
 *
 * @layer  lib（纯函数，谁都能用）
 * @since  0.22.0（0.21.0 及以前是 number.js / text.js / collection.js 三个文件）
 *
 * 为什么合成一个：这三个文件从来没有被单独改过——换百分比精度、改地名简称、
 * 调分组句式，三处总是一起动。为了改一行去翻三个文件，是小项目里真实的浪费。
 * 合并只是把三个 IIFE 放进同一个文件，各自作用域不变，对外挂载点
 * （HT.num / HT.esc / HT.groupDesc …）一个没动，调用方无感。
 *
 * 为什么 obs.js 不并进来：它有状态、要读写 storage，混进"纯函数"堆里会让人
 * 误以为这里的东西都可以随便同步调用。
 *
 * 组内顺序：number → text → collection。后一个用到前一个（pad / sum）。
 */

/**
 * src/lib/number.js —— 数值、百分比、最大余数法
 *
 * @layer  lib（公共层）
 * @file   原 src/lib/number.js（0.22.0 并入 util.js）
 * @since  5.0.0
 *
 * 这一层不含任何业务概念，不知道"起数""占比"是什么，只提供纯函数。
 * 校验层、设置页预览、离线测试都可以直接复用，不依赖取数或 DOM。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /** 宽松取数：'1,234' / '12.5%' / ' 8 ' → number；非法值一律 0 */
  const num = v => {
    const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  /** 两位小数字符串（不做四舍五入补零以外的加工） */
  const r2 = x => (Math.round(x * 100) / 100).toFixed(2);

  /** a 占 b 的百分比，两位小数；b 为 0 时返回 '0.00' */
  const pct = (a, b) => (b ? r2((a / b) * 100) : '0.00');

  /** 千分位整数（面板页脚、校验详情用） */
  const group = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /**
   * 最大余数法：把 nums 相对 total 的占比，以 0.01% 为整数单位分配到 target。
   *
   * 为什么不用 toFixed：五类各自 toFixed(2) 后加总常常是 99.99% 或 100.01%，
   * 公文里被核出来很难解释。最大余数法保证同组加总严格等于 target。
   *
   * **固定项（pin）**：凑整必然要让某些项偏离"四舍五入"，让谁偏是能选的。
   * 一类是全文被单独引用最多的数（"一类 X 起，占比 Y%"），
   * 它一旦比报表少 0.01，拿计算器核对的人第一眼就看出来。所以调用方把它的
   * 下标放进 pin：该项**直接取四舍五入真值**，既不 floor 也不参与加减，
   * 凑整的压力全部由其余小项承担（虚假警、安保勤务差 0.01 没人会去核）。
   *
   * 每动一次就把该项的余数翻到另一端，下一轮自然轮到别人。原来的写法是
   * `base[order[k % order.length].i] += 1`——当要动的次数超过池长度时，
   * 同一个下标会被连动两次，某一项凭空多/少 0.02，比不调整还离谱。
   *
   * @param {number[]} nums   各项原始数值
   * @param {number}   total  分母
   * @param {number}   [target=10000]  合计单位数（10000 = 100.00%）
   * @param {number[]} [pin]   锁定为四舍五入真值的下标（不参与凑整）
   * @returns {number[]} 与 nums 等长的单位数数组，和为 target
   */
  function allocUnits(nums, total, target, pin) {
    const T = target === undefined ? 10000 : target;
    if (!total) return nums.map(() => 0);
    const scaled = nums.map(n => (n / total) * 10000);
    const base = scaled.map(x => Math.floor(x + 1e-9));
    const pinIdx = pin || [];
    /* 先落定固定项，再算还差多少——它们的余数不参与排序，下面统一排除。 */
    pinIdx.forEach(i => { if (i >= 0 && i < base.length) base[i] = Math.round(scaled[i]); });
    const rest = scaled.map((x, i) => x - base[i]);
    let diff = T - base.reduce((a, b) => a + b, 0);

    /* dir = +1 补一个单位，-1 削一个单位。
       返回 false 表示已经无人可动（只剩固定项且都归零），调用方就此收手。 */
    const step = dir => {
      const cand = scaled
        .map((x, i) => ({ i, r: rest[i] }))
        .filter(o => dir > 0 || base[o.i] > 0);
      const free = cand.filter(o => pinIdx.indexOf(o.i) < 0);
      /* 削减时优先动"削完还剩一位"的项：把某一类削成 0.00%，
         比让它差 0.01 更难解释（"安保勤务 500 起，占比 0.00%"）。 */
      const safe = dir < 0 ? free.filter(o => base[o.i] > 1) : free;
      const pick = safe.length ? safe : (free.length ? free : cand);
      if (!pick.length) return false;
      pick.sort((a, b) => (dir > 0 ? b.r - a.r : a.r - b.r));
      const t = pick[0];
      base[t.i] += dir;
      rest[t.i] -= dir;
      return true;
    };

    while (diff > 0 && step(1)) diff--;
    while (diff < 0 && step(-1)) diff++;
    return base;
  }

  /** 单位数 → '18.43' */
  const fmtUnit = u => (u / 100).toFixed(2);

  const sum = arr => arr.reduce((a, b) => a + b, 0);

  Object.assign(HT, { num, r2, pct, group, allocUnits, fmtUnit, sum });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * src/lib/text.js —— 中文日期、区域简称、原子串拼接
 *
 * @layer  lib（公共层）
 * @file   原 src/lib/text.js（0.22.0 并入 util.js）
 * @since  5.0.0
 *
 * 公文口径的日期与地名写法集中在这里，避免同一个"11月11日"在五个地方各写一遍。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const pad = n => String(n).padStart(2, '0');

  /** 2026-11-12 */
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /** 2026-11-12 18:00:00 */
  const fmtTime = d =>
    `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  /** 11月11日（公文正文用，不补零） */
  const cnDay = d => `${d.getMonth() + 1}月${d.getDate()}日`;
  /** 2026年11月11日 */
  const cnFullDay = d => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  /** 点分隔日期（站点导出文件名用这个写法，月日补零） */
  const fmtDot = d => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;

  /**
   * 区域简称。例外表优先，其余统一去掉「区/县/市」后缀。
   * 「忠县」这类去后缀就成单字的，保留全称。
   */
  const TOWN_ALIAS = {
    '两江新区': '两江',
    '高新区': '高新',
    /* 两个"经开区"是平台自造的开发区值，不在行政区划树里，但明细里会出现
       （2026-11-15 实测：25 个区域值里有「万盛经开区」「双桥经开区」）。
       与万盛一样去掉后缀，保持"简称"口径统一；不做合并——它们是独立值，
       真并进綦江/大足就再也分不出来了。 */
    '万盛经开区': '万盛',
    '双桥经开区': '双桥',
    '经开区': '经开',
    '石柱土家族自治县': '石柱',
    '秀山土家族苗族自治县': '秀山',
    '酉阳土家族苗族自治县': '酉阳',
    '彭水苗族土家族自治县': '彭水',
    '忠县': '忠县'
  };

  /* 区域层级：同起数时正文按「先主城、再其他区、最后县」列名。
     用户口径（2026-11-16）：万盛、双桥视为县——它们是平台自造的开发区值、
     不是行政区，但在业务口径里各自单列，读稿的人按"离主城远近"理解，
     挂到"县"这一档才符合习惯。
     键是 TOWN_ALIAS 归一之后的简称；不在这张表里的（起火原因、条目类型等）
     返回 9，等于"不分层"，排序退回按名字，原有行为不变。 */
  const TOWN_TIER = {
    /* 0 主城（中心城区）*/
    '渝中': 0, '大渡口': 0, '江北': 0, '沙坪坝': 0, '九龙坡': 0, '南岸': 0,
    '北碚': 0, '渝北': 0, '巴南': 0, '两江': 0, '高新': 0,
    /* 1 其他区 */
    '万州': 1, '涪陵': 1, '綦江': 1, '大足': 1, '黔江': 1, '长寿': 1, '江津': 1,
    '合川': 1, '永川': 1, '南川': 1, '璧山': 1, '铜梁': 1, '潼南': 1, '荣昌': 1,
    '开州': 1, '梁平': 1, '武隆': 1,
    /* 2 县（含 4 个自治县，以及按用户口径视为县的万盛、双桥）*/
    '城口': 2, '丰都': 2, '垫江': 2, '忠县': 2, '云阳': 2, '奉节': 2, '巫山': 2,
    '巫溪': 2, '石柱': 2, '秀山': 2, '酉阳': 2, '彭水': 2, '万盛': 2, '双桥': 2
  };

  /**
   * 区域分层：0 主城 / 1 其他区 / 2 县 / 9 不是区域或不认识。
   * 判据只认简称（先过 shortTown），所以「垫江县」「酉阳土家族苗族自治县」
   * 「万盛经开区」都能落位；不在表里的一律 9，调用方据此不分层。
   */
  const townTier = name => {
    const k = shortTown(name, true);
    return TOWN_TIER[k] === undefined ? 9 : TOWN_TIER[k];
  };

  function shortTown(name, on) {
    if (!name) return '';
    const s = String(name).trim();
    if (on === false) return s;
    if (TOWN_ALIAS[s]) return TOWN_ALIAS[s];
    const m = /^(.+?)(区|县|市)$/.exec(s);
    if (m && m[1].length >= 2) return m[1];
    return s;
  }

  /** HTML 转义（仅 UI 层用，取值来自接口与设置） */
  const esc = s =>
    String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  Object.assign(HT, { pad, fmtDate, fmtTime, fmtDot, cnDay, cnFullDay, TOWN_ALIAS, shortTown, esc, townTier, TOWN_TIER });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * src/lib/collection.js —— 分组计数与中文并列表达
 *
 * @layer  lib（公共层）
 * @file   原 src/lib/collection.js（0.22.0 并入 util.js）
 * @since  5.0.0
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * 按 key 计数并按数量降序返回 [{name, n}]。
   * keyFn 返回空值的条目直接跳过（例如起火原因未填）。
   */
  function countBy(list, keyFn) {
    const m = new Map();
    (list || []).forEach(x => {
      const k = keyFn(x);
      if (!k) return;
      m.set(k, (m.get(k) || 0) + 1);
    });
    return [...m.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name), 'zh'));
  }

  /**
   * 把 [{name,n}] 写成一串中文：`万州3起，两江、开州2起，…10个区域各1起`。
   *
   * 规则：
   *   1. 按起数降序排列，多起在前，1 起垫后；
   *   2. 同为 1 起且不少于 2 个时合并成「A、B、C各1起」；
   *   3. 1 起的区域达到 bigThreshold 个时，压缩成「A、B…N个区域各1起」，
   *      避免句子长到读不完（默认 5 个起）。
   *
   * @param {Array<{name:string,n:number}>} items
   * @param {number} [bigThreshold=5]
   * @param {boolean} [shortOn=true] 是否用区域简称
   */
  function groupDesc(items, bigThreshold, shortOn) {
    const big = bigThreshold === undefined ? 5 : bigThreshold;
    const short = HT.shortTown || ((x) => x);
    const by = new Map();
    (items || []).forEach(x => {
      const k = x.n;
      if (!by.has(k)) by.set(k, []);
      /* 层级按**原始名字**判，写法按 short() 出——先短后判会把「垫江县」
         裁成「垫江」，再想分清"区"还是"县"就没线索了。 */
      by.get(k).push({ name: short(x.name, shortOn), tier: HT.townTier ? HT.townTier(x.name) : 9 });
    });
    return [...by.keys()]
      .sort((a, b) => b - a)
      .map(k => {
        /* 同起数的一组内部：先主城、再其他区、最后县，同层按名字。
           以前这里沿用 countBy 的顺序（等于按名字排），于是会出现
           「垫江、奉节、九龙坡、两江」——县排在主城前面（2026-11-16 用户指出）。
           非区域列表（起火原因、条目类型）tier 全是 9，退化成按名字，行为不变。 */
        const names = by.get(k).sort((a, b) =>
          a.tier - b.tier || String(a.name).localeCompare(String(b.name), 'zh'));
        const list = names.map(x => x.name);
        /* 一组里有多个区域时，数量后面必须带「各」：
           「合川、长寿2起」读起来像这两个区域合计 2 起，实际是各 2 起、共 4 起。
           单个区域才写「垫江3起」。2026-11-16 用户指出。 */
        if (list.length >= 2) {
          if (k === 1) {
            if (list.length >= big) return `${list.join('、')}${list.length}个区县各1起`;
            return `${list.join('、')}各1起`;
          }
          return `${list.join('、')}各${k}起`;
        }
        return `${list.join('、')}${k}起`;
      })
      .join('，');
  }

  /** 按条件累加 */
  const sumBy = (list, fn) => (list || []).reduce((s, x) => s + (fn(x) || 0), 0);

  /**
   * 两个累计数 → 「上升11.00%」/「下降3.20%」/「持平」。
   *
   * 只认两个实数，方向由差值的正负决定——这两个数都是我们自己按窗口查回来的，
   * 不是接口那个"下降为正"的幅度，所以按符号判是对的。
   * 任一取不到、或去年为 0（除不了）就返回空串，调用方据此退回「同比x」。
   *
   * @param {number|null} cur  本期累计
   * @param {number|null} last 去年同期累计
   */
  function casYoyWord(cur, last) {
    if (cur == null || last == null || !isFinite(cur) || !isFinite(last) || last <= 0) return '';
    const diff = cur - last;
    if (!diff) return '持平';
    return (diff > 0 ? '上升' : '下降') + (Math.abs(diff) / last * 100).toFixed(2) + '%';
  }

  /**
   * 时间写法：整段是一个"坐标"，不是要核对的量。
   *
   * 认这几种（正文里真会出现的）：
   *   11月12日18时 / 11月12日18时30分 / 2026年11月12日
   *   11月11日18时至11月12日18时 / 18时至次日6时 / 11月1日至11月12日
   * 长写法排在短写法前面：正则从左到右试，先试长的才不会把时段拆成两个日期。
   */
  const DT_DAY = '(?:\\d{4}年)?\\d{1,2}月\\d{1,2}日(?:\\d{1,2}时(?:\\d{1,2}分)?)?';
  const DT_CLOCK = '\\d{1,2}时(?:\\d{1,2}分)?';
  const DT_RE = new RegExp(
    DT_DAY + '(?:\\s*至\\s*' + DT_DAY + ')?' +
    '|' + DT_CLOCK + '(?:\\s*至\\s*' + DT_CLOCK + ')?',
    'g'
  );

  /**
   * 只读视图的数字高亮：把数字（含小数、百分号）包成 `<b class="hn">`，
   * 日期与时段整段包成 `<i class="dt">`。
   *
   * 为什么需要它：初始界面的正文是只读的，textarea 做不到局部着色，
   * 所以列表态改用 div 渲染。这份稿子里唯一要"一眼对上"的就是数字
   * （起数、占比、同比），其余是连词，不该跟它抢注意力。
   *
   * 日期为什么要先整段摘出来（1.4.5）：`11月12日18时` 里三个数字各自成色、
   * "月/日/时"留在墨色，一句话被剪成好几截，读起来是碎的。
   * 时间是一处坐标，应当一处颜色，所以先用占位符把整段换下来、等数字那遍
   * 染完再原样放回——占位符用私用区字符，不含数字，不会被第二遍切开。
   *
   * 先转义再包标签——顺序反了的话，正文里出现的 `<` 会把标记吃掉。
   * 只认 ASCII 数字：中文数字（"十二"）在稿子里只出现在日期与前缀。
   */
  function markNums(s) {
    const txt = String(s == null ? '' : s);
    const hold = [];
    const masked = txt.replace(DT_RE, m => {
      hold.push(m);
      /* \u0001 夹一个私用区字符：既不可能是正文内容，也不会被 \d 命中 */
      return '\u0001' + String.fromCharCode(0xE000 + hold.length - 1) + '\u0001';
    });
    const body = masked
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/(\d+(?:\.\d+)?%?)/g, '<b class="hn">$1</b>');
    return body.replace(/\u0001([\uE000-\uF8FF])\u0001/g, (_, ch) => {
      const one = hold[ch.charCodeAt(0) - 0xE000] || '';
      return '<i class="dt">' +
        one.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</i>';
    });
  }

  Object.assign(HT, { countBy, groupDesc, sumBy, casYoyWord, markNums });
})(typeof window !== 'undefined' ? window : globalThis);
