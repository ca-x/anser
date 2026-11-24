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
