# Anser Rust SDK

从 Anser 仓库引用 `crates/anser-sdk`。异步请求使用 Tokio。

```rust,no_run
use anser_sdk::{Client, Message, Publish, SendOptions};

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let key = std::env::var("ANSER_API_KEY")?;
let client = Client::new("https://anser.example.com", &key)?;
let request = Publish {
    message: Message {
        title: "服务恢复".into(),
        body: "API 检查通过".into(),
        ..Message::default()
    },
    ..Publish::default()
};
let result = client.publish_with_options("operations", &request, &SendOptions {
    idempotency_key: Some("api-health-restored-20260101-1".into()),
    ..SendOptions::default()
}).await?;
let detail = client.message(&result.message_id).await?;
println!("{}", detail.status);
# Ok(())
# }
```

可通过 `Client::builder` 配置单次请求超时、操作总超时和退避。发送与发布的重试复用同一个幂等键，默认每次调用生成新键。需要跨进程恢复请求时，由调用方持久化并复用同一个键。

SDK 为读取和支持幂等重试的发送请求处理网络故障、408、429 和 5xx。订阅创建、用户登录和一次性配对交换只尝试一次。SDK 保留 HTTP 状态、API 错误码、错误消息与结构化详情。重定向不会自动跟随。

使用 `Client::builder(...).build()` 初始化未登录客户端。通过 `login(username, password)` 或 `exchange_pair_code(code)` 获取会话，再调用 `with_api_key(&session.token)` 访问收件箱及需要鉴权的 API。远程部署使用 HTTPS。

个人通知可用 `send_inbox(recipient, message)` 单次发送。支持原生收件箱幂等的服务端还可用 `send_inbox_idempotent(recipient, message, key)` 安全重试。回执的 `id` 是收件箱条目编号，`message_id` 用于查询发件历史（旧版服务端可能省略）。详情的 `inbox_deliveries` 表示发送时写入的收件箱数量。收件人阅读后，该数量保持不变。私信的 `inbox_recipient` 保留发送时填写的用户名，Topic 详情仅返回收件箱数量。
