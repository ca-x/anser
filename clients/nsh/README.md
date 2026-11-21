# 雁字 NSH 客户端

客户端提供用户名和密码或 API Key 登录、通知发送、Topic 与订阅、渠道账号、默认路由和投递记录。以个人账号登录时，收件箱接收服务器通知，也能按用户名发送给另一位用户。主题可设置订阅与发布密码。客户端在会话内存中处理个人密码、API Key 和填写中的渠道凭据。

## 语言和外观

连接页和工作区都可打开「偏好设置」。语言支持简体中文、English 和跟随系统，外观支持浅色、深色和跟随系统。改动即时生效，并通过 NSH Storage 保存在本机。

## 开发与打包

使用 [NSH 0.6.1](https://github.com/longbridge/nsh/releases/tag/v0.6.1)。从 Anser 仓库根目录执行。

```sh
nsh check clients/nsh
nsh build clients/nsh --release --out clients/nsh/dist/bundle
nsh test clients/nsh
nsh run clients/nsh
nsh package clients/nsh --target linux --out clients/nsh/dist/linux
nsh package clients/nsh --target web --out clients/nsh/dist/web
```

Linux 运行需要 GTK 4.14+ 和 NSH 运行时要求的 WebKitGTK 6.0 动态库。解压 Linux 包后，在解压目录运行 `./App`。Web 包可部署到静态站点，Anser 服务端的 `ANSER_CORS_ORIGINS` 需要包含该站点源，例如 `https://app.example.com`。连接地址应为 HTTPS 服务器源。开发环境允许使用本机回环地址的 HTTP。

使用 `nsh package clients/nsh --target ios` 或 `--target android` 生成移动端应用。iOS 真机分发需要签名和 Provisioning Profile。安卓正式发布需使用发行密钥。平台工具链及签名参数见 [NSH 打包指南](https://nsh.dev/docs/packaging.md)。

## 二维码配对与通知

1. 在 Anser 管理界面生成短时配对二维码。
2. 在手机上用系统相机扫描二维码，再点开系统识别出的雁字连接链接。也可以复制连接链接，在客户端连接页选择「导入连接链接」。
3. 核对应用显示的服务器地址，确认后客户端才向该 HTTPS 服务器提交一次性配对码。配对码过期时可回到管理界面重新生成。

NSH v0.6.1 的 TSX API 提供应用 URL scheme、系统通知和照片选择，没有应用内相机扫码接口。移动端安装包注册了 `anser://` scheme。Web 环境可粘贴链接。离开应用时，消息仍保留在服务器收件箱。当前客户端通过长轮询接收消息，需要应用运行且系统允许请求继续执行。应用挂起或关闭时不会收取新的系统提醒。系统通知权限由用户在收件箱主动开启，通知正文始终在应用内查看。

NSH headless 测试使用本地请求 mock 覆盖远程 HTTP 凭据限制、登录、发送、投递尝试详情、配对、Topic 密码和收件箱。设备侧通知授权和相机的链接交接取决于系统平台。
