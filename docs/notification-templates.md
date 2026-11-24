# 通知模板

[English](notification-templates.en.md)

在管理台的「通知模板」中创建模板。标题和正文支持 `{{service}}` 一类的占位符，模板格式可选纯文本或 Markdown。管理台「发送通知」可选择已有模板并填写变量。

| 内置模板 ID 和名称 | 变量 |
| --- | --- |
| `builtin.deployment` | `service`、`version`、`environment` |
| `builtin.service_alert` | `service`、`status`、`details` |

## 通过 API 发送

使用拥有 `send` 作用域的 API 密钥或登录会话。调用 `POST /v1/send` 可直接投递，也可以在现有主题上调用 `POST /v1/topics/{name}/publish`。请求从 `template_id` 和 `template_name` 中选一项，`variables` 使用字符串键值。标题、正文和格式由模板提供，标签、路由和回调等字段可继续使用。需要密码的主题仍需按已有权限规则提供 `topic_password`。

```bash
curl --fail-with-body "${ANSER_URL%/}/v1/topics/alerts/publish" \
  -H "Authorization: Bearer ${ANSER_API_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: anser-release-123-production' \
  --data '{"template_name":"builtin.deployment","variables":{"service":"Anser","version":"1.2.3","environment":"production"}}'
```

`202` 表示消息已入队。用同一个密钥和返回的 `message_id` 查询 `GET /v1/messages/{id}`。同一次逻辑发送在 24 小时内重试时使用原幂等键。雁字在消息入队的事务中渲染并保存实际内容，之后修改或删除模板也不会改变已入队、重试或重放的消息。

变量名支持字母、数字和下划线，首字符需为字母或下划线，最多 64 个不同变量。发送时每个占位符都需要值，同一变量可在标题和正文中复用。Markdown 正文会转义变量中的 ASCII 标点，并把换行和控制字符替换为空格。链接可用消息的 `url` 字段传入。

## 管理模板

| 操作 | API |
| --- | --- |
| 列出可访问的模板（支持游标分页） | `GET /v1/templates` |
| 新建 | `POST /v1/templates` |
| 按 ID 查询、更新或删除 | `GET`、`PUT` 或 `DELETE /v1/templates/{id}` |

创建和更新接收 `{name,title,body,format,shared}`。创建时 `shared` 默认为 `false`，更新时省略则保留当前设置。私有模板由所有者在登录会话中使用和管理。全局管理员可以创建和编辑共享模板，有发送权限的 API 密钥可以使用。管理员通过登录会话将共享模板转为私有时，该模板归当前编辑者所有。内置模板只读。若自己的私有模板和共享模板同名，按名称发送会优先选择私有模板。指定 ID 可精准选择。

命令行提供 `anser api templates --help`。运行 `anser api send --topic alerts message.json` 时，JSON 文件可以使用相同的模板字段。
