# Server酱

`SCT…` 为 Turbo 凭据，`sctp<数字>t…` 为 Server酱³ 凭据。地址由官方 SDK 规则推导，可显式填写 `version` 核对。Turbo 可配 `channel`、`openid` 和 `noip`，Server酱³ 可配 `tags`。

标题最多 32 字符，正文可使用 Markdown。可设 `short` 作为通知卡片摘要。

| 情况 | 分类 |
| --- | --- |
| HTTP 2xx，返回 code=0 | 成功 |
| HTTP 限流、超时和 5xx，以及对应业务代码 | 可重试 |
| 其他非零业务代码 | 不可重试 |
| HTTP 错误或网络故障 | [共用网络分类](../http/README.md) |

[官方 SDK](https://github.com/easychen/serverchan-sdk) · [配置示例](example.json)
