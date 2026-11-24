# 雁字 NSH 客户端

客户端提供用户名和密码或 API Key 登录、通知发送、Topic 与订阅、渠道账号、默认路由和投递记录。以个人账号登录时，收件箱接收服务器通知，也能按用户名发送给另一位用户。主题可设置订阅与发布密码。客户端在会话内存中处理个人密码、API Key 和填写中的渠道凭据。

「服务器」页可新增、编辑和移除已保存的服务器。列表与侧栏显示备注，地址可在编辑时查看。未填备注时显示主机名。客户端会记住已保存的服务器、默认发送列表、上次使用的服务器和桌面侧栏折叠状态。密码、API Key 和登录会话只保存在本次应用运行的内存中。

直接发送通知时，可以用标签勾选多台服务器。没有配置默认发送列表时，会先选中当前服务器。为目标服务器分别登录后，客户端将通知提交给各服务器的默认路由。若部分服务器失败，使用同一草稿重新发送只会重试失败项。主题、专属渠道和渠道账号仍按当前连接使用。

在发送或回复时切换页面，返回同一入口可继续编辑。普通发送、从主题发起的通知和给不同用户的回复各自保留草稿。草稿保存在各连接的内存中，断开对应连接即清除。单台服务器发送成功后可打开投递详情，查看渠道尝试和已送达的收件箱数。

添加懒猫通知账号或为主题订阅指定设备时，选择列表中的设备即可。列表包含当前懒猫登录用户已注册的在线和离线设备。设备发现需要服务端收到来自微服的登录身份；单独使用雁字账号登录时，可从懒猫应用入口打开雁字完成选择。已有账号只有在主动更换接收设备时才更新目标。

渠道账号使用「出站代理」选择已保存的代理配置。历史账号默认保留当前连接方式；选择「直连」并保存，将取消该账号的代理。代理地址与认证凭据在「代理配置」中维护。

## 语言和外观

连接页和工作区都可打开「偏好设置」。语言支持简体中文、English 和跟随系统，外观支持浅色、深色和跟随系统。改动即时生效，并通过 NSH Storage 保存在本机。桌面端还可设置关闭窗口时退出应用或留在系统托盘，托盘菜单可重新显示窗口或退出。

Linux 检测到有效的 Omarchy 配色时，外观菜单会额外显示「Omarchy 桌面主题」。选中后，客户端使用桌面主题的配色和方角控件，切换桌面主题时客户端会同步刷新。普通 Linux、Windows、macOS、移动端和 Web 使用雁字自带的主题。

## 开发与打包

客户端使用支持 `nshm` 的 [NSH 源码快照](https://github.com/longbridge/nsh/commit/21080f1cccc081d28c509817d6f95c5e06419251) 和 `nsh-omarchy 0.1.1`。CI 从固定提交构建 CLI 和客户端宿主。Linux 开发需要 GTK、WebKitGTK 6.0、GStreamer 和 GStreamer Base 和 ALSA 的开发包。打包 Web 还需要 Clang、LLVM 和 Rust 的 `wasm32-unknown-unknown` 目标。

从 Anser 仓库根目录执行以下命令。保留 NSH 源码和 `target` 目录，CLI 会从同一份源码构建宿主。

```sh
git init ../nsh-anser
git -C ../nsh-anser fetch --depth 1 https://github.com/longbridge/nsh.git 21080f1cccc081d28c509817d6f95c5e06419251
git -C ../nsh-anser checkout --detach FETCH_HEAD
rustup toolchain install 1.100.0 --profile minimal --target wasm32-unknown-unknown
export RUSTUP_TOOLCHAIN=1.100.0
(cd ../nsh-anser && cargo build --locked --target-dir target -p nsh-cli)
export PATH="$(cd ../nsh-anser && pwd)/target/debug:$PATH"
```

```sh
nsh check clients/nsh
nsh build clients/nsh --release --out clients/nsh/dist/bundle
nsh test clients/nsh
nsh run clients/nsh
nsh package clients/nsh --target linux --out clients/nsh/dist/linux
nsh package clients/nsh --target web --out clients/nsh/dist/web
```

Linux 运行需要 GTK 4.14+、WebKitGTK 6.0、GStreamer 和 ALSA 动态库。解压 Linux 包后，在解压目录运行 `./App`。Web 包可部署到静态站点，Anser 服务端的 `ANSER_CORS_ORIGINS` 需要包含该站点源，例如 `https://app.example.com`。连接地址应为 HTTPS 服务器源。开发环境允许使用本机回环地址的 HTTP。

使用 `nsh package clients/nsh --target ios` 或 `--target android` 生成移动端应用。iOS 真机分发需要签名和 Provisioning Profile。安卓正式发布需使用发行密钥。平台工具链及签名参数见 [NSH 打包指南](https://nsh.dev/docs/packaging.md)。

## 二维码配对与通知

1. 在 Anser 管理界面生成短时配对二维码。
2. 在手机上用系统相机扫描二维码，再点开系统识别出的雁字连接链接。也可以复制连接链接，在客户端连接页选择「导入连接链接」。
3. 核对应用显示的服务器地址，确认后客户端才向该 HTTPS 服务器提交一次性配对码。配对码过期时可回到管理界面重新生成。

移动端安装包注册了 `anser://` scheme。Web 环境可粘贴配对链接。

从收件箱进入「通知设置」，开启系统通知并发送一条测试通知。已登录的服务器均可接收新消息；点击系统通知可回到对应服务器。Omarchy 和其他 Linux 桌面通过 Freedesktop 通知服务接收提醒，与 `notify-send` 使用同一个服务。Windows 使用系统 Toast，macOS 和 iOS 使用 UserNotifications，Android 使用 NotificationManager。Web 提醒取决于 HTTPS、浏览器支持和站点授权。

客户端通过长轮询接收新消息，需要应用运行且系统允许请求继续执行。应用挂起或关闭时，新消息保留在服务端收件箱，重新打开可查看。通知正文始终在应用内查看。语音用原生播放器播放。Linux 的 GTK 媒体后端无法播放 MP3 时，客户端使用自带的 MP3 解码和 ALSA 音频输出。

NSH headless 测试使用本地请求 mock 覆盖远程 HTTP 凭据限制、登录、发送、投递尝试详情、配对、Topic 密码和收件箱。设备侧通知授权和相机的链接交接取决于系统平台。
