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
   * 去年同期的有效条目累计（补录前口径）。
   * @param {Date} base 基准时间（取数右端那个时刻）
   * @returns {number|null} 表里没有这一年就返回 null —— 调用方改用系统实查
   */
  function lastYearCas(base) {
    /* 不用 instanceof Date：离线用例把脚本装进 vm 沙箱跑，沙箱里的 Date
       与外层不是同一个构造函数，instanceof 会假阴性。鸭子判断跨上下文安全。 */
    if (!base || typeof base.getTime !== 'function' || isNaN(base.getTime())) return null;
    const y = base.getFullYear() - 1;
    const t = CAS_LAST_MONTH[y];
    if (!t) return null;
    const m = base.getMonth();      // 0 起
    const d = base.getDate();
    let sum = 0;
    for (let i = 0; i < m; i++) sum += t[i];
    /* 本月天数：下个月第 0 天 = 本月最后一天 */
    const days = new Date(y, m + 1, 0).getDate();
    sum += t[m] * d / days;
    return Math.round(sum);
  }

  Object.assign(HT, { CAS_LAST_MONTH, lastYearCas });
})(typeof window !== 'undefined' ? window : globalThis);
