/**
 * src/ui/sitehider.js —— 屏蔽站点自带的悬浮图标（可选功能，默认关闭）
 *
 * @layer  ui（表现层）
 * @file   src/ui/sitehider.js
 * @since  6.0.0
 *
 * 目标站左下角有个「点我AI问答哦!」的机器人浮标，盖住表格右下角、也抢点击。
 * 这个模块负责把它（以及同类浮标）从页面上隐去，按三级优先：
 *
 *   1. 内置规则：目标站那个浮标的容器就是 `.__GPT__bubble-wrap`，写死在 BUILTIN 里。
 *      用户在设置页只需要打开一个开关，**不需要自己去点选**。
 *   2. 附加规则：设置页「自定义规则」里填的选择器，跟内置规则一起生效；
 *      站点改版换了 class 时才用得上，平时留空。
 *   3. 兜底启发式：上面两层的选择器一条都没命中才跑——扫「position:fixed/sticky +
 *      小尺寸 + 屏幕下半部 + 靠左右两侧 + 有图标或 AI/问答/助手字样」的节点。
 *      命中就不再扫，避免顺手把别人的客服气泡也藏了。
 *
 * 三条安全线（宁可漏，不可误伤）：
 *   · 只改 `display`，且记住原值，关掉开关能原样还原
 *   · 命中面积超过视口 40%、或包含我们自己的宿主节点，一律跳过
 *   · SPA 重渲染后节点会回来，用 MutationObserver（450ms 防抖）重新扫一次
 *
 * 不用 <style> 注入：目标站有 CSP，`<style>` 会被拦；直接改元素 inline style 不受影响。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const MARK = 'data-ht-hide';
  /* 目标站浮标的外层容器。它内部还有 `.__GPT__tooltip`，藏外层就够了 */
  const BUILTIN = ['.__GPT__bubble-wrap'];
  const AI_TEXT = /AI|智能问答|问答|小助手|智能助手|客服|机器人|点我|问我/i;
  const MAX_W = 240;          // 候选浮标的最大宽度
  const MAX_H = 260;          // 候选浮标的最大高度
  const SCAN_BUDGET = 2500;   // 单次启发式扫描最多看多少节点

  let on = false;
  let selectors = [];
  let hidden = new Map();     // el -> 原 inline display 值
  let mo = null;
  let scanTimer = null;
  /* 点选模式的重入锁。以前挂在 window 上（__HT_PICKING__），
     但它是这个模块自己的状态：只有一个 pick()，不需要对别处可见。
     挂在 window 上还有一个坏处——页面里别的脚本能把它改成 true，让点选直接失效。 */
  let picking = false;
  let lastAuto = 0;           // 上次启发式扫描时刻（据此限流，见 apply）

  const doc = () => document;
  const scope = () => document.body || document.documentElement;
  const hostEl = () => document.getElementById('ht-root');

  /** 允许分隔符：换行、逗号、分号，最多 12 条 */
  function parseSelectors(str) {
    return String(str || '')
      .split(/[\n\r,，;；]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
  }

  function isOurs(el) {
    const h = hostEl();
    return !!h && (el === h || h.contains(el));
  }

  function containsHost(el) {
    const h = hostEl();
    return !!h && el !== h && el.contains(h);
  }

  /** 面积保护：一屏占比过大的一定不是浮标，别乱藏 */
  function tooBig(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return true; }
    const vp = (g.innerWidth || 1) * (g.innerHeight || 1);
    return r.width * r.height > vp * 0.4;
  }

  function safeToHide(el) {
    if (!el || el.nodeType !== 1 || isOurs(el) || containsHost(el) || tooBig(el)) return false;
    if (/^(HTML|BODY|HEAD|SCRIPT|STYLE|LINK)$/.test(el.tagName)) return false;
    return true;
  }

  /* ── 隐藏 / 还原 ───────────────────────────────────────── */
  function hideOne(el) {
    if (!safeToHide(el)) return;
    if (hidden.has(el)) {
      /* 站点自己把 display 改回去了：补一次，不必重新记原值 */
      if (el.style.getPropertyValue('display') !== 'none') el.style.setProperty('display', 'none', 'important');
      return;
    }
    hidden.set(el, {
      v: el.style.getPropertyValue('display'),
      p: el.style.getPropertyPriority('display')
    });
    el.setAttribute(MARK, '1');
    el.style.setProperty('display', 'none', 'important');
  }

  function restoreAll() {
    hidden.forEach((prev, el) => {
      try {
        el.removeAttribute(MARK);
        if (prev.v) el.style.setProperty('display', prev.v, prev.p);
        else el.style.removeProperty('display');
      } catch (e) { }
    });
    hidden.clear();
  }

  /* ── 选择器规则（内置 + 附加）───────────────────────────── */
  function bySelectors(list) {
    const out = [];
    list.forEach(s => {
      let nodes;
      try { nodes = document.querySelectorAll(s); } catch (e) { return; }
      nodes.forEach(n => out.push(n));
    });
    return out;
  }

  /* ── 启发式识别 ───────────────────────────────────────── */
  function autoFind() {
    const out = [];
    const vw = g.innerWidth || document.documentElement.clientWidth || 1280;
    const vh = g.innerHeight || document.documentElement.clientHeight || 720;
    const budget = { n: SCAN_BUDGET };

    const walk = (node, depth) => {
      if (depth > 6 || budget.n <= 0) return;
      const kids = node.children;
      for (let i = 0; i < kids.length; i++) {
        if (--budget.n <= 0) return;
        const el = kids[i];
        if (el.id === 'ht-root') continue;
        if (/^(SCRIPT|STYLE|LINK|META|NOSCRIPT)$/.test(el.tagName)) continue;

        let cs;
        try { cs = g.getComputedStyle(el); } catch (e) { continue; }
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        if (cs.position === 'fixed' || cs.position === 'sticky') {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (r.width > MAX_W || r.height > MAX_H) continue;
          if (r.top < vh * 0.45) continue;                                // 只看屏幕下半部
          /* 贴左或贴右：落在左侧 1/4 或右侧 1/4 之内（左下角那个浮标就是左侧） */
          if (!(r.left < vw * 0.25 || r.right > vw * 0.75)) continue;
          const text = String(el.textContent || '').slice(0, 120);
          const media = !!el.querySelector('img, svg, canvas');
          if (AI_TEXT.test(text) || media) out.push(el);
          continue;                                                       // 命中浮标就不再往里钻
        }
        walk(el, depth + 1);
      }
    };
    walk(scope(), 0);
    return out;
  }

  /* ── 观察重渲染 ───────────────────────────────────────── */
  function stopObserver() {
    clearTimeout(scanTimer);
    scanTimer = null;
    if (mo) { try { mo.disconnect(); } catch (e) { } mo = null; }
  }

  function startObserver() {
    if (mo || !on) return;
    try {
      mo = new MutationObserver(() => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(apply, 450);
      });
      mo.observe(scope(), { childList: true, subtree: true });
    } catch (e) { mo = null; }
  }

  /**
   * 重新应用一次规则。翻页 / 重新登录 / 路由切换后调用都安全（幂等）。
   * @param {boolean} [force] 忽略启发式扫描的限流
   * @returns {{hidden:number, matched:number}}
   */
  function apply(force) {
    if (!on) { restoreAll(); stopObserver(); return { hidden: 0, matched: 0 }; }
    /* 已经不在文档里的节点，从记录里清掉，避免内存泄漏 */
    hidden.forEach((_, el) => { if (!el.isConnected) hidden.delete(el); });

    /* 第一层：内置规则 + 用户附加规则。查选择器很便宜，每次都可以跑 */
    const byRule = bySelectors(BUILTIN.concat(selectors));
    byRule.forEach(hideOne);
    if (byRule.length) {
      startObserver();
      return { hidden: hidden.size, matched: byRule.length };
    }

    /* 第二层：一条都没命中才退回启发式。它要遍历 + 逐个取计算样式，
       给个 4 秒限流，否则页面里一个每 100ms 跳动的时钟就能让它一直全量扫 */
    if (!force && Date.now() - lastAuto < 4000) {
      startObserver();
      return { hidden: hidden.size, matched: 0, throttled: true };
    }
    lastAuto = Date.now();
    const list = autoFind();
    list.forEach(hideOne);
    startObserver();
    return { hidden: hidden.size, matched: list.length };
  }

  /* ── 点选器：在页面上点一下，生成选择器 ───────────────── */
  /* 浮层放进 Shadow DOM。目标站自带 `*{box-sizing}` 和一套字体栈，
     外链 CSS 会把这层框线与提示条改形（框比目标大两三个像素那种），
     而这里画的是"你正要点哪个元素"，差几像素就看错了。
     attachShadow 自 Chrome 53 就有，清单要求 111，不存在没有的情况，
     所以不留"没有就退回内联样式"的岔路——那种兜底永远没人测。 */
  const PICK_CSS = [
    ':host{all:initial}',
    '.box{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563EB;' +
      'border-radius:6px;background:rgba(37,99,235,.10);' +
      'box-shadow:0 0 0 9999px rgba(15,23,42,.06);transition:all 90ms ease;display:none}',
    '.tip{position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);' +
      'pointer-events:none;max-width:min(560px,90vw);padding:7px 12px;border-radius:8px;' +
      'background:rgba(15,23,42,.92);color:#fff;' +
      'font:500 12px/1.5 ui-sans-serif,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei UI",sans-serif;' +
      'box-shadow:0 12px 28px -10px rgba(15,23,42,.5);white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis}'
  ].join('');
  /* 宿主自己不能挡住下面的元素：零尺寸、不吃指针事件 */
  const HOST_CSS = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none';

  function cssEscape(s) {
    try { return (g.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'); }
    catch (e) { return String(s).replace(/[^\w-]/g, '\\$&'); }
  }

  /** 尽量短、尽量稳的选择器：优先 id，其次 class 链，最后退到 nth-child */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      const sel = '#' + cssEscape(el.id);
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { }
    }
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      const tag = node.tagName.toLowerCase();
      if (node === document.body || node === document.documentElement) { parts.unshift(tag); break; }

      let sel = tag;
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        sel = '#' + cssEscape(node.id);
      } else {
        const cls = [...node.classList]
          .filter(c => /^[A-Za-z][\w-]*$/.test(c) && c.length <= 26 && !/\d{3,}/.test(c))
          .slice(0, 2);
        if (cls.length) sel += '.' + cls.map(cssEscape).join('.');
        else {
          const parent = node.parentElement;
          if (parent) sel += ':nth-child(' + ([...parent.children].indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(sel);
      const joined = parts.join(' > ');
      try { if (document.querySelectorAll(joined).length === 1) return joined; } catch (e) { }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** 从命中的小节点往上找到那个 fixed / sticky 的浮标容器 */
  function containerOf(el) {
    let node = el, best = el;
    for (let i = 0; node && node !== document.body && i < 8; i++) {
      let cs;
      try { cs = g.getComputedStyle(node); } catch (e) { break; }
      if (cs.position === 'fixed' || cs.position === 'sticky') return node;
      best = node;
      node = node.parentElement;
    }
    return best;
  }

  /**
   * 进入点选模式：鼠标移动高亮，点一下返回该元素的选择器。
   * @returns {Promise<string|null>} 取消（Esc）返回 null
   */
  function pick() {
    return new Promise(resolve => {
      if (picking) { resolve(null); return; }
      picking = true;

      const host = document.createElement('div');
      host.setAttribute('data-ht-pick', '');
      host.style.cssText = HOST_CSS;
      const sh = host.attachShadow({ mode: 'open' });
      sh.innerHTML = '<style>' + PICK_CSS + '</style>'
        + '<div class="box"></div><div class="tip"></div>';
      const box = sh.querySelector('.box');
      const tip = sh.querySelector('.tip');
      tip.textContent = '点选要隐藏的元素 · Esc 取消';

      document.body.appendChild(host);

      let target = null;

      const draw = el => {
        if (!el) { box.style.display = 'none'; target = null; return; }
        const r = el.getBoundingClientRect();
        box.style.display = 'block';
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        target = el;
        const sel = cssPath(el);
        tip.textContent = `点选要隐藏的元素 · ${sel}`.slice(0, 96) + ' · Esc 取消';
      };

      const move = e => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || isOurs(el)) { draw(null); return; }
        draw(containerOf(el));
      };

      const finish = sel => {
        cleanup();
        resolve(sel || null);
      };

      const cleanup = () => {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', key, true);
        /* 只摘宿主：里面的三个节点跟着一起走 */
        if (host.parentNode) host.parentNode.removeChild(host);
        picking = false;
      };

      const click = e => {
        e.preventDefault();
        e.stopPropagation();
        finish(target ? cssPath(target) : null);
      };

      const key = e => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      };

      document.addEventListener('pointermove', move, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
    });
  }

  /* ── 对外 ─────────────────────────────────────────────── */
  /**
   * @param {{hideSiteFab?:boolean, siteFabSelectors?:string}} cfg
   * @returns {boolean} 配置是否发生变化（变了才需要重扫）
   */  function setCfg(cfg) {
    const c = cfg || {};
    const nextOn = c.hideSiteFab === true;
    const nextSel = parseSelectors(c.siteFabSelectors);
    const changed = nextOn !== on || nextSel.join('\n') !== selectors.join('\n');
    on = nextOn;
    selectors = nextSel;
    if (changed) { lastAuto = 0; apply(true); }
    else if (on) startObserver();
    return changed;
  }

  HT.siteHider = {
    setCfg,
    apply,
    pick,
    cssPath,
    count: () => hidden.size,
    isOn: () => on
  };
})(typeof window !== 'undefined' ? window : globalThis);
