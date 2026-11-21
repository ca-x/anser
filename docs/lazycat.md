# 懒猫微服通知

渠道 ID 为 `lazycat`，rutis 服务名为 `anser.channel.lazycat`。Linux 和 macOS 二进制默认编译此渠道，常规发送需要在具备懒猫应用运行环境的实例上执行。服务初始化时延迟加载凭据，其他部署仍可正常启动健康检查。

## 配置与测试发送

复制 [账号配置示例](../examples/lazycat.json)，填写微服用户 ID 和该用户名下的客户端设备 ID。

```sh
anser channel-schema lazycat
anser test-send lazycat --config examples/lazycat.json --title '雁字测试' --body '这是一条测试通知'
```

插件使用应用运行时挂载的 `/lzcapp/run/certs/{box.crt,app.crt,app.key}` 调用本机网关。网关按用户列出设备，插件从返回结果选择指定在线设备，使用 SDK 签名换取设备令牌，再调用 `NotificationService.Notify`。令牌由 SDK 缓存及刷新。账号 JSON 只保存接收人和设备标识。

默认使用微服本机 Unix socket 访问网关，并用 `box.crt` 校验设备 API 的证书链和主机名。设备使用其他 CA 时，可通过 `ANSER_LAZYCAT_DEVICE_CA` 指定 PEM 证书路径。

旧版微服若没有可验证的设备证书，仅在可信网络内可设置 `ANSER_LAZYCAT_LEGACY_TLS=1`，沿用 Neko 的 SDK 兼容传输。该模式跳过设备端证书链和主机名校验，也允许 SDK 使用可能为明文的 `LZCAPP_API_GATEWAY_ADDRESS` 网关覆盖。测试发送返回成功表示设备 API 已接收通知。

## 消息与错误

Markdown 先转为纯文本。省略标题时，取正文中第一行可读文本作为标题，正文保留至渠道长度上限。标题上限 80 字符，正文上限 240 字符，截断处显示省略号。

| 情况 | 分类 |
| --- | --- |
| 设备离线或缺少 API 地址 | 可重试 |
| 超时、连接故障、设备服务暂时不可用、限流 | 可重试 |
| 设备不属于配置用户，或目标不存在 | 不可重试 |
| 应用凭据、权限或配置无效 | 不可重试 |
| 标题为空或格式不支持 | 不可重试 |
