# Bark

支持 Bark V2 的 `/push` 接口，可配置单个设备密钥 `device_key` 或最多 100 个 `device_keys`。`level` 支持 `passive`、`active`、`timeSensitive` 和 `critical`。

将 Bark 客户端的 AES-CBC 密钥填入 `encryption_key` 即启用加密。密钥的 UTF-8 长度为 16、24 或 32 字节，同一账号中的设备须设置相同密钥与加密模式。每条消息使用各自的 IV。设备密钥由服务器路由使用。Markdown 和 HTML 降为纯文本，正文长度限制在加密时更短以预留密文空间。

| 情况 | 分类 |
| --- | --- |
| HTTP 2xx，单设备 code=200 或批量中全部 code=200 | 成功 |
| 设备 code=408、429 或 5xx | 可重试 |
| 设备 code=400、401、403、410 等其他失败 | 不可重试 |
| Batch 未给出所有设备的状态 | 可重试 |
| HTTP 错误或网络故障 | [共用网络分类](../http/README.md) |

批量推送按账号记录结果，部分设备成功、部分设备暂时失败时，重试可能再次触达已接收的设备。

[接口资料](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md) · [配置示例](example.json)
