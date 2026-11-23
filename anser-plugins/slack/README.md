# Slack

渠道 ID 为 `slack`。安装 Slack 应用，授予机器人 `chat:write` 权限，并将 Bot User OAuth Token 填入 `bot_token`。`channel_id` 填目标会话的 ID。发送到频道时，机器人需要具备发言权限。订阅目标可覆盖会话 ID。

Anser 调用 `chat.postMessage`，以纯文本合并标题、正文和消息 URL，总长度上限为 4,000 个字符。

| 下游结果 | 分类 |
| --- | --- |
| 返回 `ok=true` | 成功 |
| 限流、服务不可用、内部错误或请求超时 | 可重试 |
| 令牌无效、权限缺失、会话错误或其他业务错误 | 不可重试 |
| 其他 HTTP 或网络错误 | 参见共用网络分类 |

使用代理时需放行 `slack.com`。[配置示例](example.json) · [Slack API](https://docs.slack.dev/reference/methods/chat.postMessage/) · [共用网络分类](../http/README.md)
