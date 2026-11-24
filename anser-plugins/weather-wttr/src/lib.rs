//! Local weather and forecasts resolved through wttr.in.

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
const MAX_FORECAST_DAYS: u8 = 3;

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
    #[serde(default)]
    forecast: Forecast,
    forecast_days: Option<u8>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Forecast {
    #[default]
    Current,
    Today,
    Tomorrow,
    Custom,
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
                    "forecast":{
                        "type":"string","enum":["current","today","tomorrow","custom"],"default":"current",
                        "x-anser-ui":{
                            "label":{"en":"Forecast period","zh-CN":"预报范围"},
                            "option_labels":{
                                "current":{"en":"Current conditions","zh-CN":"实时天气"},
                                "today":{"en":"Today","zh-CN":"当天"},
                                "tomorrow":{"en":"Tomorrow","zh-CN":"次日"},
                                "custom":{"en":"Custom days","zh-CN":"自定义天数"}
                            }
                        }
                    },
                    "forecast_days":{
                        "type":"integer","minimum":1,"maximum":MAX_FORECAST_DAYS,"default":3,
                        "x-anser-ui":{
                            "label":{"en":"Forecast days","zh-CN":"预报天数"},
                            "description":{"en":"Counts from today, up to 3 days.","zh-CN":"从当天起算，最多 3 天。"},
                            "visible_when":{"field":"forecast","equals":"custom"}
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
    #[serde(default)]
    current_condition: Vec<Condition>,
    #[serde(default)]
    weather: Vec<LocalDay>,
}

#[derive(Deserialize)]
struct LocalDay {
    date: String,
    #[serde(rename = "mintempC")]
    min_c: String,
    #[serde(rename = "maxtempC")]
    max_c: String,
    #[serde(rename = "mintempF")]
    min_f: String,
    #[serde(rename = "maxtempF")]
    max_f: String,
    hourly: Vec<Phenomenon>,
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
    #[serde(flatten)]
    phenomenon: Phenomenon,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Phenomenon {
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

    let (start, days) = match settings.forecast {
        Forecast::Current => (0, 0),
        Forecast::Today => (0, 1),
        Forecast::Tomorrow => (1, 1),
        Forecast::Custom => {
            let days = settings.forecast_days.unwrap_or(MAX_FORECAST_DAYS);
            if !(1..=MAX_FORECAST_DAYS).contains(&days) {
                return Err(SendError::new(
                    "weather_days",
                    "Choose between 1 and 3 forecast days",
                    false,
                ));
            }
            (0, days)
        }
    };
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
    if days == 0 {
        return current(settings, location, weather);
    }
    let range = start..start + usize::from(days);
    let forecast: Vec<_> = weather
        .weather
        .get(range)
        .ok_or_else(missing_data)?
        .iter()
        .map(|day| daily_line(settings, day))
        .collect::<Result<_, _>>()?;
    let period = match (settings.forecast, settings.language) {
        (Forecast::Today, Language::English) => "today's forecast".to_owned(),
        (Forecast::Tomorrow, Language::English) => "tomorrow's forecast".to_owned(),
        (Forecast::Today, Language::Chinese) => "今日天气".to_owned(),
        (Forecast::Tomorrow, Language::Chinese) => "明日天气".to_owned(),
        (_, Language::English) => format!("{days}-day forecast"),
        (_, Language::Chinese) => format!("{days} 天天气"),
    };
    let title = match settings.language {
        Language::English => format!("{location}: {period}"),
        Language::Chinese => format!("{location} · {period}"),
    };
    Ok(draft(title, forecast.join("\n")))
}

fn daily_line(settings: &Settings, day: &LocalDay) -> Result<String, SendError> {
    let (min, max, unit) = match settings.units {
        Units::Metric => (&day.min_c, &day.max_c, "°C"),
        Units::Us => (&day.min_f, &day.max_f, "°F"),
    };
    let min = min.parse::<i16>().map_err(|_| invalid_data())?;
    let max = max.parse::<i16>().map_err(|_| invalid_data())?;
    let condition = day
        .hourly
        .get(day.hourly.len() / 2)
        .map_or("", |phenomenon| describe(phenomenon, settings.language));
    let date = &day.date;
    if !matches!(
        date.as_bytes(),
        [
            b'0'..=b'9',
            b'0'..=b'9',
            b'0'..=b'9',
            b'0'..=b'9',
            b'-',
            b'0'..=b'9',
            b'0'..=b'9',
            b'-',
            b'0'..=b'9',
            b'0'..=b'9'
        ]
    ) || min > max
    {
        return Err(invalid_data());
    }
    let prefix = if condition.is_empty() {
        date.clone()
    } else {
        format!("{date} · {}", anser_channel_http::truncate(condition, 64))
    };
    Ok(format!("{prefix} · {min} / {max}{unit}"))
}

fn current(settings: &Settings, location: &str, weather: Weather) -> Result<TaskOutput, SendError> {
    let condition = weather.current_condition.first().ok_or_else(missing_data)?;
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
    let description =
        anser_channel_http::truncate(describe(&condition.phenomenon, settings.language), 128);
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
    Ok(draft(title, body))
}

fn draft(title: String, body: String) -> TaskOutput {
    TaskOutput {
        notifications: vec![Message {
            title,
            body,
            ..Message::default()
        }],
        details: None,
    }
}

fn describe(condition: &Phenomenon, language: Language) -> &str {
    match language {
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
    }
}

fn missing_data() -> SendError {
    SendError::new(
        "weather_missing",
        "No weather data returned for this location",
        false,
    )
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
        "The weather provider returned invalid data",
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
            forecast: Forecast::Current,
            forecast_days: None,
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
            forecast: Forecast::Current,
            forecast_days: None,
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

    const LOCAL_FORECAST: &str = r#"{
        "weather":[
          {"date":"2026-11-24","mintempC":"2","maxtempC":"9","mintempF":"36","maxtempF":"48","hourly":[{"weatherCode":"122","weatherDesc":[{"value":"Overcast"}]}]},
          {"date":"2026-11-25","mintempC":"1","maxtempC":"8","mintempF":"34","maxtempF":"46","hourly":[{"weatherCode":"113","weatherDesc":[{"value":"Sunny"}]}]}
        ],
        "nearest_area":[{"latitude":"48.8566","longitude":"2.3522"}]
    }"#;
    #[tokio::test]
    async fn selects_today_tomorrow_and_custom_local_dates() {
        let policy = NetworkPolicy::new(true, vec![]);
        for (forecast, suffix, expected) in [
            (
                Forecast::Today,
                "today's forecast",
                "2026-11-24 · Overcast · 2 / 9°C",
            ),
            (
                Forecast::Tomorrow,
                "tomorrow's forecast",
                "2026-11-25 · Sunny · 1 / 8°C",
            ),
            (
                Forecast::Custom,
                "2-day forecast",
                "2026-11-24 · Overcast · 2 / 9°C\n2026-11-25 · Sunny · 1 / 8°C",
            ),
        ] {
            let (base, request) = serve("200 OK", "", LOCAL_FORECAST).await;
            let settings = Settings {
                location: "Paris".into(),
                language: Language::English,
                units: Units::Metric,
                forecast,
                forecast_days: Some(2),
            };
            let output = weather(&settings, base, &policy).await.unwrap();
            request.await.unwrap();
            assert_eq!(output.notifications[0].title, format!("Paris: {suffix}"));
            assert_eq!(output.notifications[0].body, expected);
        }
    }

    #[tokio::test]
    async fn rejects_forecast_requests_beyond_three_days_before_network_access() {
        let settings = Settings {
            location: "Paris".into(),
            language: Language::Chinese,
            units: Units::Metric,
            forecast: Forecast::Custom,
            forecast_days: Some(4),
        };
        let error = weather(
            &settings,
            url(BASE).unwrap(),
            &NetworkPolicy::new(false, vec![]),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "weather_days");
        assert!(!error.retryable);
    }

    #[tokio::test]
    #[ignore = "requires access to the public wttr.in service"]
    async fn live_wttr_compatibility() {
        let settings = Settings {
            location: "Shanghai".into(),
            language: Language::Chinese,
            units: Units::Metric,
            forecast: Forecast::Current,
            forecast_days: None,
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
        for (forecast, days) in [
            (Forecast::Today, 1),
            (Forecast::Tomorrow, 1),
            (Forecast::Custom, 3),
        ] {
            let settings = Settings {
                forecast,
                forecast_days: Some(days),
                location: settings.location.clone(),
                ..settings
            };
            let output = weather(
                &settings,
                url(BASE).unwrap(),
                &NetworkPolicy::new(false, vec![]),
            )
            .await
            .unwrap();
            assert_eq!(
                output.notifications[0].body.lines().count(),
                usize::from(days)
            );
        }
    }
}
