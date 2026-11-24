# SMTP 邮件

渠道 ID 为 `email`。账户字段见 [example.json](example.json)。`encryption` 默认为 `starttls`（587），也可以设置 `tls`（465）或 `none`（25），各模式都可自定义端口。AUTH 需要 TLS，使用原 SMTP 主机名验证证书。私有中继须由部署者配置 `ANSER_OUTBOUND_ALLOW_HOSTS`。订阅目标可覆盖 `to`。

Web 管理台和 NSH 客户端可选择 QQ 邮箱、网易 163/126、腾讯企业邮、Gmail、iCloud 邮件和 Yahoo 邮箱预设。预设填写 SMTP 主机、端口和加密方式。用户名、授权码或应用专用密码、发件人和收件人由用户填写，也可手动设置 SMTP 连接。

发件人地址使用 `from`，显示名称使用可选的 `from_name`。例如填写 `alerts@example.com` 和 `雁字提醒`，收件人会看到 `雁字提醒 <alerts@example.com>`。省略 `from_name` 时，既有的 `姓名 <地址>` 写法仍有效。

编辑已有账号时可以直接修改发件人、收件人和邮件样式。授权码输入框留空即可保留原凭据。更改 SMTP 主机、端口、加密方式或用户名时，请填写新的授权码。

文本和 Markdown 通知默认使用由 [FerrumEmail](https://github.com/AutomataNexus/FerrumEmail) 渲染的雁字模板，邮件同时包含 HTML 和纯文本版本。Markdown 会先转换为文本。在账号设置中将「邮件样式」改为「纯文本」（`"email_style": "plain"`）即可只发送纯文本。显式提交的 HTML 消息沿用自身排版。

| 下游结果 | 是否重试 |
| --- | --- |
| SMTP 4xx、超时、连接失败 | 是 |
| SMTP 5xx、无效账户配置或邮件地址 | 否 |
