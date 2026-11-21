# 微信公众号

渠道 ID 为 `wechat-mp`。账户需开通模板消息，接收人须符合公众号的推送条件。使用 [example.json](example.json) 创建账户并将 `title_field`、`body_field` 改成实际模板字段。没有显式字段映射时，渠道使用 `first` 和 `remark`。

消息可传 `extras.wechat_mp_data` 覆盖整组模板变量，例如 `{"thing1":{"value":"服务恢复"},"time2":{"value":"2026-11-21 10:00"}}`。订阅目标可覆盖 `openid`。`message.url` 为可选的 HTTP(S) 跳转链接。

渠道缓存 access token，提前刷新，并在微信明确返回令牌过期时重试一次。

| 下游结果 | 是否重试 |
| --- | --- |
| HTTP 408、429、5xx、连接失败，或微信暂时繁忙、接口限流 | 是 |
| 无效的 AppID、Secret、OpenID、模板和模板变量 | 否 |
