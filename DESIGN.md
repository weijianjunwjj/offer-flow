---
name: OfferFlow
description: 决策操作系统 — 理性、克制、可解释的求职决策驾驶舱
colors:
  primary: "#2563eb"
  primary-hover: "#3b82f6"
  primary-pressed: "#1d4ed8"
  neutral-bg: "#f6f8fc"
  neutral-surface: "#ffffff"
  neutral-ink: "#0f172a"
  neutral-ink-2: "#475569"
  neutral-muted: "#94a3b8"
  neutral-line: "rgba(15, 23, 42, 0.08)"
  success: "#166534"
  success-bg: "#dcfce7"
  danger: "#991b1b"
  danger-bg: "#fee2e2"
  warning: "#92400e"
  warning-bg: "#fef3c7"
  info: "#0e7490"
  info-bg: "#cffafe"
  highlight: "#3730a3"
  highlight-bg: "#eef2ff"
  neutral-tag-bg: "#eef1f5"
  neutral-tag-text: "#475569"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.2
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.05em"
rounded:
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-pressed}"
  card:
    backgroundColor: "{colors.neutral-surface}"
    rounded: "{rounded.xl}"
    padding: "16px 18px"
  tag-neutral:
    backgroundColor: "{colors.neutral-tag-bg}"
    textColor: "{colors.neutral-tag-text}"
    rounded: "{rounded.pill}"
    padding: "4px 11px"
---

# Design System: OfferFlow

## Overview

**Creative North Star: "Decision Operating System"（决策操作系统）**

OfferFlow 不是求职记录工具,而是帮助用户做出更好职业决策的分析驾驶舱。每个页面都在回答三个问题:当前发生了什么、为什么会这样(证据是什么)、下一步最值得做什么。AI 负责分析、归纳和量化风险,但不替用户下最终判断——正式记录和现实行动始终由用户确认。

整体气质是专业、克制、理性、可信,参照 Linear、GitHub、Stripe Dashboard、Vercel Dashboard 的设计语言,而不是招聘网站的营销感或聊天机器人的对话感。信息密度优先于视觉效果,用户需要能连续工作数小时而不产生视觉疲劳。颜色承担语义(状态、风险等级),不作装饰;动画(若使用)只服务于状态变化的理解,不用来吸引注意力。

明确拒绝:社交媒体式设计、游戏化激励、炫技动画、AI 魔法感、大面积渐变、无意义装饰、情绪化表达。

**Key Characteristics:**
- 理性优先于表现:每个视觉决策服务于信息传达
- 高密度但不拥挤:紧凑排版配合克制的留白节奏
- 语义色而非装饰色:状态、风险、动作各自有固定色彩语言
- 扁平为主,阴影表状态:深度只在需要强调层级时出现
- 渐进披露:核心结论先行,证据和细节按需展开

## Colors

调色板以单一决策蓝为核心强调色,搭配冷灰中性色系承载绝大部分界面,状态色严格限定在标记场景使用。

### Primary
- **决策蓝 / Decisive Blue** (`#2563eb`): 唯一的品牌强调色,用于主按钮、当前选中态、品牌标识、焦点环和关键数字。`primaryColorHover` 用 `#3b82f6`,`primaryColorPressed` 用 `#1d4ed8`。

### Neutral
- **石墨黑 / Ink** (`#0f172a`): 正文标题、主要文本颜色。
- **烟灰 / Ink Secondary** (`#475569`): 次要文本、说明性文字、标签文本。
- **雾灰 / Muted** (`#94a3b8`): 占位文本、极弱化的辅助信息。
- **云雾背景 / Cloud Background** (`#f6f8fc`): 页面级背景色,`html/body/#app` 的默认底色。
- **纯白卡片 / Card White** (`#ffffff`): 卡片、模态框、输入框的表面色。
- **描边灰 / Hairline** (`rgba(15, 23, 42, 0.08)`): 卡片边框、分隔线,极轻,不抢视觉焦点。
- **中性徽标底 / Neutral Tag** (`#eef1f5` 底 / `#475569` 字): 弱状态、默认态标签的底色和文字色组合。

### Semantic Status Colors
状态色成对出现(浅底 + 深字),用于岗位机会等级、投递策略、动作建议等标记场景,不用于装饰。

- **成功绿 / Success Green** (`#dcfce7` 底 / `#166534` 字): 强机会、已推进、正向反馈。
- **危险红 / Danger Red** (`#fee2e2` 底 / `#991b1b` 字): 止损、拒绝、需要立即关注的负面状态。
- **警示黄 / Warning Amber** (`#fef3c7` 底 / `#92400e` 字): 观察中、待处理、需要谨慎对待。
- **信息青 / Info Cyan** (`#cffafe` 底 / `#0e7490` 字): 低成本试探、中性提示、辅助性信息。
- **强调蓝紫 / Highlight Indigo** (`#eef2ff` 底 / `#3730a3` 字): 待复核、准备面试等需要单独标记但非常规状态色的场景。

### Named Rules
**The One Accent Rule.** 决策蓝是唯一的品牌强调色,不引入第二个品牌色;`--of-brand-2 (#0ea5e9)` 仅用于装饰性渐变/图表点缀,不作为可点击元素的主色。
**The Semantic-Only Rule.** 五组状态色只用于传达状态语义(风险等级、动作类型),禁止用作纯装饰配色。

## Typography

**Display / Body / Label Font:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif`(系统字体栈,中英文混排一致)

**Character:** 全系统统一使用系统默认字体,不引入自定义 Web Font。字重和字号承担层级区分的全部职责,克制、可靠、无装饰性字符。

### Hierarchy
- **Display**(700, `30px`, line-height 1.2):页面级 Hero 数字与核心指标(如页面顶部大号数据卡)。
- **Headline**(700, `22px`, line-height 1.3):页面主标题(如「岗位台账」)。
- **Title**(600, `16px`, line-height 1.4):区块标题、卡片标题。
- **Body**(400, `13px`, line-height 1.5):正文、说明文字、表格内容,系统内最常用字号。
- **Label**(600, `12px`, letter-spacing `0.05em`):徽标、标签、eyebrow 小标签,常见搭配 `#2563eb` 强调色。

### Named Rules
**The Density-First Rule.** 默认正文字号为 13px 而非常见的 14-16px,优先信息密度;不要为追求"呼吸感"随意放大正文字号。

## Layout

页面容器最大宽度 `1212px`(`--of-content-max-width`),居中,内边距 `24px`。核心内容区块普遍采用 12-16px 的模块间距(`gap`),小型内联元素(徽标、图标+文字)使用 4-8px 紧凑间距。

响应式断点集中在 `560px`、`620px`、`720px`、`860px`,超过阈值时多列网格(如 `repeat(3, minmax(0, 1fr))`)收缩为单列;不追求复杂的多级断点体系。

Hero 区块(页面顶部介绍卡)常用 `padding: 28px` 的宽松内边距,搭配渐变背景(如 `linear-gradient(135deg, #fff, #f0f7ff)`)与常规卡片区分层级;普通卡片使用 `16px 18px` 的紧凑内边距。

## Elevation & Depth

系统整体扁平化,大部分表面(标签、区块、次级容器)无阴影,依赖背景色块(`#f1f3f6`、`#eef1f5` 等)和描边(`--of-line`)区分层级。阴影只在两类场景出现:承载主要内容的卡片容器(表明"这是一张可交互的卡片")、以及需要状态强调的元素(聚焦环、悬浮态)。

### Shadow Vocabulary
- **卡片阴影 / Card Shadow**(`--of-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 18px 40px -28px rgba(16, 24, 40, 0.22)`):默认卡片容器的静态阴影,双层阴影模拟柔和漂浮感,不锐利。
- **聚焦环 / Focus Ring**(`box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12)`):输入框聚焦态,用决策蓝的低透明度光晕表达"当前激活"。
- **弹层重阴影 / Overlay Shadow**(`box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28)`):模态框、下拉面板等浮层,阴影明显加重以从背景中"抬起"。

### Named Rules
**The Flat-By-Default Rule.** 静态展示元素(标签、次级容器、列表行)不使用阴影,阴影只出现在卡片级容器或响应状态变化(聚焦、浮层)时。

## Shapes

圆角策略分三档:小型交互元素(按钮、输入框)用 `8-10px`;卡片级容器用 `14-16px`(`--of-radius: 16px` 为系统默认卡片圆角);徽标、标签、圆形头像用 `999px`(胶囊状)或 `50%`(圆形)。不使用直角(0 圆角),也不使用超大圆角(>16px)营造"玩具感"。

边框统一使用 `1px solid var(--of-line)`(极轻描边),不使用粗边框或强调色边框作为默认状态,仅在选中/激活态用决策蓝描边(如 `rgba(37, 99, 235, 0.35-0.45)`)。

## Components

组件整体手感克制可靠(refined and restrained):功能清晰、状态明确,但不过度设计。naive-ui 作为基础组件库,项目级 `themeOverrides` 统一覆盖主色和圆角;自定义组件遵循同一套 token。

### Buttons
- **Shape:** 圆角 8-9px(小型交互标准值)。
- **Primary:** 背景 `#2563eb`,文字白色,内边距 `9px 16px`,字重 600,字号 14px。
- **Hover / Focus:** hover 加深至 `#1d4ed8`;无过渡动画时也应有明显的背景色变化,让点击反馈清晰但不花哨。
- **Ghost / Secondary:** 使用 naive-ui 默认次级按钮样式,不单独定制视觉语言。

### Chips / Badges
- **Style:** 胶囊形(`border-radius: 999px`),内边距 `4px 11px`,字号 12px,字重 600。
- **State:** 语义色徽标(`tone-strong/good/watch/caution/weak`)按机会等级或动作类型着色,颜色对照见 Colors 章节;中性态使用 `#eef1f5` 底 + `#475569` 字。

### Cards / Containers
- **Corner Style:** `16px`(`--of-radius`)。
- **Background:** `#ffffff`,Hero 卡片可用浅蓝渐变(`linear-gradient(135deg, #fff, #f0f7ff)`)区分层级。
- **Shadow Strategy:** 见 Elevation & Depth 的卡片阴影(`--of-shadow`)。
- **Border:** `1px solid var(--of-line)`。
- **Internal Padding:** 常规卡片 `16px 18px`,Hero 卡片 `28px`。

### Inputs / Fields
- **Style:** `1px solid var(--of-line)` 描边,圆角 8-10px,背景白色。
- **Focus:** 聚焦环 `box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12)`,不改变边框粗细。
- **Error:** 背景 `#fdecec`,文字 `#a4262c`(表单级错误提示条,与状态徽标的危险红 `#991b1b/#fee2e2` 为同一语义但不同具体取值,两者均已在用,不强行统一)。

### Navigation
顶部导航为扁平化文字链接式导航,当前选中项用决策蓝高亮,无下拉阴影或强烈视觉分隔;移动端未见专门的折叠导航模式,遵循内容自然换行。

## Do's and Don'ts

### Do:
- **Do** 把决策蓝(`#2563eb`)限制在按钮、选中态、强调文字和图表主色,不作为大面积背景。
- **Do** 状态和结果始终通过语义色徽标传达(成功绿/危险红/警示黄/信息青/强调紫),而不是仅靠文案。
- **Do** 卡片和容器保持扁平,阴影仅用于可交互元素的静止态弱阴影(`--of-shadow`)或聚焦态高亮环。
- **Do** 数据密集页面(战场页、岗位台账)优先信息密度和可扫描性,用 12-13px 正文字号和紧凑间距。
- **Do** 表单、聚焦、错误态使用统一的 `rgba(37, 99, 235, 0.12)` 聚焦环和克制的错误提示配色。

### Don't:
- **Don't** 引入大面积渐变、玻璃拟态、强投影或任何"AI 魔法感"视觉效果。
- **Don't** 使用游戏化元素(徽章解锁动画、进度条庆祝效果、彩纸动画等)。
- **Don't** 用聊天气泡、圆形头像串、社交动态流等社交媒体式布局呈现决策信息。
- **Don't** 为吸引注意力添加装饰性动画;动画只能用于状态变化的过渡(如展开/折叠、加载态)。
- **Don't** 混用多套圆角体系;卡片统一 16px,小型交互元素统一 8-10px,标签统一胶囊形。

