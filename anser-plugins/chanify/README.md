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

## 以 Chanify 格式投递到雁字

先在管理后台「插件管理」中启用该渠道的入口开关。`POST /v1/receive/chanify/v1/sender` 接受 UTF-8 纯文本、JSON 和 URL 编码表单。将具有 `send` 权限的雁字密钥放在 Chanify 的 `token` 请求头，或使用雁字 Bearer 认证，消息通过空间默认路由分发。Chanify 服务商令牌仅用于出口账号。

```sh
curl "$ANSER_URL/v1/receive/chanify/v1/sender" \
  -H "token: $ANSER_KEY" -H "Content-Type: text/plain" \
  --data-binary '备份完成'

curl "$ANSER_URL/v1/receive/chanify/v1/sender" \
  -H "Authorization: Bearer $ANSER_KEY" \
  --json '{"title":"构建","text":"所有测试通过","priority":10,"sound":1}'
```

正文 `text` 必填，限 1500 字节。可选标题 `title` 限 240 字节。`sound`（0 或 1）和 `priority`（5 或 10）分别保存在 `extras.chanify_sound` 和 `extras.chanify_priority`。入队后返回 HTTP 200，`res` 为 0，`request-uid` 是雁字消息 ID。
