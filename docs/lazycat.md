# 懒猫微服通知

渠道 ID 为 `lazycat`，rutis 服务名为 `anser.channel.lazycat`。Linux 和 macOS 二进制默认编译此渠道，常规发送需要在具备懒猫应用运行环境的实例上执行。服务初始化时延迟加载凭据，其他部署仍可正常启动健康检查。

## 配置与测试发送

在懒猫微服中打开雁字，以雁字管理员登录。创建懒猫通知账号时，从设备列表选择接收端。列表属于当前登录微服的用户，显示设备备注名、名称或型号，以及在线状态。离线设备可以保存为目标，发送时按账号的重试策略处理。已有账号保留原来的用户与设备 ID 配置。

使用本地 CLI 时，可复制 [账号配置示例](../examples/lazycat.json)，填写已知的微服用户 ID 和该用户名下的客户端设备 ID。

```sh
anser channel-schema lazycat
anser test-send lazycat --config examples/lazycat.json --title '雁字测试' --body '这是一条测试通知'
```

插件使用应用运行时挂载的 `/lzcapp/run/certs/{box.crt,app.crt,app.key}` 调用本机网关。网关按用户列出设备，插件从返回结果选择指定在线设备，使用 SDK 签名换取设备令牌，再调用 `NotificationService.Notify`。令牌由 SDK 缓存及刷新。账号 JSON 只保存接收人和设备标识。

默认使用微服本机 Unix socket 访问网关，并用 `box.crt` 校验设备 API 的证书链和主机名。设备使用其他 CA 时，可通过 `ANSER_LAZYCAT_DEVICE_CA` 指定 PEM 证书路径。

旧版微服若没有可验证的设备证书，仅在可信网络内可设置 `ANSER_LAZYCAT_LEGACY_TLS=1`，沿用 Neko 的 SDK 兼容传输。该模式跳过设备端证书链和主机名校验，也允许 SDK 使用可能为明文的 `LZCAPP_API_GATEWAY_ADDRESS` 网关覆盖。测试发送返回成功表示设备 API 已接收通知。

## 设备发现与身份

`GET /v1/channels/lazycat/devices` 需要雁字全局管理权限和当前请求的微服身份。接口使用懒猫 SDK 的 `EndDeviceService.ListEndDevices`，只读当前微服用户名下的设备。返回值可直接生成通知账号配置。

```json
{"user_id":"alice","devices":[{"device_id":"work-laptop","name":"工作电脑","online":true}]}
```

喵喵商店与官方商店使用同一个微服安装包。安装包在设备发现请求上使用懒猫的 request 阶段注入，读取已经认证的 `ctx.safe_uid`。网关覆盖 `X-Anser-Lazycat-Uid` 和 `X-Anser-Lazycat-Proof`，后者与后端的 `ANSER_LAZYCAT_INGRESS_SECRET` 共用该应用独立生成的 64 位十六进制凭据。平台用户信息和凭据只在网关至 Anser 的内部连接上传递。直接连接服务端或提供自定义 `x-hc-user-id` 无法获得设备目录。

遇到 `403 lazycat_identity_required` 时，先登录微服，再从微服入口进入管理台。服务器未配置可信入口时，API 返回 `503 lazycat_identity_unavailable`。设备目录不需要枚举盒子上的用户。设备 API 地址有效期较短，插件在每次发送前按保存的设备 ID 重新解析。

## 消息与错误

Markdown 先转为纯文本。省略标题时，取正文中第一行可读文本作为标题，正文保留至渠道长度上限。标题上限 80 字符，正文上限 240 字符，截断处显示省略号。

| 情况 | 分类 |
| --- | --- |
| 设备离线或缺少 API 地址 | 可重试 |
| 超时、连接故障、设备服务暂时不可用、限流 | 可重试 |
| 设备不属于配置用户，或目标不存在 | 不可重试 |
| 应用凭据、权限或配置无效 | 不可重试 |
| 标题为空或格式不支持 | 不可重试 |
