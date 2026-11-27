/**
 * src/ui/uikit.js —— 五颗控件的几何与动作（1.12.17）
 *
 * @layer  ui（表现层）
 * @file   src/ui/uikit.js
 * @since  1.12.17
 *
 * 为什么单独一个文件：
 *   （1.12.16）给设置页加了「界面」这一组，把五颗控件的手感做成了参数——
 *   分类树（branched menu）、导出菜单（glide select）、长按按钮
 *   （hold button）、日 / 周开关（rubber segment）、查询图标（status mark）。
 *   参数存在配置里，落成 CSS 变量；但其中两件事**不是**改变量就能做到的：
 *     · 查询图标的分段数、弧长要重画 SVG（几何是算出来的）；
 *     · 长按按钮要在按住的那几百毫秒里逐帧推液面（rAF）。
 *   这两件加上"把参数落成 CSS 变量"放在一起，就是一个很小的 kit。
 *   塞进 panel.js 会让那个已经 2000 行的文件再多两类职责，
 *   塞进 settings.js 则位置不对——面板标题栏也要用。
 *
 * 边界：这里**不做布局**，只把参数写成 CSS 变量；谁长什么样仍然在 panel.css。
 * 唯一自己画的东西是那个 SVG（因为圆的半径由线宽与分段数决定）。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const px = n => (Math.round(Number(n) * 100) / 100) + 'px';
  const ms = n => Math.round(Number(n)) + 'ms';
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  /* ── 分类树（设置页左侧）─────────────────────────────────
     几何参数先落到 CSS 变量上，再由 navLayout 用同一批数字算出 SVG 路径。
     为什么路径要在 JS 里算：弧的终点、竖线的长度都跟"这一组有几项"有关，
     CSS 没法按子元素个数画出 A 命令。参考实现也是这么做的（render 时算）。
     五个数（行高 / 主干 / 圆角 / 线宽 / 字号）里，前四个都进路径。 */
  function applyNav(el, nav) {
    if (!el || !nav) return;
    el.style.setProperty('--stn-row', px(nav.rowHeight));
    el.style.setProperty('--stn-trunk', px(nav.trunk));
    el.style.setProperty('--stn-r', px(nav.radius));
    el.style.setProperty('--stn-lw', px(nav.lineWidth));
    el.style.setProperty('--stn-fs', px(nav.fontSize));
    /* 变量刚写完，样式还没重算：读几何要等一帧，否则拿到的是旧行高 */
    const box = el.querySelector ? el.querySelector('.st-nav') : null;
    if (!box) return;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { navLayout(box); navSync(box); });
    } else {
      navLayout(box); navSync(box);
    }
  }

  /* 与 CSS 里 .stn-tree 的上下内边距是同一个数（6px），改一处要改两处。
     写成常量而不是读样式：读 padding 要经过 calc 与盒模型两道解析，
     这里只需要"第一行的中点在哪"。 */
  const NAV_PAD = 6;
  const NAV_MARK = 16;

  /** 从计算样式里取下这一棵树当前的四个几何量（px） */
  function navGeom(nav) {
    const cs = g.getComputedStyle ? g.getComputedStyle(nav) : null;
    const num = (name, dflt) => {
      const v = cs ? parseFloat(cs.getPropertyValue(name)) : NaN;
      return Number.isFinite(v) ? v : dflt;
    };
    const row = num('--stn-row', 30);
    const trunk = num('--stn-trunk', 12);
    /* 缩进是 calc()，自定义属性的计算值仍是 calc 文本，parseFloat 读不出来。
       改量第一个叶子按钮的左内边距——那是解析过的真实像素，
       也正好是"文字从哪里开始"。没有叶子时退回同一个公式。 */
    const probe = nav.querySelector('.stn-i');
    const indent = probe && cs
      ? (parseFloat(g.getComputedStyle(probe).paddingLeft) || trunk + 20)
      : trunk + 20;
    const r = Math.max(0, Math.min(num('--stn-r', 8), row / 2 - 2));
    /* 分支横段在文字左侧 8px 收住：贴到字上会像是"下划线" */
    const endX = Math.max(trunk + r + 2, indent - 8);
    return { row, trunk, indent, r, endX };
  }

  /** 重排每一组的分支线（折叠展开、改参数、换字号都要重排） */
  function navLayout(nav) {
    if (!nav) return;
    const gm = navGeom(nav);
    const rowY = k => NAV_PAD + k * gm.row + gm.row / 2;
    nav.querySelectorAll('.stn-tree').forEach(tree => {
      const svg = tree.querySelector('.stn-lines');
      if (!svg) return;
      const n = tree.querySelectorAll('.stn-i').length;
      const h = n ? NAV_PAD * 2 + n * gm.row : 0;
      svg.setAttribute('width', gm.indent.toFixed(1));
      svg.setAttribute('height', h.toFixed(1));
      svg.setAttribute('viewBox', '0 0 ' + gm.indent.toFixed(1) + ' ' + h.toFixed(1));
      if (!n) { svg.innerHTML = ''; return; }

      const last = rowY(n - 1);
      /* 主干只画到最后一行"折弯开始"的位置：再往下画就成了尾巴 */
      let base = '<path class="stn-ln" d="M ' + gm.trunk + ' 0 V ' + (last - gm.r) + '"></path>';
      let reach = '';
      for (let k = 0; k < n; k++) {
        const y = rowY(k);
        /* A r r 0 0 0：从 (trunk, y-r) 逆时针拐 90° 到 (trunk+r, y)，
           再横着走到 endX。sweep=0 是"向左下拐"，与参考实现一致。 */
        const d = 'M ' + gm.trunk + ' ' + (y - gm.r) +
          ' A ' + gm.r + ' ' + gm.r + ' 0 0 0 ' + (gm.trunk + gm.r) + ' ' + y +
          ' H ' + gm.endX;
        base += '<path class="stn-ln" d="' + d + '"></path>';
        /* 选中项的强调色线：同一条竖段 + 弧 + 横段，从主干顶端一路画到这一行。
           dasharray / dashoffset 用同一段长度——量真实长度要 getTotalLength，
           而这个 svg 可能还没进文档。公式见下：竖段 + 四分之一圆弧 + 横段。 */
        const len = (y - gm.r) + (Math.PI * gm.r) / 2 + (gm.endX - gm.trunk - gm.r);
        reach += '<path class="stn-reach" data-k="' + k + '" d="M ' + gm.trunk + ' 0 V ' + (y - gm.r) +
          ' A ' + gm.r + ' ' + gm.r + ' 0 0 0 ' + (gm.trunk + gm.r) + ' ' + y +
          ' H ' + gm.endX + '" stroke-dasharray="' + len.toFixed(2) +
          '" stroke-dashoffset="' + len.toFixed(2) + '"></path>';
      }
      svg.innerHTML = base + reach;
    });
  }

  /**
   * 把"当前在哪一页"同步到树上：选中项的 reach 画出来，其余收回去；
   * 导轨上的标记条滑到所在分组的标题上。
   *
   * 为什么标记条要跟着分组标题而不是选中项：参考实现就是这个分工——
   * 亮条说"你在这一组"，分支线说"具体是这一项"。两件事分开，
   * 收起一组时亮条还停在组名上，不会跟着子项一起消失。
   */
  function navSync(nav) {
    if (!nav) return;
    nav.querySelectorAll('.stn-tree').forEach(tree => {
      const items = Array.prototype.slice.call(tree.querySelectorAll('.stn-i'));
      const paths = tree.querySelectorAll('.stn-reach');
      items.forEach((it, k) => {
        const p = paths[k];
        if (!p) return;
        const len = parseFloat(p.getAttribute('stroke-dasharray')) || 0;
        p.setAttribute('stroke-dashoffset', it.classList.contains('is-on') ? '0' : String(len));
      });
    });

    const marker = nav.querySelector('.stn-marker');
    if (!marker) return;
    const on = nav.querySelector('.stn-i.is-on');
    const sec = on ? on.closest('.stn') : null;
    const head = sec ? sec.querySelector('.stn-hd') : null;
    const open = sec ? sec.getAttribute('data-open') === '1' : false;
    if (!head || !open) { marker.removeAttribute('data-on'); return; }
    /* 标记条与分组标题同在 .st-tree 里，offsetTop 是同一个坐标系；
       放在 .st-nav 上的话要额外加树的偏移，滚动时还会跟内容错位。 */
    marker.style.top = (head.offsetTop + (head.offsetHeight - NAV_MARK) / 2).toFixed(1) + 'px';
    marker.setAttribute('data-on', '');
  }

  /** 挂载：排一次、同步一次，之后靠 ResizeObserver 跟着容器变化重排 */
  function mountNav(nav) {
    if (!nav) return nav;
    navLayout(nav);
    navSync(nav);
    if (!nav.__navRO && typeof g.ResizeObserver === 'function') {
      let first = true;
      const ro = new g.ResizeObserver(() => {
        /* 第一次回调是 observe 当时那一下，几何刚排过，跳过；
           否则每次挂载都多一次无谓的重排（还会打断折叠动画）。 */
        if (first) { first = false; return; }
        navLayout(nav);
        navSync(nav);
      });
      ro.observe(nav);
      nav.__navRO = ro;
    }
    return nav;
  }


  /* ── 标题栏三颗 + 长按按钮 ────────────────────────────────
     全部落成 CSS 变量，挂在 #ht-panel 上（长按按钮在设置浮层里，
     也在 #ht-panel 之内；独立设置页则挂在 .st-body 上，由 settings.js 调）。
     时长也走变量：CSS 的 transition / animation 直接吃 var()，
     JS 里的动画则读 getComputedStyle 拿同一个值——只有一份。 */
  function applyUi(el, ui) {
    if (!el || !ui) return;
    const m = ui.menu || {}, s = ui.seg || {}, k = ui.mark || {};
    el.style.setProperty('--ui-menu-r', px(m.radius));
    el.style.setProperty('--ui-menu-w', px(m.menuWidth));
    el.style.setProperty('--ui-menu-row', px(m.rowHeight));
    el.style.setProperty('--ui-menu-glide', ms(m.glideDuration));
    el.style.setProperty('--ui-menu-pop', ms(m.popDuration));
    /* 收起时长 = 展开的 2/3（与参考实现同一个算式，别改成独立参数：
       两个数一旦各调各的，关得比开还慢，点空白处收菜单就显得迟钝） */
    el.style.setProperty('--ui-menu-pop-out', ms(Math.round((Number(m.popDuration) || 180) * 2 / 3)));
    el.style.setProperty('--ui-seg-h', px(s.size));
    el.style.setProperty('--ui-seg-r', px(s.radius));
    el.style.setProperty('--ui-seg-in', px(s.inset));
    el.style.setProperty('--ui-seg-pad', px(s.pad));
    el.style.setProperty('--ui-seg-stretch', String(s.stretch));
    el.style.setProperty('--ui-seg-squash', px(s.squash));
    el.style.setProperty('--ui-seg-speed', String(s.speed));
    el.style.setProperty('--ui-mark-size', px(k.size));
    el.style.setProperty('--ui-mark-sw', String(k.strokeWidth));
    el.style.setProperty('--ui-mark-spin', ms(k.spinDuration));
    el.style.setProperty('--ui-mark-draw', ms(k.drawDuration));
  }

  /**
   * 查询图标（1.12.17 按官网 CSS 档重做，status mark）。
   *
   * 与之前最大的不同：**只有一个圆环**。四种状态不是四个元素换着显示，
   * 而是同一个环的 dasharray 在变——
   *   静止    n 段刻度：每段占自己槽位的 30%，环整体淡到 55%
   *   查询中  一道占 arcLength 的弧，dashoffset 匀速跑，看着在转
   *   完成    一整圈（dasharray = 100 0），圈里铺一层淡底，对勾从 0 描到 1
   *   出错    同样整圈，红色，画叉
   * 为什么值得：换形不换元素，视线在点击那一刻不用重新找"刚才那颗按钮在哪"。
   *
   * 圆环给 pathLength="100"，于是所有长度都是百分数：刻度、弧长、整圈三者
   * 用同一套数表达，CSS 里也能直接写 100 0，不必知道真实周长。
   * 静止段数默认 8（参考实现的取值）；填 1 就是"满圈"。
   */
  function markSvg(mk) {
    const k = mk || {};
    const sw = clamp(Number(k.strokeWidth) || 2, 1, 3.4);
    /* viewBox 是 24：半径要把线宽扣掉，否则线会溢出视框被裁 */
    const r = 10 - sw / 2;
    const n = clamp(Math.round(Number(k.dashes) || 8), 1, 16);
    const arc = clamp(Number(k.arcLength) || 0.68, 0.15, 0.95);
    const fo = clamp(Number(k.fillOpacity) || 0, 0, 0.3);
    /* 静止每段只占 30%：太满就成了虚线圈，太空就只剩几个点 */
    const slot = 100 / n;
    const on = (slot * 0.3).toFixed(2);
    const off = (slot * 0.7).toFixed(2);
    return '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" class="ht-mark"' +
      ' style="--mk-arc:' + (arc * 100).toFixed(2) + ' ' + ((1 - arc) * 100).toFixed(2) +
      ';--mk-fill:' + fo + '">' +
      '<circle class="mk-track" cx="12" cy="12" r="' + r.toFixed(2) + '" stroke-width="' + sw +
      '" transform="rotate(-90 12 12)"></circle>' +
      '<circle class="mk-ring" cx="12" cy="12" r="' + r.toFixed(2) + '" stroke-width="' + sw +
      '" pathLength="100" stroke-dasharray="' + on + ' ' + off +
      '" transform="rotate(-90 12 12)"></circle>' +
      '<path class="mk-ck" d="M7.5 12.25 10.5 15.25 16.75 8.75" pathLength="1" stroke-width="' + sw + '"></path>' +
      '<path class="mk-x" d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" pathLength="1" stroke-width="' + sw + '"></path>' +
      '</svg>';
  }

  /* ── 长按按钮 ───────────────────────────────────────────
     按住 → 液面推满（holdTime）→ 执行一次；松手 → 按 releaseTime 退回；
     完成后停 resetAfter 再复位。

     为什么是"按住"而不是"再弹一个 confirm"：恢复默认一步清掉模板、区域与所有
     偏好，没有撤销。弹框的确认可以闭着眼连点两下过去，按住 1.3 秒不行。

     动作曲线照参考实现分两段：按住是**线性**（液面推进要与手指同步，
     用缓出会"先快后慢"，看着像卡住），松手是三次缓出（退回去要果断）。
     另外按住期间每秒真正的判断在 complete()：到点前 50ms 内不算——
     定时器可能早到一两帧，早到就"按了 0.9 秒却算 1.3 秒"，那一下很可疑。 */
  const EASE_OUT = t => 1 - Math.pow(1 - t, 3);
  const LINEAR = t => t;

  /** 一格标签：原位份 + 完成份叠在同一格里，靠 CSS 交叉淡出 */
  function holdLabel(idle, done) {
    const box = document.createElement('span');
    box.className = 'st-hold-label';
    const a = document.createElement('span');
    a.className = 'st-hold-idle';
    a.textContent = idle;
    const b = document.createElement('span');
    b.className = 'st-hold-done';
    b.textContent = done;
    box.appendChild(a);
    box.appendChild(b);
    return box;
  }

  /**
   * 把一颗普通按钮改造成"液面推满"的结构（只做一次）：
   *   pulse            完成时散开的一圈
   *   label            最上层那份字（未按下时看见的就是它）
   *   clip             裁掉超出圆角的部分
   *     fill           液面（clip-path 推）
   *       label-fill   液面上的反白字
   *     crest          波峰（mask 横向只占一条，纵向滚动）
   *       label-fill   同一份反白字，保证波形前沿的字也是反白的
   *   sr               读屏念的一句说明
   * 结构必须在 JS 里建：CSS 无法把一颗已有文字的按钮"包"成这五层。
   */
  function buildHold(el) {
    const idle = (el.textContent || '').trim() || '恢复默认';
    el.textContent = '';
    el.classList.add('st-hold');
    el.setAttribute('data-phase', 'idle');

    const pulse = document.createElement('span');
    pulse.className = 'st-hold-pulse';
    pulse.setAttribute('aria-hidden', 'true');

    const top = holdLabel(idle, '已完成');
    top.classList.add('st-hold-top');

    const clip = document.createElement('span');
    clip.className = 'st-hold-clip';
    clip.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'st-hold-fill';
    const fLabel = holdLabel(idle, '已完成');
    fLabel.classList.add('st-hold-label-fill');
    fill.appendChild(fLabel);
    const crest = document.createElement('span');
    crest.className = 'st-hold-crest';
    const cLabel = holdLabel(idle, '已完成');
    cLabel.classList.add('st-hold-label-fill');
    crest.appendChild(cLabel);
    clip.appendChild(fill);
    clip.appendChild(crest);

    const sr = document.createElement('span');
    sr.className = 'st-sr';

    el.appendChild(pulse);
    el.appendChild(top);
    el.appendChild(clip);
    el.appendChild(sr);

    const parts = { top, fill, crest, sr, idle: [], done: [] };
    el.querySelectorAll('.st-hold-idle').forEach(n => parts.idle.push(n));
    el.querySelectorAll('.st-hold-done').forEach(n => parts.done.push(n));
    el.__holdParts = parts;
    return parts;
  }

  function hold(el, o) {
    if (!el) return el;
    const opt = el.__holdOpt || (el.__holdOpt = {});
    Object.assign(opt, o || {});
    const parts = el.__holdParts || buildHold(el);

    const holdMs = Math.max(200, Number(opt.holdTime) || 1300);
    const relMs = opt.releaseTime == null ? 180 : Math.max(0, Number(opt.releaseTime));
    el.style.setProperty('--hold-r', px(opt.radius == null ? 7 : opt.radius));
    el.style.setProperty('--hold-scale', String(opt.pressScale == null ? 0.965 : opt.pressScale));
    el.style.setProperty('--hold-wave', px(opt.wave === false ? 0 : (opt.waveAmplitude == null ? 5 : opt.waveAmplitude)));
    el.style.setProperty('--hold-release', ms(relMs));
    el.style.setProperty('--hold-hold', ms(holdMs));
    /* 波浪的纵向位移按"几圈"算：时长翻倍不该让浪跑得两倍快 */
    el.style.setProperty('--hold-cycles', String(Math.round((holdMs / 1100) * 100) / 100));
    if (opt.glow === false) el.setAttribute('data-glow', 'off');
    else el.removeAttribute('data-glow');

    /* 文案三份一起换（原位 / 液面 / 波峰），否则推到一半会看见两种字 */
    const idleText = opt.label || '恢复默认';
    const doneText = opt.doneLabel || '已完成';
    parts.idle.forEach(n => { n.textContent = idleText; });
    parts.done.forEach(n => { n.textContent = doneText; });
    parts.sr.textContent = '按住不放 ' + (holdMs / 1000).toFixed(1).replace(/\.0$/, '') + ' 秒确认';

    const measure = () => {
      el.style.setProperty('--hold-w', px(el.offsetWidth));
      el.style.setProperty('--hold-h', px(el.offsetHeight));
    };
    measure();

    if (el.__holdBound) return el;
    el.__holdBound = true;

    let raf = 0;
    let timerDone = 0;
    let timerReset = 0;
    let p = 0;
    let from = 0;
    let to = 0;
    let startAt = 0;
    let phase = 'idle';
    const gesture = { id: null, t0: 0, rect: null };

    const curHold = () => Math.max(200, Number(opt.holdTime) || 1300);
    const curRel = () => (opt.releaseTime == null ? 180 : Math.max(0, Number(opt.releaseTime)));

    function apply(v) {
      p = v;
      el.style.setProperty('--hold-p', v.toFixed(4));
    }
    function go(next) {
      phase = next;
      el.setAttribute('data-phase', next);
    }
    function clearTimers() {
      clearTimeout(timerDone);
      clearTimeout(timerReset);
      timerDone = 0;
      timerReset = 0;
    }

    function drive(target, dur, ease) {
      cancelAnimationFrame(raf);
      from = p;
      to = target;
      startAt = performance.now();
      const step = now => {
        const t = dur > 0 ? Math.min(1, (now - startAt) / dur) : 1;
        apply(from + (to - from) * ease(t));
        if (t < 1) { raf = requestAnimationFrame(step); return; }
        raf = 0;
        if (to === 1) complete();
      };
      raf = requestAnimationFrame(step);
    }

    function complete() {
      if (phase !== 'holding') return;
      /* 早到的一两帧不算：按了多久是手指的事，定时器只是兜底 */
      if (performance.now() - gesture.t0 < curHold() - 50) return;
      clearTimers();
      go('done');
      if (typeof opt.onHold === 'function') opt.onHold();
      const wait = Number(opt.resetAfter);
      if (wait > 0) {
        timerReset = setTimeout(() => {
          go('idle');
          drive(0, curRel(), EASE_OUT);
          el.removeAttribute('data-input');
        }, wait);
      }
    }

    function begin() {
      if (phase !== 'idle') return false;
      gesture.rect = el.getBoundingClientRect();
      gesture.t0 = performance.now();
      go('holding');
      drive(1, curHold(), LINEAR);
      /* 兜底：rAF 被后台标签页掐掉时，时间到了照样算完成 */
      timerDone = setTimeout(complete, curHold() + 100);
      return true;
    }

    function release() {
      if (phase !== 'holding') return;
      clearTimers();
      go('idle');
      drive(0, curRel(), EASE_OUT);
    }

    function endPointer(e) {
      if (e && e.pointerId !== gesture.id) return;
      gesture.id = null;
      try {
        if (e && el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch (err) { /* 没有捕获也能收尾 */ }
      el.removeAttribute('data-input');
      release();
    }

    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.isPrimary || gesture.id !== null) return;
      if (!begin()) return;
      gesture.id = e.pointerId;
      el.setAttribute('data-input', 'pointer');
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到捕获也能按完 */ }
    });
    /* 手指 / 指针滑出按钮 10px 就算放弃：手滑一下就清空全部设置，
       比"按不满没反应"严重得多。 */
    el.addEventListener('pointermove', e => {
      if (e.pointerId !== gesture.id || !gesture.rect) return;
      const r = gesture.rect;
      const pad = 10;
      if (e.clientX < r.left - pad || e.clientX > r.right + pad ||
          e.clientY < r.top - pad || e.clientY > r.bottom + pad) endPointer(e);
    });
    el.addEventListener('pointerup', e => endPointer(e));
    el.addEventListener('pointercancel', e => endPointer(e));
    el.addEventListener('lostpointercapture', e => endPointer(e));
    el.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') endPointer(e); });

    /* 键盘：按住 Enter / 空格同样算按住，松手算放弃；Esc 立刻取消 */
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (phase === 'holding') { endPointer(null); } return; }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (e.repeat) return;
      if (!begin()) return;
      el.setAttribute('data-input', 'key');
    });
    el.addEventListener('keyup', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (el.getAttribute('data-input') === 'key') endPointer(null);
    });
    /* 切走 / 最小化时松手：回来发现"刚才一直按着"就执行了，是最坏的一种意外 */
    const cancel = () => { if (phase === 'holding') endPointer(null); };
    g.addEventListener('blur', cancel);
    if (g.document && g.document.addEventListener) {
      g.document.addEventListener('visibilitychange', () => { if (g.document.hidden) cancel(); });
    }
    el.addEventListener('contextmenu', e => e.preventDefault());
    /* 完成之后那一串 click（键盘回车会发）不该再走一遍动作 */
    el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });

    if (typeof g.ResizeObserver === 'function') {
      let first = true;
      new g.ResizeObserver(() => {
        if (first) { first = false; return; }
        measure();
      }).observe(el);
    }
    return el;
  }

  /* ── 分段开关的滑块（1.12.17 按官网 CSS 档重做，rubber segment）
     滑块不是"一个会平移的方块"，而是"铺满内区的一整条底 + 一个裁剪窗口"：
     左右两条边各自独立移动，拉长与挤压都是这两条边的事，所以中途它可以是
     任意宽度，而不是从 A 格跳到 B 格。三拍（数照抄参考实现）：
       dilate   0.19s  两条边张开到新旧两格的并集（stretch 参数决定张多少）
       handoff  0.15s  之后交给落位（在 dilate 结束前 40ms 就开始，衔接才不断）
       land            先到的边用 0.3s 弹到位；后到的边越过目标 squash 像素，
                       再用 0.16s 收回来——"橡皮"的手感全在这一次过冲上。
     滑块里的字是按钮的**副本**：底色盖住原按钮，所以那个字看起来"反了色"，
     其实是一份深色字压在强调色底上。副本跟按钮用同一套栅格，位置天然对齐。 */
  const SPRING_UI = { dur: 0.3, bounce: 0 };
  const SPRING_RELAX = { dur: 0.16, bounce: 0 };

  /** 阻尼弹簧的解析解：0 → 1。
   *  z 是阻尼比（1 = 临界阻尼，不弹）；w 选成"到时长末尾只剩千分之二"，
   *  于是 duration 仍是"多长"这个直觉数字，而不是一个玄学参数。 */
  function springK(z, w, t) {
    if (z >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  }

  function runSpring(dur, bounce, onFrame, onDone) {
    const d = Math.max(0.04, dur);
    const z = Math.min(1, Math.max(0.05, 1 - bounce));
    const w = 6 / (z * d);
    const t0 = performance.now();
    const step = now => {
      const t = (now - t0) / 1000;
      if (t >= d) { onFrame(1); if (onDone) onDone(); return; }
      onFrame(springK(z, w, t));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function slideThumb(track, thumb, toEl, animate) {
    if (!track || !thumb || !toEl) return;
    const slots = Array.prototype.slice.call(track.querySelectorAll('button'));
    const idx = slots.indexOf(toEl);
    const br = track.getBoundingClientRect();
    const tr = thumb.getBoundingClientRect();
    if (idx < 0 || !tr.width || !br.width) return;

    /* 每格在**滑块坐标系**里的左右边：滑块与按钮区是同一个盒子（都是 inset 内区），
       所以减掉滑块左上角就是格子自己的边。 */
    const rects = slots.map(b => {
      const r = b.getBoundingClientRect();
      return { l: r.left - tr.left, r: r.right - tr.left };
    });
    const target = rects[idx];
    if (!target) return;

    const cs = g.getComputedStyle ? g.getComputedStyle(track) : null;
    const num = (name, dflt) => {
      const v = cs ? parseFloat(cs.getPropertyValue(name)) : NaN;
      return Number.isFinite(v) ? v : dflt;
    };
    const stretch = Math.max(0, Math.min(160, num('--ui-seg-stretch', 100))) / 100;
    const squash = Math.max(0, num('--ui-seg-squash', 3));
    const speed = Math.max(0.1, num('--ui-seg-speed', 1));
    const radius = Math.max(0, num('--ui-seg-r', 8) - num('--ui-seg-in', 2));
    const W = tr.width;

    const cur = thumb.__edges || { l: target.l, r: target.r };
    const paint = () => {
      const l = Math.max(0, Math.min(W, cur.l));
      const rr = Math.max(0, Math.min(W, cur.r));
      thumb.style.clipPath = 'inset(0 ' + (W - rr).toFixed(2) + 'px 0 ' + l.toFixed(2) +
        'px round ' + radius.toFixed(2) + 'px)';
      thumb.__edges = cur;
    };

    /* 换项时的重入保护：上一次的 handoff 定时器与弹簧都要作废，
       否则快速连点会在中途被两条曲线抢着写同一个 clip-path。 */
    const gen = (thumb.__gen || 0) + 1;
    thumb.__gen = gen;
    clearTimeout(thumb.__timer);

    const land = () => {
      if (thumb.__gen !== gen) return;
      const dir = Math.sign((target.l + target.r) / 2 - (cur.l + cur.r) / 2) || 1;
      const lead = dir > 0 ? 'r' : 'l';
      const trail = dir > 0 ? 'l' : 'r';
      const springEdge = (edge, to, sp, then) => {
        const from = cur[edge];
        runSpring(sp.dur / speed, sp.bounce, k => {
          cur[edge] = from + (to - from) * k;
          paint();
        }, then);
      };
      springEdge(lead, target[lead], SPRING_UI);
      if (squash <= 0) { springEdge(trail, target[trail], SPRING_UI); return; }
      springEdge(trail, target[trail] + dir * squash, SPRING_UI, () => {
        if (thumb.__gen !== gen) return;
        springEdge(trail, target[trail], SPRING_RELAX);
      });
    };

    if (!animate || HT.prefersReduced() || !g.requestAnimationFrame) {
      cur.l = target.l;
      cur.r = target.r;
      paint();
      return;
    }

    /* 张开：竖着看是两条边各走各的，横着看就是"先横跨新旧两格" */
    const dil = {
      l: target.l + (Math.min(cur.l, target.l) - target.l) * stretch,
      r: target.r + (Math.max(cur.r, target.r) - target.r) * stretch
    };
    const from = { l: cur.l, r: cur.r };
    const dur = (190 / speed);
    const t0 = performance.now();
    const step = now => {
      if (thumb.__gen !== gen) return;
      const t = Math.min(1, (now - t0) / dur);
      const k = EASE_OUT(t);
      cur.l = from.l + (dil.l - from.l) * k;
      cur.r = from.r + (dil.r - from.r) * k;
      paint();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    thumb.__timer = setTimeout(land, 150 / speed);
  }

  /* ── 导出菜单的高亮块（1.12.17 重做，对应 glide select 的"选择框"那一半）
     参考实现里高亮块不跟行"一起高亮"，而是**一块独立的底**在行之间滑：
       · 位置用 transform（GPU 合成），不是每帧改 top；时长 = glideDuration
       · 透明度单独一条 150ms：指针离开时整块淡出，再进来从上次那行滑过来
       · 行自己不涂底色（否则两块底叠在一起，中间那一帧会发深）
     指针离开后回到"上一次停的那一行"（rememberPosition）：再进来时从那儿
     继续滑，而不是每次从第一行跳一下。 */
  function mountGlide(menu) {
    if (!menu || menu.__glideBox) return menu.__glideBox || null;
    const box = document.createElement('i');
    box.className = 'ht-glide';
    box.setAttribute('aria-hidden', 'true');
    menu.insertBefore(box, menu.firstChild);
    menu.__glideBox = box;

    const rows = () => Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
    let at = null;                    // 高亮块当前停在哪一行
    let rest = null;                  // 指针离开后回到哪一行

    function place(row, animate) {
      if (!row) return;
      const cs = g.getComputedStyle ? g.getComputedStyle(menu) : null;
      const glide = cs ? (parseFloat(cs.getPropertyValue('--ui-menu-glide')) || 0) : 0;
      const bt = cs ? (parseFloat(cs.borderTopWidth) || 0) : 0;
      const mr = menu.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const y = rr.top - mr.top - bt;
      box.style.height = rr.height + 'px';
      if (!animate || HT.prefersReduced() || glide <= 0) {
        /* 首次贴位必须瞬时：否则会从菜单顶端滑下来一段，看着像"菜单在掉" */
        box.style.transition = 'none';
        box.style.transform = 'translateY(' + y + 'px)';
        void box.offsetWidth;
        box.style.transition = '';
      } else {
        box.style.transform = 'translateY(' + y + 'px)';
      }
      box.classList.add('is-on');
      at = row;
    }

    menu.addEventListener('mouseover', e => {
      const row = e.target.closest ? e.target.closest('[role="menuitem"]') : null;
      if (row && row !== at) { rest = row; place(row, true); }
    });
    menu.addEventListener('mouseleave', () => {
      if (rest) place(rest, true);
    });
    menu.addEventListener('focusin', e => {
      const row = e.target.closest ? e.target.closest('[role="menuitem"]') : null;
      if (row) { rest = row; place(row, true); }
    });
    /* 菜单每次打开都要重新摆：行高与宽度都可能刚被设置改过 */
    return {
      open() {
        box.classList.remove('is-on');
        const first = rows()[0];
        if (!first) return;
        rest = first;
        place(first, false);
      },
      close() { box.classList.remove('is-on'); }
    };
  }

  Object.assign(HT, { applyNav, applyUi, markSvg, hold, slideThumb, mountGlide, mountNav, navLayout, navSync });
})(typeof window !== 'undefined' ? window : globalThis);
