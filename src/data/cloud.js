/**
 * 云端配置同步：所有装了本扩展的电脑共用**同一份**配置。
 *
 * ## 为什么没有「同步码」了
 *
 * 1.7 之前每份配置靠一串码区分，是为了回答"新装的那台该取哪一份"。
 * 但这个扩展的用途只有一种——按同一个单位的同一个口径出同一份稿子。
 * 既然答案永远是"就那一份"，那就不该有第二份：云端只有**一个槽**
 * （`SLOT`），谁来取都是它，谁来改都算它。
 *
 * 少掉的不只是界面上那串码，还有三处专门为"多份"写的护栏：
 * 新装机禁止自动上传、云端更新时抛 conflict、手动点「取回/上传」。
 * 现在都不需要了——一台机器打开站点就是查一下，改完就是传一下。
 *
 * ## 代价（必须说清，也必须在界面上留退路）
 *
 * 共用一份意味着：**装了本扩展的人谁改都算数，后改的覆盖先改的**。
 * 所以留两样东西兜底：
 *   · 每次「取回」覆盖本机之前，先把本机那份存成 `cfgPrev`（只留一层），
 *     设置页在发生覆盖之后多一个「还原上一份」；
 *   · 「备份」组里的导出/导入照旧，改坏了能整份退回。
 *
 * ## 什么时候动
 *
 *   boot()       打开站点 / 打开设置页 → 查云端；云端更晚且本机没有未传的改动就取回
 *   onCfgSaved() 配置写完 → 记一笔"待上传"，几秒后静默上传
 *   sync()       上面两件事共用的决策：拉、推、还是什么都不做
 *
 * 判断"谁更新"只靠一个东西：云端返回的 `at`（服务端时间戳）与本地
 * `meta.at` 比大小。字符串比较即可，服务端按这个格式发。
 *
 * 冲突规则：**谁后改算谁的**。本机有未传的改动（dirty）就推上去，
 * 没有就拉下来，不问、不弹框——一份共用的配置，问也没有"保留哪份"的意义。
 *
 * ## 失败怎么办
 *
 * 一律不打断人：配置已经在本机存好了，云端没跟上不该让保存失败。
 * 但也不能一声不响——失败原因记进 `meta.fail`，设置页那一行改口说
 * 「没传上去（…），本机已保存」。下一轮 boot / 下次保存会自动重试。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const KEY = 'cloudSync';
  /** 被云端覆盖之前的那一份配置，只留一层，设置页给它一个「还原」 */
  const PREV = 'cfgPrev';
  /**
   * 服务端的固定槽位。要过服务端那关码格式校验（6–32 位字母数字），
   * 但**不再由用户填写**，界面上也不出现——它只是"那份共用配置"的地址。
   * 改它等于换一份云端配置：老槽里的内容不会跟过来。
   */
  const SLOT = 'ht-shared';
  /* 当前生效的槽位。正常只有一个值，允许改的唯一理由是 `云端端到端脚本`：
     那个脚本要真联网跑一遍「A 传 → B 取」，如果打的是正式槽位，跑一次测试
     就会把大家的配置换成测试数据。 */
  let slot = SLOT;

  const TIMEOUT = 8000;
  /* nginx 的 cfg 三个地址共用一个桶（zone=htcfg），每 1.5 秒补一个令牌，
     所以退避 2 秒一定能拿到下一个。 */
  const RETRY_MS = 2000;
  /* 同一台机器两次自动查询的最小间隔。打开站点、切页面都会叫 boot，
     不拦一道的话一天能打几百次 stat——那是白耗别人的带宽。 */
  const CHECK_MS = 60000;
  /** 保存后等多久上传：改模板会连点几次保存，防抖成一次 */
  const PUSH_WAIT = 4000;

  const meta0 = () => ({
    v: 2,
    /** 本机这份配置对应的云端时刻；空 = 还没同步过 */
    at: '',
    /** 本机有改动还没传上去。1 就表示"本机更新"，sync 优先推 */
    dirty: 0,
    /** 机型标签，只在状态行说"哪台改的"，不含任何身份信息 */
    dev: '',
    /** 上次没传上去的原因；成功一次就清掉 */
    fail: '',
    /** 自动同步开关。关掉就只剩本机，一个请求都不发 */
    auto: true,
    /** 上次查询的时间戳，给 boot 限流用 */
    checked: 0
  });

  /* ── 存储 ─────────────────────────────────────────────── */

  function hasStore() {
    try { return !!(g.chrome && g.chrome.storage && g.chrome.storage.local); }
    catch (e) { return false; }
  }

  function rawGet(keys) {
    return new Promise(res => {
      let done = false;
      const fin = v => { if (!done) { done = true; res(v || {}); } };
      if (!hasStore()) return fin({});
      try {
        g.chrome.storage.local.get(keys, r => {
          const le = g.chrome.runtime && g.chrome.runtime.lastError;
          fin(le ? {} : (r || {}));
        });
      } catch (e) { fin({}); }
      setTimeout(() => fin({}), 1200);
    });
  }

  function rawSet(obj) {
    return new Promise(res => {
      if (!hasStore()) return res(false);
      try {
        g.chrome.storage.local.set(obj, () => {
          const le = g.chrome.runtime && g.chrome.runtime.lastError;
          res(!le);
        });
      } catch (e) { res(false); }
    });
  }

  /**
   * 老版本存在同一个键里的 meta 是 `{code, pulledAt, pushedAt, pushFail}`。
   * 升级到"共用一份"之后，本机那套模板是用户攒出来的，而云端槽位可能是空的
   * 或装着别人的——**必须先当成本机有改动推上去**，不能一上来就被覆盖。
   * 所以迁移只在有旧同步记录时才置 dirty。
   */
  function migrate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (Number(raw.v) === 2) return raw;
    const at = String(raw.pushedAt || raw.pulledAt || '');
    return {
      v: 2,
      at,
      dirty: at ? 1 : 0,
      dev: raw.dev || '',
      fail: '',
      auto: raw.auto !== false,
      checked: 0
    };
  }

  /** 读同步元信息。读不到就当空——它不影响出稿，不值得为它拦一道。 */
  function readMeta() {
    return rawGet([KEY]).then(r => Object.assign(meta0(), migrate(r[KEY]) || {}));
  }

  function writeMeta(patch) {
    return readMeta().then(m => {
      const next = Object.assign(meta0(), m, patch || {});
      return rawSet({ [KEY]: next }).then(() => next);
    });
  }

  /** 设备名：只用来在状态行区分"哪台机器改的" */
  function devName() {
    return readMeta().then(m => {
      if (m.dev) return m.dev;
      const ua = (g.navigator && g.navigator.userAgent) || '';
      const os = /Windows/i.test(ua) ? 'win'
        : /Macintosh|Mac OS X/i.test(ua) ? 'mac'
          : /CrOS/i.test(ua) ? 'cros'
            : /Linux/i.test(ua) ? 'linux' : 'dev';
      const r = Math.random().toString(36).slice(2, 6);
      const dev = os + '-' + r;
      return writeMeta({ dev }).then(() => dev);
    });
  }

  /* ── 网络 ─────────────────────────────────────────────── */

  function api() {
    const s = (HT.RELEASE && HT.RELEASE.sync) || {};
    if (s.enabled === false || !s.url) return '';
    return String(s.url).replace(/\/+$/, '');
  }

  /**
   * 同步类错误一律用普通 Error，不套 errors.js 的错误卡。
   * 理由：它从不阻断出稿，也不该在面板上占一块红框——设置页那一行
   * 只需要一句人话（"连不上服务器"），套 CARD 会变成"出现了没归类的错误"。
   */
  function fail(why) {
    const e = new Error(why);
    e.sync = true;
    return e;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /**
   * 发一个请求。**只对 503 退避重试一次**，其余错误原样抛出。
   * 503 是 nginx 限流，属于"现在太挤"而不是"请求不对"，等一个令牌再发就好。
   */
  function req(url, opt) {
    return attempt(url, opt, 0);
  }

  /* ── 请求从哪发出去 ────────────────────────────────────────────
     两条路，不是二选一的设计洁癖：
       · 扩展页面（设置页以标签页打开）：自己 fetch，同源、不受任何页面 CSP 影响；
       · 内容脚本（面板）：页面 origin 的 fetch 会被目标站的 connect-src 拦掉，
         必须交给 Service Worker 代发。 */
  function inExtPage() {
    try { return String((g.location && g.location.protocol) || '') === 'chrome-extension:'; } catch (e) { return false; }
  }

  function hasSW() {
    try { return !!(g.chrome && g.chrome.runtime && typeof g.chrome.runtime.sendMessage === 'function'); } catch (e) { return false; }
  }

  function viaSW(url, o) {
    return new Promise(resolve => {
      try {
        g.chrome.runtime.sendMessage({ type: 'cfgReq', url, method: o.method, body: o.body }, r => {
          if (g.chrome.runtime.lastError || !r) {
            resolve({ ok: false, reason: 'unreach', detail: '后台未回话' });
            return;
          }
          resolve(r);
        });
      } catch (e) {
        resolve({ ok: false, reason: 'unreach', detail: '后台未回话' });
      }
    });
  }

  function attempt(url, opt, tried) {
    const o = opt || {};
    if (!HT.req || !HT.req.json) return Promise.reject(fail('请求工具未加载'));

    const go = (inExtPage() || !hasSW())
      ? HT.req.json(url, { method: o.method, body: o.body, timeout: TIMEOUT })
      : viaSW(url, o);

    return go.then(r => {
      /* 限流时 nginx 回 503 的 HTML 页，不是 JSON。统一按"服务器忙"处理 */
      if (r.reason === 'http' && r.status === 503) {
        if (!tried) return sleep(RETRY_MS).then(() => attempt(url, o, 1));
        throw fail('服务器繁忙，请稍后再试');
      }
      if (!r.ok) {
        if (r.reason === 'timeout') throw fail('连接超时');
        if (r.reason === 'unreach') throw fail('连不上服务器');
        throw fail('返回内容无法识别（' + (r.status || '') + '）');
      }
      const d = r.data;
      if (!d || !d.ok) {
        const m = {
          code: '云端不接受这个槽位', doc: '云端拒绝：配置内容不完整',
          full: '云端存满了', length: '请求为空'
        };
        throw fail(m[d && d.err] || ('云端拒绝（' + ((d && d.err) || r.status) + '）'));
      }
      return d;
    });
  }

  /** 云端元信息：有没有、什么时候、哪台机器传的 */
  function stat() {
    const base = api();
    if (!base) return Promise.reject(fail('云同步未启用'));
    /* 槽位放 body 不放 query：URL 会进 nginx 的 access_log 与浏览器历史 */
    return req(base + '/stat', { method: 'POST', body: { code: slot } });
  }

  /* ── 落地 ─────────────────────────────────────────────── */

  /* pull 自己要写配置，写进去的那一下不该被当成"用户改动"再传回云端
     ——否则拉下来紧接着就推上去，白跑一趟，还会把另一台刚传的盖掉。 */
  let applying = false;

  /** 取 doc 里 activeId 那一份（别把档案列表算进差异，它永远不同） */
  function pickActive(doc) {
    try {
      const id = doc && doc.activeId;
      return (doc && doc.cfgOf && doc.cfgOf[id]) || {};
    } catch (e) { return {}; }
  }

  function getDoc() {
    return req(api() + '/get', { method: 'POST', body: { code: slot } });
  }

  /**
   * 取回：整份替换本机配置。
   *
   * 覆盖前先把本机那份存进 `cfgPrev`——共用一份配置时，"别人改了"和
   * "我攒的模板没了"是同一件事，得留一条退路。存之前先比一下，
   * 内容一致就不留（否则「还原上一份」会一直亮着，点了也没变化）。
   */
  function pull() {
    return getDoc().then(r => {
      if (r.empty) return { empty: true };
      return HT.exportCfg().then(before => {
        /* 两边都过一遍 normalizeCfg 再比：云端存的是它那台的完整配置，
           本机这份也是完整的——但缺字段（老版本、手改过的备份）会被补成默认值，
           拿补全前的原始对象比，永远"不一样"，于是每次都留一层没意义的底。 */
        const norm = d => JSON.stringify(HT.normalizeCfg(pickActive(d)));
        const changed = norm(before) !== norm(r.doc);
        const snap = changed
          ? rawSet({ [PREV]: { at: before.at, doc: before } })
          : Promise.resolve(false);
        return snap.then(() => {
          applying = true;
          return HT.importCfg(r.doc)
            .then(() => writeMeta({ at: r.at, dirty: 0, fail: '', checked: Date.now() }))
            .then(() => {
              /* 配置换过之后要让人看见：面板重排稿子、设置页重画表单都挂在这个事件上。
                 用事件而不是让 cloud 直接调界面，是因为 cloud 是数据层，
                 它不该知道"面板"长什么样。 */
              try { g.dispatchEvent(new g.Event('ht-cloud-pulled')); } catch (e) { }
              return { empty: false, at: r.at, dev: r.dev, size: r.size, replaced: changed };
            })
            .then(v => { applying = false; return v; }, e => { applying = false; throw e; });
        });
      });
    });
  }

  /** 上传本机这份 */
  function push() {
    return devName().then(dev =>
      HT.exportCfg().then(doc =>
        req(api() + '/put', { method: 'POST', body: { code: slot, dev, doc } })
          .then(r => writeMeta({ at: r.at, dirty: 0, fail: '', checked: Date.now() })
            .then(() => ({ ok: true, at: r.at, dev, size: r.size })))));
  }

  /* ── 决策 ─────────────────────────────────────────────── */

  let busy = false;

  /**
   * 拉、推、还是什么都不做。三条判据，按顺序：
   *
   *   ① 云端空     → 本机有东西（同步过 或 有改动）就推上去，否则等
   *   ② 本机没同步过 → 有改动就推（本机是攒出来的那份），否则拉（新装机）
   *   ③ 都比上了   → 云端更晚且本机没有未传改动 → 拉；本机有未传改动 → 推
   *
   * ③ 里"云端更晚但本机也有改动"选择推：规则是谁后改算谁的，
   * 本机有未传的改动，说明本机改在这之后。
   */
  function sync() {
    if (!api()) return Promise.resolve({ skip: 'off' });
    if (busy) return Promise.resolve({ skip: 'busy' });
    return readMeta().then(m => {
      if (m.auto === false) return { skip: 'auto-off' };
      busy = true;
      const fin = () => { busy = false; };
      const oops = e => writeMeta({
        fail: String((e && e.message) || '连不上服务器').slice(0, 24),
        checked: Date.now()
      }).then(() => ({ err: (e && e.message) || '同步失败' }));

      return stat().then(remote => {
        let step;
        if (remote.empty) {
          step = (!m.at && !m.dirty) ? { skip: 'empty' }
            : push().then(r => ({ pushed: r.at, dev: r.dev }));
        } else if (!m.at) {
          step = m.dirty
            ? push().then(r => ({ pushed: r.at, dev: r.dev }))
            : pull().then(r => ({ pulled: r.at, dev: r.dev, replaced: r.replaced }));
        } else if (String(remote.at || '') > String(m.at)) {
          step = m.dirty
            ? push().then(r => ({ pushed: r.at, dev: r.dev }))
            : pull().then(r => ({ pulled: r.at, dev: r.dev, replaced: r.replaced }));
        } else if (m.dirty) {
          step = push().then(r => ({ pushed: r.at, dev: r.dev }));
        } else {
          step = { skip: 'same' };
        }
        return Promise.resolve(step)
          .then(r => writeMeta({ fail: '' }).then(() => r))
          .catch(oops);
      }).catch(oops).then(r => { fin(); return r; });
    });
  }

  /**
   * 打开站点 / 打开设置页时叫一次。带 60 秒限流，可以放心到处叫。
   * @param {{force?:boolean}} [opt] force 跳过限流（设置页点「立即同步」）
   */
  let booting = null;
  function boot(opt) {
    const force = !!(opt && opt.force);
    if (booting) return booting;
    if (!api()) return Promise.resolve({ skip: 'off' });
    booting = readMeta().then(m => {
      if (m.auto === false) return { skip: 'auto-off' };
      const last = Number(m.checked) || 0;
      if (!force && last && Date.now() - last < CHECK_MS) return { skip: 'throttle' };
      return writeMeta({ checked: Date.now() }).then(() => sync());
    });
    return booting.then(r => { booting = null; return r; },
      e => { booting = null; throw e; });
  }

  /* ── 保存后自动上传 ─────────────────────────────────────── */

  let pushTimer = 0;

  /**
   * 配置写完调这个（config.js 的 writePack 里挂的钩子）。
   * 只记一笔"待上传"再排一次传，不做任何判断——判断都在 sync 里，
   * 两处各判一套，早晚判得不一样。
   */
  function onCfgSaved() {
    if (applying) return Promise.resolve({ skip: 'applying' });   // pull 自己写的不算改动
    return writeMeta({ dirty: 1 }).then(() => {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        pushTimer = 0;
        sync().catch(() => { });
      }, (HT.RELEASE && HT.RELEASE.sync && HT.RELEASE.sync.debounceMs) || PUSH_WAIT);
      return { dirty: 1 };
    });
  }

  /* ── 还原被覆盖的那一份 ─────────────────────────────────── */

  function prevInfo() {
    return rawGet([PREV]).then(r => {
      const p = r[PREV];
      if (!p || !p.doc) return null;
      return { at: p.at || '' };
    });
  }

  function restorePrev() {
    return rawGet([PREV]).then(r => {
      const p = r[PREV];
      if (!p || !p.doc) return Promise.reject(fail('没有可以还原的那一份'));
      applying = true;
      return HT.importCfg(p.doc).then(() => {
        applying = false;
        /* 还原完要传上去，否则下次 boot 一比对，云端那份又把它盖回来 */
        return writeMeta({ dirty: 1 }).then(() => sync()).then(() => ({ ok: true }));
      });
    });
  }

  /* ── 状态行 ───────────────────────────────────────────── */

  /** 把服务端时间戳说成人话：今年的只写月日，跨年才带年 */
  function when(at) {
    const s = String(at || '');
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
    if (!m) return s;
    const now = new Date();
    const sameYear = String(now.getFullYear()) === m[1];
    return (sameYear ? '' : m[1] + '-') + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  }

  /**
   * 一句话说清当前状态。设置页只显示这一句，不列错误码。
   * 顺序有讲究：**失败要压过「已同步」**——那句话说的是上一次成功，
   * 不是现在。两件事同时成立时，人需要先知道的是"没传上"。
   */
  function statusText(meta) {
    const m = Object.assign(meta0(), meta || {});
    if (!api()) return '云同步未启用';
    if (m.auto === false) return '自动同步已关闭，只存本机';
    if (m.fail) return '没传上去（' + m.fail + '），本机已保存';
    if (m.dirty) return '正在同步…';
    if (m.at) return '已同步 ' + when(m.at);
    return '还没连上云端';
  }

  HT.cloud = {
    KEY, PREV, SLOT,
    slot: () => slot,
    /** 只给实跑脚本换槽位用；界面上没有入口，也不该有 */
    setSlot: s => { slot = String(s || '').trim() || SLOT; },
    readMeta, writeMeta, devName,
    stat, pull, push, sync, boot,
    onCfgSaved, statusText, when,
    prevInfo, restorePrev,
    url: api
  };
})(typeof window !== 'undefined' ? window : globalThis);
