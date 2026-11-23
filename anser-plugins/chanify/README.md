# Chanify

渠道 ID 为 `chanify`。从 Chanify 客户端创建或复制发送令牌，并填入 `token`。`server_url` 默认使用 `https://api.chanify.net`，也可填写自建节点的根地址。`sound` 默认关闭。普通优先级填 10，低优先级填 5，默认使用 10。

Anser 通过 `/v1/sender` 发送消息，并在 `token` 请求头中传递令牌。部署在反向代理子路径时，保留 `server_url` 的路径前缀。Markdown 和 HTML 转为纯文本。标题上限为 240 字节，正文和消息 URL 合计上限为 1,500 字节。

| 下游结果 | 分类 |
| --- | --- |
| 业务码为 0、200 或省略，并返回非空的 `request-uid` | 成功 |
| 业务码 408、429 或 500 至 599 | 可重试 |
| 成功状态缺少 `request-uid`、令牌无效或其他业务错误 | 不可重试 |
| 其他 HTTP 或网络错误 | 参见共用网络分类 |

账号可选择共享代理配置，也可在 `proxy` 中指定代理地址。[配置示例](example.json) · [Chanify 文档](https://github.com/chanify/chanify) · [共用网络分类](../http/README.md)
