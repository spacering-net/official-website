# spacering.net

[English](README.md) | 简体中文

SpaceRing（网络空间戒指）官网。页面由 Astro 静态构建，3D 场景用 three.js；登录与用户数据由同一个 Cloudflare Worker 提供（Hono + Better Auth，数据在 D1，头像在 R2）。

## 开发

需要 Node 22.12+ 和 pnpm。

```bash
pnpm install
pnpm dev        # http://localhost:4321 ，中文版 /zh/
pnpm build      # 输出静态站点到 dist/
pnpm preview    # 本地预览 dist/
pnpm check      # 类型检查（网站与 Worker）
```

登录和 `/api` 由 Worker 提供，本地另开一个终端：

```bash
cp .dev.vars.example .dev.vars   # 第一次：填 BETTER_AUTH_SECRET
pnpm db:migrate                  # 第一次及每次新增迁移后：本地 D1 建表
pnpm dev:api                     # :8787；pnpm dev 会把 /api 转发过去
```

## 常改的地方

| 想改什么 | 文件 |
| --- | --- |
| 中英文案、产品名、示例助手的名字 | `src/i18n/index.ts` |
| 各幕的投影示意 | `src/components/holo/` |
| 仓库、文档地址，统计兜底值 | `src/config.ts` |
| 色板、字号、间距 | `src/styles/global.css` 顶部变量 |
| 戒指尺寸、材质与戒身脉络 | `src/client/scene/ring.ts` |
| 星环粒子 | `src/client/scene/disk.ts` |
| 开场节奏 | `src/client/intro.ts` |
| 每幕戒指的位置 | `src/client/chapters.ts` 的 `layouts()` |
| 登录、会话、戒指编号 | `api/auth.ts`、`api/ring-number.ts` |
| 数据库表结构 | `db/migrations/`（只增不改；推送前先运行 `pnpm db:migrate:remote`） |
| 戒身内壁的刻字 | `src/client/scene/ring.ts` 的 `inscribe()`，`src/client/account.ts` |

## 调试参数

- `?quality=high|medium|low`：强制画质档位。
- `?off=bloom,nebula,corona,disk,glow,stars,iri,final,ring`：关闭单项效果，用于排查性能。
- `?capture`：隐藏界面元素，用于生成分享图。

## 视觉检查脚本

脚本用 Playwright 驱动本机 Chrome，先运行 `pnpm build && pnpm preview`。截图保存在 `shots/`（已忽略）。

```bash
pnpm qa:shots   # 开场与各幕截图（桌面）
pnpm qa:modes   # 无 WebGL、减少动态效果、键盘焦点
pnpm qa:nav     # 深链接、焦点、刻度盘、顶部导航高亮、语言切换
pnpm qa:jump    # 跨幕跳转只投射起点和终点
pnpm qa:switch  # 语言切换接力：同一幕、不重播开场、画面不闪
pnpm qa:menu    # 矮屏菜单可滚动、背景锁定、Esc 与焦点归还；展开时场景暂停、不用实时模糊
pnpm qa:fit     # 各尺寸下面板是否完整落在 HUD 与屏幕底边之间
pnpm qa:perf    # 帧时间（1 倍与 2 倍像素比）
pnpm og         # 重新生成分享图，之后转成 public/og.jpg 与 og-zh.jpg
```

## 品牌素材

`logo/` 下是标志源文件与构造图。favicon 来自同一组路径。

## 许可证

代码以 MIT 协议开源，见 [LICENSE](LICENSE)。SpaceRing 的名称与标志（`logo/`、站点图标和分享图）不在授权范围内。
