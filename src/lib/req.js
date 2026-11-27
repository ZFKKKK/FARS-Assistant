/**
 * src/lib/req.js —— 一次 JSON 请求：超时、解析、失败归一
 *
 * @layer  lib（纯工具）
 * @since  1.6.16
 *
 * 为什么要有这个文件：
 *   "发一个请求、给它 8 秒、把结果变成'成功/超时/连不上/回的不是 JSON'四类"
 *   这件事，之前有四份实现——release.js 的 withTimeout、cloud.js 的 req()、
 *   background.js 的 diagSend 与 tgFlush。四份里的超时值、失败措辞、
 *   是否读 lastError 都不一样，改一次策略要在四个地方对齐。
 *
 * 它**不**替代 data/http.js：那边对接的是站点接口，错误要分成九类长码
 * （NET-TIMEOUT / AUTH / SHAPE…），每一类对应使用者不同的处置动作；
 * 这里是"自建服务器上的轻请求"，只关心"走到哪一步断的"。两层抽象不同，
 * 合在一起会让九类错退化成四类。
 *
 * 约定：**永不 reject**。失败也 resolve 成 { ok:false, reason }。
 * 理由与 obs.js 的 persist 相同——reject 会冒成 unhandledrejection，
 * 那会被全局监听记成一条错误，于是"服务器没开"看起来像"扩展有 bug"。
 *
 * 四个 reason 就是路由表的全部：
 *   unreach 请求没发出去（DNS / 拒绝连接 / 被拦 / 跨域）→ 查网络与权限
 *   timeout 发出去了没回                                     → 服务器或链路挂住
 *   http    回了但不是 2xx                                   → 服务器那一侧
 *   format  回了 2xx 但不是 JSON                             → 发布/部署写错了
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const WHY = { UNREACH: 'unreach', TIMEOUT: 'timeout', HTTP: 'http', FORMAT: 'format' };

  /** 默认 8 秒：自建服务器上都是几百字节的 JSON，超过就是挂了 */
  const TIMEOUT = 8000;

  /**
   * 读响应体。两种取法都认：真实 Response 同时有 json() 与 text()，
   * 而手工构造的 Response-like（离线测试、verify 的桩）通常只实现其一。
   * 这不是为测试让步——"能读出来一个对象"本来就是这一层的全部要求。
   */
  function readJson(r) {
    if (typeof r.json === 'function') {
      return Promise.resolve().then(() => r.json())
        .then(d => ({ ok: true, data: d }),
          e => ({ ok: false, detail: String((e && e.message) || e) }));
    }
    if (typeof r.text === 'function') {
      return Promise.resolve().then(() => r.text()).then(t => {
        try { return { ok: true, data: JSON.parse(t) }; }
        catch (e) { return { ok: false, detail: '返回的不是 JSON' }; }
      }, e => ({ ok: false, detail: String((e && e.message) || e) }));
    }
    return Promise.resolve({ ok: false, detail: '响应无法读取' });
  }

  /**
   * @param {string} url
   * @param {{method?:string, body?:*, headers?:object, timeout?:number}} [opt]
   * @returns {Promise<{ok:boolean, status?:number, data?:*, reason?:string, detail?:string}>}
   */
  function json(url, opt) {
    const o = opt || {};
    const budget = Number(o.timeout) > 0 ? Number(o.timeout) : TIMEOUT;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { } }, budget) : null;

    const init = { method: o.method || 'GET', cache: 'no-store' };
    if (ctl) init.signal = ctl.signal;
    if (o.headers) init.headers = o.headers;
    if (o.body !== undefined) {
      init.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
      init.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    }

    const stop = v => { if (timer) clearTimeout(timer); return v; };

    return fetch(url, init).then(r => {
      /* 用 status 判失败而不是 r.ok：离线测试里的 Response 打桩只有 status 与
         text()，没有 ok 字段——用 r.ok 会把"200 且内容正常"误判成失败，
         而这正是那些测试想覆盖的正常路径。 */
      if (r.status >= 400) {
        return { ok: false, reason: WHY.HTTP, status: r.status, detail: 'HTTP ' + r.status };
      }
      /* 服务器把错误页、登录页、目录索引当 200 返回是常事，
         解析出来的不是 JSON——这类"看着成功实则没内容"
         必须和网络问题分开，否则人只会去查网线。 */
      return readJson(r).then(p => {
        if (!p.ok) {
          return { ok: false, reason: WHY.FORMAT, status: r.status, detail: p.detail };
        }
        return { ok: true, status: r.status, data: p.data };
      });
    }).catch(e => {
      const name = String((e && e.name) || '');
      const m = String((e && e.message) || e);
      if (name === 'AbortError' || /abort/i.test(m)) {
        return {
          ok: false, reason: WHY.TIMEOUT,
          detail: `没有在 ${Math.round(budget / 1000)} 秒内返回`
        };
      }
      return { ok: false, reason: WHY.UNREACH, detail: m };
    }).then(stop, e => stop({ ok: false, reason: WHY.UNREACH, detail: String(e) }));
  }

  Object.assign(HT, { req: { json, WHY, TIMEOUT } });
})(typeof window !== 'undefined' ? window : globalThis);
