# Discord

渠道 ID 为 `discord`。在目标频道的集成设置中创建 Webhook，将完整地址填入 `webhook`。支持 `discord.com` 或 `discordapp.com` 下的官方 HTTPS Webhook 地址。Webhook 路径包含访问令牌，应当保密。

Anser 将标题、正文和消息 URL 合并为纯文本，总长度上限为 2,000 个字符。发送时设置 `allowed_mentions.parse=[]`，避免通知触发用户、角色或全体提及。

| 下游结果 | 分类 |
| --- | --- |
| 使用 `wait=true` 发送后返回消息 ID | 成功 |
| HTTP 2xx，响应无法解析或消息 ID 为空 | 可重试 |
| Webhook 无效、已删除或无权限 | 不可重试 |
| 其他 HTTP 或网络错误 | 参见共用网络分类 |

使用代理时需放行 Webhook 对应的 Discord 主机。[配置示例](example.json) · [Discord Webhook API](https://docs.discord.com/developers/resources/webhook#execute-webhook) · [共用网络分类](../http/README.md)
