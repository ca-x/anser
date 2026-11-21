# Telegram

向 Telegram Bot API 的 `sendMessage` 方法发送通知。`chat_id` 可用数字或频道的 `@username`。Bot 须拥有对应会话的发送权限。

`parse_mode` 可选 `html`、`markdown`、`markdown_v2`，消息格式相符时生效。过长或格式不符时降为纯文本。标题加正文最多 4096 个 UTF-16 单元。带 URL 的消息附带链接按钮。

| 情况 | 分类 |
| --- | --- |
| HTTP 2xx，响应 `ok=true` | 成功 |
| HTTP 429，或业务代码 429 | 可重试，遵循 Retry-After 或 Bot API `parameters.retry_after` |
| 网络故障、超时、5xx | 可重试 |
| 无权限、找不到会话、无效 token 或参数 | 不可重试 |

[Bot API](https://core.telegram.org/bots/api#sendmessage) · [配置示例](example.json)
