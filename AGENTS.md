# Anser 开发约定

- Rust 开发使用 rust-best-practices、rust-port 和 security-audit。移植功能时核对参考实现的外部行为、错误分类与凭据边界。
- NSH 客户端使用 nsh 和 nsh-design-guides。UI 与 UX 使用 ui-ux-pro-max、emil-design-eng、apple-design、frontend-design 和 animate。先建立语义主题、复用控件和各平台布局，再实现功能页。
- 首版渠道为 ntfy、Server酱、Bark、SMTP 邮件、懒猫通知、微信公众号、企业微信应用、飞书、Telegram。PushPlus 和 gorush 是实现参考。
- Rust 渠道 crate 依赖 anser-plugin-api，rutis 运行时适配留在 anser-host。保持路由纯逻辑和可注入随机源。渠道提供 JSON Schema、配置示例、错误分类和本地 mock 测试。
- GitHub Actions 构建参考 Raindrop。版本标签发布前运行 fmt、Clippy、测试和 cargo-deny。
- 管理台使用 React 与 Elastic UI，Vite 产物嵌入 Rust 服务端。NSH 独立打包，界面使用 NSH 原生组件。
- 存储设计遵循 ddia-principles。SeaORM 与 SQLite 队列共用连接池。维持事务入队、幂等、租约隔离与至少一次投递语义。新增数据库后端必须通过一致性及故障恢复测试。
- 服务端、Web 和 NSH 统一使用三段式 SemVer。发布标签格式为 `vX.Y.Z`。
- 从 `0.5.5` 之后的发布开始，各通知渠道插件独立维护三段式 SemVer。新增或更新插件时在插件自己的 `Cargo.toml` 声明版本，按该插件的变更递增。服务端、Web 或 NSH 发版时不批量改动插件版本。
