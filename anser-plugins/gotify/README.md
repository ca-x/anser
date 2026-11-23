# Gotify

渠道 ID 为 `gotify`。在 Gotify 的 Applications 页面创建应用，把应用令牌填入 `app_token`。`server_url` 填 Gotify 的根地址。若通过反向代理部署在子路径，保留该前缀。`priority` 默认 0。

Anser 向 `/message` 发送消息，在 `X-Gotify-Key` 请求头中传递令牌。渠道支持纯文本和 Markdown，HTML 转为纯文本。标题上限为 256 个字符，正文上限为 16,384 个字符。消息 URL 用于点击跳转。

| 下游结果 | 分类 |
| --- | --- |
| 返回大于 0 的消息 ID | 成功 |
| HTTP 2xx，响应无法解析或消息 ID 无效 | 可重试 |
| 令牌错误或权限不足 | 不可重试 |
| 其他 HTTP 或网络错误 | 参见共用网络分类 |

账号可选择共享代理配置，也可在 `proxy` 中指定代理地址。[配置示例](example.json) · [Gotify API](https://gotify.net/api-docs) · [共用网络分类](../http/README.md)
