//! Bark v2 single and batch push, with optional Bark-compatible encryption.

mod ingress;

use std::collections::HashSet;

use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
use anser_channel_http::{
    NetworkPolicy, append_path, client_with_policy, config, decode, link, network_error,
    plain_body, provider_error, response, truncate_bytes, url, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};

const TITLE_LIMIT: usize = 160;
const MESSAGE_LIMIT: usize = 2600;
const ENCRYPTED_MESSAGE_LIMIT: usize = 1600;
const MAX_DEVICES: usize = 100;

#[derive(Default)]
pub struct Bark;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default = "default_server")]
    server_url: String,
    device_key: Option<String>,
    #[serde(default)]
    device_keys: Vec<String>,
    group: Option<String>,
    sound: Option<String>,
    level: Option<Level>,
    encryption_key: Option<String>,
    proxy: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Level {
    Active,
    TimeSensitive,
    Passive,
    Critical,
}

impl Level {
    fn as_api_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::TimeSensitive => "timeSensitive",
            Self::Passive => "passive",
            Self::Critical => "critical",
        }
    }
}

fn default_server() -> String {
    "https://api.day.app/".into()
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let mut config: Self = config(value)?;
        if let Some(key) = config.device_key.take() {
            if !config.device_keys.is_empty() {
                return Err(config_error());
            }
            config.device_keys.push(key);
        }
        let server = url(&config.server_url)?;
        validate_proxy(config.proxy.as_deref())?;
        let mut unique = HashSet::new();
        if server.query().is_some()
            || config.device_keys.is_empty()
            || config.device_keys.len() > MAX_DEVICES
            || config.device_keys.iter().any(|key| {
                key.is_empty()
                    || key.len() > 128
                    || !key
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                    || !unique.insert(key)
            })
            || config
                .encryption_key
                .as_ref()
                .is_some_and(|key| !matches!(key.len(), 16 | 24 | 32))
            || config.group.as_ref().is_some_and(|group| group.len() > 128)
            || config.sound.as_ref().is_some_and(|sound| sound.len() > 128)
        {
            return Err(config_error());
        }
        Ok(config)
    }
}

fn config_error() -> SendError {
    SendError::new(
        "bark_config",
        "check server, device keys and Bark encryption configuration",
        false,
    )
}

impl ChannelService for Bark {
    fn id(&self) -> &'static str {
        "bark"
    }
    fn display_name(&self) -> &'static str {
        "Bark"
    }

    fn config_schema(&self) -> Value {
        let device_key =
            json!({"type":"string","pattern":"^[A-Za-z0-9_-]{1,128}$","writeOnly":true});
        json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type":"object",
            "x-anser-ui": {"help":{"zh-CN":"入口接收 Bark JSON 消息，可填写标题、正文、链接、分组和级别。使用雁字密钥认证，可省略设备密钥或填写 default。通过 X-Anser-Topic 指定主题，否则使用默认路由。成功回执表示已入队。出口账号使用真实 Bark 设备密钥。","en":"Receive Bark JSON with title, body, url, group and level. Authenticate with an Anser key. Omit device_key or use default. Set X-Anser-Topic to publish to a topic, or use the default route. Success means queued. Outbound accounts use real Bark device keys."},"label":{"en":"Bark","zh-CN":"Bark"},"account_editor": {"fields":["server_url","group","sound","level"],"credentials":{"device_key":["server_url","device_keys"],"device_keys":["server_url","device_key"],"encryption_key":["server_url","device_key","device_keys"]}}},
            "properties":{
                "server_url":{"x-anser-ui":{"label":{"en":"Server URL","zh-CN":"服务器地址"}},"type":"string","format":"uri","default":default_server()},
                "device_key":device_key,
                "device_keys":{"x-anser-ui":{"label":{"en":"Device keys","zh-CN":"设备密钥列表"}},"type":"array","minItems":1,"maxItems":MAX_DEVICES,"uniqueItems":true,"items":device_key,"writeOnly":true},
                "group":{"x-anser-ui":{"label":{"en":"Notification group","zh-CN":"通知分组"}},"type":"string","maxLength":128},
                "sound":{"x-anser-ui":{"label":{"en":"Notification sound","zh-CN":"通知铃声"}},"type":"string","maxLength":128},
                "level":{"x-anser-ui":{"label":{"en":"Interruption level","zh-CN":"打扰级别"},"option_labels":{"active":{"en":"Active","zh-CN":"主动"},"critical":{"en":"Critical","zh-CN":"重要警报"},"passive":{"en":"Passive","zh-CN":"静默"},"timeSensitive":{"en":"Time sensitive","zh-CN":"时效性"}}},"enum":["passive","active","timeSensitive","critical"]},
                "encryption_key":{"x-anser-ui":{"label":{"en":"Encryption key","zh-CN":"加密密钥"},"description":{"en":"Use an AES-CBC key of 16, 24, or 32 UTF-8 bytes.","zh-CN":"请使用长度为 16、24 或 32 个 UTF-8 字节的 AES-CBC 密钥。"}},"type":"string","minLength":1,"maxLength":32,"description":"AES-CBC key. UTF-8 byte length must be 16, 24 or 32.","writeOnly":true},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "oneOf":[{"required":["device_key"]},{"required":["device_keys"]}],
            "additionalProperties":false
        })
    }

    fn validate_config(&self, config: &Value) -> Result<(), SendError> {
        Config::parse(config).map(|_| ())
    }

    fn direction(&self) -> anser_plugin_api::ChannelDirection {
        anser_plugin_api::ChannelDirection::Bidirectional
    }
    fn ingress_routes(&self) -> &'static [anser_plugin_api::IngressRoute] {
        ingress::ROUTES
    }
    fn decode_ingress(
        &self,
        request: anser_plugin_api::IngressRequest<'_>,
    ) -> Result<anser_plugin_api::IngressMessage, &'static str> {
        ingress::decode(request)
    }
    fn ingress_response(
        &self,
        _message: &anser_plugin_api::IngressMessage,
        receipt: &anser_core::api::Receipt,
    ) -> Value {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        json!({"code":200,"message":"success","timestamp":timestamp,"data":{"message_id":receipt.message_id}})
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text],
            max_title_chars: Some(TITLE_LIMIT as u32),
            max_body_chars: Some(MESSAGE_LIMIT as u32),
            attachments: false,
            user_target: true,
        }
    }

    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            send(
                &Config::parse(&account.config)?,
                message,
                &NetworkPolicy::from_env(),
            )
            .await
        })
    }
}

fn payload(config: &Config, message: &Message) -> Result<Value, SendError> {
    let limit = if config.encryption_key.is_some() {
        ENCRYPTED_MESSAGE_LIMIT
    } else {
        MESSAGE_LIMIT
    };
    let body = plain_body(message, limit);
    let mut payload = json!({
        "title": truncate_bytes(&message.title, TITLE_LIMIT),
        "body": truncate_bytes(&body, limit),
    });
    if let Some(group) = &config.group {
        payload["group"] = json!(group);
    }
    if let Some(sound) = &config.sound {
        payload["sound"] = json!(sound);
    }
    if let Some(level) = &config.level {
        payload["level"] = json!(level.as_api_str());
    }
    if let Some(target) = &message.url {
        let target = link(target)?;
        payload["url"] = json!(target.as_str());
    }

    if let Some(key) = &config.encryption_key {
        payload = encrypt(&payload, key)?;
    }
    if let [key] = config.device_keys.as_slice() {
        payload["device_key"] = json!(key);
    } else {
        payload["device_keys"] = json!(config.device_keys);
    }
    Ok(payload)
}

fn encrypt(payload: &Value, key: &str) -> Result<Value, SendError> {
    let bytes = serde_json::to_vec(payload).map_err(|_| config_error())?;
    let mut random = [0u8; 12];
    getrandom::fill(&mut random).map_err(|_| {
        SendError::new(
            "bark_random",
            "could not generate the Bark initialization vector",
            true,
        )
    })?;
    // Bark devices treat `iv` as literal UTF-8. Base64 gives 16 printable bytes
    // without the fixed IV used in the upstream shell example.
    let iv = STANDARD.encode(random);
    let key = key.as_bytes();
    let iv_bytes = iv.as_bytes();
    let ciphertext = match key.len() {
        16 => cbc::Encryptor::<aes::Aes128>::new_from_slices(key, iv_bytes)
            .map_err(|_| config_error())?
            .encrypt_padded_vec::<Pkcs7>(&bytes),
        24 => cbc::Encryptor::<aes::Aes192>::new_from_slices(key, iv_bytes)
            .map_err(|_| config_error())?
            .encrypt_padded_vec::<Pkcs7>(&bytes),
        32 => cbc::Encryptor::<aes::Aes256>::new_from_slices(key, iv_bytes)
            .map_err(|_| config_error())?
            .encrypt_padded_vec::<Pkcs7>(&bytes),
        _ => return Err(config_error()),
    };
    Ok(json!({"ciphertext": STANDARD.encode(ciphertext), "iv": iv}))
}

async fn send(
    config: &Config,
    message: &Message,
    network: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    let endpoint = append_path(url(&config.server_url)?, &["push"])?;
    let payload = payload(config, message)?;
    let client = client_with_policy(&endpoint, config.proxy.as_deref(), network).await?;
    let body = response(
        client
            .post(endpoint)
            .json(&payload)
            .send()
            .await
            .map_err(network_error)?,
    )
    .await?;
    let reply: Reply = decode(&body)?;
    if reply.code != 200 {
        return Err(bark_error(reply.code));
    }
    if config.device_keys.len() > 1 {
        let result = reply.data.ok_or_else(invalid_response)?;
        let targets: HashSet<_> = config.device_keys.iter().map(String::as_str).collect();
        let acknowledged: HashSet<_> = result.iter().map(|item| item.device_key.as_str()).collect();
        if result.len() != targets.len() || acknowledged != targets {
            return Err(invalid_response());
        }
        let mut failures = result
            .iter()
            .filter(|item| item.code != 200)
            .map(|item| bark_error(item.code));
        if let Some(first) = failures.next() {
            return Err(if first.retryable {
                first
            } else {
                failures.find(|error| error.retryable).unwrap_or(first)
            });
        }
    }
    Ok(SendOutcome::Delivered)
}

fn invalid_response() -> SendError {
    SendError::new(
        "bark_response",
        "Bark returned an incomplete delivery result",
        true,
    )
}

fn bark_error(code: u16) -> SendError {
    provider_error("bark", code, matches!(code, 408 | 429 | 500..=599))
}

#[derive(Deserialize)]
struct Reply {
    code: u16,
    data: Option<Vec<DeviceReply>>,
}

#[derive(Deserialize)]
struct DeviceReply {
    device_key: String,
    code: u16,
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockModeDecrypt;
    use anser_channel_http::mock;

    #[tokio::test]
    async fn batch_checks_each_device_and_encrypts_inner_fields() {
        let (base, received) = mock::serve("200 OK", "", r#"{"code":200,"data":[{"device_key":"key1","code":200},{"device_key":"key2","code":503}]}"#).await;
        let config = Config::parse(&json!({
            "server_url":base.as_str(), "device_keys":["key1","key2"],
            "group":"Alerts", "encryption_key":"0123456789012345"
        }))
        .unwrap();
        let message = Message {
            title: "Anser".into(),
            body: "**encrypted!**".into(),
            format: MessageFormat::Markdown,
            ..Message::default()
        };
        let error = send(&config, &message, &NetworkPolicy::new(true, vec![]))
            .await
            .unwrap_err();
        assert!(error.retryable);
        assert_eq!(error.code, "bark_503");
        let received = received.await.unwrap();
        assert!(received.headers.starts_with("POST /push "));
        let body: Value = decode(&received.body).unwrap();
        assert!(body.get("body").is_none());
        assert_eq!(body["device_keys"], json!(["key1", "key2"]));
        let cipher = STANDARD
            .decode(body["ciphertext"].as_str().unwrap())
            .unwrap();
        let iv = body["iv"].as_str().unwrap();
        let plain =
            cbc::Decryptor::<aes::Aes128>::new_from_slices(b"0123456789012345", iv.as_bytes())
                .unwrap()
                .decrypt_padded_vec::<Pkcs7>(&cipher)
                .unwrap();
        let plain: Value = decode(&plain).unwrap();
        assert_eq!(plain["body"], "encrypted!");
        assert_eq!(plain["group"], "Alerts");
    }
}
