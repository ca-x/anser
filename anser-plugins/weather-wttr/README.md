# wttr.in weather

Run this task from **Plugins → Tasks** or with a global administrator request to `POST /v1/plugins/task/wttr-weather/run`.

```json
{
  "config": {
    "location": "Shanghai",
    "language": "zh",
    "units": "metric",
    "forecast": "tomorrow"
  }
}
```

The location accepts a city name or airport code. The notification language is `en` or `zh`, and units are `metric` (°C) or `us` (°F). Set `forecast` to `current` (the default), `today`, `tomorrow`, or `custom`. The current report shows temperature, apparent temperature and humidity. A forecast shows each local date, weather conditions, and the daily low and high. Set `forecast_days` to 1, 2, or 3 in custom mode (default 3). The range starts on the local date of the selected location and uses the three forecast days provided by wttr.in.

| Error | Retryable |
| --- | --- |
| Invalid options, missing location data, or upstream 4xx other than timeout/rate limit | No |
| Network timeout, upstream 5xx, or invalid response | Yes |
| Rate limit | Yes, respecting Retry-After |

[wttr.in query options](https://wttr.in/:help)
