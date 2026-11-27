/**
 * src/data/http.js —— 接口访问、登录态、缓存、重试
 *
 * @layer  data（数据层）
 * @file   src/data/http.js
 * @since  5.0.0
 *
 * 只做"把接口变成结构化数据"，不判断业务含义、不拼句子。
 *   · 统计报告：1 次 GET 返回 60 段模板，按 templateCode 索引
 *   · 有效明细：POST comprehensive/query，分页取当日与去年同日
 *   · 5 分钟缓存：重复点击不重复打接口；设置变更时 clearCache 主动失效
 *   · 单次重试：AUTH 类不重试（重试也不会好），其余失败 400ms 后重来一次
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /* 站点契约全部在 data/contract.js：地址、参数名、列下标、明细字段名。
     这里只取用，不定义——站点改版时改那份，本文件一个字都不用动。 */
  const API = HT.API;
  const TIME_PARAMS = HT.TIME_PARAMS;
  const REPORT_QUERY = HT.REPORT_QUERY;
  const REPORT_NAMES = HT.REPORT_NAMES;
  const REPORT_SHAPE = HT.REPORT_SHAPE;
  const DETAIL_BODY = HT.DETAIL_BODY;
  const DETAIL_WINDOW = HT.DETAIL_WINDOW;
  const DETAIL_SHAPE = HT.DETAIL_SHAPE;
  const DETAIL_KEYS = HT.DETAIL_KEYS;
  const HEAD_QUERY = HT.HEAD_QUERY;
  const POLICY = HT.POLICY;

  const API_REPORT = API.report;
  const API_REPORT_GEN = API.reportGen;
  const REPORT_CROSS = HT.REPORT_CROSS;
  const API_COMP = API.comprehensive;
  const CACHE_TTL = POLICY.cacheTtl;
  const DETAIL_LIMIT = POLICY.detailLimit;      // 单页条数
  const DETAIL_MAX_PAGES = POLICY.detailMaxPages;  // 翻页上限，见 contract.js 说明
  const FETCH_TIMEOUT = POLICY.fetchTimeout;    // 20 秒，明细/汇总/翻页用
  const REPORT_TIMEOUT = POLICY.reportTimeout;  // 60 秒，报表要现算整年聚合

  /* 造错统一走 data/errors.js 的那张表：本文件只提供"事实"，
     不写"请刷新""请重试"——那是面板的处置语（见 errors.js 顶部五条规矩）。
     这里声明一次，下面全部用 err(...)，读者不必猜是哪一层在造错。 */
  const err = HT.err;

  /**
   * 打上数据源标签。
   *
   * 为什么不在造错时传 source：request() 不知道调用者是谁——同一个 fetch 既可能
   * 是「当日 · 条目统计」，也可能是「今年以来 · 一类」。只有 fetchReport /
   * fetchDetail 拿到 label，所以在它们出口处补一次。
   * 补在错误对象上而不是拼进 message：message 保持纯事实，
   * 报障行由 errLine() 统一拼成 `短码｜数据源：事实`，前缀只出现一次。
   */
  function tagSource(label, e) {
    if (label && e && !e.source) e.source = String(label);
    return e;
  }

  function token() {
    try { return g.localStorage.getItem('token') || ''; } catch (e) { return ''; }
  }

  /**
   * 缓存隔离用标签：同一个浏览器换账号登录后 token 会变，上一账号的响应不能复用。
   * 不把 token 本身写进 key——它不该出现在任何缓存键、日志或报错文本里，
   * 只取"长度 + 末 6 位"当指纹，足以区分同一台机器上的两次登录。
   */
  function cacheTag() {
    const t = token();
    return t ? t.length + ':' + t.slice(-6) : 'anon';
  }

  /**
   * 票据的剩余寿命。站点发的是 JWT（带 sub / exp / userid / iat 四个字段），
   * **签发即定死 30 分钟**，localStorage 里只有 `token` 这一把，没有 refresh_token，
   * 接口也没有"拿旧票据换新票据"的入口——所以"保活"在前端做不了。
   * 能做的是知道它哪一刻断：到期前说一声、断点不丢稿、登录完自己接着取。
   *
   * 解不出来（不是 JWT、base64 坏了、站点换了票据格式）一律记 unknown，
   * 不参与 ready 判定：最坏的结果应该是"提醒不出来"，而不是"明明能取数却说没登录"。
   */
  function b64json(s) {
    const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = g.atob(b + '==='.slice((b.length + 3) % 4));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder('utf-8').decode(u));
  }

  function tokenLife() {
    const t = token();
    const out = { has: !!t, exp: 0, iat: 0, leftMs: 0, expired: false, unknown: true };
    if (!t) return out;
    const p = String(t).split('.');
    if (p.length !== 3) return out;
    let j = null;
    try { j = b64json(p[1]); } catch (e) { return out; }
    const exp = Number(j && j.exp) > 0 ? Number(j.exp) * 1000 : 0;
    if (!exp) return out;                      // 没有 exp：无状态票据，不判
    const iat = Number(j.iat) > 0 ? Number(j.iat) * 1000 : 0;
    out.exp = exp;
    out.iat = iat;
    out.leftMs = exp - Date.now();
    out.expired = out.leftMs <= 0;
    out.unknown = false;
    return out;
  }

  /**
   * 「这个页面现在能不能取数」。
   *
   * **不看 exp。**（2026-11-18 现场回收的判断错误）
   * 上一版把 `expired` 放进了 ready，理由是"票过期了就该判未登录，省得白等一轮"。
   * 出稿人当场推翻：「我在站点上明明还能查数据，扩展却显示已过期」。原因是票的
   * exp 只是签发那一刻写下的 30 分钟，**服务端并不按它逐秒掐人**——请求还带着
   * 同源 Cookie，票面时间过了照样能取数。按 exp 判死的代价是：人看见「未登录」、
   * 跑去登了一次、回来发现本来就是好的，一次完整的白跑，还顺手把稿子那一轮打断。
   *
   * 所以 ready 只回答"页面里有没有票"。exp 退回去做**提前提醒**（还剩几分钟），
   * 真假的"票被拒"只由请求结果说话：401/403，或者响应根本不是 JSON（被重定向到登录页）。
   */
  function loginInfo() {
    const t = token();
    const life = tokenLife();
    let onLogin = false;
    try { onLogin = /login/i.test(g.location.pathname + g.location.hash); } catch (e) { }
    return {
      hasToken: !!t, onLoginPage: onLogin,
      ready: !!t && !onLogin,
      exp: life.exp, iat: life.iat, leftMs: life.leftMs,
      expired: life.expired, unknown: life.unknown
    };
  }

  /**
   * 带超时的请求。所有 fetch 都走这里，不允许直接调 g.fetch——
   * 漏一个，那条路径在代理卡死时就永远挂着，而界面看不出区别。
   *
   * 分三类：401/403 → AUTH（刷新重登）；超时 → NET（换网络/稍后）；
   * 其余非 2xx 与连接失败 → NET，并带上状态码，便于远程排障。
   *
   * @param {number} [ms] 这个请求自己的超时预算。不传就用默认 20 秒——
   *   报表要现算整年聚合，比明细慢一个量级，调用处显式给长预算。
   */
  let reqN = 0;
  async function request(url, opt, ms) {
    const budget = ms || FETCH_TIMEOUT;
    reqN++;                       // 真实打出去的次数（含重试、含翻页），给状态栏用
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const o = Object.assign({}, opt);
    if (ctrl) o.signal = ctrl.signal;
    const timer = ctrl
      ? setTimeout(() => { try { ctrl.abort(); } catch (e) { } }, budget)
      : null;

    let r;
    try {
      r = await g.fetch(url, o);
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
      /* timeout 单独打个标：超时说明"等够了也没回"，再等一轮只让人多站一会儿。
         真正需要重试的是握手失败、被重置这类一过性故障。 */
      throw aborted
        ? err('NET_TIMEOUT', `${budget / 1000} 秒内未返回`, { timeout: true, url: String(url).split('?')[0] })
        : err('NET_DOWN', `请求发不出去（${(e && e.message) || '网络或代理拒绝'}）`, { url: String(url).split('?')[0] });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (r && (r.status === 401 || r.status === 403)) {
      throw err('AUTH', `凭证被拒（${r.status}）`, { status: r.status });
    }
    if (!r || !r.ok) {
      throw err('NET_STATUS', `返回 ${r ? r.status : '空响应'}`, { status: r ? r.status : 0 });
    }
    return r;
  }

  /* ── 缓存 ─────────────────────────────────────────────── */
  const cache = new Map();
  function cacheGet(k) {
    const v = cache.get(k);
    if (!v) return null;
    if (Date.now() - v.t > CACHE_TTL) { cache.delete(k); return null; }
    return v.d;
  }
  function cacheSet(k, d) { cache.set(k, { t: Date.now(), d }); }
  function clearCache() { cache.clear(); }
  /* 状态栏原来写"数据源个数 次请求"——翻页之后这个数会小于真实请求数。
     改成真计数器：命中缓存是 0，翻 3 页是 3，重试也算一次。 */
  function requestCount() { return reqN; }

  async function withRetry(fn, times) {
    const n = times === undefined ? 1 : times;
    let last;
    for (let i = 0; i <= n; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (e && e.kind === 'AUTH') throw e;
        /* 超时不重试：一次 20 秒已经等够了，重试只会让人再站 20 秒。
           两台机器上都出现过——"当日 · 条目统计"这一条单独挂住，其余四条都正常，
           结果面板黑着四十秒才报错，还看不出是哪一条。 */
        if (e && e.timeout) throw e;
        if (i < n) await new Promise(r => setTimeout(r, 400));
      }
    }
    throw last;
  }

  /* ── 统计报告 ─────────────────────────────────────────── */
  /**
   * @param {{s:Date,e:Date}} win
   * @param {0|1|null} isNoDamage  0=只要有效；null=不限（一类全集）
   * @param {string} [label] 数据源人话名（如「当日 · 条目统计」），只用于报错定位
   * @param {string} [types] 段落分块，如 '1,3'；不给就拉全部三块。含义见
   *   contract.js 的 REPORT_QUERY.paragraphType（1 记录 / 2 处置 / 3 条目）
   * @param {string[]} [codes] 要哪几段（模板码，如 `['HZ_01']`）。给了就按段名筛，
   *   只回这几段；不给 = 整块返回。段名的唯一来源是 contract.js 的 REPORT_NAMES
   * @returns {Promise<Object<string,{code,name,content,values:string[]}>>}
   */
  async function fetchReport(win, isNoDamage, label, types, codes) {
    const params = Object.assign({}, REPORT_QUERY);
    if (types) params.paragraphType = types;
    /* 块内再收紧：只点名要哪几段。取不到名字的模板码不发——宁可整块回来，
       也不要发个平台不认的名字出去，让服务端回空、再报"缺少段落"。 */
    const names = (codes || []).map(c => REPORT_NAMES[c]).filter(Boolean);
    if (names.length) params.paragraphName = names.join(',');
    params[TIME_PARAMS.report.start] = HT.fmtTime(win.s);
    params[TIME_PARAMS.report.end] = HT.fmtTime(win.e);
    const q = new URLSearchParams(params);
    if (isNoDamage !== undefined && isNoDamage !== null) q.set('isNoDamage', String(isNoDamage));
    const key = 'R|' + cacheTag() + '|' + q.toString();

    const hit = cacheGet(key);
    if (hit) return hit;

    /* 同一组参数发一次。段名筛的自愈要再发一次，所以抽成函数 */
    const ask = qs => withRetry(async () => {
      const r = await request(API_REPORT + '?' + qs.toString(), {
        method: 'GET',
        headers: { token: token() },
        credentials: 'include'
      }, REPORT_TIMEOUT);
      let o = null;
      try { o = await r.json(); } catch (e) { o = null; }
      if (!o || !Array.isArray(o[REPORT_SHAPE.list])) {
        const code = o ? String(o.code) : '';
        /* 三种情况，处置完全不同，别合成一句：
             解析不出 JSON     → 多半被重定向到登录页（票据没了）
             401/403/-1      → 票据被拒
             其余有 code      → 接口说"没有数据"，去查截点与录入 */
        if (!o) throw err('AUTH', '响应不是 JSON（多半已被重定向到登录页）');
        if (code === '401' || code === '403' || code === '-1') {
          throw err('AUTH', `票据被拒（${code}）`, { status: code });
        }
        throw err('DATA', `接口返回 ${code || '空数据'}${o.msg ? ' ' + o.msg : ''}`, { status: code });
      }
      return o;
    });

    let j;
    try {
      j = await ask(q);
      /* 段名筛没生效就退回整块。判据是「要的段一个都没回来」，不是「回来的段
         比要的少」——后者会误伤没有数据的日子：某个段服务端不返回，段数就少一个，
         于是每轮都白跑一道整块请求，反而更慢。
         一个都没回来，说明名字筛把自己要的也筛掉了（平台改名、参数不认、拼错），
         退回整块再要一次。整块回来仍按 templateCode 索引，多出来的段自然被忽略。
         只错一部分名字时不会走到这里，缺的那段由 want.required 明确报出来。 */
      if (names.length) {
        const got = j[REPORT_SHAPE.list]
          .map(p => p[REPORT_SHAPE.key]);
        if (!codes.some(c => got.indexOf(c) >= 0)) {
          const q2 = new URLSearchParams(q.toString());
          q2.delete('paragraphName');
          j = await ask(q2);
        }
      }
    } catch (e) {
      throw tagSource(label, e);
    }

    const map = {};
    j[REPORT_SHAPE.list].forEach(p => {
      const code = p[REPORT_SHAPE.key];
      map[code] = {
        code: code,
        name: p[REPORT_SHAPE.name],
        content: p[REPORT_SHAPE.content] || '',
        values: String(p[REPORT_SHAPE.value] || '').split(',').map(s => s.trim())
      };
    });
    cacheSet(key, map);
    return map;
  }

  /**
   * 接口自称的总条数。能读到就拿它当"收够了"的判据；读不到也不算错，
   * 多翻一页、看到短页就停。
   *
   * 只认明显是"总数"的键。count / size / records 在部分版本里表示"本页条数"，
   * 拿它当总数会在第一页就停下——正是这次要修的那个错。
   */
  function readTotal(d) {
    if (!d) return null;
    const keys = DETAIL_SHAPE.total;
    for (let i = 0; i < keys.length; i++) {
      const v = d[keys[i]];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (isFinite(n) && n >= 0) return n;
    }
    return null;
  }

  /**
   * 取一页明细。
   *
   * 分页参数同时写 page 与 offset，两处取值一致：现存请求里 page=1 时 offset 也是 1，
   * 说明这套接口把 offset 当 1 起的页序号，不是"跳过条数"。若某个版本的理解不同，
   * 后果是相邻两页重叠——由下面的跨页去重兜住，不会凭空多数。
   */
  async function fetchDetailPage(base, page, ep) {
    return withRetry(async () => {
      const body = Object.assign({}, base, { page: page, offset: page });
      const r = await request(API_COMP + (ep || 'query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8', token: token() },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      let o = null;
      try { o = await r.json(); } catch (e) { o = null; }
      const d = o && o.data && o.data[DETAIL_SHAPE.payload];
      if (!d) {
        /* 与报表取数同一套判法，别两处各写一套（会慢慢漂开） */
        if (!o) throw err('AUTH', '响应不是 JSON（多半已被重定向到登录页）');
        const code = String(o.code || '');
        if (code === '401' || code === '403' || code === '-1') {
          throw err('AUTH', `票据被拒（${code}）`, { status: code });
        }
        throw err('DATA', `明细接口返回 ${code || '空数据'}${o.msg ? ' ' + o.msg : ''}`, { status: code });
      }
      let t = readTotal(d);
      if (t === null) t = readTotal(o.data);
      const list = d[DETAIL_SHAPE.list] || [];
      /* 平台会给一个**假的 total = 0**：列表明明有 10 条，`data.data.total` 仍是 0
         （2026-11-13 那次带行政区域筛选的真实响应就是这样）。0 一旦被当成"总数"，
         翻页判断 `rows.length >= total` 立刻成立——第一页就收工，还标记成"已取全"。
         有效高峰日（>500 条）因此静默少取，区域加总偏小而校验不响。
         列表非空时 0 只能是"这个字段没填"，按未知处理，退回"短页即最后一页"。 */
      if (t === 0 && list.length > 0) t = null;
      return {
        list: list,
        total: t,
        /* 整个 payload 也带出去：汇总对象（fireWarning 之类）就在这一层，
           而它和列表是同一次响应——分两次请求拿同一份东西没道理。 */
        raw: d
      };
    });
  }

  /**
   * 从汇总对象里按候选字段名取一个数。
   * 只认能解析成有限数的值：`""`、`null`、`"上升4.21%"` 这类一律当没取到，
   * 交给上层退回报表口径——把 `"上升4.21%"` 硬转成 0 会写出"同比上升0%"。
   */
  function pickNum(o, k) {
    const v = o[k];
    if (v === null || v === undefined || v === '' || typeof v === 'object') return null;
    const n = Number(String(v).replace(/[,\s%]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function headNum(obj, names) {
    if (!obj) return null;
    for (let i = 0; i < names.length; i++) {
      const n = pickNum(obj, names[i]);
      if (n !== null) return n;
      /* 再往下一层找：有的版本把处置三个数收在 dispatch 之类的子对象里。
         只下探一层——再深就是猜结构了，不如让校验把字段名列出来。 */
      const ks = Object.keys(obj);
      for (let j = 0; j < ks.length; j++) {
        const c = obj[ks[j]];
        if (c && typeof c === 'object' && !Array.isArray(c)) {
          const m = pickNum(c, names[i]);
          if (m !== null) return m;
        }
      }
    }
    return null;
  }

  /**
   * 读「带方向词的百分比」：汇总里的同比是 `"上升9.45%"` / `"下降3.2%"` / `"-"`。
   * 不能塞给 pickNum——它只剥逗号空格百分号，`"上升9.45"` 转不成数。
   * 只取其中第一个数字，方向由调用方从报表的方向列拿（report.js 就是这么配的）。
   *
   * 不用 pickNum 改通用逻辑：那会把 "2026-11-14" 里的 2026 也当数字吃进去。
   */
  function pickPct(o, k) {
    const v = o[k];
    if (v === null || v === undefined || v === '' || typeof v === 'object') return null;
    const m = String(v).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  function headPct(obj, names) {
    if (!obj) return null;
    for (let i = 0; i < names.length; i++) {
      const n = pickPct(obj, names[i]);
      if (n !== null) return n;
    }
    return null;
  }

  /**
   * 汇总对象的字段名清单（含一层子对象，写成 `parent.child`）。
   * 只收名字、不收值：认不出字段时靠它定位，而它可以安全地截图、上报。
   */
  function flatKeys(o) {
    const out = [];
    if (!o || typeof o !== 'object') return out;
    Object.keys(o).forEach(k => {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.keys(v).forEach(k2 => out.push(k + '.' + k2));
      } else out.push(k);
    });
    return out.slice(0, 40);
  }

  /**
   * 「综合查询」的汇总行——页面上那行「共查询到 N 起记录记录，其中一类 X 起…」。
   *
   * 为什么不再去数列表、也不用报表的 JQ_01/JQ_04：
   *   三处对同一段时间给出三个数（综合查询 1234 / 报表 1236 / 条目域 210），
   *   差的是 8 起、4 起，0.01% 量级。两个都是平台算的，我们做不了仲裁；
   *   而使用者核对的是**页面上那一行**，所以正文取这一行。
   *   报表那边继续留着做对账（checks 的 ytd.head 会把两个数并排写出来）。
   *
   * 一次请求拿全：汇总对象（五类 + 处置）+ 列表 total。
   * 上一版这里错了——它沿用了明细请求体的 fireType=4（条目域），
   * 读到的是条目域的条数，与「记录记录」不是一个数；这一版显式给 fireType=1。
   *
   * @returns {Promise<{box:string, keys:string[], v:object, miss:string[], total:number|null}>}
   *   box   命中的汇总对象名（空串 = 响应里没这个对象）
   *   keys  该对象的字段名（只名字，不含值；认不出字段时靠它定位，可安全外传）
   *   v     认出来的指标（T/F/Q/S/A/X/team/truck/person/…）
   *   miss  没认出来的指标名
   */
  async function fetchHead(win, label, opts) {
    /* fireOnly = 只要「一类」那一类的汇总（起数 + 该类的处置数）。
       服务端靠 time 数组区分：空数组按"某一类"统计、给三项按全量。
       实测同一窗口：空数组返回 warningCount 14497 = fireFighting、其余四类 0，
       处置 23138 队次 / 496 辆次 / 355145 人次（全量是 946 / 1496 / 9416）。
       缓存键必须带模式，否则同一个窗口的两种汇总会互相串。 */
    const fireOnly = !!(opts && opts.fireOnly);
    const key = 'H|' + cacheTag() + '|' + win.s.getTime() + '|' + win.e.getTime()
      + (fireOnly ? '|fire' : '');
    const hit = cacheGet(key);
    if (hit) return hit;

    /* 与 fetchDetail 同一套时间窗写法，只改 fireType 与 limit */
    const body = Object.assign({}, DETAIL_BODY, {
      limit: HEAD_QUERY.limit, fireType: HEAD_QUERY.fireType
    });
    body[DETAIL_WINDOW.warning.key] = {
      [DETAIL_WINDOW.warning.start]: win.s.getTime(),
      [DETAIL_WINDOW.warning.end]: win.e.getTime()
    };
    /* `areaGroupStaticFlag`：**2026-11-20 七组对照实测，加不加返回值完全相同**
       （time 空数组时 95/95，time 三项时 96/96），它不该被当成"全量开关"。
       留着无害（照抄页面），但别在它上面找原因。 */
    if (!fireOnly) body[DETAIL_WINDOW.warning.key].areaGroupStaticFlag = HEAD_QUERY.areaGroupStaticFlag;
    /* 2026-11-20 七组对照（fireType=1，同一窗口）：**真正决定全量还是子集的，
       只有条目域那个 Req 对象一项（`DETAIL_WINDOW.fire.key`）**——
         fireReq = {}  → warningCount 95（time 空）/ 96（time 三项）
         fireReq = 有值 → warningCount 14 = fireFighting（哪一种 time 都一样）
       `time` 只挪窗口边界（96 比 95 多含结束那一秒），不换模式；
       `areaGroupStaticFlag` 毫无影响。此前以为"三个把手必须成组"，是错的；
       三种形态服务端都不报错，所以只能靠对照实验才看得出来。
       （明细走 fireType=4，fireReq 必须填，那是另一套规矩，别互相抄。） */
    body[DETAIL_WINDOW.fire.key] = fireOnly ? {
      [DETAIL_WINDOW.fire.start]: win.s.getTime(),
      [DETAIL_WINDOW.fire.end]: win.e.getTime()
    } : {};
    /* 页面还传了这个 time 数组：UTC 的 ISO 串，三项——开始 / 结束（毫秒补到 .999）/ null。
       **它只决定窗口边界，不决定全量还是一类**（2026-11-20 实测：空数组 95、三项 96，
       差的就是结束那一秒）。补 .999 是为了把那一秒整含进去，与页面请求逐字一致。 */
    body.time = fireOnly ? [] : [
      win.s.toISOString(),
      new Date(win.e.getTime() + 999).toISOString(),
      null
    ];

    /* 先走 `queryresult`。`query` + limit:1 实测汇总恒为 null（见 接口实测记录），
       以前的顺序是"先试 query，找不到汇总再试 queryresult"——等于每次出稿都白跑一次
       query，固定多花约 6 秒。反过来：正常情况一次到位，万一哪一版把汇总挪回 query，
       下面的兜底仍然能救回来。 */
    let got;
    try {
      got = await fetchDetailPage(body, 1, 'queryresult');
    } catch (e) {
      try { got = await fetchDetailPage(body, 1); } catch (e2) { throw tagSource(label, e); }
    }

    let raw = got.raw || {};
    let boxName = '';
    let box = null;
    const findBox = () => {
      for (let i = 0; i < HEAD_QUERY.boxes.length; i++) {
        const o = raw[HEAD_QUERY.boxes[i]];
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          boxName = HEAD_QUERY.boxes[i]; box = o; return true;
        }
      }
      return false;
    };
    findBox();
    /* 兜底：`query` 与 `queryresult` 是同一条业务链上的两个入口，前者给列表、
       后者给"列表 + 汇总"。上面已经先走 queryresult，这里只在"那一版把汇总挪回
       query"时才发第二次——正常情况下这一块不会执行。 */
    if (!box) {
      try {
        const alt = await fetchDetailPage(body, 1);
        if (alt && alt.raw) { raw = alt.raw; findBox(); }
      } catch (e) { /* 第二个入口不通就不通，下面按"没认到汇总"降级 */ }
    }

    const v = {};
    const miss = [];
    const F = HEAD_QUERY.fields;
    Object.keys(F).forEach(k => {
      /* yoy* 是"上升9.45%"这种串，得用百分比解析；其余都是纯数字 */
      const n = /^yoy/.test(k) ? headPct(box, F[k]) : headNum(box, F[k]);
      if (n === null) miss.push(k); else v[k] = n;
    });
    /* 汇总对象没给总数，就用同一响应里的列表 total（同一个窗口、同一份数据） */
    if (v.T === undefined && got.total !== null && got.total !== undefined) v.T = got.total;

    const out = { box: boxName, keys: flatKeys(box), v: v, miss: miss, total: got.total };
    cacheSet(key, out);
    return out;
  }

  /**
   * 明细行的稳定主键。跨页去重只认这个——不能拿整行内容当指纹：
   * 同区域、同等级、同起火原因的行本来就会有多条（轻微条目尤其常见），
   * 按内容去重会把真实的重复记录当成重复数据吃掉，条数直接对不上。
   */
  function rowKey(x) {
    if (!x) return '';
    for (let i = 0; i < DETAIL_KEYS.length; i++) {
      const v = x[DETAIL_KEYS[i]];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
    return '';
  }

  /**
   * 有效明细，逐页取全（isNoDamage=0 已由接口过滤，这里再兜一次）。
   *
   * 四个停止条件，任何一个都保证循环有界：
   *   空页            → 到底了
   *   整页指纹重复     → 接口没按页返回，再翻也是同一页
   *   不满一页         → 最后一页
   *   收够 total / 翻满 DETAIL_MAX_PAGES → 停
   *
   * @param {{s:Date,e:Date}} win
   * @param {string} [label] 数据源人话名，只用于报错定位
   * @returns {Promise<Array>} 数组 + 四个标记：
   *   __truncated 可能不全（STALLED / CAPPED）
   *   __paged     停在哪：'end' 取全 ｜ 'stalled' 接口未翻页 ｜ 'capped' 到页数上限
   *   __pages     实际翻了几页
   *   __total     接口自称总条数，读不到为 null
   */
  async function fetchDetail(win, label) {
    const key = 'D|' + cacheTag() + '|' + win.s.getTime() + '|' + win.e.getTime();
    const hit = cacheGet(key);
    if (hit) return hit;

    const base = Object.assign({}, DETAIL_BODY, { limit: DETAIL_LIMIT });
    /* 记录域只放「只要有效」，**时间给空串**——这不是省事，是口径。
       两个时间窗都填时服务端取的是**并集**，不是交集（2026-11-17 出稿人实测：
       同一窗口只填起火时间 24 条，两个都填 25 条；两次的分母都是 22 起，
       同比 9.09% / 13.64%，只差分子那一条）。多出来的那条是
       「发生在本期、起火在上一期」的条目。
       而正文用明细只算四件事——一般及以上 / 区域分布 / 中心城区 / 起火原因，
       都是"这个时段**发生**的有效条目"，口径就是起火时间；报表 HZ_01 的有效数
       也是这个口径（24 起与只填起火时对得上）。明细行里的 warningDate（发生时间）
       全项目没有任何一处读过（grep 只有本文件的参数名和 report.js 一句注释）。
       空串而不是删掉这个键：页面清空该条件时发的就是 ""（见 报文目录B0q-请求.txt），
       保持对象形状一致，免得服务端对"缺键"另作解释。 */
    base[DETAIL_WINDOW.warning.key] = {
      [DETAIL_WINDOW.warning.start]: '',
      [DETAIL_WINDOW.warning.end]: '',
      [HT.NO_DAMAGE_FIELD]: '0'
    };
    base[DETAIL_WINDOW.fire.key] = {
      [DETAIL_WINDOW.fire.start]: win.s.getTime(),
      [DETAIL_WINDOW.fire.end]: win.e.getTime()
    };

    const rows = [];
    const seen = new Set();        // 主键集合：跨页去重（无主键的行不参与，见 rowKey）
    const pagesSeen = new Set();   // 整页指纹：识别"没翻页"
    let pages = 0;
    let total = null;
    let stop = 'end';

    for (let p = 1; p <= DETAIL_MAX_PAGES; p++) {
      let got;
      try {
        got = await fetchDetailPage(base, p);
      } catch (e) {
        /* 翻到第几页挂的也写上：翻页请求共用同一个 URL，只有这里知道是第几页。 */
        if (e) e.page = p;
        throw tagSource(label, e);
      }
      pages = p;
      if (got.total !== null) total = got.total;
      const list = got.list;

      if (!list.length) { stop = 'end'; break; }

      /* 整页指纹只看首尾两行 + 条数：接口把 page 当摆设时，第 2 页会和第 1 页
         一模一样。没有这一条，要么无限翻同一页，要么把同一页拼 10 份。 */
      const sig = list.length + '|' + JSON.stringify(list[0]) + '|'
        + JSON.stringify(list[list.length - 1]);
      if (pagesSeen.has(sig)) { stop = 'stalled'; break; }
      pagesSeen.add(sig);

      let added = 0;
      for (let i = 0; i < list.length; i++) {
        const k = rowKey(list[i]);
        if (k) {
          if (seen.has(k)) continue;
          seen.add(k);
        }
        rows.push(list[i]);
        added++;
      }
      /* 整页都是见过的行：分页没生效，或者接口在原地返回。停，并且说清楚。 */
      if (!added) { stop = 'stalled'; break; }

      /* 有 total 就以 total 为准，此时"不满一页"不算数：有的版本不认 limit，
         每页只给 200 条，短页之后还有。没有 total 才退回"短页即最后一页"。 */
      if (total !== null) {
        if (rows.length >= total) { stop = 'end'; break; }
      } else if (list.length < DETAIL_LIMIT) { stop = 'end'; break; }
      if (p === DETAIL_MAX_PAGES) stop = 'capped';
    }

    const out = rows.filter(x => x[HT.NO_DAMAGE_FIELD] !== HT.NO_DAMAGE_YES);
    out.__truncated = stop === 'capped' || stop === 'stalled';
    out.__paged = stop;
    out.__pages = pages;
    out.__total = total;
    cacheSet(key, out);
    return out;
  }

  /**
   * 「明细可能不全」那句话。三种停法处置不同：
   *   stalled → 接口没翻页，要报障，不是数据真只有这些
   *   capped  → 翻到 10 页还没完，得人工核
   * 只说"已达 500 条上限"会让使用者以为拉满一页就正常。
   */
  function detailTruncText(paged, pages, n) {
    if (paged === 'stalled') {
      return `明细接口未按页返回（第 ${pages} 页与上一页内容相同），仅取到 ${n} 条`;
    }
    if (paged === 'capped') {
      return `已翻 ${pages} 页共 ${n} 条仍未取完，请人工核对`;
    }
    return `已达 ${DETAIL_LIMIT} 条上限，仅取到 ${n} 条`;
  }

  /**
   * 报表统计（固定报表）· 只取数、不排版。
   *
   * 2026-11-16 抓包：POST JSON，回 `data.result`（二维数组，一行一个区划格，
   * 前两列是「层级 / 区域」，第 3 列起 24 个指标）。参数与坑见 接口实测记录 §5。
   *
   * 只走区域档：下级区域档 1102 行、154 KB，还有 51 个跨区重名下级区域与开州区带前导空格的
   * 下级区域名——正文只到区域，那些坑一个都用不上。
   *
   * 只服务「报表互校」这条后台链路，出稿不等它。
   */
  async function fetchReportCross(win, label) {
    /* 字段名与档位一律走 contract.js 的 reportCrossBody，这里不拼参数名 */
    const t1 = HT.fmtTime(win.s), t2 = HT.fmtTime(win.e);
    const body = HT.reportCrossBody(t1, t2,
      '分区划分等级火灾情况统计表(' + HT.cnFullDay(win.s) + '-' + HT.cnFullDay(win.e) + ')');
    const key = 'RG|' + cacheTag() + '|' + t1 + '|' + t2;
    const hit = cacheGet(key);
    if (hit) return hit;

    let j = null;
    try {
      const r = await request(API_REPORT_GEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: token() },
        credentials: 'include',
        body: JSON.stringify(body)
      }, REPORT_TIMEOUT);
      try { j = await r.json(); } catch (e) { j = null; }
      /* 票据没了的时候服务端**不给 401/403**，而是 200 + 登录页 HTML
         （2026-11-20 实测：错 token / 缺 token 都是 text/html，状态码照旧 200）。
         所以这里必须与 fetchReport / fetchDetail 同一套判法——少了这一句，
         票据失效会被归成 DATA，authDead 永不置位，界面永远不提示「未登录」，
         人只看到一句看不懂的「报表接口没回 result 数组」。 */
      if (!j) throw err('AUTH', '响应不是 JSON（多半已被重定向到登录页）');
      const code = String(j.code || '');
      if (code === '401' || code === '403' || code === '-1') {
        throw err('AUTH', `票据被拒（${code}）`, { status: code });
      }
      if (!j.data || !Array.isArray(j.data.result)) {
        throw err('DATA', '报表接口没回 result 数组', { status: code });
      }
    } catch (e) {
      throw tagSource(label, e);
    }

    /* 同一列里 int 与 str 混着来（`2` 与 `"300"` 并存），先统一成字符串再转数。
       不这么做，`'0'` 与 `0` 在 === 上永远不相等。 */
    const num = v => {
      const n = Number(String(v == null ? '' : v).trim().replace(/,/g, ''));
      return isFinite(n) ? n : 0;
    };
    let total = 0, sxq = 0, sxx = 0;
    const byTown = Object.create(null);
    j.data.result.forEach(row => {
      if (!Array.isArray(row) || row.length < 3) return;
      const lvl = String(row[0] == null ? '' : row[0]).trim();
      const name = String(row[1] == null ? '' : row[1]).trim();
      const n = num(row[2]);
      /* 两档首行标签不同：下级区域档「总计/总计/总计」，区域档「合计/合计」 */
      if (name === '合计' || name === '总计') { if (!total) total = n; return; }
      if (name === '小计') {
        if (lvl === '市辖区') sxq = n; else if (lvl === '市辖县') sxx = n;
        return;
      }
      if (name) byTown[name] = n;
    });

    const out = { total, shiXiaQu: sxq, shiXiaXian: sxx, byTown, rows: j.data.result.length };
    cacheSet(key, out);
    return out;
  }

  /**
   * 导出统计报表——「综合查询 → 查条目 → 生成报表 → 导出」那张分原因分等级表。
   *
   * 与 fetchReportCross 同一条接口、同一套判法，差别只在模板与用途：那边只读
   * 「条目概况」一列做互校，这边整张表都要（表头、合并区、左对齐列）。
   *
   * **文件不由服务端生成**（这一张是网页前端拼的），所以这里只把表格结构要回来，
   * xlsx 交给页面自己的导出模块——不自己拼表，页面改表样扩展不用跟着改。
   */
  async function fetchReportStat(win) {
    const t1 = HT.fmtTime(win.s), t2 = HT.fmtTime(win.e);
    const body = HT.reportBody(HT.REPORT_STAT, t1, t2,
      '分原因分等级火灾情况统计表(' + HT.cnFullDay(win.s) + '-' + HT.cnFullDay(win.e) + ')');
    let j = null;
    try {
      const r = await request(API_REPORT_GEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: token() },
        credentials: 'include',
        body: JSON.stringify(body)
      }, REPORT_TIMEOUT);
      try { j = await r.json(); } catch (e) { j = null; }
      /* 与 fetchReport / fetchDetail / fetchReportCross 同一套判法：
         票据没了服务端回的是 200 + 登录页 HTML，不是 401。 */
      if (!j) throw err('AUTH', '响应不是 JSON（多半已被重定向到登录页）');
      const code = String(j.code || '');
      if (code === '401' || code === '403' || code === '-1') {
        throw err('AUTH', `票据被拒（${code}）`, { status: code });
      }
      const d = j.data;
      if (!d || !Array.isArray(d.result) || !Array.isArray(d.head)) {
        throw err('DATA', '报表接口没回表格结构', { status: code });
      }
    } catch (e) {
      throw tagSource('导出报表', e);
    }

    const d = j.data;
    /* 文件名优先用服务端回的 excelTitle（它可能带单位前缀，如「重庆总队…」），
       没回才退回请求里那一份；扩展名只补一次。 */
    let name = String(d.excelTitle || body.excelTitle || '').trim();
    if (!/\.xlsx$/i.test(name)) name += '.xlsx';
    return {
      name: name,
      head: d.head,
      result: d.result,
      merges: Array.isArray(d.mergeCells) ? d.mergeCells : [],
      leftLine: Array.isArray(d.leftLine) ? d.leftLine : [],
      rangeStartRow: d.rangeStartRow,
      rangeStartCol: d.rangeStartCol
    };
  }

  /**
   * 导出条目清单——「综合查询 → 查条目 → 查询结果 → 导出」那张表。
   *
   * 这张表是**服务端**生成的（响应就是 xlsx 字节流），所以这里只做三件事：
   * 拼表单、发请求、认住「回来的到底是不是文件」。
   *
   * 票据失效时服务端不给 401/403，而是 200 + 登录页 HTML——判法与
   * fetchReport / fetchDetail / fetchReportCross 同一套。少这一句，就会把
   * 一个登录页存成 .xlsx，人点开是一片乱码，还以为导出坏了。
   *
   * @param {{s:Date,e:Date}} win   导出窗口（与正文当日窗口同一段）
   * @param {string[]} names        要导的列名，顺序即列序；空数组直接报错
   * @returns {Promise<{name:string, bytes:ArrayBuffer}>}
   */
  async function fetchExport(win, names) {
    const want = (names || []).filter(Boolean);
    const cols = [];
    for (let i = 0; i < want.length; i++) {
      const k = HT.EXPORT.keyOf(want[i]);
      if (k) cols.push([k, want[i]]);
    }
    /* 一列都没有就不发请求：服务端会回一张只有表头的空表，
       那比报错更难看出问题。 */
    if (!cols.length) throw err('DATA', '没有勾选要导出的列');
    const header = cols.map(c => HT.EXPORT.numCols.indexOf(c[1]) >= 0
      ? c[0] + ':' + c[1] + ':number'
      : c[0] + ':' + c[1]).join(',');
    /* 文件名与页面逐字一致（`条目信息列表（YYYY.MM.DD-YYYY.MM.DD）.xlsx`）——
       导出来的东西与手点那份同名同内容，放在一个文件夹里才分得清。 */
    const name = '火灾信息列表（' + HT.fmtDot(win.s) + '-' + HT.fmtDot(win.e) + '）.xlsx';

    const q = new URLSearchParams();
    q.set('classfunction', HT.EXPORT.cls);
    q.set('filename', name);
    q.set('header', header);
    q.set('fireType', String(HT.EXPORT.fireType));
    q.set(DETAIL_WINDOW.warning.key, '{}');
    q.set(DETAIL_WINDOW.dispatch.key, '{}');
    q.set(DETAIL_WINDOW.dispatchHead.key, '{}');
    q.set(DETAIL_WINDOW.fire.key, JSON.stringify({
      [DETAIL_WINDOW.fire.start]: win.s.getTime(),
      [DETAIL_WINDOW.fire.end]: win.e.getTime()
    }));
    q.set('dataTimeSource', '');
    q.set('staticFlag', '1');
    q.set('isNoDamage', HT.EXPORT.isNoDamage);

    return withRetry(async () => {
      const r = await request(API.exportExcel, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          token: token()
        },
        credentials: 'include',
        body: q.toString()
      }, REPORT_TIMEOUT);
      /* 先看回来的东西是什么类型，再决定怎么读：读成文本就再也读不成二进制了。
         正常情况下是 `application/octet-stream` 或 xlsx 那一串。 */
      const ct = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
      if (/json|html|text/i.test(ct)) {
        let o = null;
        try { o = JSON.parse(await r.text()); } catch (e) { o = null; }
        if (!o) throw err('AUTH', '响应不是文件（多半已被重定向到登录页）');
        const code = String(o.code || '');
        if (code === '401' || code === '403' || code === '-1') {
          throw err('AUTH', `票据被拒（${code}）`, { status: code });
        }
        throw err('DATA', `导出接口返回 ${code || '空数据'}${o.msg ? ' ' + o.msg : ''}`, { status: code });
      }
      const bytes = await r.arrayBuffer();
      /* xlsx 是 zip，头两字节必须是 PK。空响应、被代理换成别的东西，
         一律当失败——宁可不给文件，也别在下载目录里留一个打不开的。 */
      const head = new Uint8Array(bytes.slice(0, 2));
      if (!bytes.byteLength || head[0] !== 0x50 || head[1] !== 0x4b) {
        throw err('DATA', '导出接口没回文件');
      }
      return { name: name, bytes: bytes };
    });
  }
  Object.assign(HT, {
    API_REPORT, API_COMP, CACHE_TTL, DETAIL_LIMIT, DETAIL_MAX_PAGES,
    token, tokenLife, loginInfo, clearCache, requestCount, fetchReport, fetchDetail, fetchHead,
    fetchReportCross, fetchReportStat, detailTruncText, fetchExport
  });})(typeof window !== 'undefined' ? window : globalThis);
