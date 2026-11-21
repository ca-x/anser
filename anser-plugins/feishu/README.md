# 飞书 / Lark

渠道 ID 为 `feishu`。支持[自定义机器人 webhook](example.json)和[企业自建应用](example.app.json)。Lark 应用使用 `"region": "lark"`。自建应用需要消息发送权限，接收目标须在机器人可见范围内。订阅目标仅适用于应用模式，可覆盖 `receive_id` 和 `receive_id_type`。

默认发送文本。传入 `extras.feishu_card` JSON 对象可发送互动卡片。若配置了 webhook 签名密钥，部署机需要保持时间同步。应用令牌由渠道缓存，在过期前自动刷新。

| 下游结果 | 是否重试 |
| --- | --- |
| HTTP 408、429、5xx、连接失败，或飞书限流与暂时不可用 | 是 |
| 无效配置、签名、凭据、接收目标、卡片格式 | 否 |
