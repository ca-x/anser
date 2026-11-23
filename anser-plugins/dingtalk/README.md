# 钉钉

渠道 ID 为 `dingtalk`。在钉钉群的机器人设置中添加自定义机器人，将完整的 HTTPS Webhook 填入 `webhook`。启用加签后，将签名密钥填入 `signing_secret`。Anser 为每次请求生成时间戳和签名。Webhook 中的访问令牌与签名密钥都需保密。

渠道支持纯文本和 Markdown，HTML 转为纯文本。内容合并标题、正文和消息 URL，限制为 20,000 字节。Markdown 消息另有上限为 256 个字符的标题字段。

| 下游结果 | 分类 |
| --- | --- |
| 业务码 `errcode=0` | 成功 |
| 业务码 429、500 至 599、130101 或 130102 | 可重试 |
| 签名、访问令牌、安全设置或其他业务错误 | 不可重试 |
| 其他 HTTP 或网络错误 | 参见共用网络分类 |

使用代理时需放行 `oapi.dingtalk.com`。[配置示例](example.json) · [钉钉机器人文档](https://open.dingtalk.com/document/orgapp/custom-robot-access) · [共用网络分类](../http/README.md)
