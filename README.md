<img src="assets/logo.png" width="92" height="92" alt="雁字标志">

# 雁字

雁字是自托管通知聚合与分发应用。用统一 API 将消息投递到主题、渠道账号或雁字原生客户端。服务端自带 Elastic UI 管理台，NSH 客户端独立安装，用原生组件处理连接、通知、发送和投递记录。

[English](README.en.md) · [官网](https://ca-x.github.io/anser/) · [下载](https://github.com/ca-x/anser/releases/latest) · [界面截图](#界面截图) · [配置](#配置)

服务端二进制、Docker 镜像归档与 NSH 客户端分别打包。下载后可用同版的 `SHA256SUMS` 校验。

## 启动服务端

Docker Compose 可从源码构建服务端和内置前端。首次启动通过环境变量创建管理员。

```sh
export ANSER_BOOTSTRAP_USERNAME=admin
read -rsp '雁字管理员密码：' ANSER_BOOTSTRAP_PASSWORD
echo
export ANSER_BOOTSTRAP_PASSWORD
docker compose up --build -d
unset ANSER_BOOTSTRAP_PASSWORD
```

访问 `http://127.0.0.1:8080/login` 登录，管理界面位于 `/admin`。同一 SQLite 数据库上的后续启动不会重置管理员。生产环境可用 HTTPS 反向代理，设置 `ANSER_PUBLIC_URL=https://anser.example.com` 生成移动端配对二维码。Docker 镜像使用持久卷保存数据库与主密钥文件。

使用预构建镜像时，下载对应架构的归档，用 `docker load -i anser-docker-linux-amd64.tar.gz` 导入。导入的镜像标签为 `anser:<版本号>`。

也可下载独立服务端二进制，或使用 Node.js 24 和 Rust 1.94 从源码构建。

```sh
npm --prefix clients/web ci
npm --prefix clients/web run build
ANSER_REQUIRE_WEB=1 cargo build --locked --release -p anser-server
./target/release/anser serve
```

设置 `ANSER_BOOTSTRAP_USERNAME` 和 `ANSER_BOOTSTRAP_PASSWORD` 后再首次执行二进制。也可用 `ANSER_BOOTSTRAP_API_KEY` 配置高熵初始管理员 API Key。Web 静态文件已编入发行二进制，运行时只需该二进制与数据目录。

## 使用客户端

在客户端连接页输入服务端地址并登录。也可以在管理台的「配对客户端」生成两分钟内有效的一次性二维码，用手机系统相机扫描，在雁字确认服务器地址后登录。同一台设备上可复制配对链接，在客户端选择「导入连接链接」。

**发送第一条通知。** 在管理台「发送通知」选择「个人收件箱」，填写自己的用户名和一句正文，即可在客户端收件箱看到它。发给另一位用户时，对方可以从通知详情直接回复。发送者的投递记录显示通知存入了谁的收件箱。发布到主题时，详情显示实际收到通知的收件箱数量。阅读状态仅在收件人自己的收件箱中显示。

登录期间，在客户端或管理台切换页面会保留发送草稿。刷新页面或退出登录会清除草稿。

用户可在账号安全设置中自行开启双重验证。绑定验证器后，密码登录还需输入动态验证码或一次性恢复码。恢复码只在绑定成功时展示，请保存到安全的位置。

- [NSH 客户端构建、打包与通知支持](clients/nsh/README.md)
- [Web 管理台开发](clients/web)
- [SQLite、一致性与恢复](docs/storage.md)

- [通知模板与 API 示例](docs/notification-templates.md)
- [插件开发 Skill](.agents/skills/anser-plugin-authoring/SKILL.md)
- [定时推送与市场发现](docs/scheduled-notifications.md)
- [问询交互与 MCP](docs/interactions.md)

## 界面截图

投递总览展示队列、送达、死信和重试。截图使用简体中文和演示数据。

![投递总览](docs/screenshots/zh-CN/server-overview.png)

<details>
<summary>投递详情、插件、代理与账号安全设置</summary>

![直发通知的收件箱回执](docs/screenshots/zh-CN/server-inbox-receipt.png)

![投递和发送尝试详情](docs/screenshots/zh-CN/server-delivery.png)

![文本转语音插件的模型、音色与保存设置](docs/screenshots/zh-CN/server-tts.png)

![编辑邮件账号，显示连接预设、发件人名称和邮件样式](docs/screenshots/zh-CN/server-email.png)

![选择懒猫通知设备，绿色圆点表示在线，灰色表示离线（演示设备）](docs/screenshots/zh-CN/server-account-device.png)

![渠道插件的运行和账号设置](docs/screenshots/zh-CN/server-plugin.png)

![按能力分类的已安装插件](docs/screenshots/zh-CN/server-plugins-catalog.png)

![定时任务列表展示周期、每周和单次计划](docs/screenshots/zh-CN/server-schedules.png)

![通知模板管理](docs/screenshots/zh-CN/server-templates.png)

![出站代理设置](docs/screenshots/zh-CN/server-proxies.png)

![账号安全设置](docs/screenshots/zh-CN/server-security.png)

![关于雁字，可查看服务端版本、发布说明和标志的由来](docs/screenshots/zh-CN/server-about.png)

![个人设置弹窗，可编辑昵称和头像](docs/screenshots/zh-CN/server-profile.png)

</details>

<details>
<summary>移动端网页管理台</summary>

![移动端管理员登录](docs/screenshots/zh-CN/server-mobile-login.png)

![移动端投递总览](docs/screenshots/zh-CN/server-mobile-overview.png)

![移动端导航抽屉](docs/screenshots/zh-CN/server-mobile-menu.png)

![移动端发送通知](docs/screenshots/zh-CN/server-mobile-send.png)

![移动端合成与发送语音通知](docs/screenshots/zh-CN/server-mobile-speech.png)

![移动端渠道插件](docs/screenshots/zh-CN/server-mobile-channels.png)

![移动端出站代理](docs/screenshots/zh-CN/server-mobile-proxies.png)

</details>

<details>
<summary>Linux 原生客户端</summary>

![原生客户端回复后的送达回执](docs/screenshots/zh-CN/nsh-receipt.png)

![NSH 客户端勾选多台发送服务器](docs/screenshots/zh-CN/nsh-compose.png)

![NSH 客户端管理服务器备注和默认发送列表](docs/screenshots/zh-CN/nsh-servers.png)

![在原生客户端勾选一组懒猫设备（演示设备）](docs/screenshots/zh-CN/nsh-account-device.png)

![原生客户端的插件设置](docs/screenshots/zh-CN/nsh-plugin.png)

![原生客户端的代理设置](docs/screenshots/zh-CN/nsh-proxies.png)

![原生客户端的关于页](docs/screenshots/zh-CN/nsh-about.png)

![原生客户端的个人设置弹窗](docs/screenshots/zh-CN/nsh-profile.png)

</details>

网页端登录页和管理台的齿轮菜单，以及 NSH 客户端的设置页，均可切换简体中文或英文，以及浅色、深色或跟随系统的主题。偏好保存在当前浏览器或客户端设备。

## 出站代理

管理员可在代理设置中保存多个 HTTP 或 HTTPS 代理，也可填写代理的登录凭据。支持 HTTP 代理的渠道账号可以选择其中一个配置。修改代理后，引用它的账号会在下一次发送尝试时使用新配置。已有账号可以保留原连接设置。主动选择「直连」并保存，会解除共享配置并清除这个账号旧有的内嵌代理。

部署时将代理主机和通知目标主机都加入 `ANSER_OUTBOUND_ALLOW_HOSTS`。列表以逗号分隔，只填主机名或 IP。删除配置前，先解除账号引用。SMTP 邮件和懒猫通知使用各自的传输方式。终端管理命令见 `anser api proxies --help`。

## 插件与语音通知

插件页按渠道、任务和内容转换分类。证书检查支持多个 HTTPS 站点和提前提醒天数，wttr.in 提供实时、当天、次日及 1 到 3 天预报，独立的 Open-Meteo 任务支持一周和自定义 1 到 16 天预报。在「定时任务」选择任务插件和目标后，可以按分钟、小时、天循环，按每周指定时间运行，或在指定日期和时间运行一次。服务器会把结果发到所选主题或默认路由。「插件市场」检索带 `anser-plugin` 标签的公开 GitHub 仓库，主题公告可在市场内单独访问。

在「内容转换 → 文本转语音」选择模型和音色，保存后即可用同一配置预听或发送语音。登录中的雁字客户端会依次播放新语音通知，可在收件箱关闭自动播放。其他渠道收到文字和限时音频链接。通过主题或默认渠道发送前，请配置可访问的 HTTPS `ANSER_PUBLIC_URL`。

## API 与渠道

从头像菜单打开「个人设置」，可在管理台或客户端更新昵称和头像。同一账号的资料会在两端显示，登录和直发通知仍使用登录用户名。

从已登录的懒猫微服入口打开雁字，在「渠道账号」选择「懒猫微服通知」，即可按名称选择自己的设备。离线设备也可以保存。回到账号列表可测试发送。

- API 文档由服务端提供在 `/v1/openapi.json`。健康检查在 `/healthz`。
- 管理员可在管理台和 NSH 客户端打开各渠道插件的设置页，启用、禁用或重载插件，并用该插件专属的表单配置账号。禁用状态重启后仍然生效，该插件的账号会从新投递的候选集中跳过。
- `POST /v1/send` 或 `POST /v1/topics/{name}/publish` 持久化入队，支持 `Idempotency-Key` 和 `?wait=true`。API Key 使用 `Authorization: Bearer ...`。
- `POST /v1/inbox/send` 按用户名直发，支持 `Idempotency-Key`。回执中的 `id` 用于操作收件箱条目，`message_id` 用于查询发送结果。升级前的直发消息仍保留在收件人的收件箱中。
- `GET /v1/messages/{id}` 查看路由投递和历史尝试。管理台可配置广播、有序故障转移、按权重选择、加权首选再故障转移、限流和退避。
- 官方 SDK 支持发送、模板发布、投递查询和订阅管理。查看 [Rust](https://crates.io/crates/anser-sdk)、[Go](https://github.com/lib-x/anser-sdk-go)、[TypeScript](https://github.com/lib-x/anser-sdk-ts) 与[双语使用说明](https://ca-x.github.io/anser/?lang=zh-CN#sdk)。
- 终端用户可通过 `anser api --help` 查看管理命令与示例。
- 支持 ntfy、Server酱、Bark、SMTP 邮件、懒猫通知、微信公众号、企业微信应用、飞书、Telegram、Gotify、QQ 机器人、钉钉、Slack、Discord、IFTTT 和 Chanify。PushPlus 和 gorush 用作设计参考。[渠道配置](anser-plugins) · [懒猫通知配置](docs/lazycat.md)

## 配置

| 环境变量 | 默认或用途 |
| --- | --- |
| `ANSER_BIND` | `127.0.0.1:8080`，容器内监听 `0.0.0.0:8080` |
| `ANSER_DATABASE` | `anser.sqlite3` |
| `ANSER_BOOTSTRAP_USERNAME` / `ANSER_BOOTSTRAP_PASSWORD` | 首次初始化管理员，密码 8 到 256 个 UTF-8 字节 |
| `ANSER_BOOTSTRAP_API_KEY` | 可选，首次初始化 API Key，至少 32 个高熵字符 |
| `ANSER_MASTER_KEY_FILE` / `ANSER_MASTER_KEY` | 可选，URL-safe Base64 编码的 32 字节密钥，默认在数据库旁生成 `.key` 文件 |
| `ANSER_PUBLIC_URL` | 管理台生成移动端配对二维码时使用的 HTTPS 地址 |
| `ANSER_CORS_ORIGINS` | 允许访问 API 的 Web 客户端来源，以逗号分隔 |
| `ANSER_ALLOW_PRIVATE_NETWORK` / `ANSER_OUTBOUND_ALLOW_HOSTS` | 默认限制访问内网，自建渠道按部署配置放行 |
| `ANSER_CALLBACK_ALLOW_HOSTS` / `ANSER_ATTACHMENT_ALLOW_HOSTS` | 分别允许回调和附件访问指定私网主机，以逗号分隔 |
| `ANSER_WORKERS` / `ANSER_CONCURRENCY` | 默认 4 个调度 worker、32 个并行发送 |
| `ANSER_CHANNEL_CONCURRENCY` / `ANSER_ACCOUNT_CONCURRENCY` | 默认单渠道 8、单账号 1 |
| `ANSER_MAX_TTL_SECONDS` / `ANSER_RETENTION_DAYS` | 默认 86400 秒上限、30 天记录保留 |
| `ANSER_QUEUE_LIMIT` / `ANSER_REQUESTS_PER_MINUTE` | 默认 10000 个待处理路线、每凭据每分钟 120000 次请求 |

在「系统设置」中可调整投递记录保留天数，或关闭自动清理。开启清理后，已设置保留天数的主题按各自设置处理。个人收件箱和语音附件沿用各自的保留规则。

服务端、Web 管理台和 NSH 客户端使用同一个 `x.y.z` 版本，渠道插件各自维护版本。GitHub Actions 在匹配的 `vX.Y.Z` 标签构建 GHCR 的 Linux amd64/arm64 镜像，并随 GitHub Release 发布 Docker 镜像归档、服务端多平台二进制、独立 NSH 客户端包及 SHA-256 校验和。
