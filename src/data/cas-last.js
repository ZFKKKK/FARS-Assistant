/**
 * src/data/cas-last.js —— 去年有效条目的「补录前」月度数（2025 特例专用）
 *
 * @layer  data（数据层）
 * @file   src/data/cas-last.js
 * @since  1.4.0（1.2.0 首次引入；中间有一版整体删掉过，1.4.0 起按"2025 特例专用"恢复）
 *
 * ## 什么时候用这张表
 *
 * **只有去年是 2025 那年用它。** 其余年份一律查系统（`ytdLast` 数据源，去年 YTD 实查）。
 *
 * 为什么 2025 是特例：平台上的去年数据会被事后补录。2025 年年底结账的那个全年总数，
 * 在补录完成后被抬高一截。今年算同比如果拿补录后的数去比，等于拿"去年最终的数"比
 * "今年此刻的数"——这批补录会把同比长期压低。使用者出一份稿子时用的是
 * **当时报出去的那个数**，所以 2025 那一年必须用月度表里的补录前数。
 *
 * 但这条只对 2025 成立：补录是那一轮的特殊情况，不是每年的常态。所以不维护
 * "每年一张表"——表里没有的年份（2026 及以后）一律实查系统，分母跟着基准时间走，
 * 没有人需要每年更新文件。曾经有一版这么做过，方向没错，错在把 2025 一起删了。
 *
 * ## 口径（与手工月度表逐字一致）
 *
 *   去年同期累计 = 去年 1 月至上月的整月之和
 *                + 去年本月 × 基准日期 / 本月天数
 *
 * 最后四舍五入到整数。例：基准时间在某月 14 日，取「上年 1 月至上月整月之和」
 * 再加「上年本月 × 14 / 本月天数」，四舍五入后的数与手工表上那一格相同。
 * 按天折算而不是按整月：本月才过 14 天，整月算会把去年多算半个月的量。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * 各年有效条目的月度数（当月结账口径，不含事后补录）。
   * 键是年份，值是 1–12 月的起数。
   *
   * **只放 2025 这一行**，也不打算为其他年份加行。真要加，得是"那一年也被补录过"
   * 这种特殊情况：两边都给数时以表为准（见 report.js），表里写错一个数，
   * 同比就常年错下去，而界面上看不出来。
   */
  const CAS_LAST_MONTH = {
    2025: [1605, 842, 909, 724, 637, 551, 677, 717, 677, 753, 704, 813]
  };

  /**
   * 某年「到 m 月 day 日**之前**」的补录前累计（day 从 1 起，day=1 即本月零天）。
   * 内部单位：起数（小数，调用方决定何时取整）。
   */
  function casBeforeDay(y, m, day) {
    const t = CAS_LAST_MONTH[y];
    if (!t) return null;
    let sum = 0;
    for (let i = 0; i < m; i++) sum += t[i];
    /* 本月天数：下个月第 0 天 = 本月最后一天 */
    const days = new Date(y, m + 1, 0).getDate();
    sum += t[m] * (day - 1) / days;
    return sum;
  }

  /**
   * 去年同期的有效条目累计（补录前口径）。
   * @param {Date} base 基准时间（取数右端那个时刻）
   * @returns {number|null} 表里没有这一年就返回 null —— 调用方改用系统实查
   */
  function lastYearCas(base) {
    /* 不用 instanceof Date：离线用例把脚本装进 vm 沙箱跑，沙箱里的 Date
       与外层不是同一个构造函数，instanceof 会假阴性。鸭子判断跨上下文安全。 */
    if (!base || typeof base.getTime !== 'function' || isNaN(base.getTime())) return null;
    const y = base.getFullYear() - 1;
    const s = casBeforeDay(y, base.getMonth(), base.getDate() + 1);
    return s === null ? null : Math.round(s);
  }

  /**
   * 去年**同一段区间**的补录前有效起数（周报的有效同比要用它）。
   *
   * 周窗口是一周，不是「今年以来」，所以不能拿 lastYearCas 的结果直接比：
   * 那个数是累计到某一天的量。这里两头各算一次累计再相减，
   * 得到的是 [s, e] 这一段（含首尾两天）的折算量。
   *
   * 折算而不是查实数，理由与年累计相同：2025 那一年被事后补录过，
   * 平台现在返回的「去年同周」是补录后的数，拿它比今年会年年偏低。
   *
   * 起止跨年（周一在去年 12 月、周日已在今年 1 月）时返回 null ——
   * 表里没有可减的两头，调用方退回平台实查的同周数。
   *
   * @param {Date} s 区间起点
   * @param {Date} e 区间终点
   * @returns {number|null}
   */
  function lastYearCasBetween(s, e) {
    if (!s || !e) return null;
    if (typeof s.getTime !== 'function' || typeof e.getTime !== 'function') return null;
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
    const y = s.getFullYear();
    if (e.getFullYear() !== y) return null;
    const a = casBeforeDay(y, s.getMonth(), s.getDate());
    const b = casBeforeDay(y, e.getMonth(), e.getDate() + 1);
    if (a === null || b === null) return null;
    return Math.max(0, Math.round(b - a));
  }

  Object.assign(HT, { CAS_LAST_MONTH, lastYearCas, lastYearCasBetween });
})(typeof window !== 'undefined' ? window : globalThis);
