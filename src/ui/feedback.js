/**
 * src/ui/feedback.js —— 诊断文本与复制
 *
 * @layer  ui（表现层）
 * @file   src/ui/feedback.js
 * @since  0.21.0
 *
 * 把 obs 里的记录拼成一段人能读、能直接发出去的文本。
 *
 * 为什么拼在这一层：
 *   版本号在 data（release.js），记录在 lib（obs.js），只有 ui 同时看得到两边；
 *   而"把事实写成一句话"本来就是表现层的事。data 不该为了拼一段给人看的
 *   文本去认识 obs，lib 更不该反过来读版本号。
 *
 * 这段文本是**唯一**会离开这台机器的东西，因此它只有三个来源：
 *   版本与通道（release.js）、运行环境（navigator）、短码与校验项名（obs）。
 *   不读模板、不读事实对象、不读存储里的配置。
 *
 * 发到哪：自建的那台轻量服务器（release.js 的 report.url），小范围自用。
 *   仍然保留「复制」——上报链路本身也会坏（没网、服务器没开），
 *   那时复制粘贴是唯一还走得通的路。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const p2 = n => String(n).padStart(2, '0');

  function stamp(t) {
    const d = new Date(t || Date.now());
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' '
      + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function fullStamp(t) {
    const d = new Date(t || Date.now());
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
      + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  /** "Chrome 131 · Windows · zh-CN"。整条 UA 太长且没有额外信息量 */
  function envLine() {
    const na = g.navigator || {};
    const ua = String(na.userAgent || '');
    const ch = (ua.match(/Chrome\/(\d+)/) || [])[1] || '';
    let os = '';
    if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Linux/.test(ua)) os = 'Linux';
    const lang = String(na.language || '');
    return [ch ? 'Chrome ' + ch : 'Chrome ?', os || '未知系统', lang]
      .filter(Boolean).join(' · ');
  }

  function pad(s, n) {
    s = String(s == null ? '' : s);
    /* 中文按两格算：这批短码与模块名全是 ASCII，但 fact 里可能混中文，
       只在 code/mod 上用，够用就行 */
    while (s.length < n) s += ' ';
    return s;
  }

  /**
   * 拼诊断文本。
   * @param {string} [extra] 当前那条错误的报障行（`短码｜数据源：事实`）
   * @returns {Promise<string>}
   */
  HT.diagText = function (extra) {
    const R = HT.RELEASE || {};
    const lines = [];
    lines.push((HT.META ? HT.META.name : '简报助手')
      + ' v' + (R.version || '?') + ' · ' + fullStamp());
    lines.push(envLine());
    if (extra) lines.push('本次：' + String(extra));
    lines.push('');

    return HT.obs.list().then(arr => {
      if (!arr.length) {
        lines.push('最近没有记录。校验不过或扩展出错时会自动留一行。');
      } else {
        lines.push('最近的自检记录（本机保存，最多 ' + HT.obs.MAX + ' 条）');
        /* 同一件事反复出现才是信号，出现一次多半是偶发。
           所以先按 code+mod+fact 合并，时间取最近的那次，次数标在行尾——
           把 18 行一模一样的 det.town 铺出来，读者还得自己数。 */
        lines.push.apply(lines, rows(arr).map(r =>
          stamp(r.t) + '  ' + pad(r.code, 14) + pad(r.mod, 10)
          + r.fact + (r.n > 1 ? '  ×' + r.n : '')));
      }
      lines.push('');
      lines.push('本机记录，不含任何警情数字。');
      return lines.join('\n');
    });
  };

  /**
   * 合并同一条。返回按最近时间倒序。
   * 设置页那一屏与这段文本共用这一个函数——两处若各写一遍合并逻辑，
   * 迟早一个改了一个没改，屏幕上有 ×3 而复制出来是三条。
   */
  function rows(arr) {
    const m = new Map();
    arr.forEach(x => {
      const k = x.code + '|' + x.mod + '|' + x.fact;
      const g = m.get(k);
      if (g) { g.n++; if (x.t > g.t) g.t = x.t; }
      else m.set(k, { t: x.t, code: x.code, mod: x.mod, fact: x.fact, n: 1 });
    });
    return Array.from(m.values()).sort((a, b) => b.t - a.t);
  }
  HT.obsRows = rows;

  /**
   * 写剪贴板。content script 里 navigator.clipboard 要页面给权限，
   * 拿不到就退回 execCommand —— 面板里那个复制按钮走的是同一套办法。
   * @returns {Promise<boolean>}
   */
  HT.copyText = async function (t) {
    try { await g.navigator.clipboard.writeText(t); return true; }
    catch (e) {
      try {
        const ta = g.document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;opacity:0';
        g.document.body.appendChild(ta);
        ta.select();
        const ok = g.document.execCommand('copy');
        g.document.body.removeChild(ta);
        return ok;
      } catch (e2) { return false; }
    }
  };

  /**
   * 存一个文件。
   *
   * 面板导出正文、设置页导出备份，两处原来各写一遍 createObjectURL → a.click →
   * revoke：除了 revoke 的延时（4000 / 1000）不同，其余逐字相同。延时这件事
   * 只有"多久之后才安全回收"一个正确答案，两份迟早会分叉（短的那份在某些
   * 机器上会把还没开始写的下载掐掉）。
   *
   * @param {string} name     文件名
   * @param {string} content  内容
   * @param {string} mime     类型
   * @param {boolean} [bom]   是否加 BOM。文本给记事本 / Excel 看时要加，
   *                          JSON 备份不能加——开头多三个字节，JSON.parse 直接报错
   */
  HT.download = function (name, content, mime, bom) {
    const blob = new Blob([(bom ? '\ufeff' : '') + content], { type: mime });
    const a = g.document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    g.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  /* 动作完成的回执图标在 HT.ICON（src/ui/dom.js）里：tick / bang。
     这里原本是两个内联常量，与面板那份图标表各写各的——
     同一个对勾在两处能画出两种线宽。 */

  /**
   * 按钮上做一次瞬时回执。原来的写法只改 btn.title —— 原生 tooltip 要**悬停**
   * 才出来，点完按钮人根本看不见，等于复制了也没反馈。现在同时改三样：
   * 图标临时换成对勾 / 叹号、按钮变绿或变红、2.5 秒后淡出换回。
   *
   * 为什么是 2.5 秒而不是 1.3 秒：1.3 秒刚够"看见"，不够"确认"——手还在移动、
   * 眼睛还在原处，回执已经没了。2.5 秒覆盖了"点完→移动视线→看见→放下心"这一整段。
   * 为什么先淡出再换图：对勾与原图标尺寸不同，直接换是**跳变**；先用 160ms
   * 淡到 25%，换图那一下藏在过渡里，视觉上只有"绿的在退、原来的回来"。
   *
   * @param {Element} btn 触发这次回执的按钮
   * @param {string} text 回执文字（同时写进 title）
   * @param {boolean} [ok] 成功/失败；不给当成功
   */
  HT.flashBtn = function (btn, text, ok) {
    if (!btn) return;
    const good = ok !== false;
    /* 第一次点的时候把原图标和原标题存下来，之后每次复位都用这一份 ——
       连点两下时若拿当前 innerHTML 当"原样"，存下来的就成了对勾自己。 */
    const icon0 = btn.__icon0 || (btn.__icon0 = btn.innerHTML);
    const title0 = btn.__title0 || (btn.__title0 = btn.title);
    btn.innerHTML = good ? HT.ICON.tick : HT.ICON.bang;
    btn.title = text;
    btn.classList.remove('ok', 'bad', 'is-fading');
    btn.classList.add(good ? 'ok' : 'bad');
    clearTimeout(btn.__t);
    clearTimeout(btn.__t2);
    btn.__t = setTimeout(() => {
      /* 先淡下去（160ms），再换回原样。两个 timer 都要清，
         否则连点时前一次的换图会把后一次的对勾抹掉。 */
      btn.classList.add('is-fading');
      btn.__t2 = setTimeout(() => {
        btn.innerHTML = icon0;
        btn.title = title0;
        btn.classList.remove('ok', 'bad', 'is-fading');
      }, 160);
    }, 2500);
  };

  /**
   * 覆盖层（设置 / 问答）的进出。
   *
   * 状态有两份：`hidden` 属性管布局，`is-in` / `is-out` 类管观感。
   * 两份都要——只改 `hidden` 就是硬切（1.9.0 之前的样子：点齿轮像换了一屏）；
   * 只改类，收起后那块东西还在无障碍树与命中区里（校验区折叠踩过同一个坑，
   * 当时是 15 个不可见的校验项被 Tab 逐条走了一遍）。
   *
   * 为什么用动画而不是 transition：默认态必须是"看得见"。用 transition 就得让
   * 基态是 opacity:0、再加类变 1，那么任何一条"只把 hidden 摘掉"的旧路径
   * 都会得到一块**透明但仍吃点击**的浮层——最难查的那种 bug。
   * 动画只在加上类的这 200ms 里生效，类没了就回到可见，失败方向是安全的那一头。
   *
   * @param {Element} el  浮层根（.ht-set / .ht-faq）
   * @param {number} [exitMs] 退出时长，要与 CSS 的 ht-veil-out 一致
   */
  HT.veil = function (el, exitMs) {
    const EXIT = exitMs || 130;
    let t = 0;
    return {
      show() {
        clearTimeout(t);
        el.classList.remove('is-out');
        el.hidden = false;
        /* 同名动画不会自己重放：摘掉类、读一次布局把旧状态冲掉，再加回来。
           直接加法（不加 reflow）在"关一半又打开"时会看到块是定住的。 */
        el.classList.remove('is-in');
        void el.offsetWidth;
        el.classList.add('is-in');
      },
      hide(done) {
        if (el.hidden) { if (done) done(); return; }
        clearTimeout(t);
        el.classList.remove('is-in');
        el.classList.add('is-out');
        /* 比动画多留 20ms：宁可晚一帧收起，也不要在动画最后 3px 上掐断 */
        t = setTimeout(() => {
          el.hidden = true;
          el.classList.remove('is-out');
          if (done) done();
        }, EXIT + 20);
      }
    };
  };

  /**
   * 上报诊断。**不问，直接发**。
   *
   * 为什么不弹确认：要发的内容就是这一份——短码、模块名、校验项名、版本、环境，
   * 里面没有一个记录数字。它本来就允许随手截图，多一步确认只会让人少报一次，
   * 等到真出问题时手里什么都没有。
   *
   * 请求必须由 background 发出：content script 的 fetch 走页面 origin，
   * 会被站点的 connect-src CSP 拦掉，失败时只有一句 Failed to fetch。
   *
   * @param {string} [extra] 本次那条报障行
   * @param {string} [kind]  'auto' 出错时自动 / 'manual' 人点的
   * @returns {Promise<{ok:boolean, why?:string, at?:number}>} 永远 resolve，不 reject
   */
  HT.diagSend = function (extra, kind) {
    const R = (HT.RELEASE || {}).report || {};
    if (!R.enabled) return Promise.resolve({ ok: false, why: 'off' });
    return HT.diagText(extra).then(text => new Promise(res => {
      try {
        g.chrome.runtime.sendMessage(
          { type: 'diagSend', text: text, kind: kind || 'auto' },
          r => {
            /* 没有页面在听 / 后台刚被回收：读一下 lastError 消掉噪音 */
            if (g.chrome.runtime.lastError || !r) return res({ ok: false, why: 'nobg' });
            res(r);
          });
      } catch (e) { res({ ok: false, why: 'nobg' }); }
    })).catch(() => ({ ok: false, why: 'build' }));
  };
})(typeof window !== 'undefined' ? window : globalThis);
