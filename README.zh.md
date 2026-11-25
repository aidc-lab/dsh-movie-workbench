[English](README.md) | **简体中文**

# dsh-movie-workbench

DSH **影视工作台**：在一个页面里检索 **TMDB**、**IMDb** 和 **豆瓣** 的电影与剧集，自动发现 BT 资源。

| ![alt text](https://raw.githubusercontent.com/aidc-lab/dsh-movie-workbench/main/docs/home.png) | ![alt text](https://raw.githubusercontent.com/aidc-lab/dsh-movie-workbench/main/docs/detail.png)  |
|------|------|

## 功能

- **多源搜索** — 同时检索 TMDB、IMDb 和豆瓣，结果按来源分组。
- **热门与渠道浏览** — 首页热门行，以及各来源的渠道页、分类标签和无限加载。
- **豆瓣榜单** — 电影与剧集的官方、年度和类型榜单，以及电影冷门佳作。
- **详情页** — 简介、元数据、相关作品与榜单收录。
- **BT 资源** — 搜索、排序、复制磁力链接和打开来源页。
- **AI 选资源** — 用 Profile 模型为 BT 资源排序，可选偏好并编辑提示词。
- **设置** — 在一个对话框里管理数据源、TMDB API Key 和默认模型。

## 安装

### 通过插件页面

直接将插件的GitHub仓库地址 `https://github.com/aidc-lab/dsh-movie-workbench.git` 拷贝到输入框中，如下图。

![alt text](https://raw.githubusercontent.com/aidc-lab/dsh-movie-workbench/main/docs/install.png)

### 通过命令行

`dsh plugin` 与插件页面做的是同一件事：把包装进 profile 依赖并注册 bundle。运行前请
先完全退出 DSH Desktop（`desktop` profile 由应用初始化，运行期间不能被占用），并确保
`pnpm` 在 `PATH` 中。

```bash
npm install -g @deepseek-ai/dsh      # 提供 dsh 命令
dsh plugin --profile desktop add dsh-movie-workbench
```

也支持 Git URL：`dsh plugin --profile desktop add
git+https://github.com/aidc-lab/dsh-movie-workbench.git`。

## 设置对话框

页头的齿轮按钮打开设置对话框，浏览器的本地偏好都集中在这里：

- **数据源** — TMDB、IMDb、豆瓣三个开关，保存在 `localStorage`
  （`dsh-movie-workbench.sources`）；至少保留一个渠道，只剩一个时筛选行收起到该渠道。
- **TMDB API Key** — 支持 v3 Key 或 v4 读取令牌，只保存在本机浏览器
  （`dsh-movie-workbench.tmdb-key`）；Host 端已配置 Key 时可以留空。
- **默认模型** — 列出 Profile 的 LLM 提供商所提供的模型（来自 Host 的 `GET /models`），
  供「AI 选资源」使用；选择保存在 `localStorage`（`dsh-movie-workbench.ai-model`）。
  只有配置了 DSH LLM 服务与模型时才可用。

所有修改按下「保存」后才会生效；点 ×、按 Escape 或点击对话框外部关闭会丢弃本次修改。

## Host API

Host 端（`index.js` + `lib/`）只有一个前缀路由 `/movie-workbench/api`：

| 路由 | 用途 |
|---|---|
| `GET /status` | 各渠道是否已配置凭据 |
| `GET /search?q=&source=&lang=` | 分发到所选渠道并返回归一化结果 |
| `GET /trending?source=&lang=&limit=` | 推荐行，或单个渠道的更长列表 |
| `GET /browse?source=&category=&page=&cursor=&lang=` | 渠道浏览分类的一页（20 条），返回 `hasMore` 与 IMDb 的不透明 `next` 游标用于无限加载 |
| `GET /charts?source=douban&kind=movie\|tv` | 单个榜单目录：`movie`（默认）含 3 个官方榜单（实时元数据）+ 10 个年度榜单（2025–2021 的高分/热门）+ 27 个类型冷门佳作 + 54 个分类题材榜单（共 94 个）；`tv` 含 3 个官方 + 10 个年度 + 54 个分类题材榜单（共 67 个，无冷门佳作） |
| `GET /chart?source=douban&id=&start=&count=` | 某个榜单的一页按排名条目；`id` 为官方榜单 id、`year:<年份>:<S 或 U>`、`hidden:<类型>`、`genre:<类型>:<S 或 U>`，以及剧集形式 `tv-year:<年份>:<S 或 U>` / `tv-genre:<类型>:<S 或 U>`（S 高分经典，U 近期热门） |
| `GET /detail?source=douban\|tmdb\|imdb&id=` | 豆瓣条目的简介与元数据（国家/地区、分类、片长），或 TMDB 电影所属的合集信息，或 IMDb 条目的元数据 |
| `GET /collection?source=tmdb&id=` | TMDB 合集里的全部作品（归一化电影结果） |
| `GET /series?source=imdb&id=` | 单个 IMDb 条目的相关系列（前作 / 续作 / 衍生），按上映年份排序 |
| `GET /chart?source=douban&id=collection:<id>` | 豆瓣条目收录的某个官方榜单，返回结构与其他榜单一致 |
| `GET /torrents?q=&alt=&source=&limit=&page=` | BT 资源搜索；返回一页结果（`page` 1–20）及 `hasMore` 供下滑加载 |
| `GET /models` | Profile 的 LLM 提供商所提供的模型，以及当前 Profile 选中的模型 |
| `POST /pick` | 让 Host 端 AI 模型从最多 30 条 BT 资源中挑选最佳；请求体 `{ item, rows, lang, preferences?, prompt?, preview?, model? }`（`preferences` 为 `{ quality, language, subtitle }`，`prompt` 覆盖默认提示词，`preview: true` 只返回提示词不调用模型），返回 `pick`（`{id, rank, reason}`）、`picks`、`prompt`、`preferences` 与 `errors`（`llm_unavailable` / `llm_no_model` / `bad_preferences` / `bad_prompt` / 超时等） |
| `GET /image?url=` | 代理白名单图床的海报 |

所有上游 HTTP 请求都在 Host 完成，因此页面保持同源，豆瓣的 `Referer` 要求也由服务端
处理。所有路由都经过 DSH 浏览器会话的访问检查；响应仅限同源，不发送 CORS 授权。

## 配置

`cordis.patch.yml` 中的插件配置：

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `tmdbApiKey` | `''` | 可选的服务端 TMDB 凭据（回退到 `TMDB_API_KEY` 环境变量） |
| `maxResults` | `12` | 每个渠道的结果上限 |
| `requestTimeoutMs` | `8000` | 单个上游请求超时 |

TMDB 需要凭据：可设置 `tmdbApiKey`，或在面板的「设置」对话框里粘贴 v3 Key / v4 令牌
（只保存在本机浏览器）。IMDb 与豆瓣无需 Key。

## 开发

浏览器端仍保持单个 `client.js`（DSH 客户端加载器只接受一次 classic-script 注册），
直接修改即可，没有构建步骤。Host 拆分为 `lib/host/` 下的独立 ES 模块，统一由
`lib/host.js` 导出；上游适配器位于 `lib/providers/`，统一由 `lib/providers.js` 导出。

| 命令 | 用途 |
|---|---|
| `make check` | 对所有源文件执行 `node --check` |
| `make smoke` | 离线的 client/render/pick 测试 |
| `make live` | 对 TMDB、IMDb、豆瓣和 BT 索引的在线联调 |
| `make publish` | 发布到 npm（会提示输入 2FA 验证码） |

## 说明

- 需要 DSH Web GUI，并能访问 TMDB、IMDb、豆瓣、BT4G、BitSearch 及海报图床。
- IMDb 搜索结果没有评分；豆瓣推荐带公开的 `rate`；TMDB 提供评分与票数。
- 部分上游接口未公开，可能变更或限流；失败按渠道隔离，不影响其他渠道。
