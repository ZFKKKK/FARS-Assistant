/**
 * debug/files.js —— 源码加载顺序（唯一来源）
 *
 * manifest.json 的 content_scripts.js 必须与本文件的 ALL 完全一致、顺序一致，
 * 自检脚本 会逐项比对，改分层时不要只改一边。
 *
 * 分层：lib（纯函数） → data（取数与配置） → domain（业务规则） → ui（表现）
 */
const CORE = [
  'src/lib/util.js',             // 数字 / 文本 / 分组计数（原 number+text+collection）
  'src/lib/obs.js',              // 观测缓冲；只收不发，不依赖任何一层
  'src/lib/req.js',              // 一次 JSON 请求（超时/解析/四类失败）；release 与 cloud 共用
  'src/data/errors.js',          // 必须在 config / http / 校验之前：它们都靠它造错
  'src/data/release.js',         // 版本与更新策略；config 的 META 从它取值
  'src/data/contract.js',        // 站点契约（地址/参数/列下标）；http 与校验都靠它
  'src/data/config.js',
  'src/data/cloud.js',              // 云端配置同步；设置页的「云端」一组靠它，不参与出稿
  'src/data/settings-schema.js',  // 设置页结构声明；settings.js 与 verify 都读它
  'src/data/window.js',
  'src/data/cas-last.js',        // 2025 年有效条目的补录前月度数（同比分母的特例）
  'src/data/faq.js',
  'src/data/http.js',
  'src/domain/render.js',        // 字段取值与占位符渲染（原 fields+template）
  'src/domain/segments.js',
  'src/domain/phrases.js',
  'src/domain/checks.js',        // 形状体检 + 数字互校（原 schema+checks）
  'src/domain/report.js'
];

const UI = [
  'src/ui/geom.js',              // 面板落位的几何口径；panel.js 依赖，必须最先
  'src/ui/dom.js',               // 令牌与 DOM 小工具（原 tokens+dom）
  'src/ui/feedback.js',          // 诊断文本与复制；panel 的错误按钮与设置页共用
  'src/ui/editor.js',            // 模板正文编辑器（列表 / 光标 / chip / 三级级联）
  'src/ui/sections.js',          // 段落列表 / 专注 / 折叠；panel.js 只留壳
  'src/ui/faq.js',               // 问答浮层；互斥只写在 open() 一处
  'src/ui/checks.js',            // 校验栏；缓存/筛选/展开三态自己持有
  'src/ui/settings.js',
  'src/ui/panel.js',
  'src/ui/sitehider.js',
  'src/ui/nav.js'                // 顶部「数据」入口 + 挂载入口（原 fab+entry，必须排最后）
];

module.exports = { CORE, UI, ALL: CORE.concat(UI) };
