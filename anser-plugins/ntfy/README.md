# ntfy

在自建服务上使用其公开根地址，反向代理安装在子路径时保留该前缀。服务默认使用 `https://ntfy.sh`，优先级默认 3。公开 topic 可以省略认证。私有 topic 使用 bearer token，或同时设置 username 与 password。

消息格式支持 text 和 Markdown，HTML 降为纯文本。正文限制为 4096 字节，标题限制为 256 字节。消息 URL 设置点击跳转。ntfy 接收首个外链附件及文件名，也兼容 `extras.attach`。

| 情况 | 分类 |
| --- | --- |
| HTTP 2xx，返回消息事件及消息 ID | 成功 |
| HTTP 2xx，缺少消息事件或 ID | 可重试 |
| HTTP 错误或网络故障 | [共用网络分类](../http/README.md) |

[发布接口资料](https://docs.ntfy.sh/publish/) · [配置示例](example.json)
