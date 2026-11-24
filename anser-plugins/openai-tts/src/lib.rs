//! Converts notification text into audio using the OpenAI speech protocol.

use anser_channel_http::{
    NetworkPolicy, append_path, client_with_policy, config, network_error, plain_body,
    reqwest::{Url, header::HeaderValue},
    status_error, url,
};
use anser_core::Message;
use anser_plugin_api::{
    ContentTransformService, MAX_TRANSFORM_ARTIFACT_BYTES, PluginDescriptor, PluginFuture,
    PluginKind, SendError, TransformArtifact, TransformOutput,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_INPUT_CHARS: usize = 4096;

#[derive(Default)]
pub struct OpenAiTts;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    server_url: String,
    api_key: String,
    model: String,
    voice: String,
    #[serde(default)]
    response_format: AudioFormat,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AudioFormat {
    #[default]
    Mp3,
    Opus,
    Aac,
    Flac,
    Wav,
    Pcm,
}

impl AudioFormat {
    fn extension_and_mime(self) -> (&'static str, &'static str) {
        match self {
            Self::Mp3 => ("mp3", "audio/mpeg"),
            Self::Opus => ("opus", "audio/ogg"),
            Self::Aac => ("aac", "audio/aac"),
            Self::Flac => ("flac", "audio/flac"),
            Self::Wav => ("wav", "audio/wav"),
            Self::Pcm => ("pcm", "application/octet-stream"),
        }
    }
}

impl ContentTransformService for OpenAiTts {
    fn descriptor(&self) -> PluginDescriptor {
        PluginDescriptor {
            id: "openai-tts".into(),
            kind: PluginKind::ContentTransform,
            display_name: "OpenAI TTS".into(),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            config_schema: json!({
                "type": "object",
                "x-anser-ui": {"label":{"en":"OpenAI TTS","zh-CN":"文本转语音"}},
                "properties": {
                    "server_url": {
                        "type": "string", "format": "uri", "default": "https://api.openai.com",
                        "x-anser-ui": {"label":{"en":"Server URL","zh-CN":"服务地址"}}
                    },
                    "api_key": {
                        "type": "string", "format": "password", "writeOnly": true, "maxLength": 4096,
                        "x-anser-ui": {"label":{"en":"API key","zh-CN":"API 密钥"}}
                    },
                    "model": {
                        "type": "string", "default": "tts-1", "maxLength": 128,
                        "x-anser-ui": {"label":{"en":"Model","zh-CN":"模型"}}
                    },
                    "voice": {
                        "type": "string", "default": "alloy", "maxLength": 128,
                        "x-anser-ui": {"label":{"en":"Voice","zh-CN":"音色"}}
                    },
                    "response_format": {
                        "type": "string", "enum": ["mp3","opus","aac","flac","wav","pcm"], "default":"mp3",
                        "x-anser-ui": {"label":{"en":"Audio format","zh-CN":"音频格式"}}
                    }
                },
                "required": ["server_url","api_key","model","voice"],
                "additionalProperties": false
            }),
        }
    }

    fn transform<'a>(
        &'a self,
        config: &'a Value,
        message: Message,
    ) -> PluginFuture<'a, TransformOutput> {
        Box::pin(async move {
            let config: Config = self::config(config)?;
            synthesize(config, message, &NetworkPolicy::from_env()).await
        })
    }
}

fn invalid_config() -> SendError {
    SendError::new(
        "tts_config",
        "provide a valid speech URL, API key, model and voice",
        false,
    )
}

fn speech_url(server_url: &str) -> Result<Url, SendError> {
    let base = url(server_url)?;
    if base.query().is_some() {
        return Err(invalid_config());
    }
    if base.path().trim_end_matches('/').ends_with("/v1") {
        append_path(base, &["audio", "speech"])
    } else {
        append_path(base, &["v1", "audio", "speech"])
    }
}

async fn synthesize(
    config: Config,
    message: Message,
    policy: &NetworkPolicy,
) -> Result<TransformOutput, SendError> {
    let endpoint = speech_url(&config.server_url)?;
    if config.api_key.is_empty()
        || config.api_key.len() > 4096
        || !config.api_key.bytes().all(|byte| byte.is_ascii_graphic())
        || [config.model.as_str(), config.voice.as_str()]
            .iter()
            .any(|value| {
                value.trim().is_empty() || value.len() > 128 || value.contains(char::is_control)
            })
    {
        return Err(invalid_config());
    }
    // An extra character distinguishes exact-limit input from truncation.
    let body = plain_body(&message, MAX_INPUT_CHARS + 1);
    let input = if body.trim().is_empty() {
        message.title.trim()
    } else {
        body.trim()
    };
    if input.is_empty() || input.chars().count() > MAX_INPUT_CHARS {
        return Err(SendError::new(
            "tts_input",
            "speech requires between 1 and 4096 characters of text",
            false,
        ));
    }
    let (extension, content_type) = config.response_format.extension_and_mime();
    let mut token = HeaderValue::from_str(&format!("Bearer {}", config.api_key))
        .map_err(|_| invalid_config())?;
    token.set_sensitive(true);
    let mut reply = client_with_policy(&endpoint, None, policy)
        .await?
        .post(endpoint)
        .header("Authorization", token)
        .header("Accept", content_type)
        .json(&json!({
            "input": input,
            "model": config.model,
            "voice": config.voice,
            "response_format": extension
        }))
        .send()
        .await
        .map_err(network_error)?;

    if let Some(error) = status_error(&reply) {
        return Err(error);
    }
    let mime = reply
        .headers()
        .get("Content-Type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !mime.starts_with("audio/") && mime != "application/octet-stream" {
        return Err(invalid_audio());
    }
    if reply
        .content_length()
        .is_some_and(|size| size > MAX_TRANSFORM_ARTIFACT_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = reply.chunk().await.map_err(network_error)? {
        if chunk.len() > MAX_TRANSFORM_ARTIFACT_BYTES - bytes.len() {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !valid_audio(config.response_format, &bytes) {
        return Err(invalid_audio());
    }
    Ok(TransformOutput {
        message,
        artifacts: vec![TransformArtifact {
            name: format!("speech.{extension}"),
            content_type: content_type.into(),
            content_base64: STANDARD.encode(bytes),
        }],
    })
}

fn valid_audio(format: AudioFormat, bytes: &[u8]) -> bool {
    match format {
        AudioFormat::Mp3 => bytes.starts_with(b"ID3") || starts_with_audio_frame(bytes, 0xe0),
        AudioFormat::Opus => bytes.starts_with(b"OggS"),
        AudioFormat::Aac => bytes.starts_with(b"ID3") || starts_with_audio_frame(bytes, 0xf0),
        AudioFormat::Flac => bytes.starts_with(b"fLaC"),
        AudioFormat::Wav => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE"),
        AudioFormat::Pcm => !bytes.is_empty() && bytes.len().is_multiple_of(2),
    }
}

fn starts_with_audio_frame(bytes: &[u8], mask: u8) -> bool {
    matches!(bytes, [0xff, second, ..] if second & mask == mask)
}

fn invalid_audio() -> SendError {
    SendError::new(
        "tts_response",
        "speech endpoint did not return the requested audio",
        true,
    )
}

fn too_large() -> SendError {
    SendError::new(
        "tts_audio_too_large",
        "speech exceeded the 4 MiB audio limit",
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(server_url: &str, key: &str) -> Config {
        Config {
            server_url: server_url.into(),
            api_key: key.into(),
            model: "tts-1".into(),
            voice: "alloy".into(),
            response_format: AudioFormat::Mp3,
        }
    }

    #[tokio::test]
    async fn sends_openai_request_and_returns_audio_without_changing_message() {
        let (server, request) =
            anser_channel_http::mock::serve("200 OK", "Content-Type: audio/mpeg\r\n", "ID3fixture")
                .await;
        let message = Message {
            title: "Release".into(),
            body: "Ready to ship".into(),
            ..Message::default()
        };
        let output = synthesize(
            settings(server.join("proxy/v1/").unwrap().as_str(), "test-key"),
            message,
            &NetworkPolicy::new(true, vec![]),
        )
        .await
        .unwrap();
        let request = request.await.unwrap();
        assert!(
            request
                .headers
                .starts_with("POST /proxy/v1/audio/speech HTTP/1.1")
        );
        assert!(request.headers.contains("authorization: Bearer test-key"));
        assert_eq!(
            serde_json::from_slice::<Value>(&request.body).unwrap(),
            json!({
                "model": "tts-1", "voice": "alloy", "input": "Ready to ship", "response_format": "mp3"
            })
        );
        assert_eq!(output.message.title, "Release");
        assert_eq!(output.artifacts[0].content_type, "audio/mpeg");
        assert_eq!(
            STANDARD
                .decode(&output.artifacts[0].content_base64)
                .unwrap(),
            b"ID3fixture"
        );
    }

    #[tokio::test]
    async fn maps_rate_limit_without_returning_provider_body() {
        let (server, request) = anser_channel_http::mock::serve(
            "429 Too Many Requests",
            "Retry-After: 3\r\n",
            "provider-private-details",
        )
        .await;
        let error = synthesize(
            settings(server.as_str(), "test-key"),
            Message {
                body: "Ready".into(),
                ..Message::default()
            },
            &NetworkPolicy::new(true, vec![]),
        )
        .await
        .err()
        .unwrap();
        assert!(error.retryable);
        assert_eq!(error.retry_after_ms, Some(3000));
        assert!(!error.to_string().contains("provider-private-details"));
        assert!(
            request
                .await
                .unwrap()
                .headers
                .starts_with("POST /v1/audio/speech HTTP/1.1")
        );
    }

    #[tokio::test]
    #[ignore = "requires a configured OpenAI-compatible endpoint"]
    async fn live_openai_compatibility() {
        let server = std::env::var("ANSER_TTS_SMOKE_URL").unwrap();
        let key =
            std::fs::read_to_string(std::env::var_os("ANSER_TTS_SMOKE_KEY_FILE").unwrap()).unwrap();
        let mut config = settings(&server, key.trim());
        if let Ok(model) = std::env::var("ANSER_TTS_SMOKE_MODEL") {
            config.model = model;
        }
        if let Ok(voice) = std::env::var("ANSER_TTS_SMOKE_VOICE") {
            config.voice = voice;
        }
        let output = synthesize(
            config,
            Message {
                body: "Anser speech test.".into(),
                ..Message::default()
            },
            &NetworkPolicy::new(false, vec![]),
        )
        .await
        .unwrap();
        let audio = STANDARD
            .decode(&output.artifacts[0].content_base64)
            .unwrap();
        assert!(audio.len() > 1024);
        println!("Received {} bytes of validated MP3.", audio.len());
    }
}
