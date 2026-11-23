# IFTTT

渠道 ID 为 `ifttt`。在 IFTTT Applet 中选择 Webhooks 的事件触发器，填写同名的 `event_name`。将 Webhooks 页面提供的密钥填入 `webhook_key`。

| Applet 字段 | Anser 消息 |
| --- | --- |
| `Value1` | 标题，上限为 4,096 个字符 |
| `Value2` | 纯文本正文，上限为 4,096 个字符 |
| `Value3` | HTTP(S) 消息 URL |

| 下游结果 | 分类 |
| --- | --- |
| Webhooks 返回 HTTP 2xx，事件已接收 | 成功 |
| 事件或密钥错误，或无权限 | 不可重试 |
| 其他 HTTP 或网络错误 | 参见共用网络分类 |

投递状态表示 IFTTT 是否接收了事件。Applet 的后续动作结果可在 IFTTT 中查看。使用代理时需放行 `maker.ifttt.com`。[配置示例](example.json) · [IFTTT Webhooks](https://ifttt.com/maker_webhooks) · [共用网络分类](../http/README.md)
