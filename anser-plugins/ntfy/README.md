# ntfy

在自建服务上使用其公开根地址，反向代理安装在子路径时保留该前缀。服务默认使用 `https://ntfy.sh`，优先级默认 3。公开 topic 可以省略认证。私有 topic 使用 bearer token，或同时设置 username 与 password。

消息格式支持 text 和 Markdown，HTML 降为纯文本。正文限制为 4096 字节，标题限制为 256 字节。消息 URL 设置点击跳转。ntfy 接收首个外链附件及文件名，也兼容 `extras.attach`。

| 情况 | 分类 |
| --- | --- |
| HTTP 2xx，返回消息事件及消息 ID | 成功 |
| HTTP 2xx，缺少消息事件或 ID | 可重试 |
| HTTP 错误或网络故障 | [共用网络分类](../http/README.md) |

[发布接口资料](https://docs.ntfy.sh/publish/) · [配置示例](example.json)

## 以 ntfy 格式投递到雁字

先在管理后台「插件管理」中启用该渠道的入口开关。入口使用雁字的服务器地址与具有 `send` 权限的 Bearer 密钥。将下例中的 `alerts` 替换为已配置的雁字主题，主题路由和订阅决定最终接收目标。接收入站请求无需创建 ntfy 出口账号。

```sh
curl "$ANSER_URL/v1/receive/ntfy/" \
  -H "Authorization: Bearer $ANSER_KEY" \
  --json '{"topic":"alerts","title":"备份完成","message":"数据库已备份","priority":3}'

curl -X PUT "$ANSER_URL/v1/receive/ntfy/alerts" \
  -H "Authorization: Bearer $ANSER_KEY" -H "Title: Backup" -H "Tags: backup" \
  --data-binary '数据库已备份'
```

- `POST /` 接受 ntfy JSON，支持 `topic`、`title`、`message`、`tags`、`priority`（整数 1–5）、`markdown`、`click`、`attach` 和 `filename`。
- `POST /{topic}` 与 `PUT /{topic}` 接受 UTF-8 正文。通过 `Title`、`Tags`（逗号分隔）、`Priority`、`Markdown`、`Click`、`Attach` 和 `Filename` 请求头设置选项，也可使用对应的 `X-` 前缀。点击和附件链接应使用 HTTP(S)。标题最多 256 字节，正文最多 4096 字节。
- 入口适配即时发布。定时发送请使用雁字的定时任务。消息优先级记录到 `extras.ntfy_priority`，并分别映射为 `debug`（1–2）、`info`（3）、`warn`（4）和 `error`（5）。
- 入队后返回 HTTP 200 和 ntfy 消息事件，`id` 是雁字消息 ID，可使用同一身份查询 `GET /v1/messages/{id}` 的实际投递状态。
