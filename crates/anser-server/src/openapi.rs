use axum::Json;
use serde_json::{Map, Value, json};

pub async fn document() -> Json<Value> {
    let mut paths = Map::new();
    for (path, operations) in [
        ("/v1/health", &["GET / Health check"][..]),
        ("/v1/info", &["GET / Server version"]),
        (
            "/v1/auth/profile",
            &[
                "GET / Read your personal profile",
                "PUT / Replace your personal profile",
            ],
        ),
        ("/v1/auth/login", &["POST / Create a login session"]),
        ("/v1/auth/me", &["GET / Current user"]),
        ("/v1/auth/logout", &["POST / Revoke current login session"]),
        ("/v1/auth/pair", &["POST / Create single-use pairing code"]),
        (
            "/v1/auth/totp",
            &["GET / Read the current user's TOTP status"],
        ),
        (
            "/v1/auth/totp/setup",
            &["POST / Begin TOTP setup in the current session"],
        ),
        (
            "/v1/auth/totp/confirm",
            &["POST / Confirm TOTP and receive single-use recovery codes"],
        ),
        (
            "/v1/auth/totp/disable",
            &["POST / Disable TOTP with the current password and a code"],
        ),
        ("/v1/auth/pair/exchange", &["POST / Exchange pairing code"]),
        ("/v1/users", &["GET / List users", "POST / Create user"]),
        ("/v1/users/{id}", &["PUT / Update user"]),
        (
            "/v1/api-keys",
            &["GET / List API keys", "POST / Issue API key"],
        ),
        ("/v1/api-keys/{id}", &["DELETE / Disable API key"]),
        ("/v1/api-keys/{id}/rotate", &["POST / Rotate API key"]),
        (
            "/v1/proxies",
            &[
                "GET / List outbound proxy profiles",
                "POST / Create an outbound proxy profile",
            ],
        ),
        (
            "/v1/proxies/{id}",
            &[
                "GET / Read outbound proxy profile metadata",
                "PUT / Update an outbound proxy profile",
                "DELETE / Delete an unassigned proxy profile",
            ],
        ),
        (
            "/v1/proxies/{id}/test",
            &["POST / Test an outbound proxy with an HTTPS request"],
        ),
        (
            "/v1/accounts",
            &[
                "GET / List channel accounts",
                "POST / Create channel account",
            ],
        ),
        (
            "/v1/accounts/{id}",
            &[
                "GET / Read account metadata",
                "PUT / Update account",
                "DELETE / Delete account",
            ],
        ),
        ("/v1/accounts/{id}/test", &["POST / Test channel account"]),
        (
            "/v1/plugins",
            &["GET / List installed plugins by capability"],
        ),
        (
            "/v1/plugins/market",
            &["GET / Search public GitHub plugin repositories"],
        ),
        (
            "/v1/schedules",
            &[
                "GET / List scheduled pushes",
                "POST / Create a scheduled push",
            ],
        ),
        (
            "/v1/schedules/{id}",
            &[
                "GET / Read a schedule and its editable options",
                "PATCH / Edit a schedule",
                "PUT / Pause or resume a schedule",
                "DELETE / Delete a schedule",
            ],
        ),
        (
            "/v1/settings/history-retention",
            &[
                "GET / Read the delivery history retention settings",
                "PUT / Set delivery history retention",
            ],
        ),
        (
            "/v1/schedules/{id}/run",
            &["POST / Request an immediate run"],
        ),
        (
            "/v1/plugins/task/{id}/run",
            &["POST / Run one task and return notification drafts (global administrator only)"],
        ),
        (
            "/v1/plugins/content_transform/{id}/run",
            &["POST / Transform one notification (global administrator only)"],
        ),
        (
            "/v1/channels",
            &["GET / List plugin schemas and capabilities"],
        ),
        (
            "/v1/channels/lazycat/devices",
            &[
                "GET / List the signed-in LazyCat platform user's devices (global administrator and authenticated LazyCat ingress required)",
            ],
        ),
        (
            "/v1/channels/{id}",
            &["GET / Read plugin schema and capabilities"],
        ),
        (
            "/v1/channels/{id}/runtime",
            &["PUT / Set durable plugin enablement or reload a plugin"],
        ),
        (
            "/v1/default-route",
            &["GET / Read default policy", "PUT / Update default policy"],
        ),
        ("/v1/topics", &["GET / List Topics", "POST / Create Topic"]),
        (
            "/v1/topics/{name}",
            &[
                "GET / Read Topic",
                "PUT / Update Topic",
                "DELETE / Delete Topic",
            ],
        ),
        (
            "/v1/topics/{name}/subscriptions",
            &["GET / List subscriptions", "POST / Subscribe"],
        ),
        (
            "/v1/topics/{name}/subscriptions/{id}",
            &["DELETE / Unsubscribe and cancel queued deliveries"],
        ),
        ("/v1/topics/{name}/publish", &["POST / Publish a message"]),
        ("/v1/send", &["POST / Submit a message"]),
        (
            "/v1/templates",
            &[
                "GET / List visible notification templates",
                "POST / Create a notification template",
            ],
        ),
        (
            "/v1/templates/{id}",
            &[
                "GET / Read a notification template",
                "PUT / Replace a notification template",
                "DELETE / Delete a notification template",
            ],
        ),
        ("/v1/messages", &["GET / List messages"]),
        ("/v1/messages/{id}", &["GET / Read deliveries and attempts"]),
        (
            "/v1/messages/{id}/replay",
            &["POST / Replay a terminal failure"],
        ),
        (
            "/v1/inbox",
            &["GET / Read or wait for a native notification"],
        ),
        (
            "/v1/settings/mcp",
            &["GET / Read the configured MCP address"],
        ),
        (
            "/v1/interactions",
            &["POST / Send a question to a user inbox"],
        ),
        (
            "/v1/interactions/{id}",
            &["GET / Read the response for the issuing credential"],
        ),
        (
            "/v1/inbox/{id}/interaction",
            &[
                "GET / Read a received interaction form",
                "POST / Submit the recipient's response",
            ],
        ),
        ("/v1/inbox/send", &["POST / Send a native notification"]),
        (
            "/v1/inbox/{id}/read",
            &["POST / Mark a notification as read"],
        ),
        (
            "/v1/speech/send",
            &["POST / Synthesize and send a voice notification"],
        ),
        (
            "/v1/speech/audio/{file}",
            &["GET / Play a retained voice notification"],
        ),
        ("/v1/statistics", &["GET / Queue statistics"]),
        ("/v1/metrics", &["GET / Prometheus metrics"]),
    ] {
        let mut methods = Map::new();
        for spec in operations {
            let (method, summary) = spec.split_once(" / ").unwrap();
            let public = matches!(
                path,
                "/v1/health"
                    | "/v1/info"
                    | "/v1/auth/login"
                    | "/v1/auth/pair/exchange"
                    | "/v1/speech/audio/{file}"
            );
            let mut method_params: Vec<_> = path.split('/').filter_map(|segment| segment.strip_prefix('{')?.strip_suffix('}'))
                .map(|name| json!({"name":name,"in":"path","required":true,"schema":{"type":"string"}})).collect();
            let publishes = path == "/v1/send" || path.ends_with("/publish");
            if publishes || matches!(path, "/v1/inbox/send" | "/v1/speech/send") {
                method_params.push(json!({"name":"Idempotency-Key","in":"header","description":"Repeat the same key with the same credential within 24 hours to retrieve the original receipt. Native sends use a separate key space.","schema":{"type":"string","pattern":"^[!-~]{1,128}$"}}));
            }
            if publishes {
                method_params.extend([
                    json!({"name":"wait","in":"query","schema":{"type":"boolean"}}),
                    json!({"name":"timeout_ms","in":"query","schema":{"type":"integer","maximum":30000}}),
                ]);
            }
            if method == "GET"
                && matches!(
                    path,
                    "/v1/accounts"
                        | "/v1/topics"
                        | "/v1/messages"
                        | "/v1/templates"
                        | "/v1/users"
                        | "/v1/api-keys"
                        | "/v1/proxies"
                        | "/v1/schedules"
                        | "/v1/inbox"
                        | "/v1/topics/{name}/subscriptions"
                )
            {
                method_params.extend([
                    json!({"name":"cursor","in":"query","schema":{"type":"string"}}),
                    json!({"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":100}}),
                ]);
            }
            if path == "/v1/plugins/market" {
                method_params.extend([
                    json!({"name":"q","in":"query","schema":{"type":"string"}}),
                    json!({"name":"cursor","in":"query","schema":{"type":"integer","minimum":1,"maximum":50}}),
                ]);
            }
            if path == "/v1/inbox" {
                method_params.push(json!({"name":"wait","in":"query","schema":{"type":"boolean"}}));
            }
            if method == "GET" && path == "/v1/api-keys" {
                method_params.push(json!({"name":"scope","in":"query","description":"Filter by an explicit API key scope.","schema":{"type":"string"}}));
            }
            if method == "GET" && path == "/v1/accounts" {
                method_params.push(json!({"name":"channel","in":"query","description":"Filter by channel plugin ID","schema":{"type":"string"}}));
            }
            if path == "/v1/channels/lazycat/devices" {
                method_params.push(json!({"name":"account_id","in":"query","description":"Optionally preselect a LazyCat account's devices belonging to the current LazyCat identity","schema":{"type":"string"}}));
            }
            let mut operation = json!({
                "summary": summary,
                "security": if public { json!([]) } else { json!([{"bearerAuth":[]}]) },
                "parameters": method_params,
                "responses":{"200":{"description":"Success"},"default":{"$ref":"#/components/responses/Error"}}
            });
            if path == "/v1/speech/audio/{file}" {
                operation["parameters"]
                    .as_array_mut()
                    .expect("parameters array")
                    .push(json!({"name":"Range","in":"header","schema":{"type":"string"}}));
                for status in ["200", "206"] {
                    operation["responses"][status] = json!({"description":"MP3 audio","content":{"audio/mpeg":{"schema":{"type":"string","format":"binary"}}}});
                }
                operation["responses"]["416"] = json!({"description":"Invalid byte range"});
            }
            if method == "DELETE"
                || path.ends_with("/logout")
                || path.ends_with("/read")
                || (method == "PUT" && path == "/v1/schedules/{id}")
            {
                operation["responses"]["204"] =
                    json!({"description":"Resource changed successfully"});
            }
            if publishes || path.ends_with("/replay") || path == "/v1/speech/send" {
                operation["responses"]["202"] = json!({"description":"Message persisted","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Receipt"}}}});
            }
            if let Some(body) = request_schema(path, method) {
                operation["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":reference(body)}}});
            }
            if let Some((code, schema)) = success_schema(path, method) {
                operation["responses"][code] = json!({"description":"Success","content":{"application/json":{"schema":schema}}});
            }
            if path == "/v1/auth/login" {
                operation["responses"]["401"] = json!({
                    "description":"Invalid credentials, totp_required after a valid password, or invalid_totp for an invalid or used code",
                    "content":{"application/json":{"schema":reference("Error")}}
                });
            } else if path.starts_with("/v1/auth/totp") {
                operation["description"] = json!(
                    "Requires a user session. Confirming or disabling TOTP revokes other sessions and outstanding pairing codes."
                );
            }
            if path.starts_with("/v1/templates") {
                operation["description"] = json!(
                    "Requires send access. Signed-in users can use and edit their private templates. Anyone with send access can use shared and built-in templates. Only global administrators can create or edit shared templates. Built-in templates are read-only."
                );
            }
            if publishes {
                operation["description"] = json!(
                    "Send literal content or use a stored template by ID or name. The rendered title, body and format are persisted with the message. The original rendered content is retained for delivery, replay and idempotent retries."
                );
                for (code, description) in [
                    (
                        "400",
                        "An invalid request, missing or extra template variables, or invalid rendered content",
                    ),
                    (
                        "404",
                        "A template or Topic does not exist or is not visible to the current caller",
                    ),
                ] {
                    operation["responses"][code] = json!({"description":description,"content":{"application/json":{"schema":reference("Error")}}});
                }
            }
            if path == "/v1/auth/profile" {
                operation["description"] = json!(
                    "Requires a login session. Updates replace both fields. Send null to clear a field."
                );
            }
            if path == "/v1/channels/lazycat/devices" {
                operation["description"] = json!(
                    "Device discovery uses the verified current platform identity from the LazyCat ingress. No user selector is accepted. Offline devices can be selected for future delivery. An optional account ID returns its saved device selections only when the configured UID matches the verified identity."
                );
                for (code, description) in [
                    (
                        "403",
                        "forbidden: global administrator access is required; lazycat_identity_required: open the application through your signed-in LazyCat ingress",
                    ),
                    (
                        "503",
                        "lazycat_identity_unavailable: no trusted ingress is configured; channel_unavailable: the plugin is disabled or unavailable",
                    ),
                    (
                        "422",
                        "channel_error: the LazyCat gateway could not list devices; details.provider_code identifies the provider error",
                    ),
                ] {
                    operation["responses"][code] = json!({"description":description,"content":{"application/json":{"schema":reference("Error")}}});
                }
            }
            if method == "DELETE" && path == "/v1/proxies/{id}" {
                operation["responses"]["409"] = json!({
                    "description":"proxy_in_use: one or more channel accounts reference this proxy",
                    "content":{"application/json":{"schema":reference("Error")}}
                });
            }
            methods.insert(method.to_ascii_lowercase(), operation);
        }
        paths.insert(path.into(), Value::Object(methods));
    }
    paths.insert(
        "/v1/topics/{name}/plugin-listings".into(),
        crate::plugin_market::openapi_path(),
    );
    Json(json!({
        "openapi":"3.0.3",
        "info":{"title":"Anser API","version":env!("CARGO_PKG_VERSION")},
        "paths":paths,
        "components":{
            "securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"}},
            "responses":{"Error":{"description":"Anser request error","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Error"}}}}},
            "schemas": schemas()
        }
    }))
}

fn reference(name: &str) -> Value {
    json!({"$ref":format!("#/components/schemas/{name}")})
}

fn page(item: &str) -> Value {
    json!({"type":"object","required":["items","next_cursor"],"properties":{
        "items":{"type":"array","items":reference(item)},
        "next_cursor":{"type":"string","nullable":true}
    }})
}

fn request_schema(path: &str, method: &str) -> Option<&'static str> {
    match (method, path) {
        ("POST", "/v1/auth/login") => Some("Login"),
        ("POST", "/v1/auth/totp/setup") => Some("TotpSetupInput"),
        ("POST", "/v1/auth/totp/confirm") => Some("TotpConfirmInput"),
        ("POST", "/v1/auth/totp/disable") => Some("TotpDisableInput"),
        ("POST", "/v1/auth/pair") => Some("PairSettings"),
        ("POST", "/v1/auth/pair/exchange") => Some("PairCode"),
        ("POST", "/v1/users") => Some("UserInput"),
        ("PUT", "/v1/users/{id}") => Some("UserUpdate"),
        ("PUT", "/v1/auth/profile") => Some("UserProfile"),
        ("POST", "/v1/api-keys") => Some("KeyInput"),
        ("POST", "/v1/proxies") => Some("ProxyCreate"),
        ("PUT", "/v1/proxies/{id}") => Some("ProxyUpdate"),
        ("POST", "/v1/proxies/{id}/test") => Some("ProxyTest"),
        ("POST", "/v1/accounts") => Some("AccountCreate"),
        ("PUT", "/v1/accounts/{id}") => Some("AccountUpdate"),
        ("POST", "/v1/accounts/{id}/test") => Some("Message"),
        ("POST", "/v1/schedules") => Some("ScheduleInput"),
        ("PUT", "/v1/settings/history-retention") => Some("HistoryRetention"),
        ("PUT", "/v1/schedules/{id}") => Some("ScheduleState"),
        ("PATCH", "/v1/schedules/{id}") => Some("ScheduleEdit"),
        ("POST", "/v1/plugins/task/{id}/run") => Some("PluginTaskInput"),
        ("POST", "/v1/plugins/content_transform/{id}/run") => Some("PluginTransformInput"),
        ("PUT", "/v1/channels/{id}/runtime") => Some("ChannelChange"),
        ("PUT", "/v1/default-route") => Some("Policy"),
        ("POST", "/v1/topics") | ("PUT", "/v1/topics/{name}") => Some("TopicInput"),
        ("POST", "/v1/topics/{name}/subscriptions") => Some("SubscriptionInput"),
        ("POST", "/v1/send" | "/v1/topics/{name}/publish") => Some("Publish"),
        ("POST", "/v1/templates") | ("PUT", "/v1/templates/{id}") => Some("TemplateInput"),
        ("POST", "/v1/interactions") => Some("InteractionInput"),
        ("POST", "/v1/inbox/{id}/interaction") => Some("InteractionReply"),
        ("POST", "/v1/inbox/send") => Some("InboxSend"),
        ("POST", "/v1/speech/send") => Some("SpeechSend"),
        _ => None,
    }
}

fn success_schema(path: &str, method: &str) -> Option<(&'static str, Value)> {
    let (code, schema) = match (method, path) {
        ("POST", "/v1/auth/login" | "/v1/auth/pair/exchange") => ("200", reference("Session")),
        ("GET", "/v1/auth/totp") | ("POST", "/v1/auth/totp/disable") => {
            ("200", reference("TotpStatus"))
        }
        ("POST", "/v1/auth/totp/setup") => ("200", reference("TotpSetup")),
        ("POST", "/v1/auth/totp/confirm") => ("200", reference("TotpConfirmation")),
        ("GET", "/v1/info") => (
            "200",
            json!({"type":"object","required":["version"],"properties":{"version":{"type":"string","example":env!("CARGO_PKG_VERSION")}}}),
        ),
        ("GET" | "PUT", "/v1/auth/profile") => ("200", reference("UserProfile")),
        ("GET", "/v1/auth/me") | ("PUT", "/v1/users/{id}") => ("200", reference("User")),
        ("POST", "/v1/auth/pair") => ("200", reference("PairResult")),
        ("POST", "/v1/users") => ("201", reference("User")),
        ("GET", "/v1/users") => ("200", page("User")),
        ("GET", "/v1/api-keys") => ("200", page("ApiKey")),
        ("POST", "/v1/api-keys") => ("201", reference("IssuedKey")),
        ("POST", "/v1/api-keys/{id}/rotate") => ("200", reference("IssuedKey")),
        ("GET", "/v1/proxies") => ("200", page("Proxy")),
        ("POST", "/v1/proxies") => ("201", reference("Proxy")),
        ("POST", "/v1/proxies/{id}/test") => ("200", reference("ProxyTestResult")),
        ("GET" | "PUT", "/v1/proxies/{id}") => ("200", reference("Proxy")),
        ("GET", "/v1/accounts") => ("200", page("Account")),
        ("POST", "/v1/accounts") => ("201", reference("Account")),
        ("GET" | "PUT", "/v1/accounts/{id}") => ("200", reference("Account")),
        ("GET", "/v1/plugins/market") => ("200", page("GithubPlugin")),
        ("GET", "/v1/settings/mcp") => (
            "200",
            json!({"type":"object","properties":{"endpoint":{"type":"string","format":"uri","nullable":true}}}),
        ),
        ("GET" | "PUT", "/v1/settings/history-retention") => ("200", reference("HistoryRetention")),
        ("GET", "/v1/schedules") => ("200", page("Schedule")),
        ("POST", "/v1/schedules") => ("201", reference("Schedule")),
        ("PATCH", "/v1/schedules/{id}") => ("200", reference("Schedule")),
        ("GET", "/v1/schedules/{id}") => ("200", reference("ScheduleDetail")),
        ("POST", "/v1/schedules/{id}/run") => (
            "202",
            json!({"type":"object","properties":{"queued":{"const":true}}}),
        ),
        ("GET", "/v1/plugins") => ("200", page("InstalledPlugin")),
        ("POST", "/v1/plugins/task/{id}/run") => ("200", reference("PluginTaskOutput")),
        ("POST", "/v1/plugins/content_transform/{id}/run") => {
            ("200", reference("PluginTransformOutput"))
        }
        ("GET", "/v1/channels") => ("200", page("Channel")),
        ("GET", "/v1/channels/lazycat/devices") => ("200", reference("LazycatDevices")),
        ("GET", "/v1/channels/{id}") => ("200", reference("Channel")),
        ("PUT", "/v1/channels/{id}/runtime") => ("200", reference("ChannelRuntime")),
        ("GET" | "PUT", "/v1/default-route") => ("200", reference("Policy")),
        ("GET", "/v1/topics") => ("200", page("Topic")),
        ("POST", "/v1/topics") => ("201", reference("Topic")),
        ("GET" | "PUT", "/v1/topics/{name}") => ("200", reference("Topic")),
        ("GET", "/v1/topics/{name}/subscriptions") => ("200", page("Subscription")),
        ("POST", "/v1/topics/{name}/subscriptions") => ("201", reference("Subscription")),
        ("POST", "/v1/send" | "/v1/topics/{name}/publish") => ("200", reference("Receipt")),
        ("POST", "/v1/speech/send") => ("201", reference("Receipt")),
        ("GET", "/v1/templates") => ("200", page("Template")),
        ("POST", "/v1/templates") => ("201", reference("Template")),
        ("GET" | "PUT", "/v1/templates/{id}") => ("200", reference("Template")),
        ("GET", "/v1/messages") => ("200", page("MessageDetail")),
        ("GET", "/v1/messages/{id}") => ("200", reference("MessageDetail")),
        ("POST", "/v1/interactions") => ("201", reference("Interaction")),
        ("GET", "/v1/interactions/{id}") | ("POST", "/v1/inbox/{id}/interaction") => {
            ("200", reference("Interaction"))
        }
        ("GET", "/v1/inbox/{id}/interaction") => ("200", reference("InboxInteraction")),
        ("GET", "/v1/inbox") => ("200", page("InboxItem")),
        ("POST", "/v1/inbox/send") => (
            "201",
            json!({"type":"object","required":["id","message_id"],"properties":{"id":{"type":"integer","format":"int64","description":"Recipient inbox item ID"},"message_id":{"type":"string","description":"Sender receipt in /v1/messages/{id}"}}}),
        ),
        _ => return None,
    };
    Some((code, schema))
}

fn schemas() -> Value {
    let string = json!({"type":"string"});
    let integer = json!({"type":"integer"});
    let time = json!({"type":"integer","format":"int64","description":"UTC milliseconds since Unix epoch"});
    let boolean = json!({"type":"boolean"});
    let secret = json!({"type":"string","writeOnly":true});
    let mode =
        json!({"type":"string","enum":["broadcast","failover","weighted","weighted_failover"]});
    let success = json!({"type":"string","enum":["any","all"]});
    let delivery_status =
        json!({"type":"string","enum":["pending","sending","success","failed","dead","cancelled"]});
    let strings = json!({"type":"array","items":string});
    let key_fields = json!({"name":string,"scopes":{"type":"array","items":{"type":"string","enum":["send","subscribe","admin"]}},"topic_prefix":string,"expires_at":time});
    let account_fields = json!({"name":string,"channel":string,"enabled":boolean,"tags":strings,"weight":integer,"priority":integer,"rate_limit":{"type":"integer","nullable":true,"minimum":1},"proxy_id":{"type":"string","nullable":true,"description":"Proxy profile used at delivery. Omit when updating to preserve the assignment. Null clears it."}});
    let mut account_in = account_fields.clone();
    account_in["config"] =
        json!({"type":"object","writeOnly":true,"description":"See the channel's config_schema."});
    let mut account_update = account_in.clone();
    account_update["inline_proxy"] = json!({"type":"string","enum":["keep","clear"],"description":"Keep the stored inline proxy if the replacement config omits proxy. Clear removes the inline proxy even when it is supplied. Set proxy_id to null and inline_proxy to clear for a direct connection. Omit for legacy replacement behavior."});
    let mut account_out = account_fields.clone();
    account_out["id"] = string.clone();
    let proxy_input = json!({
        "name":string,
        "url":{"type":"string","format":"uri","description":"HTTP(S) proxy origin without credentials. Omit on update to preserve the connection. Provide it to replace the connection and any authentication."},
        "username":secret,
        "password":secret
    });
    let topic_fields = json!({"name":string,"description":string,"enabled":boolean,"default_tags":strings,"retention":integer,"policy":reference("Policy"),"protected":boolean});
    let mut topic_in = topic_fields.clone();
    topic_in["password"] = json!({"type":"string","nullable":true,"writeOnly":true});
    let mut key_out = key_fields.clone();
    key_out["id"] = string.clone();
    key_out["enabled"] = boolean.clone();
    key_out["created_at"] = time.clone();
    let message = json!({
        "type":"object","description":"Supply a title, a body, or both. At least one must contain non-whitespace text.",
        "anyOf":[
            {"required":["title"],"properties":{"title":{"pattern":r"\S"}}},
            {"required":["body"],"properties":{"body":{"pattern":r"\S"}}}
        ],
        "properties":{
            "title":string,"body":string,"format":{"type":"string","enum":["text","markdown","html"]},
            "tags":strings,"level":string,"url":{"type":"string","format":"uri"},
            "attachments":{"type":"array","items":reference("Attachment")},"extras":{"type":"object"}
        }
    });
    let template_fields = json!({
        "name":{"type":"string","pattern":"^[A-Za-z0-9._-]{1,80}$"},
        "title":{"type":"string","description":"Title source using {{variable}} placeholders."},
        "body":{"type":"string","description":"Body source using {{variable}} placeholders."},
        "format":{"type":"string","enum":["text","markdown"]},
        "shared":{"type":"boolean","description":"Defaults to false on create. Omit on update to preserve visibility."}
    });
    let mut template_output = template_fields.clone();
    template_output["id"] = string.clone();
    template_output["variables"] = strings.clone();
    template_output["builtin"] = boolean.clone();
    template_output["can_edit"] = boolean.clone();
    template_output["created_at"] = time.clone();
    template_output["updated_at"] = time.clone();
    let mut output = Map::new();
    for group in [
        json!({
            "Error":{"type":"object","required":["code","message","details"],"properties":{"code":string,"message":string,"details":{}}},
            "Receipt":{"type":"object","required":["message_id","status"],"properties":{"message_id":string,"status":delivery_status}},
            "Attachment":{"type":"object","required":["url"],"properties":{"url":{"type":"string","format":"uri"},"name":string,"content_type":string}},
            "Message":message,
            "Publish":{
                "oneOf":[
                    {"allOf":[reference("Message"),{"not":{"anyOf":[{"required":["template_id"]},{"required":["template_name"]},{"required":["variables"]}]}}]},
                    reference("TemplatePublish")
                ],
                "type":"object","properties":{
                    "expire_at":time,"callback_url":{"type":"string","format":"uri"},"topic_password":secret,
                    "channels":{"type":"array","items":{"oneOf":[string,reference("Target")]}},"strategy":reference("Strategy")
                }
            },
            "TemplatePublish":{
                "type":"object",
                "description":"Pass exactly one template identifier and the corresponding string variables. Name lookup prefers your private template over a shared template with the same name. Set neither title nor body because the template supplies both.",
                "oneOf":[{"required":["template_id"],"not":{"required":["template_name"]}},{"required":["template_name"],"not":{"required":["template_id"]}}],
                "properties":{
                    "template_id":string,"template_name":string,"variables":{"type":"object","additionalProperties":string,"maxProperties":64},
                    "title":{"type":"string","maxLength":0},"body":{"type":"string","maxLength":0},
                    "format":{"type":"string","enum":["text"]},
                    "tags":strings,"level":string,"url":{"type":"string","format":"uri"},
                    "attachments":{"type":"array","items":reference("Attachment")},"extras":{"type":"object"}
                },
                "example":{"template_name":"builtin.deployment","variables":{"service":"Anser","version":"1.2.3","environment":"production"}}
            },
            "TemplateInput":{"type":"object","required":["name","format"],"properties":template_fields},
            "Template":{"type":"object","required":["id","name","title","body","format","variables","shared","builtin","can_edit","created_at","updated_at"],"properties":template_output},
            "Target":{"type":"object","properties":{"channel":string,"account_id":string,"tag_selector":strings,"priority":integer,"weight":integer}},
            "Strategy":{"type":"object","properties":{"mode":mode,"retry":reference("Retry"),"success_criteria":success}},
            "Policy":{"type":"object","properties":{"mode":mode,"targets":{"type":"array","items":reference("Target")},"retry":reference("Retry"),"success_criteria":success}},
            "Retry":{"type":"object","properties":{"max_attempts":integer,"backoff":{"type":"string","enum":["fixed","exponential"]},"base_delay":integer,"max_delay":integer,"ttl":integer,"until_success":boolean,"jitter":boolean}},
            "Topic":{"type":"object","required":["name"],"properties":topic_fields},
            "TopicInput":{"type":"object","required":["name"],"properties":topic_in},
        }),
        json!({
            "SubscriptionInput":{"type":"object","required":["subscriber_ref"],"properties":{"subscriber_ref":string,"account_id":string,"target":{"type":"object","writeOnly":true},"filter":strings,"password":secret}},
            "Subscription":{"type":"object","properties":{"id":string,"user_id":string,"account_id":string,"subscriber_ref":string,"filter":strings,"created_at":time}},
            "Account":{"type":"object","properties":account_out},
            "AccountCreate":{"type":"object","required":["name","channel","config"],"properties":account_in},
            "AccountUpdate":{"type":"object","properties":account_update},
            "Proxy":{"type":"object","required":["id","name","url","authenticated"],"properties":{"id":string,"name":string,"url":{"type":"string","format":"uri","description":"Credential-free HTTP(S) origin"},"authenticated":boolean}},
            "ProxyCreate":{"type":"object","required":["name","url"],"properties":proxy_input},
            "ProxyUpdate":{"type":"object","required":["name"],"properties":proxy_input},
            "ProxyTest":{"type":"object","properties":{"url":{"type":"string","format":"uri","default":"https://www.cloudflare.com/cdn-cgi/trace"}}},
            "ProxyTestResult":{"type":"object","required":["status","latency_ms"],"properties":{"status":integer,"latency_ms":integer}},
            "LazycatDevices":{"type":"object","required":["user_id","devices"],"properties":{"user_id":{"type":"string","description":"UID verified by the LazyCat ingress."},"devices":{"type":"array","items":reference("LazycatDevice")},"max_selection":{"type":"integer"},"configured_device_ids":{"type":"array","items":{"type":"string"}}}},
            "LazycatDevice":{"type":"object","required":["device_id","name","online"],"properties":{"device_id":string,"name":string,"online":boolean}},
            "InstalledPlugin":{"type":"object","required":["id","kind","display_name","config_schema","enabled","available"],"properties":{"id":string,"kind":{"type":"string","enum":["channel","task","content_transform"]},"display_name":string,"version":string,"config_schema":{"type":"object"},"enabled":boolean,"available":boolean}},
            "GithubPlugin":{"type":"object","properties":{"full_name":string,"description":{"type":["string","null"]},"stargazers_count":integer}},
        }),
        json!({
            "InteractionInput":{"type":"object","required":["recipient","title"],
                "oneOf":[{"required":["mcd"]},{"required":["form"]}],
                "properties":{"recipient":string,"title":string,"body":string,"mcd":string,"form":reference("InteractionForm"),
                    "expires_in_seconds":{"type":"integer","minimum":1,"maximum":86400,"default":3600},"request_key":string}},
            "InteractionForm":{"type":"object","properties":{
                "buttons":{"type":"array","maxItems":12,"items":reference("InteractionOption")},
                "input":{"type":"object","nullable":true,"required":["name","label","submit"],"properties":{
                    "name":string,"label":string,"submit":string,"placeholder":{"type":"string","nullable":true},
                    "multiline":{"type":"boolean","default":true},"max_length":{"type":"integer","maximum":4096,"minimum":1,"default":4096}}},
                "select":{"type":"object","nullable":true,"required":["name","label","submit","options"],"properties":{
                    "name":string,"label":string,"submit":string,"options":{"type":"array","minItems":1,"maxItems":12,"items":reference("InteractionOption")}}}}},
            "InteractionOption":{"type":"object","required":["label","value"],"properties":{"label":string,"value":string}},
            "InteractionReply":{"oneOf":[
                {"type":"object","required":["kind","value"],"properties":{"kind":{"type":"string","enum":["action","choice"]},"value":string}},
                {"type":"object","required":["kind","text"],"properties":{"kind":{"type":"string","enum":["text"]},"text":string}}]},
            "Interaction":{"type":"object","properties":{
                "id":string,"inbox_id":integer,"expires_at":time,"replied_at":{"type":"integer","nullable":true},
                "status":{"type":"string","enum":["pending","answered","expired"]},"reply":reference("InteractionReply")}},
            "InboxInteraction":{"allOf":[reference("Interaction"),{"type":"object","properties":{"form":reference("InteractionForm")}}]},
        }),
        json!({
            "ScheduleRule":{"oneOf":[
                {"type":"object","additionalProperties":false,"required":["kind","minutes"],"properties":{
                    "kind":{"type":"string","enum":["interval"]},"minutes":{"type":"integer","minimum":1,"maximum":43200}}},
                {"type":"object","additionalProperties":false,"required":["kind","weekdays","time","time_zone"],"properties":{
                    "kind":{"type":"string","enum":["weekly"]},"weekdays":{"type":"array","items":{"type":"integer","minimum":1,"maximum":7},"minItems":1,"maxItems":7,"uniqueItems":true,"description":"ISO weekdays, Monday (1) through Sunday (7)."},
                    "time":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"time_zone":{"type":"string","example":"Asia/Shanghai","description":"IANA time zone."}}},
                {"type":"object","additionalProperties":false,"required":["kind","at"],"properties":{
                    "kind":{"type":"string","enum":["once"]},"at":{"type":"integer","format":"int64","description":"Future Unix epoch in milliseconds."}}}
            ]},
            "ScheduleInput":{"type":"object","additionalProperties":false,"required":["name","plugin_id","config"],
                "oneOf":[{"required":["rule"]},{"required":["interval_minutes"]}],
                "properties":{"name":string,"plugin_id":string,"rule":reference("ScheduleRule"),"interval_minutes":{"type":"integer","minimum":1,"maximum":43200,"description":"Legacy fixed interval."},"topic":{"type":["string","null"]},"start_at":{"type":"integer","format":"int64","description":"Optional Unix epoch in milliseconds for interval schedules only."},"config":{"type":"object","writeOnly":true},"input":{"writeOnly":true}}},
            "ScheduleEdit":{"type":"object","additionalProperties":false,"required":["name","plugin_id"],
                "properties":{"name":string,"plugin_id":string,"topic":{"type":"string","nullable":true},
                "rule":reference("ScheduleRule"),"start_at":{"type":"integer","format":"int64"},
                "config":{"type":"object","writeOnly":true},"input":{"writeOnly":true}},
                "description":"Omit rule and start_at to retain the next run. Omit config and input to retain them unless changing task plugin."},
            "ScheduleDetail":{"allOf":[reference("Schedule"),{"type":"object","properties":{"config":{"type":"object","nullable":true,"description":"Editable task options. Private input is omitted."}}}]},
            "HistoryRetention":{"type":"object","additionalProperties":false,"required":["enabled","days"],
                "properties":{"enabled":boolean,"days":{"type":"integer","minimum":1,"maximum":3650}}},
            "ScheduleState":{"type":"object","required":["enabled"],"properties":{"enabled":boolean}},
            "Schedule":{"type":"object","properties":{"id":string,"name":string,"plugin_id":string,"topic":{"type":["string","null"]},
                "rule":reference("ScheduleRule"),"interval_minutes":{"type":"integer","nullable":true},"enabled":boolean,"completed":boolean,
                "next_at":{"type":"integer","format":"int64","nullable":true},"last_at":{"type":["integer","null"]},"last_status":{"type":["string","null"]},"last_count":integer}},
            "PluginTaskInput":{"type":"object","required":["config"],"properties":{"config":{"type":"object","writeOnly":true},"input":{}}},
            "PluginTransformInput":{"type":"object","required":["config","message"],"properties":{"config":{"type":"object","writeOnly":true},"message":reference("Message")}},
            "PluginTaskOutput":{"type":"object","required":["notifications"],"properties":{"notifications":{"type":"array","items":reference("Message")},"details":{"description":"Optional diagnostics independent of notification drafts."}}},
            "PluginTransformOutput":{"type":"object","required":["message"],"properties":{"message":reference("Message"),"artifacts":{"type":"array","items":reference("PluginTransformArtifact"),"description":"Inline media results, with a total decoded size of at most 4 MiB."}}},
            "PluginTransformArtifact":{"type":"object","required":["name","content_type","content_base64"],"properties":{"name":string,"content_type":string,"content_base64":{"type":"string","format":"byte"}}},
            "Channel":{"type":"object","required":["id","display_name","enabled","available","can_manage","config_schema","capabilities"],"properties":{"id":string,"display_name":string,"enabled":{"type":"boolean","description":"Persisted desired state"},"available":{"type":"boolean","description":"Current service availability"},"can_manage":{"type":"boolean","description":"Whether the requesting identity may manage global channel runtime"},"config_schema":{"type":"object"},"capabilities":{"type":"object"}}},
            "ChannelRuntime":{"type":"object","required":["id","enabled","available"],"properties":{"id":string,"enabled":{"type":"boolean","description":"Persisted desired state"},"available":{"type":"boolean","description":"Current service availability"}}},
            "ChannelChange":{"type":"object","properties":{"enabled":boolean,"reload":boolean},"oneOf":[{"required":["enabled"],"properties":{"reload":{"enum":[false]}}},{"required":["reload"],"properties":{"reload":{"enum":[true]}},"not":{"required":["enabled"]}}]},
            "MessageDetail":{"type":"object","properties":{"id":string,"topic":string,"status":delivery_status,"message":reference("Message"),"created_at":time,"inbox_deliveries":{"type":"integer","format":"int64","minimum":0,"description":"Native inbox entries committed at send time. Independent of device activity and read status."},"inbox_recipient":{"type":"string","description":"Destination username supplied by the sender of a direct native notification. Omitted for topic messages."},"deliveries":{"type":"array","items":reference("Delivery")}}},
            "Delivery":{"type":"object","properties":{"id":string,"channel":string,"account_id":string,"account_name":{"type":"string","description":"Current account display name when accessible to a global administrator."},"subscription_id":string,"status":delivery_status,"next_retry_at":time,"attempts":{"type":"array","items":reference("Attempt")}}},
            "Attempt":{"type":"object","properties":{"n":integer,"started_at":time,"finished_at":time,"error_code":string,"error_msg":string,"latency":integer}},
        }),
        json!({
            "UserProfile":{"type":"object","additionalProperties":false,"properties":{
                "nickname":{"type":"string","nullable":true,"maxLength":64},
                "avatar":{"type":"string","nullable":true,"description":"PNG, JPEG, or WebP data URL. Maximum 256 KiB decoded and 1024 pixels on either axis. The service returns a normalized PNG."}
            }},
            "User":{"type":"object","properties":{"id":string,"username":string,"admin":boolean,"enabled":boolean,"created_at":time}},
            "UserInput":{"type":"object","required":["username","password"],"properties":{"username":string,"password":secret,"admin":boolean}},
            "UserUpdate":{"type":"object","properties":{"password":secret,"admin":boolean,"enabled":boolean}},
            "Login":{"type":"object","required":["username","password"],"properties":{"username":string,"password":secret,"code":{"type":"string","writeOnly":true,"description":"Authenticator or unused recovery code"}}},
            "TotpSetupInput":{"type":"object","required":["password"],"properties":{"password":secret}},
            "TotpConfirmInput":{"type":"object","required":["code"],"properties":{"code":{"type":"string","writeOnly":true,"pattern":"^[0-9]{6}$"}}},
            "TotpDisableInput":{"type":"object","required":["password","code"],"properties":{"password":secret,"code":{"type":"string","writeOnly":true,"description":"Authenticator or unused recovery code"}}},
            "TotpStatus":{"type":"object","required":["enabled"],"properties":{"enabled":{"type":"boolean"}}},
            "TotpSetup":{"type":"object","required":["secret","uri","expires_at"],"properties":{"secret":{"type":"string","description":"Base32 seed returned only during setup"},"uri":{"type":"string","format":"uri","description":"Secret-bearing authenticator URI"},"expires_at":time}},
            "TotpConfirmation":{"type":"object","required":["enabled","recovery_codes"],"properties":{"enabled":{"type":"boolean"},"recovery_codes":{"type":"array","items":string,"description":"Single-use codes returned only at confirmation"}}},
            "Session":{"type":"object","required":["token","user"],"properties":{"token":string,"user":reference("User")}},
            "PairSettings":{"type":"object","properties":{"server":{"type":"string","format":"uri"}}},
            "PairCode":{"type":"object","required":["code"],"properties":{"code":secret}},
            "PairResult":{"type":"object","properties":{"url":string,"expires_at":time}},
            "KeyInput":{"type":"object","required":["name","scopes"],"properties":key_fields},
            "ApiKey":{"type":"object","properties":key_out},
            "IssuedKey":{"type":"object","properties":{"token":string,"key":reference("ApiKey")}},
            "SpeechSend":{"type":"object","required":["config","message","destination"],"properties":{
                "config":{"type":"object","writeOnly":true,"description":"OpenAI TTS plugin options. Voice delivery uses MP3."},
                "message":reference("Message"),
                "destination":{"oneOf":[
                    {"type":"object","required":["kind","username"],"properties":{"kind":{"const":"inbox"},"username":string}},
                    {"type":"object","required":["kind","name"],"properties":{"kind":{"const":"topic"},"name":string}},
                    {"type":"object","required":["kind"],"properties":{"kind":{"const":"channels"}}}
                ]}
            }},
            "InboxSend":{"allOf":[reference("Message"),{"type":"object","required":["recipient"],"properties":{"recipient":string}}]},
            "InboxItem":{"type":"object","properties":{"id":integer,"from_username":string,"topic":string,"title":string,"body":string,"format":string,"created_at":time,"audio_path":{"type":"string","description":"Same-server path to an unexpired MP3, present for voice notifications"},"read_at":time,"interaction_id":string}}
        }),
    ] {
        let Value::Object(schemas) = group else {
            unreachable!("schema groups are JSON objects")
        };
        output.extend(schemas);
    }
    Value::Object(output)
}
