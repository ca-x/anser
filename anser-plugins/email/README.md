# SMTP 邮件

渠道 ID 为 `email`。账户字段见 [example.json](example.json)。`encryption` 默认为 `starttls`（587），也可以设置 `tls`（465）或 `none`（25），各模式都可自定义端口。AUTH 需要 TLS，使用原 SMTP 主机名验证证书。私有中继须由部署者配置 `ANSER_OUTBOUND_ALLOW_HOSTS`。支持纯文本、Markdown 转纯文本和 HTML。订阅目标可覆盖 `to`。

| 下游结果 | 是否重试 |
| --- | --- |
| SMTP 4xx、超时、连接失败 | 是 |
| SMTP 5xx、无效账户配置或邮件地址 | 否 |
