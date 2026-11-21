use axum::Json;
use serde_json::{Map, Value, json};

pub async fn document() -> Json<Value> {
    let mut paths = Map::new();
    for (path, operations) in [
        ("/v1/health", &["GET / Health check"][..]),
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
            "/v1/channels",
            &["GET / List plugin schemas and capabilities"],
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
        ("/v1/inbox/send", &["POST / Send a native notification"]),
        (
            "/v1/inbox/{id}/read",
            &["POST / Mark a notification as read"],
        ),
        ("/v1/statistics", &["GET / Queue statistics"]),
        ("/v1/metrics", &["GET / Prometheus metrics"]),
    ] {
        let mut methods = Map::new();
        for spec in operations {
            let (method, summary) = spec.split_once(" / ").unwrap();
            let public = matches!(
                path,
                "/v1/health" | "/v1/auth/login" | "/v1/auth/pair/exchange"
            );
            let mut method_params: Vec<_> = path.split('/').filter_map(|segment| segment.strip_prefix('{')?.strip_suffix('}'))
                .map(|name| json!({"name":name,"in":"path","required":true,"schema":{"type":"string"}})).collect();
            let publishes = path == "/v1/send" || path.ends_with("/publish");
            if publishes {
                method_params.extend([
                    json!({"name":"Idempotency-Key","in":"header","schema":{"type":"string","maxLength":128}}),
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
                        | "/v1/users"
                        | "/v1/api-keys"
                        | "/v1/inbox"
                        | "/v1/topics/{name}/subscriptions"
                )
            {
                method_params.extend([
                    json!({"name":"cursor","in":"query","schema":{"type":"string"}}),
                    json!({"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":100}}),
                ]);
            }
            if path == "/v1/inbox" {
                method_params.push(json!({"name":"wait","in":"query","schema":{"type":"boolean"}}));
            }
            if method == "GET" && path == "/v1/accounts" {
                method_params.push(json!({"name":"channel","in":"query","description":"Filter by channel plugin ID","schema":{"type":"string"}}));
            }
            let mut operation = json!({
                "summary": summary,
                "security": if public { json!([]) } else { json!([{"bearerAuth":[]}]) },
                "parameters": method_params,
                "responses":{"200":{"description":"Success"},"default":{"$ref":"#/components/responses/Error"}}
            });
            if method == "DELETE" || path.ends_with("/logout") || path.ends_with("/read") {
                operation["responses"]["204"] =
                    json!({"description":"Resource changed successfully"});
            }
            if publishes || path.ends_with("/replay") {
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
            methods.insert(method.to_ascii_lowercase(), operation);
        }
        paths.insert(path.into(), Value::Object(methods));
    }
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
        ("POST", "/v1/api-keys") => Some("KeyInput"),
        ("POST", "/v1/accounts") => Some("AccountCreate"),
        ("PUT", "/v1/accounts/{id}") => Some("AccountUpdate"),
        ("POST", "/v1/accounts/{id}/test") => Some("Message"),
        ("PUT", "/v1/channels/{id}/runtime") => Some("ChannelChange"),
        ("PUT", "/v1/default-route") => Some("Policy"),
        ("POST", "/v1/topics") | ("PUT", "/v1/topics/{name}") => Some("TopicInput"),
        ("POST", "/v1/topics/{name}/subscriptions") => Some("SubscriptionInput"),
        ("POST", "/v1/send" | "/v1/topics/{name}/publish") => Some("Publish"),
        ("POST", "/v1/inbox/send") => Some("InboxSend"),
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
        ("GET", "/v1/auth/me") | ("PUT", "/v1/users/{id}") => ("200", reference("User")),
        ("POST", "/v1/auth/pair") => ("200", reference("PairResult")),
        ("POST", "/v1/users") => ("201", reference("User")),
        ("GET", "/v1/users") => ("200", page("User")),
        ("GET", "/v1/api-keys") => ("200", page("ApiKey")),
        ("POST", "/v1/api-keys") => ("201", reference("IssuedKey")),
        ("POST", "/v1/api-keys/{id}/rotate") => ("200", reference("IssuedKey")),
        ("GET", "/v1/accounts") => ("200", page("Account")),
        ("POST", "/v1/accounts") => ("201", reference("Account")),
        ("GET" | "PUT", "/v1/accounts/{id}") => ("200", reference("Account")),
        ("GET", "/v1/channels") => ("200", page("Channel")),
        ("GET", "/v1/channels/{id}") => ("200", reference("Channel")),
        ("PUT", "/v1/channels/{id}/runtime") => ("200", reference("ChannelRuntime")),
        ("GET" | "PUT", "/v1/default-route") => ("200", reference("Policy")),
        ("GET", "/v1/topics") => ("200", page("Topic")),
        ("POST", "/v1/topics") => ("201", reference("Topic")),
        ("GET" | "PUT", "/v1/topics/{name}") => ("200", reference("Topic")),
        ("GET", "/v1/topics/{name}/subscriptions") => ("200", page("Subscription")),
        ("POST", "/v1/topics/{name}/subscriptions") => ("201", reference("Subscription")),
        ("POST", "/v1/send" | "/v1/topics/{name}/publish") => ("200", reference("Receipt")),
        ("GET", "/v1/messages") => ("200", page("MessageDetail")),
        ("GET", "/v1/messages/{id}") => ("200", reference("MessageDetail")),
        ("GET", "/v1/inbox") => ("200", page("InboxItem")),
        ("POST", "/v1/inbox/send") => (
            "201",
            json!({"type":"object","properties":{"id":{"type":"integer","format":"int64"}}}),
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
    let account_fields = json!({"name":string,"channel":string,"enabled":boolean,"tags":strings,"weight":integer,"priority":integer,"rate_limit":{"type":"integer","nullable":true,"minimum":1}});
    let mut account_in = account_fields.clone();
    account_in["config"] =
        json!({"type":"object","writeOnly":true,"description":"See the channel's config_schema."});
    let mut account_out = account_fields.clone();
    account_out["id"] = string.clone();
    let topic_fields = json!({"name":string,"description":string,"enabled":boolean,"default_tags":strings,"retention":integer,"policy":reference("Policy"),"protected":boolean});
    let mut topic_in = topic_fields.clone();
    topic_in["password"] = json!({"type":"string","nullable":true,"writeOnly":true});
    let mut key_out = key_fields.clone();
    key_out["id"] = string.clone();
    key_out["enabled"] = boolean.clone();
    key_out["created_at"] = time.clone();
    let message = json!({
        "type":"object","required":["title","body"],"properties":{
            "title":string,"body":string,"format":{"type":"string","enum":["text","markdown","html"]},
            "tags":strings,"level":string,"url":{"type":"string","format":"uri"},
            "attachments":{"type":"array","items":reference("Attachment")},"extras":{"type":"object"}
        }
    });
    let mut output = Map::new();
    for group in [
        json!({
            "Error":{"type":"object","required":["code","message","details"],"properties":{"code":string,"message":string,"details":{}}},
            "Receipt":{"type":"object","required":["message_id","status"],"properties":{"message_id":string,"status":delivery_status}},
            "Attachment":{"type":"object","required":["url"],"properties":{"url":{"type":"string","format":"uri"},"name":string,"content_type":string}},
            "Message":message,
            "Publish":{"allOf":[reference("Message"),{"type":"object","properties":{
                "expire_at":time,"callback_url":{"type":"string","format":"uri"},"topic_password":secret,
                "channels":{"type":"array","items":{"oneOf":[string,reference("Target")]}},"strategy":reference("Strategy")
            }}]},
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
            "AccountUpdate":{"type":"object","properties":account_in},
            "Channel":{"type":"object","required":["id","display_name","enabled","available","can_manage","config_schema","capabilities"],"properties":{"id":string,"display_name":string,"enabled":{"type":"boolean","description":"Persisted desired state"},"available":{"type":"boolean","description":"Current service availability"},"can_manage":{"type":"boolean","description":"Whether the requesting identity may manage global channel runtime"},"config_schema":{"type":"object"},"capabilities":{"type":"object"}}},
            "ChannelRuntime":{"type":"object","required":["id","enabled","available"],"properties":{"id":string,"enabled":{"type":"boolean","description":"Persisted desired state"},"available":{"type":"boolean","description":"Current service availability"}}},
            "ChannelChange":{"type":"object","properties":{"enabled":boolean,"reload":boolean},"oneOf":[{"required":["enabled"],"properties":{"reload":{"enum":[false]}}},{"required":["reload"],"properties":{"reload":{"enum":[true]}},"not":{"required":["enabled"]}}]},
            "MessageDetail":{"type":"object","properties":{"id":string,"topic":string,"status":delivery_status,"message":reference("Message"),"created_at":time,"deliveries":{"type":"array","items":reference("Delivery")}}},
            "Delivery":{"type":"object","properties":{"id":string,"channel":string,"account_id":string,"subscription_id":string,"status":delivery_status,"next_retry_at":time,"attempts":{"type":"array","items":reference("Attempt")}}},
            "Attempt":{"type":"object","properties":{"n":integer,"started_at":time,"finished_at":time,"error_code":string,"error_msg":string,"latency":integer}},
        }),
        json!({
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
            "InboxSend":{"allOf":[reference("Message"),{"type":"object","required":["recipient"],"properties":{"recipient":string}}]},
            "InboxItem":{"type":"object","properties":{"id":integer,"from_username":string,"topic":string,"title":string,"body":string,"format":string,"created_at":time,"read_at":time}}
        }),
    ] {
        let Value::Object(schemas) = group else {
            unreachable!("schema groups are JSON objects")
        };
        output.extend(schemas);
    }
    Value::Object(output)
}
