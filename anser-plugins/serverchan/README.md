# Server酱

在配置界面填入 SendKey 即可。微信推送使用 [Server酱 Turbo](https://sct.ftqq.com/sendkey) 的 `SCT…`，App 推送使用 [Server酱³](https://sc3.ft07.com/sendkey) 的 `sctp<数字>t…`。插件根据 SendKey 自动识别版本。API 仍支持 `version`、Turbo 的 `channel`、`openid` 和 `noip`，以及 Server酱³ 的 `tags`。通过配置界面更换 SendKey 时，旧版本专属选项会清除。

未填写标题时，取正文中第一行可读文本作为标题，正文仍完整发送至渠道长度上限。标题最多 32 字符，正文可使用 Markdown。可设 `short` 作为通知卡片摘要。

| 情况 | 分类 |
| --- | --- |
| HTTP 2xx，返回 code=0 | 成功 |
| HTTP 限流、超时和 5xx，以及对应业务代码 | 可重试 |
| 其他非零业务代码 | 不可重试 |
| HTTP 错误或网络故障 | [共用网络分类](../http/README.md) |

[官方 SDK](https://github.com/easychen/serverchan-sdk) · [配置示例](example.json)

## 以 Server酱格式投递到雁字

先在管理后台「插件管理」中启用该渠道的入口开关。使用具有 `send` 权限的雁字 Bearer 密钥。路径中的 `alerts` 是已配置的雁字主题名称，入口会应用该主题的路由与订阅。使用 `/send` 可以投递至空间默认路由。Server酱签发的 SendKey 仅用于出口账号。

```sh
curl "$ANSER_URL/v1/receive/serverchan/alerts.send" \
  -H "Authorization: Bearer $ANSER_KEY" \
  --data-urlencode 'title=备份完成' --data-urlencode 'desp=数据库已备份'

curl "$ANSER_URL/v1/receive/serverchan/send" \
  -H "Authorization: Bearer $ANSER_KEY" \
  --json '{"title":"备份完成","desp":"**数据库**已备份","tags":"备份|每日"}'
```

两条路由均使用 POST，支持 JSON 和 URL 编码表单。必填 `title`（别名 `text`），最多 32 字符。`desp` 是 Markdown 正文，最多 32768 字节。`tags` 是以 `|` 分隔的标签，映射到雁字消息标签；可选摘要 `short` 保存到 `extras.serverchan_short`。入队后返回 HTTP 200，`code` 为 0，`data.pushid` 是可用于查询雁字投递记录的字符串消息 ID。

官方 JavaScript SDK `serverchan-sdk` 1.0.7 将目标域名固定为 Server酱服务。使用该 SDK 对接雁字时，需要由调用方重定向请求至雁字入口并添加 Bearer 头。支持自定义 URL 和请求头的脚本可以直接使用上例。
