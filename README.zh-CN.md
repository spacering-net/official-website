# spacering.net

[English](README.md) | 简体中文

SpaceRing（网络空间戒指）官网。大部分页面由 Astro 静态构建，3D 场景用 three.js。同一个 Cloudflare Worker 负责提供这些页面、`/api` 下的接口（登录用 Hono 和 Better Auth，数据在 D1，头像在 R2）、用户选择分享的戒指卡片（每张一个页面，外加一张用于链接预览的图片，由 Worker 用 resvg 和 MozJPEG 渲染），以及 Harness：技能、MCP 服务等能力的市场。Harness 的页面由 Worker 按需渲染，数据在它自己的 D1 数据库和 R2 存储桶里，导入走 Cloudflare Queues。

## 开发

需要 Node 22.12+ 和 pnpm。

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 第一次：填 BETTER_AUTH_SECRET
pnpm db:migrate                  # 第一次及每次新增迁移后：本地 D1 建表
pnpm dev        # http://localhost:4321 ，中文版 /zh/；Worker 和 /api 也在里面运行
pnpm build      # 网站输出到 dist/client，Worker 输出到 dist/server
pnpm preview    # 本地预览构建结果，包括 Worker
pnpm check      # 类型检查（网站与 Worker）
pnpm test       # 单元测试：Harness、戒指卡片
```

Harness 的导入按计划任务运行。本地手动触发（队列在开发服务器里运行）：每小时的注册表同步用 `curl 'http://localhost:4321/cdn-cgi/handler/scheduled?cron=17+*+*+*+*'`，每天的任务（技能仓库、星标、计数）用 `cron=23+3+*+*+*`。`.dev.vars` 里放一个 `GITHUB_TOKEN` 可以提高 GitHub 的额度，星标也要靠它刷新：细粒度令牌的仓库访问选「Public repositories」（只读），不加任何权限就够了。

## 常改的地方

| 想改什么 | 文件 |
| --- | --- |
| 中英文案、产品名、示例助手的名字 | `src/i18n/index.ts` |
| 各幕的投影示意 | `src/components/holo/` |
| 空间、助手与开源三个页面：文案、配图与概念预览、共用的版块 | `src/i18n/pages.ts`、`src/components/product/`、`src/layouts/Product.astro` 和 `src/styles/product.css`；`src/client/product.ts` 负责概念预览的展开，以及配图移出屏幕时暂停 |
| 仓库、文档地址，统计兜底值 | `src/config.ts` |
| 色板、字号、间距 | `src/styles/site.css` 顶部变量 |
| 戒指尺寸、材质与戒身脉络 | `src/client/scene/ring.ts` |
| 星环粒子 | `src/client/scene/disk.ts` |
| 开场节奏 | `src/client/intro.ts` |
| 每幕戒指的位置 | `src/client/chapters.ts` 的 `layouts()` |
| 登录、会话、戒指编号 | `api/auth.ts`、`api/ring-number.ts` |
| 数据库表结构 | `db/migrations/` 和 Harness 的 `db/harness/`（只增不改；推送前先运行 `pnpm db:migrate:remote`） |
| Harness 的导入、检查、搜索和接口 | `api/harness/`（接口的数据结构在 `api/harness/schemas.ts`，发布在 `/api/harness/v1/openapi.json`） |
| Harness 的页面和文案 | `src/pages/[...lang]/harness/`、`src/components/harness/`、`src/i18n/harness.ts` |
| 首页以外所有页面的外壳（HUD、菜单、登录、页脚；同一栏宽，`--page-max`） | `src/layouts/Page.astro`、`src/client/page.ts` |
| 所有页面的深浅色：浅色色板、切换按钮、首帧前套用所选外观、页面内即时切换 | `src/styles/site.css` 里的 `:root[data-theme='light']`（首页的面板在 `src/styles/home.css`）、`src/components/ThemeSwitch.astro`、`src/client/theme.js`、`src/client/theme-switch.ts` |
| 首页场景的白天版：白色影棚里的银色戒指，光变成纸上的墨 | `src/client/scene/ink.ts`、`src/client/scene/stage.ts` 的 `setDay()`、`src/client/scene/environment.ts` 的 `createEnvironment()` |
| 发布者头像（GitHub 头像、网站图标；存在 R2，每日任务每 30 天重新查找一次） | `api/harness/importers/avatars.ts`、`src/components/harness/Avatar.astro` |
| HUD 链接的页面（空间、助手、Harness、开源；「戒指」回到首页），空间、助手和 Harness 的首页章节末尾也有按钮通往各自的页面。菜单里没有页面的产品仍是首页的章节 | `src/i18n/index.ts` 里的 `PAGES` |
| 404 页，分语言（`404.html`、`zh/404.html`；Harness 里不存在的地址也用它） | `src/components/NotFound.astro`、`src/pages/404.astro`、`src/pages/zh/404.astro` |
| 戒身内壁的刻字 | `src/client/scene/ring.ts` 的 `inscribe()`，`src/client/account.ts` |
| 戒指卡片的画面：账号对话框的预览、卡片页面和卡片图片共用同一份 SVG | `src/lib/ring-card.ts` |
| 戒指卡片的分享、图片和页面，以及对话框里的卡片视图 | `api/rings/`、`src/pages/[...lang]/ring/`、`src/client/card.ts` |
| 戒指卡片的背景图、刻字与字体（改动后把 `src/lib/ring-card.ts` 里的 `CARD_REVISION` 加一） | `public/ring-card/` 和 `src/lib/ring-card-still.ts`：`node scripts/ring-card-art.mjs` 从首页的 3D 场景截取（需先运行 `pnpm dev`），字体由 `node --import ./tests/harness/register.mjs scripts/ring-card-fonts.mjs` 下载 |

Harness 规则检查的具体规则放在数据库里，不在本仓库。新建的数据库里没有规则，只做内置的检查。

## 调试参数

- `?quality=high|medium|low`：强制画质档位。
- `?off=bloom,nebula,corona,disk,glow,stars,iri,final,ring`：关闭单项效果，用于排查性能。
- `?capture`：隐藏界面元素，用于生成分享图。

## 视觉检查脚本

脚本用 Playwright 驱动本机 Chrome，先运行 `pnpm build && pnpm preview`。截图保存在 `shots/`（已忽略）。

```bash
pnpm qa:shots   # 开场与各幕截图（桌面）
pnpm qa:modes   # 无 WebGL、减少动态效果、键盘焦点
pnpm qa:nav     # 深链接、焦点、刻度盘、顶部导航的当前页（首页无论哪一章都是戒指），它和章节按钮打开的页面，语言切换
pnpm qa:jump    # 跨幕跳转只投射起点和终点
pnpm qa:switch  # 语言切换接力：同一幕、不重播开场、画面不闪
pnpm qa:menu    # 矮屏菜单可滚动、背景锁定、Esc 与焦点归还；展开时场景暂停、不用实时模糊
pnpm qa:fit     # 各尺寸下面板是否完整落在 HUD 与屏幕底边之间
pnpm qa:pages   # 首页以外的页面：共用的 HUD、菜单与登录，滚动时吸顶的部分，Harness 的页内搜索与筛选，对齐的边线，浅色模式（含首页），产品页的配图与概念预览
pnpm qa:perf    # 帧时间（1 倍与 2 倍像素比）
pnpm og         # 重新生成分享图，之后转成 public/og.jpg 与 og-zh.jpg
```

## 品牌素材

`logo/` 下是标志源文件与构造图。favicon 来自同一组路径。

## 许可证

代码以 MIT 协议开源，见 [LICENSE](LICENSE)。SpaceRing 的名称与标志（`logo/`、站点图标、分享图和戒指卡片的背景图）不在授权范围内。`public/ring-card/fonts/` 里的字体采用 SIL Open Font License（见同目录的 `OFL-*.txt`）。
