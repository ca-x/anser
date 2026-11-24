//! Daily forecasts from Open-Meteo, using its own city lookup.

use anser_channel_http::{
    NetworkPolicy, client_with_policy, config, decode, network_error, reqwest::Url, response, url,
};
use anser_core::Message;
use anser_plugin_api::{
    PluginDescriptor, PluginFuture, PluginKind, SendError, TaskOutput, TaskService,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

const SEARCH: &str = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST: &str = "https://api.open-meteo.com/v1/forecast";
const MAX_DAYS: u8 = 16;

#[derive(Default)]
pub struct OpenMeteoWeather;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    location: String,
    country_code: Option<String>,
    #[serde(default)]
    language: Language,
    #[serde(default)]
    units: Units,
    #[serde(default)]
    forecast: Period,
    forecast_days: Option<u8>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Language {
    #[default]
    En,
    Zh,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Units {
    #[default]
    Metric,
    Us,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Period {
    Today,
    Tomorrow,
    #[default]
    Week,
    Custom,
}

impl TaskService for OpenMeteoWeather {
    fn descriptor(&self) -> PluginDescriptor {
        PluginDescriptor {
            kind: PluginKind::Task,
            id: "open-meteo-weather".into(),
            display_name: "Open-Meteo Weather".into(),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            config_schema: json!({
                "type":"object","required":["location"],"additionalProperties":false,
                "x-anser-ui":{"label":{"en":"Open-Meteo Weather","zh-CN":"Open-Meteo 天气"},"task_input":"none"},
                "properties":{
                    "location":{"type":"string","minLength":2,"maxLength":128,"x-anser-ui":{
                        "label":{"en":"City or postal code","zh-CN":"城市或邮编"}}},
                    "country_code":{"type":"string","pattern":"^[A-Za-z]{2}$","x-anser-ui":{
                        "label":{"en":"Country code (optional)","zh-CN":"国家代码（可选）"},
                        "description":{"en":"Use two letters, such as CN or US, to distinguish cities with the same name.","zh-CN":"同名城市可用两位代码区分，例如 CN 或 US。"}}},
                    "language":{"type":"string","enum":["en","zh"],"default":"en","x-anser-ui":{
                        "label":{"en":"Notification language","zh-CN":"通知语言"},
                        "option_labels":{"en":{"en":"English","zh-CN":"英文"},"zh":{"en":"Simplified Chinese","zh-CN":"简体中文"}}}},
                    "units":{"type":"string","enum":["metric","us"],"default":"metric","x-anser-ui":{
                        "label":{"en":"Units","zh-CN":"单位"},
                        "option_labels":{"metric":{"en":"Metric","zh-CN":"公制"},"us":{"en":"US customary","zh-CN":"美制"}}}},
                    "forecast":{"type":"string","enum":["today","tomorrow","week","custom"],"default":"week","x-anser-ui":{
                        "label":{"en":"Forecast period","zh-CN":"预报范围"},"option_labels":{
                            "today":{"en":"Today","zh-CN":"当天"},"tomorrow":{"en":"Tomorrow","zh-CN":"次日"},
                            "week":{"en":"7 days","zh-CN":"一周"},"custom":{"en":"Custom days","zh-CN":"自定义天数"}}}},
                    "forecast_days":{"type":"integer","minimum":1,"maximum":MAX_DAYS,"default":7,"x-anser-ui":{
                        "label":{"en":"Forecast days","zh-CN":"预报天数"},
                        "description":{"en":"Counts from today, up to 16 days.","zh-CN":"从当天起算，最多 16 天。"},
                        "visible_when":{"field":"forecast","equals":"custom"}}}
                }
            }),
        }
    }

    fn run<'a>(&'a self, settings: &'a Value, input: &'a Value) -> PluginFuture<'a, TaskOutput> {
        Box::pin(async move {
            if !input.is_null() && !input.as_object().is_some_and(serde_json::Map::is_empty) {
                return Err(SendError::new(
                    "open_meteo_input",
                    "Use the plugin options to configure forecasts",
                    false,
                ));
            }
            weather(
                &config(settings)?,
                url(SEARCH)?,
                url(FORECAST)?,
                &NetworkPolicy::from_env(),
            )
            .await
        })
    }
}

#[derive(Deserialize)]
struct Places {
    #[serde(default)]
    results: Vec<Place>,
}

#[derive(Deserialize)]
struct Place {
    name: String,
    admin1: Option<String>,
    country: Option<String>,
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize)]
struct Forecast {
    daily: Daily,
}

#[derive(Deserialize)]
struct Daily {
    time: Vec<String>,
    temperature_2m_min: Vec<f64>,
    temperature_2m_max: Vec<f64>,
    weather_code: Vec<u8>,
}

async fn weather(
    settings: &Settings,
    mut search: Url,
    mut forecast: Url,
    policy: &NetworkPolicy,
) -> Result<TaskOutput, SendError> {
    let location = settings.location.trim();
    if !(2..=128).contains(&location.chars().count()) || location.chars().any(char::is_control) {
        return Err(SendError::new(
            "open_meteo_location",
            "Enter a city or postal code",
            false,
        ));
    }
    let (start, days) = match settings.forecast {
        Period::Today => (0, 1),
        Period::Tomorrow => (1, 1),
        Period::Week => (0, 7),
        Period::Custom => (0, settings.forecast_days.unwrap_or(7)),
    };
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(SendError::new(
            "open_meteo_days",
            "Choose between 1 and 16 forecast days",
            false,
        ));
    }
    let end = start + days;
    let locale = match settings.language {
        Language::En => "en",
        Language::Zh => "zh",
    };
    search
        .query_pairs_mut()
        .append_pair("name", location)
        .append_pair("count", "1")
        .append_pair("language", locale);
    if let Some(country) = settings
        .country_code
        .as_deref()
        .map(str::trim)
        .filter(|code| !code.is_empty())
    {
        if country.len() != 2 || !country.bytes().all(|ch| ch.is_ascii_alphabetic()) {
            return Err(SendError::new(
                "open_meteo_country",
                "Enter a two-letter country code",
                false,
            ));
        }
        search
            .query_pairs_mut()
            .append_pair("countryCode", &country.to_ascii_uppercase());
    }
    let places: Places = fetch(search, policy).await?;
    let place = places.results.into_iter().next().ok_or_else(|| {
        SendError::new(
            "open_meteo_not_found",
            "No location matches this city or postal code",
            false,
        )
    })?;
    if place.latitude.abs() > 90.0 || place.longitude.abs() > 180.0 {
        return Err(invalid_forecast());
    }
    let (temperature_unit, unit) = match settings.units {
        Units::Metric => ("celsius", "°C"),
        Units::Us => ("fahrenheit", "°F"),
    };
    forecast
        .query_pairs_mut()
        .append_pair("latitude", &place.latitude.to_string())
        .append_pair("longitude", &place.longitude.to_string())
        .append_pair("timezone", "auto")
        .append_pair("forecast_days", &end.to_string())
        .append_pair("temperature_unit", temperature_unit)
        .append_pair(
            "daily",
            "weather_code,temperature_2m_min,temperature_2m_max",
        );
    let report: Forecast = fetch(forecast, policy).await?;
    let daily = report.daily;
    if [
        daily.time.len(),
        daily.temperature_2m_min.len(),
        daily.temperature_2m_max.len(),
        daily.weather_code.len(),
    ]
    .into_iter()
    .any(|length| length != usize::from(end))
    {
        return Err(invalid_forecast());
    }
    let rows = (usize::from(start)..usize::from(end))
        .map(|index| {
            let date = &daily.time[index];
            let min = daily.temperature_2m_min[index];
            let max = daily.temperature_2m_max[index];
            if date.len() != 10
                || !date.bytes().enumerate().all(|(i, ch)| {
                    if matches!(i, 4 | 7) {
                        ch == b'-'
                    } else {
                        ch.is_ascii_digit()
                    }
                })
                || min > max
            {
                return Err(invalid_forecast());
            }
            let condition = describe(daily.weather_code[index], settings.language);
            Ok(format!("{date} · {condition} · {min:.0} / {max:.0}{unit}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let place_name = [Some(place.name), place.admin1, place.country]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ");
    let place_name = anser_channel_http::truncate(&place_name, 128);
    let title = match (settings.forecast, settings.language) {
        (Period::Today, Language::En) => format!("{place_name}: today's forecast"),
        (Period::Tomorrow, Language::En) => format!("{place_name}: tomorrow's forecast"),
        (Period::Today, Language::Zh) => format!("{place_name} · 今日天气"),
        (Period::Tomorrow, Language::Zh) => format!("{place_name} · 明日天气"),
        (_, Language::En) => format!("{place_name}: {days}-day forecast"),
        (_, Language::Zh) => format!("{place_name} · {days} 天天气"),
    };
    Ok(TaskOutput {
        notifications: vec![Message {
            title,
            body: rows.join("\n"),
            url: Some("https://open-meteo.com/".into()),
            ..Message::default()
        }],
        details: None,
    })
}

async fn fetch<T: DeserializeOwned>(endpoint: Url, policy: &NetworkPolicy) -> Result<T, SendError> {
    let reply = client_with_policy(&endpoint, None, policy)
        .await?
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(network_error)?;
    decode(&response(reply).await?)
}

fn invalid_forecast() -> SendError {
    SendError::new(
        "open_meteo_response",
        "Open-Meteo returned invalid forecast data",
        true,
    )
}

fn describe(code: u8, language: Language) -> &'static str {
    let (en, zh) = match code {
        0 => ("Clear", "晴"),
        1..=2 => ("Partly cloudy", "多云"),
        3 => ("Overcast", "阴"),
        45 | 48 => ("Fog", "雾"),
        51..=57 => ("Drizzle", "毛毛雨"),
        61..=67 => ("Rain", "雨"),
        71..=77 => ("Snow", "雪"),
        80..=82 => ("Showers", "阵雨"),
        85..=86 => ("Snow showers", "阵雪"),
        95..=99 => ("Thunderstorms", "雷暴"),
        _ => ("Unknown conditions", "天气状况未知"),
    };
    match language {
        Language::En => en,
        Language::Zh => zh,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock::serve;

    const PLACE: &str = r#"{"results":[{"name":"Paris","latitude":48.8566,"longitude":2.3522,"country":"France"}]}"#;
    const TWO_DAYS: &str = r#"{"daily":{"time":["2026-11-24","2026-11-25"],"temperature_2m_min":[32.0,33.0],"temperature_2m_max":[45.0,46.0],"weather_code":[0,95]}}"#;

    #[tokio::test]
    async fn finds_city_and_requests_local_tomorrow() {
        let (search, lookup) = serve("200 OK", "", PLACE).await;
        let (forecast, request) = serve("200 OK", "", TWO_DAYS).await;
        let settings = config(&json!({
            "location":"Paris", "country_code":"fr", "language":"zh", "units":"us", "forecast":"tomorrow"
        })).unwrap();
        let result = weather(
            &settings,
            search,
            forecast,
            &NetworkPolicy::new(true, vec![]),
        )
        .await
        .unwrap();
        let lookup = lookup.await.unwrap().headers;
        assert!(lookup.contains("name=Paris") && lookup.contains("countryCode=FR"));
        let request = request.await.unwrap().headers;
        for query in [
            "latitude=48.8566",
            "longitude=2.3522",
            "forecast_days=2",
            "temperature_unit=fahrenheit",
            "timezone=auto",
        ] {
            assert!(request.contains(query));
        }
        let draft = &result.notifications[0];
        assert_eq!(draft.title, "Paris, France · 明日天气");
        assert_eq!(draft.body, "2026-11-25 · 雷暴 · 33 / 46°F");
    }

    #[tokio::test]
    async fn handles_invalid_options_unknown_locations_and_provider_errors() {
        let policy = NetworkPolicy::new(true, vec![]);
        let invalid =
            config(&json!({"location":"Paris","forecast":"custom","forecast_days":17})).unwrap();
        let error = weather(
            &invalid,
            url(SEARCH).unwrap(),
            url(FORECAST).unwrap(),
            &policy,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "open_meteo_days");
        assert!(!error.retryable);

        let settings = config(&json!({"location":"Paris"})).unwrap();
        let (search, request) = serve("200 OK", "", "{}").await;
        let error = weather(&settings, search, url(FORECAST).unwrap(), &policy)
            .await
            .unwrap_err();
        request.await.unwrap();
        assert_eq!(error.code, "open_meteo_not_found");

        let (search, request) = serve("200 OK", "", PLACE).await;
        let (forecast, delivery) = serve("429 Too Many Requests", "Retry-After: 12\r\n", "").await;
        let error = weather(&settings, search, forecast, &policy)
            .await
            .unwrap_err();
        request.await.unwrap();
        delivery.await.unwrap();
        assert!(error.retryable);
        assert_eq!(error.retry_after_ms, Some(12_000));
    }

    #[tokio::test]
    #[ignore = "requires access to the public Open-Meteo service"]
    async fn live_forecasts() {
        for (forecast, days) in [("week", 7), ("custom", 16)] {
            let settings = config(&json!({"location":"Paris","country_code":"FR","forecast":forecast,"forecast_days":days})).unwrap();
            let result = weather(
                &settings,
                url(SEARCH).unwrap(),
                url(FORECAST).unwrap(),
                &NetworkPolicy::new(false, vec![]),
            )
            .await
            .unwrap();
            assert_eq!(result.notifications[0].body.lines().count(), days);
        }
    }
}
