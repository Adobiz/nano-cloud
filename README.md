<div align="center">

<img src="assets/logo.svg" width="160" height="160" alt="nano-cloud logo" />

# nano-cloud

**小而轻的云盘，简单自在地分享。**

轻量 · 自托管 · Cloudflare 驱动 · Claude 风格界面

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" /></a>
  <a href="https://developers.cloudflare.com/r2/"><img src="https://img.shields.io/badge/Storage-R2%20%2F%20S3%20%2F%20WebDAV-a64f36?style=flat-square" alt="R2, S3 and WebDAV storage" /></a>
  <a href="https://developers.cloudflare.com/d1/"><img src="https://img.shields.io/badge/Database-D1-302e29?style=flat-square" alt="Cloudflare D1" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-35664c?style=flat-square" alt="MIT license" /></a>
</p>

中文 · [English](README.en.md)

[功能](#主要功能) · [快速开始](#快速开始) · [部署](#部署到-cloudflare) · [项目结构](#项目结构) · [致谢](#致谢)

基于 Cloudflare Workers 的轻量网盘与文件分享系统。使用 R2 存储文件、D1 管理元数据，支持 S3 兼容存储与远程 WebDAV。原生 HTML 前端采用 Claude 风格的暖色纸张、简洁留白和清晰排版。

</div>

---

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 文件管理 | 上传、文件列表、删除与存储目录浏览 |
| 分享与直链 | 分享密码、有效期、下载次数限制、撤销、下载文件名与独立直链 |
| 下载市场 | 公开分享展示、搜索与排序 |
| 下载控制 | 月流量限额、单 IP 下载限制、自动封禁与激活码额度 |
| 登录安全 | 管理会话、TOTP 两步验证、恢复码与登录审计 |
| 访客验证 | Cloudflare Turnstile 与 OAuth 下载登录 |
| 存储选择 | R2、S3 兼容存储、远程 WebDAV |
| WebDAV 服务 | Basic Auth、目录浏览与文件操作 |
| 下载统计 | 下载日志、每日流量与国家分布；Analytics Engine 可选 |
| 界面 | 中文/英文、响应式布局、管理后台浅色/深色主题 |

生产代码使用 Workers 与 Web Crypto 原生 API，无 npm 运行时依赖。此版本在上游基础上调整前端样式与项目名称，并修复后台脚本、分享下载、全球分布、流量统计和激活码预扣费。同时修复了并发限额、存储切换、WebDAV 路径与覆盖操作、OAuth 回调和数据库迁移问题。

## 快速开始

准备可运行项目所锁定 Wrangler 版本的 Node.js、npm 与 Cloudflare 账号。在项目根目录执行：

```bash
npm ci
```

创建 `.dev.vars`，用于本地开发：

```dotenv
admin=请换成你自己的长随机管理密钥
```

启动本地服务：

```bash
npm run dev -- --local --config wrangler.jsonc
```

访问 [http://localhost:8787/admin](http://localhost:8787/admin)，使用上述 `admin` 密钥登录。当前 `wrangler.jsonc` 声明了 D1 与 R2 绑定，Wrangler 可在本地模拟这些资源。数据库在首次请求时初始化。

`.dev.vars` 已被忽略，请勿提交到仓库。

## 回归验证

测试使用 Node.js 24 或更高版本，在内存 SQLite、模拟 R2 和模拟远程接口上执行，不连接真实 Cloudflare 账号。

```bash
npm run check
npm test
npx wrangler deploy --dry-run --config wrangler.jsonc
```

部署后再验证：普通与密码分享下载、激活码余额、并发限额、S3/WebDAV 上传下载、WebDAV 挂载与文件操作、OAuth 登录回跳，以及流量统计。旧记录的文件大小会在下载或 HEAD 请求时与存储元数据同步。

## 部署到 Cloudflare

部署步骤见 [DEPLOY.md](DEPLOY.md)，外部存储配置见 [DEPLOY-S3.md](DEPLOY-S3.md)。以仓库当前的 `wrangler.jsonc` 为准，并确认它指向你实际使用的资源。

```bash
npx wrangler login
npx wrangler d1 create nano-cloud
npx wrangler r2 bucket create nano-cloud
```

将创建 D1 时返回的数据库 ID 填入 `wrangler.jsonc` 的 `database_id`，确认资源名称后设置管理密钥并部署：

```bash
npx wrangler secret put admin --config wrangler.jsonc
npm run deploy -- --config wrangler.jsonc
```

已有数据库和存储桶可直接复用，无需重复创建。CLI 部署使用配置中的绑定声明，不要仅依赖控制台设置。

| 配置项 | 说明 |
| --- | --- |
| Worker 名称 | `nano-cloud` |
| `db` 绑定 | Cloudflare D1，示例数据库名为 `nano-cloud` |
| `r2` 绑定 | Cloudflare R2，示例存储桶名为 `nano-cloud` |
| `analytics` 绑定 | 可选 Analytics Engine，当前 dataset 为 `r2pan_downloads` |
| `admin` Secret | 管理登录与加密使用的密钥 |
| Turnstile | 按需配置 `turnstile_sitekey` / `turnstile_secret` 或后台对应设置 |
| `totp_recovery` Secret | 可选，两步验证恢复密钥 |

### 使用已有实例

项目名称的修改不会重命名 Cloudflare 上的现有资源，也不会搬迁文件或数据库。继续使用旧实例时，请保留实际的 Worker 名称、D1 数据库 ID、R2 存储桶名称和 Secrets；新建 `nano-cloud` Worker 时需为它设置密钥与域名。

数据库中已保存的站点标题也不会因源码默认值变化而自动修改，需要在管理后台手动更新。

## 验证部署

- 打开 `/admin`，检查登录、文件列表与上传交互。
- 创建测试分享，访问 `/s/:token`，检查密码、下载次数和文件下载。
- 按实际启用的功能检查 `/market`、直链、OAuth、Turnstile 与 WebDAV。
- 使用 `npm run tail -- --config wrangler.jsonc` 查看线上 Worker 日志。

使用 Node.js 24，在安装依赖后执行本次修复的回归检查：

```bash
node scripts/check-downloads.mjs
node scripts/check-global.mjs
```

检查使用内存 SQLite、模拟存储和实际图表引擎，不访问 Cloudflare 或线上数据。项目尚未提供 `npm run check`；完整 TypeScript 检查仍有已知的存储类型问题。

### 下载扣费与统计

通过鉴权并确认文件存在后，D1 事务在返回文件之前同时预留下载次数与激活码额度。余额不足不返回文件；失败鉴权、文件不存在、无效 Range 和 HEAD 不扣费。Range 按本次请求范围预扣；下载中断不会自动退款。

流量按服务端响应长度异步记录，按 UTC 日期汇总，并在跨月首次写入时重置月累计。全球分布使用下载日志中的国家代码；旧记录缺少国家信息时保留为未知，不自动推测。地图与图表脚本由本站提供。

## 项目结构

```text
assets/logo.svg          nano-cloud README 标识
public/
  admin.html             管理后台
  share.html             分享页
  market.html            下载市场
src/
  index.ts               Worker 入口与路由
  admin.ts               管理 API
  public.ts              分享鉴权与下载
  codes.ts               激活码
  storage.ts             R2 / S3 / 远程 WebDAV 存储
  webdav.ts              WebDAV 服务
  settings.ts            站点设置与流量统计
  db.ts                  D1 Schema 与迁移
  oauth*.ts              OAuth Provider 与会话
  auth.ts / crypto.ts    管理认证、签名、加密与 TOTP
  pages.ts               HTML 与错误页响应
wrangler.jsonc           本文使用的部署配置
wrangler.toml            上游保留的另一份配置
```

常用入口：`/admin` 管理后台、`/market` 下载市场、`/s/:token` 分享、`/d/:token` 直链、`/webdav/` WebDAV 挂载。

## 致谢

nano-cloud 基于 [Admin666pro/cloud-r2pan](https://github.com/Admin666pro/cloud-r2pan) 开发。感谢原作者 **Admin666pro** 提供 Workers、R2、D1 架构以及文件分享、安全验证和多存储实现。本版本沿用上游架构，调整前端样式与项目名称，并修复下载、鉴权、存储和统计流程；README 的版式参考 FlareDrive。

## 许可证

[MIT](LICENSE)。保留上游作者的版权声明与许可。
