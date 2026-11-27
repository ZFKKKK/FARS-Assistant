/**
 * src/data/window.js —— 截点判定与查询窗口
 *
 * @layer  data（数据层）
 * @file   src/data/window.js
 * @since  0.5.0
 *
 * 这里只回答两个问题：
 *   1. 现在过了基准时间没有？（决定提示与按钮可用性）
 *   2. 要查的四个窗口的起止时间是几点？（今年以来 / 当日或本周 / 去年同日 / 去年年初至今）
 *
 * 周期（1.12.0）：day = 当日滚动 24h；week = 本周（周一 0 时至条件时间）。
 * 后者是给周报用的：条件时间在周日 18:00 时，窗口正好是「11月9日0时至11月15日18时」，
 * 与手工周报的写法一致；在周中打开则是「本周至上一结算点」，不编造一个没走完的整周。
 *
 * 基准时间有两种来源（1.1 起）：
 *   自动 —— 每天 18:00:00。过没过点按当前时刻判，过了算今天、没过算昨天。
 *   手动 —— 面板上点「基准时间」直接指定到某一刻（年月日时分秒），
 *           想补前天的数、想按 17:30 结账，都改这一个值，取数右端就跟着走。
 *   手动值存成 'YYYY-MM-DDTHH:MM:SS'（本地时间）；空串 = 自动。
 *
 * 口径（0.8 起精确到秒）：
 *   当日 = [基准时间 - 24h, 基准时间 - 1s]，即 18:00:00 → 17:59:59。
 *   右端取**基准时间前一秒**，两个周期才首尾相接、不重不漏——18:00:00 这一秒
 *   只会落在后一个周期里。基准时间只到分钟时，18:00:00–18:00:59 这一分钟
 *   悬在两个周期之间，要么重复统计、要么整个漏掉；记录是按秒入库的。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /** '18:00:00' / '18:00' → [18, 0, 0]。缺秒按 0 算，兼容 5.x 存下的旧配置 */
  function parseAnchor(a) {
    const p = String(a || '18:00:00').split(':');
    return [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0];
  }

  const BASE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

  /**
   * 手填的基准时间 → Date。空串 / 不合法返回 null（= 走自动）。
   *
   * 必须回读比对：`new Date(2026, 1, 31)` 不会报错，它顺延成 3 月 3 日。
   * 用户手打 2 月 31 日，我们要的是"不认"，不是悄悄换成另一天。
   */
  function parseBaseAt(v) {
    const m = BASE_RE.exec(String(v == null ? '' : v).trim());
    if (!m) return null;
    const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
    if (y < 2000 || y > 2100 || h > 23 || mi > 59 || s > 59) return null;
    const dt = new Date(y, mo - 1, d, h, mi, s, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    if (dt.getHours() !== h || dt.getMinutes() !== mi || dt.getSeconds() !== s) return null;
    return dt;
  }

  /** Date → 'YYYY-MM-DDTHH:MM:SS'（本地时间；就是 <input type="datetime-local"> 的 value 形状） */
  function baseAtStr(d) {
    return `${d.getFullYear()}-${HT.pad(d.getMonth() + 1)}-${HT.pad(d.getDate())}` +
      `T${HT.pad(d.getHours())}:${HT.pad(d.getMinutes())}:${HT.pad(d.getSeconds())}`;
  }

  /**
   * 截点的**公文写法**：18时 / 18时30分 / 18时00分30秒。
   * 秒为 0 时不写秒——正文那句「截至11月12日18时」必须保持公文习惯，
   * 只有用户真把截点设到带秒时才把秒露出来。
   */
  function anchorCn(h, m, s) {
    if (s) return `${h}时${HT.pad(m)}分${HT.pad(s)}秒`;
    return m ? `${h}时${HT.pad(m)}分` : `${h}时`;
  }

  /** 今天的截点时刻 */
  function anchorOf(d, h, m, s) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, s, 0);
  }

  /**
   * 某一天所在那一周的周一 00:00:00。
   *
   * 一周从周一开始、到周日结束（国内公文与值班表的通行口径）。周日的 getDay() 是 0，
   * 直接 (0 + 6) % 7 = 6，正好回退到本周一，不需要额外特判。
   */
  function weekStartOf(d) {
    const back = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 0, 0, 0, 0);
  }

  /**
   * 周报的「该结的那一笔」：base 之后最近的一个周日截点（含 base 当天）。
   * 只给面板悬停提示用——窗口右端始终是 base 本身，不提前到周日。
   */
  function weekTargetOf(base, h, m, s) {
    const t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, s, 0);
    t.setDate(t.getDate() + ((7 - t.getDay()) % 7));
    if (t.getTime() < base.getTime()) t.setDate(t.getDate() + 7);
    return t;
  }

  /**
   * 基准时间状态。
   * @returns {{passed:boolean, anchor:string, anchorText:string, target:Date,
   *            remainMs:number, remainText:string, cycleLabel:string, explicit:boolean}}
   */
  function anchorStatus(now, cfg) {
    const c = HT.normalizeCfg(cfg);
    const n = now || new Date();
    /* 手填了就照手填的判，没填才回落到「今天 18:00」 */
    const at = parseBaseAt(c.baseAt);
    const [ah0, am0, as0] = parseAnchor(c.anchor);
    const [ah, am, as] = at
      ? [at.getHours(), at.getMinutes(), at.getSeconds()]
      : [ah0, am0, as0];
    const target = at || anchorOf(n, ah0, am0, as0);
    const passed = n.getTime() >= target.getTime();
    const remainMs = passed ? 0 : target.getTime() - n.getTime();
    const hh = Math.floor(remainMs / 3600000);
    const mm = Math.floor((remainMs % 3600000) / 60000);
    const remainText = remainMs <= 0 ? '' :
      (hh ? `${hh} 小时 ${mm} 分` : (mm ? `${mm} 分` : '不到 1 分'));
    /* 已结算周期的末日：过了基准时间算当天，没过算前一天 */
    const cycleDay = new Date(target.getFullYear(), target.getMonth(),
      target.getDate() - (passed ? 0 : 1));

    return {
      passed,
      anchor: `${HT.pad(ah)}:${HT.pad(am)}:${HT.pad(as)}`,
      anchorText: anchorCn(ah, am, as),
      target,
      remainMs,
      remainText,
      explicit: !!at,
      cycleLabel: `${cycleDay.getMonth() + 1} 月 ${cycleDay.getDate()} 日`
    };
  }

  /**
   * 构造查询窗口。
   *
   * 口径只有一个：**最近一个已结算周期**（到点前是「昨天此时 → 今天此时-1秒」，
   * 到点后是「今天此时-24h → 今天此时-1秒」）。不再提供"截至此刻"的半截窗口——
   * 当天的数据在截点前不完整，用半截窗口写出来的文字会前后不一致。
   *
   * 周周期（period='week'）把左端换成**本周一 00:00:00**，右端仍是条件时间：
   * 周报是「周一 0 时至周日 18 时」那一段，条件时间落在周日 18:00 时正好齐整。
   * 周中打开时拿到的是「本周至今」，而不是把上周整周当成本周。
   *
   * @param {Date} now
   * @param {object} cfg
   * @param {'day'|'week'} [period]
   */
  /* 去年同期 = 同一个日历时刻往前推一年，闰日按 Date 的自然进位处理。
     2024-02-29 17:59:59 减一年会得到 2023-03-01 17:59:59——看着像"错了一天"，
     其实是对的：2023 年没有 2 月 29 日，去年同位置的第二天就是 3 月 1 日，
     这样窗口起止仍相差 24 小时减去 1 秒。
     曾经有过一种"更聪明"的改法：遇到 2/29 就夹到 2/28。那会让结束时刻
     早于开始时刻（2/28 18:00 → 2/28 17:59:59），窗口变成负一秒，
     同比基准整体塌掉。这一条别改。 */

  function buildWindows(now, cfg, period) {
    const c = HT.normalizeCfg(cfg);
    const n = now || new Date();
    const week = period === 'week';
    const [ah0, am0, as0] = parseAnchor(c.anchor);
    const st = anchorStatus(n, c);

    /* 自动模式：最近一个已结算的 18:00；手填模式：就用他填的那一刻。
       手填的值本身就是"结算点"，不再按 now 往前推——否则填了 11 月 13 日
       18 时，第二天打开它会自己往后跳一天，补出来的稿子就不是那一天了。 */
    const anchorToday = anchorOf(n, ah0, am0, as0);
    const autoBase = st.passed ? anchorToday
      : anchorOf(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1), ah0, am0, as0);
    const base = parseBaseAt(c.baseAt) || autoBase;
    const [ah, am, as] = [base.getHours(), base.getMinutes(), base.getSeconds()];
    /* 基准时间的前一秒（18:00:00 → 17:59:59） */
    const end = new Date(base.getTime() - 1000);

    const start = week
      ? weekStartOf(base)
      : new Date(end.getTime() - 86400000 + 1000);   // 起点 18:00:00
    const ytdStart = new Date(end.getFullYear(), 0, 1, 0, 0, 0);
    const lastStart = new Date(start); lastStart.setFullYear(lastStart.getFullYear() - 1);
    const lastEnd = new Date(end); lastEnd.setFullYear(lastEnd.getFullYear() - 1);
    /* 去年同期的**年初至今**：算「有效条目同比」的分母要用它。
       不能用 LAST（那个只有 24 小时），也不能用"去年同期累计 + 按天折算"——
       折算要一张手工月度表，而平台本身就查得到去年这一段时间的数。 */
    const lastYtdStart = new Date(lastEnd.getFullYear(), 0, 1, 0, 0, 0);
    const cn = anchorCn(ah, am, as);

    /* 「基准时间」= 结算的那个时刻本身，形如 2026年11月12日18时00分。
       它是整套口径的锚：当日窗口是它往前推 24 小时，同比窗口是它往前推一年，
       「截至…」那句公文话说的也是它。写给人看时分钟必须补零——
       anchorCn 为公文省掉了「00分」，但作为一个独立的时刻标签，
       「18时」和「18时00分」读起来是两种精度，这里统一成后者。 */
    const baseText = `${base.getFullYear()}年${base.getMonth() + 1}月${base.getDate()}日` +
      `${ah}时${HT.pad(am)}分` + (as ? HT.pad(as) + '秒' : '');
    /* 面板顶部那两行用它。一格里只放一个时刻，精度统一到分：
       秒只可能在手填基准时间时才有，写进 title，不撑破一行。
       targetText 是「该结的那一笔」——每天 18:00 落到今天哪一号，
       过没过点都指向同一个目标；queryText 是「这一轮实际取的」，
       没过点时它比 targetText 早一天。两行并排，差一天一眼就看见，
       不必再用一句话解释"现在取的是上一周期"。 */
    const cnMoment = d => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` +
      `${d.getHours()}时${HT.pad(d.getMinutes())}分`;
    /* 周报那一笔：下一个周日截点。只在提示里用——窗口右端仍是条件时间本身，
       提前把右端推到周日等于替人编一小时还没发生的数。 */
    const targetText = cnMoment(week ? weekTargetOf(base, ah, am, as) : st.target);
    const queryText = cnMoment(base);
    /* 这两个键跟着基准时间走，不跟 cfg.anchor 走：用户把基准时间改到 17:30，
       正文里的「截至…17时30分」必须跟着变，否则稿子和取数是两份说法。 */
    const clock = `${HT.pad(ah)}:${HT.pad(am)}:${HT.pad(as)}`;

    return {
      YTD: { s: ytdStart, e: end },
      DAY: { s: start, e: end },
      /* 本周窗口。周周期下它与 DAY 是同一个区间（DAY 恒指"这一轮实际取的那一段"），
         单独留一个名字，是为了让面板、导出、校验不必去猜"这次是哪种周期"：
         凡是要说"本周"的地方都取它，说"本期"的地方取 DAY。 */
      WEEK: { s: weekStartOf(base), e: end },
      LAST: { s: lastStart, e: lastEnd },
      /* 去年年初 → 去年同期时刻，与 YTD 一一对应（同月同日同时刻往前推一年） */
      YTDL: { s: lastYtdStart, e: lastEnd },
      base,
      baseText,
      targetText,
      queryText,
      baseAt: baseAtStr(base),
      explicit: !!parseBaseAt(c.baseAt),
      anchorText: cn,
      anchor: clock,
      passed: st.passed,
      /* 公文里那句「11月11日18时至11月12日18时」。
         右端写基准时间而不是 17:59:59——公文的「18时至次日18时」本身就是一个
         左闭右开的 24 小时，写成「至17时59分59秒」反而别扭。
         基准时间带秒时才把秒写出来。
         周报写「11月9日0时至11月15日18时」：起点就是周一零点，
         写「0时」而不是「0时00分」——公文里这个位置从不补零。 */
      dayRange: week
        ? `${HT.cnDay(start)}0时至${HT.cnDay(base)}${cn}`
        : `${HT.cnDay(start)}${cn}至${HT.cnDay(end)}${cn}`,
      /* 模板里能插的几种时间写法。同一段时间有多种说法，
         用哪种是文风问题，不该由代码替用户决定，所以全列出来让他挑。 */
      dayRangeShort: `${HT.pad(start.getMonth() + 1)}/${HT.pad(start.getDate())} ` +
        `${HT.pad(start.getHours())}:${HT.pad(start.getMinutes())} → ` +
        `${HT.pad(end.getMonth() + 1)}/${HT.pad(end.getDate())} ` +
        `${HT.pad(end.getHours())}:${HT.pad(end.getMinutes())}`,
      dayRangeDay: `${HT.cnDay(start)}至${HT.cnDay(end)}`,
      lastRange: week
        ? `${HT.cnFullDay(lastStart)}0时至${HT.cnFullDay(lastEnd)}${cn}`
        : `${HT.cnFullDay(lastStart)}${cn}至${HT.cnFullDay(lastEnd)}${cn}`,
      anchorClock: clock,
      anchorCnFull: `${ah}时${HT.pad(am)}分${HT.pad(as)}秒`,
      /* 这一轮是哪个周期。模板里的日期标签取 W.DAY.* 就够了——
         它在周周期下就是本周窗口，不必再记两个名字。 */
      period: week ? 'week' : 'day'
    };
  }

  Object.assign(HT, {
    anchorStatus, buildWindows, parseAnchor, anchorCn, parseBaseAt, baseAtStr,
    weekStartOf
  });
})(typeof window !== 'undefined' ? window : globalThis);
