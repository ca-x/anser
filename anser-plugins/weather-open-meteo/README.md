# Open-Meteo weather

Run **Open-Meteo Weather** from the task plugins or schedule it in **Scheduled tasks**. Administrators can also call `POST /v1/plugins/task/open-meteo-weather/run` with the [example configuration](example.json).

Enter a city or postal code. Set a two-letter country code if several places share the same name. Choose today, tomorrow, seven days, or a custom range of 1 to 16 days. Custom ranges start today. Forecasts use the location's time zone and show the daily low, high, and weather conditions in the selected language and units.

The plugin calls `geocoding-api.open-meteo.com` for the city and `api.open-meteo.com` for the forecast. It uses Open-Meteo's [public non-commercial API](https://open-meteo.com/en/terms). No API key is needed.

| Error | Retryable |
| --- | --- |
| Invalid options or no matching location | No |
| Invalid forecast response, timeout, or provider 5xx | Yes |
| Provider rate limit | Yes, respecting Retry-After |
