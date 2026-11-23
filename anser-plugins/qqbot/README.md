# QQ 机器人

渠道 ID 为 `qqbot`。填写 QQ 开放平台机器人的 `app_id` 和 `app_secret`，并填写目标的 OpenID 或频道 ID。账号可通过 `sandbox` 选择沙箱，默认为关闭。

| `recipient_kind` | `recipient_id` |
| --- | --- |
| `user` | 私聊用户的 OpenID |
| `group`（默认） | 群聊的 OpenID |
| `guild_channel` | QQ 频道子频道的 ID |

机器人需要具备主动发消息的权限。订阅目标可覆盖接收类型和 ID。标题、正文和消息 URL 合并为纯文本，总长度上限为 2,000 个字符。渠道缓存访问令牌，发送遇到 HTTP 401 时会刷新令牌并重新发送一次。

| 下游结果 | 分类 |
| --- | --- |
| 返回消息 ID | 成功 |
| HTTP 2xx，响应无法解析或缺少消息 ID | 可重试 |
| 业务码 429 或 500 至 599 | 可重试 |
| 无可用令牌、刷新后仍被拒绝、无权限或其他业务错误 | 不可重试 |
| 其他 HTTP 或网络错误 | 参见共用网络分类 |

使用代理时需放行 `bots.qq.com` 和对应的生产或沙箱 API 主机。[配置示例](example.json) · [QQ 机器人文档](https://bot.q.qq.com/wiki/develop/api-v2/) · [共用网络分类](../http/README.md)
