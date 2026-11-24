# wttr.in weather

Run this task from **Plugins → Tasks** or with a global administrator request to `POST /v1/plugins/task/wttr-weather/run`.

```json
{
  "config": {
    "location": "Shanghai",
    "language": "zh",
    "units": "metric"
  }
}
```

The location accepts a city name or airport code. The notification language is `en` or `zh`, and units are `metric` (°C) or `us` (°F). The task uses wttr.in's JSON endpoint and returns a notification draft with current conditions, apparent temperature, and humidity.

| Error | Retryable |
| --- | --- |
| Invalid options, missing location data, or upstream 4xx other than timeout/rate limit | No |
| Network timeout, upstream 5xx, or invalid response | Yes |
| Rate limit | Yes, respecting Retry-After |

[wttr.in query options](https://wttr.in/:help)
