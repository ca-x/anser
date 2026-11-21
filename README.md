<img src="assets/logo.png" width="92" height="92" alt="雁字标志">

# 雁字

雁字是自托管通知聚合与分发应用。用统一 API 将消息投递到主题、渠道账号或雁字原生客户端。服务端自带 Elastic UI 管理台，NSH 客户端独立安装，用原生组件处理连接、通知、发送和投递记录。

[English](README.en.md) · [下载](https://github.com/ca-x/anser/releases/latest) · [界面截图](#界面截图) · [配置](#配置)

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

连接页输入服务端地址和用户账号。在服务端管理台可生成两分钟内有效的一次性二维码，使用手机系统扫码打开雁字并确认登录。已经订阅同一主题的用户各自收到一条通知。已登录用户也可按用户名直接发送通知。

用户可在账号安全设置中自行开启双重验证。绑定验证器后，密码登录还需输入动态验证码或一次性恢复码。恢复码只在绑定成功时展示，请保存到安全的位置。

- [NSH 客户端构建、打包与通知支持](clients/nsh/README.md)
- [Web 管理台开发](clients/web)
- [SQLite、一致性与恢复](docs/storage.md)

## 界面截图

投递总览展示队列、送达、死信和重试。截图使用简体中文和演示数据。

![投递总览](docs/screenshots/zh-CN/server-overview.png)

<details>
<summary>服务端的插件与账号安全设置</summary>

![渠道插件的运行和账号设置](docs/screenshots/zh-CN/server-plugin.png)

![账号安全设置](docs/screenshots/zh-CN/server-security.png)

</details>

<details>
<summary>Linux 原生客户端</summary>

![原生客户端发送通知](docs/screenshots/zh-CN/nsh-compose.png)

![原生客户端的插件设置](docs/screenshots/zh-CN/nsh-plugin.png)

</details>

网页端登录页和管理台的齿轮菜单，以及 NSH 客户端的设置页，均可切换简体中文或英文，以及浅色、深色或跟随系统的主题。偏好保存在当前浏览器或客户端设备。

## API 与渠道

- API 文档由服务端提供在 `/v1/openapi.json`。健康检查在 `/healthz`。
- 管理员可在管理台和 NSH 客户端打开各渠道插件的设置页，启用、禁用或重载插件，并用该插件专属的表单配置账号。禁用状态重启后仍然生效，该插件的账号会从新投递的候选集中跳过。
- `POST /v1/send` 或 `POST /v1/topics/{name}/publish` 持久化入队，支持 `Idempotency-Key` 和 `?wait=true`。API Key 使用 `Authorization: Bearer ...`。
- `GET /v1/messages/{id}` 查看路由投递和历史尝试。管理台可配置广播、有序故障转移、按权重选择、加权首选再故障转移、限流和退避。
- [Rust SDK](crates/anser-sdk) 支持类型化发送、主题订阅、查询、登录及收件箱。CLI 用 `anser api --help` 查看管理命令，例如 `anser api channels ntfy --action disable`。
- 支持 [ntfy](anser-plugins/ntfy)、[Server酱](anser-plugins/serverchan)、[Bark](anser-plugins/bark)、[SMTP 邮件](anser-plugins/email)、[懒猫通知](docs/lazycat.md)、[微信公众号](anser-plugins/wechat-mp)、[企业微信应用](anser-plugins/wecom)、[飞书](anser-plugins/feishu)和 [Telegram](anser-plugins/telegram)。PushPlus 和 gorush 用作设计参考。

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

保持 `Cargo.toml`、Web 和 NSH 客户端版本为同一 `x.y.z` 值。GitHub Actions 在匹配的 `vX.Y.Z` 标签构建 GHCR 的 Linux amd64/arm64 镜像，并随 GitHub Release 发布 Docker 镜像归档、服务端多平台二进制、独立 NSH 客户端包及 SHA-256 校验和。
