//! Current weather from the wttr.in JSON endpoint.

use anser_channel_http::{
    NetworkPolicy, append_path, client_with_policy, config, decode, network_error, reqwest::Url,
    response, url,
};
use anser_core::Message;
use anser_plugin_api::{
    PluginDescriptor, PluginFuture, PluginKind, SendError, TaskOutput, TaskService,
};
use serde::Deserialize;
use serde_json::{Value, json};

const BASE: &str = "https://wttr.in";

#[derive(Default)]
pub struct WttrWeather;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    location: String,
    #[serde(default)]
    language: Language,
    #[serde(default)]
    units: Units,
}

#[derive(Clone, Copy, Default, Deserialize)]
enum Language {
    #[default]
    #[serde(rename = "en")]
    English,
    #[serde(rename = "zh")]
    Chinese,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Units {
    #[default]
    Metric,
    Us,
}

impl TaskService for WttrWeather {
    fn descriptor(&self) -> PluginDescriptor {
        PluginDescriptor {
            kind: PluginKind::Task,
            id: "wttr-weather".into(),
            display_name: "wttr.in Weather".into(),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            config_schema: json!({
                "type":"object",
                "x-anser-ui":{"label":{"en":"wttr.in Weather","zh-CN":"wttr.in 天气"},"task_input":"none"},
                "properties":{
                    "location":{
                        "type":"string","maxLength":128,
                        "x-anser-ui":{
                            "label":{"en":"City or airport code","zh-CN":"城市或机场代码"},
                            "description":{"en":"Examples: Shanghai, Paris, MUC","zh-CN":"例如上海、巴黎或 MUC"}
                        }
                    },
                    "language":{
                        "type":"string","enum":["en","zh"],"default":"en",
                        "x-anser-ui":{
                            "label":{"en":"Notification language","zh-CN":"通知语言"},
                            "option_labels":{"en":{"en":"English","zh-CN":"英文"},"zh":{"en":"Simplified Chinese","zh-CN":"简体中文"}}
                        }
                    },
                    "units":{
                        "type":"string","enum":["metric","us"],"default":"metric",
                        "x-anser-ui":{
                            "label":{"en":"Units","zh-CN":"单位"},
                            "option_labels":{"metric":{"en":"Metric","zh-CN":"公制"},"us":{"en":"US customary","zh-CN":"美制"}}
                        }
                    }
                },
                "required":["location"],"additionalProperties":false
            }),
        }
    }

    fn run<'a>(&'a self, settings: &'a Value, input: &'a Value) -> PluginFuture<'a, TaskOutput> {
        Box::pin(async move {
            if !(input.is_null() || input.as_object().is_some_and(serde_json::Map::is_empty)) {
                return Err(SendError::new(
                    "weather_input",
                    "configure location in the task options",
                    false,
                ));
            }
            weather(&config(settings)?, url(BASE)?, &NetworkPolicy::from_env()).await
        })
    }
}

#[derive(Deserialize)]
struct Weather {
    current_condition: Vec<Condition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Condition {
    #[serde(rename = "temp_C")]
    temp_c: String,
    #[serde(rename = "temp_F")]
    temp_f: String,
    #[serde(rename = "FeelsLikeC")]
    feels_c: String,
    #[serde(rename = "FeelsLikeF")]
    feels_f: String,
    humidity: String,
    weather_code: String,
    weather_desc: Vec<Description>,
    #[serde(default, rename = "lang_zh")]
    description_zh: Vec<Description>,
}

#[derive(Deserialize)]
struct Description {
    value: String,
}

async fn weather(
    settings: &Settings,
    base: Url,
    policy: &NetworkPolicy,
) -> Result<TaskOutput, SendError> {
    let location = settings.location.trim();
    if location.is_empty()
        || location.chars().count() > 128
        || matches!(location, "." | "..")
        || location.starts_with(':')
        || location.contains(['/', '\\', '?', '#', '%'])
        || location.contains(char::is_control)
    {
        return Err(SendError::new(
            "weather_location",
            "enter a city name or airport code",
            false,
        ));
    }

    let mut endpoint = append_path(base, &[location])?;
    let language = match settings.language {
        Language::English => "en",
        Language::Chinese => "zh",
    };
    endpoint
        .query_pairs_mut()
        .append_pair("format", "j1")
        .append_pair("lang", language);
    let reply = client_with_policy(&endpoint, None, policy)
        .await?
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(network_error)?;
    let weather: Weather = decode(&response(reply).await?)?;
    let condition = weather.current_condition.first().ok_or_else(|| {
        SendError::new(
            "weather_missing",
            "wttr.in returned no weather for this location",
            false,
        )
    })?;

    let (temperature, feels_like, unit) = match settings.units {
        Units::Metric => (&condition.temp_c, &condition.feels_c, "°C"),
        Units::Us => (&condition.temp_f, &condition.feels_f, "°F"),
    };
    let temperature: i16 = temperature.parse().map_err(|_| invalid_data())?;
    let feels_like: i16 = feels_like.parse().map_err(|_| invalid_data())?;
    let humidity: u8 = condition
        .humidity
        .parse()
        .ok()
        .filter(|value| *value <= 100)
        .ok_or_else(invalid_data)?;
    let description = match settings.language {
        Language::English => condition
            .weather_desc
            .first()
            .map_or("", |value| value.value.trim()),
        // wttr.in may return the English description even when lang_zh is present.
        Language::Chinese => condition
            .description_zh
            .first()
            .map(|value| value.value.trim())
            .filter(|value| {
                value
                    .chars()
                    .any(|ch| ('\u{3400}'..='\u{9fff}').contains(&ch))
            })
            .unwrap_or_else(|| chinese_condition(&condition.weather_code)),
    };
    let description = anser_channel_http::truncate(description, 128);
    let measurement = format!("{temperature}{unit}");
    let condition = if description.is_empty() {
        measurement
    } else {
        format!("{description} · {measurement}")
    };
    let (title, body) = match settings.language {
        Language::English => (
            format!("{location} weather"),
            format!("{condition}\nFeels like {feels_like}{unit} · Humidity {humidity}%"),
        ),
        Language::Chinese => (
            format!("{location}天气"),
            format!("{condition}\n体感 {feels_like}{unit} · 湿度 {humidity}%"),
        ),
    };
    Ok(TaskOutput {
        notifications: vec![Message {
            title,
            body,
            ..Message::default()
        }],
        details: None,
    })
}

fn chinese_condition(code: &str) -> &'static str {
    match code {
        "113" => "晴",
        "116" | "119" => "多云",
        "122" => "阴",
        "143" | "248" | "260" => "雾",
        "176" | "263" | "266" => "零星小雨",
        "293" | "296" | "353" => "小雨",
        "299" | "302" => "中雨",
        "305" | "308" | "356" | "359" => "大雨",
        "200" | "386" | "389" => "雷阵雨",
        "179" | "227" | "323" | "326" | "368" => "小雪",
        "329" | "332" => "中雪",
        "230" | "335" | "338" | "371" => "大雪",
        "392" | "395" => "雷阵雪",
        "182" | "317" | "320" | "362" | "365" => "雨夹雪",
        "185" | "281" | "284" | "311" | "314" => "冻雨",
        "350" | "374" | "377" => "冰粒",
        _ => "",
    }
}

fn invalid_data() -> SendError {
    SendError::new(
        "weather_response",
        "wttr.in returned invalid weather data",
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock::serve;

    const DATA: &str = r#"{"current_condition":[{"temp_C":"17","temp_F":"63","FeelsLikeC":"16","FeelsLikeF":"61","humidity":"80","weatherCode":"116","weatherDesc":[{"value":"Partly Cloudy"}],"lang_zh":[{"value":"Partly Cloudy"}]}]}"#;

    #[tokio::test]
    async fn formats_location_language_and_units() {
        let (base, request) = serve("200 OK", "", DATA).await;
        let settings = Settings {
            location: "上海".into(),
            language: Language::Chinese,
            units: Units::Us,
        };
        let output = weather(&settings, base, &NetworkPolicy::new(true, vec![]))
            .await
            .unwrap();
        assert!(
            request
                .await
                .unwrap()
                .headers
                .starts_with("GET /%E4%B8%8A%E6%B5%B7?format=j1&lang=zh HTTP/1.1",)
        );
        assert_eq!(output.notifications[0].title, "上海天气");
        assert_eq!(
            output.notifications[0].body,
            "多云 · 63°F\n体感 61°F · 湿度 80%"
        );
    }

    #[tokio::test]
    async fn reports_no_data_and_propagates_retry_after() {
        let policy = NetworkPolicy::new(true, vec![]);
        let settings = Settings {
            location: "Paris".into(),
            language: Language::English,
            units: Units::Metric,
        };
        let (base, request) = serve("200 OK", "", r#"{"current_condition":[]}"#).await;
        let missing = weather(&settings, base, &policy).await.unwrap_err();
        assert_eq!(missing.code, "weather_missing");
        assert!(!missing.retryable);
        request.await.unwrap();

        let (base, request) = serve("429 Too Many Requests", "Retry-After: 9\r\n", "").await;
        let error = weather(&settings, base, &policy).await.unwrap_err();
        assert!(error.retryable);
        assert_eq!(error.retry_after_ms, Some(9_000));
        request.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires access to the public wttr.in service"]
    async fn live_wttr_compatibility() {
        let settings = Settings {
            location: "Shanghai".into(),
            language: Language::Chinese,
            units: Units::Metric,
        };
        let output = weather(
            &settings,
            url(BASE).unwrap(),
            &NetworkPolicy::new(false, vec![]),
        )
        .await
        .unwrap();
        assert_eq!(output.notifications[0].title, "Shanghai天气");
        assert!(output.notifications[0].body.contains("°C"));
    }
}
