[English](README.md) | **简体中文**

# dsh-movie-workbench

一个 DeepSeek Harness 插件，在左侧栏加入 **影视工作台 / Movies workbench** 面板：
在一个页面里检索 **TMDB**、**IMDb** 和 **豆瓣** 的电影与剧集，浏览各渠道推荐，打开
详情页并查找 BT 资源。

## 功能

- **一次搜索、三个渠道** — 结果按渠道分组，含海报、年份、评分与来源链接。
- **空闲推荐** — 每个渠道一行，行尾「查看全部」进入该渠道更长列表（最多 24 部）。
- **详情页** — 海报、原名、标签、简介与来源链接；豆瓣简介按需加载。
- **BT 资源** — 合并 BT4G 与 BitSearch 结果，可按大小、做种、下载排序；可复制磁力
  链接或打开来源页。
- **数据源开关** — 在页头关闭 TMDB、IMDb 或豆瓣后，该渠道不再出现在筛选、推荐、
  统计与结果中。
- **最近搜索与取消搜索** — 搜索框下方显示最近记录；清除按钮（或 `Esc`）取消搜索并
  回到推荐。

## 启用

将插件加入 DSH profile 即可。它会注册「影视工作台」侧栏入口和一个 Host 路由
`/movie-workbench/api`。无需构建、无额外依赖、无需会话。

## 数据源设置

页头 TMDB Key 按钮旁的齿轮按钮打开数据源开关。选择保存在 `localStorage`
（`dsh-movie-workbench.sources`）；至少保留一个渠道，只剩一个时筛选行收起到该渠道。

## 空闲推荐

| 渠道 | 数据来源 | 说明 |
|---|---|---|
| TMDB | `trending/all/week` | 需要 TMDB 凭据；否则该行显示设置 Key 的入口 |
| IMDb | 精选片单，经 suggestion API 实时解析 | 没有公开的热度接口；Host 内存缓存 3 小时 |
| 豆瓣 | `j/search_subjects`（`tag=热门`，电影 + 剧集） | 无需 Key，带豆瓣评分 |

工具栏的刷新按钮重新加载当前界面（空闲时刷新推荐，否则重跑当前搜索）；保存或清除
TMDB Key 也会刷新推荐行。

## 详情页与简介

点击结果会在面板内打开独立详情页，返回按钮回到结果列表。豆瓣的 suggestion 和搜索
接口不返回简介，因此豆瓣影片打开详情页时会请求 `/detail?source=douban&id=`：Host
调用该条目的移动端详情接口（`m.douban.com/rexxar`，无需 Key）并在内存缓存 30 分钟。
简介返回前页面显示「简介加载中…」；同一响应还包含类型、片长、地区和豆瓣评分。

## BT 资源

详情页还会用影片的原始标题和译名检索两个公开 BT 索引，并把合并结果列在元数据下方。
每行两个操作：**复制** 复制该行磁力链接，**详情** 打开来源页。排序按钮：默认、做种、
下载、大小——点击当前排序可切换升/降序；缺少该指标的条目始终排在最后。

| 来源 | 使用的接口 |
|---|---|
| BT4G | `https://bt4gprx.com/search?q=…&page=rss` |
| BitSearch | `https://bitsearch.to/search?q=…`（会跳转到 `bitsearch.eu`） |

页面只展示元数据和磁力链接：不下载种子文件、不连接 tracker、不写入会话。Host 内存
缓存 10 分钟，页面按影片缓存。这些是第三方索引，下载是否合法取决于你所在地区和具体
作品。

## Host API

Host 端（`index.js` + `lib/`）只有一个前缀路由 `/movie-workbench/api`：

| 路由 | 用途 |
|---|---|
| `GET /status` | 各渠道是否已配置凭据 |
| `GET /search?q=&source=&lang=` | 分发到所选渠道并返回归一化结果 |
| `GET /trending?source=&lang=&limit=` | 推荐行，或单个渠道的更长列表 |
| `GET /detail?source=douban&id=` | 豆瓣条目的简介与元数据 |
| `GET /torrents?q=&alt=&source=&limit=` | BT 资源搜索（BT4G + BitSearch） |
| `GET /image?url=` | 代理白名单图床的海报 |

所有上游 HTTP 请求都在 Host 完成，因此页面保持同源，豆瓣的 `Referer` 要求也在服务端
处理。

## 配置

`cordis.patch.yml` 中的插件配置：

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `tmdbApiKey` | `''` | 可选的服务端 TMDB 凭据（回退到 `TMDB_API_KEY` 环境变量） |
| `maxResults` | `12` | 每个渠道的结果上限 |
| `requestTimeoutMs` | `8000` | 单个上游请求超时 |

TMDB 需要凭据：可设置 `tmdbApiKey`，或在面板的 Key 控件里粘贴 v3 Key / v4 令牌
（只保存在本机浏览器）。IMDb 与豆瓣无需 Key。

## 说明

- 需要 DSH Web GUI（提供 `ctx.webServer`），并能访问
  `api.themoviedb.org`、`v2.sg.media-imdb.com`、`movie.douban.com`、`bt4gprx.com`、
  `bitsearch.to` 及海报图床。
- IMDb 搜索结果没有评分；豆瓣推荐带公开的 `rate`；TMDB 提供评分与票数。
- suggestion、rexxar、BT4G 与 BitSearch 都是未公开接口，可能变更或限流；失败时按渠道
  单独提示，不影响其他渠道。
