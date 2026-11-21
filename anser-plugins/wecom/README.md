# 企业微信应用

渠道 ID 为 `wecom`。从企业微信应用管理页获取企业 ID、应用 ID 和 Secret。参考 [example.json](example.json)。`touser` 默认 `@all`，也可限定为用 `|` 分隔的企业成员 ID。订阅目标可覆盖 `touser`。

请将 Anser 的出口 IP 加入应用的企业可信 IP。个人微信是否显示通知取决于企业微信的微信插件及成员配置。渠道缓存应用令牌，并启用企业微信的 600 秒内容去重。企业微信确认已抑制重复消息时返回成功。

支持纯文本、Markdown 和图片。通过 `extras.wecom_image` 上传图片，例如 `{"base64":"<base64>","filename":"notice.png","content_type":"image/png"}`。也可通过 `attachments` 提供单个 HTTP(S) 图片 URL，下载受出站网络策略约束。图片为 JPEG、PNG 或 GIF，解码后上限 2 MiB。渠道先上传到企业微信取得 `media_id`，再发送图像通知。

| 下游结果 | 是否重试 |
| --- | --- |
| HTTP 408、429、5xx、连接失败，或企业微信暂时繁忙、接口限流 | 是 |
| 凭据、接收目标、余量或请求无效 | 否 |
| 返回 60020 等可信 IP 错误 | 否，需配置应用可信 IP |
