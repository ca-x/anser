# Scheduled notifications

Open **Scheduled tasks**, select an installed task such as wttr.in weather or certificate expiry, and fill in its options. Choose an enabled Topic or use the server's default route.

- **Fixed interval** runs every specified number of minutes, hours, or days. A day is 24 hours and the longest interval is 30 days. Set an optional first run in your local time zone. Later runs are scheduled one interval after the preceding run finishes.
- **Weekly** runs at a chosen local time on one or more days from Monday through Sunday, in the selected time zone. If a daylight saving change skips that time, the occurrence is skipped. If the clock repeats the same time, the earlier occurrence is used.
- **One time** runs on a specified date at the selected local time. The plan finishes after its first recorded result, including a failure. **Run now** uses up that occurrence.

The server stores the schedule and its encrypted plugin inputs. A task can produce several messages or none, such as when there are no expiring certificates. The most recent run shows how many messages entered the delivery queue. Delivery attempts are visible in notification history. After downtime or a pause, an overdue plan runs once. A weekly plan then returns to its configured weekday and local time. Pausing or deleting a schedule prevents an in-progress run from queuing its result. Messages already submitted follow the normal delivery policy. Deleting a Topic also removes schedules that target it.

The marketplace searches public GitHub repositories with the `anser-plugin` repository topic. Search sends the submitted keyword to the GitHub API. Administrators can set the optional `ANSER_GITHUB_TOKEN` environment variable to authenticate requests to GitHub.

All schedule operations require global administrator permission. Create and list schedules at `/v1/schedules`. When creating a plan, set `rule` to one of the following shapes:

| Type | Example rule |
| --- | --- |
| Fixed interval | `{"kind":"interval","minutes":120}` |
| Weekly | `{"kind":"weekly","weekdays":[1,5],"time":"09:30","time_zone":"Asia/Shanghai"}` |
| One time | `{"kind":"once","at":1893459600000}` |

Weekly days use ISO numbering from Monday (1) through Sunday (7). One-time `at`, interval-only `start_at`, and response timestamps use Unix milliseconds. The create endpoint still accepts a top-level `interval_minutes` in place of `rule`.

Edit a plan from its **Edit** action. The admin API uses `GET /v1/schedules/{id}` and `PATCH /v1/schedules/{id}`. Supply `name`, `plugin_id`, and the destination `topic` (or null for default routing). Omit `rule` and `start_at` to keep the next run. Changing a finished one-time plan to a new date schedules it again. Stored task input is write-only. A running plan returns a conflict until it finishes.

Pause or resume with `PUT /v1/schedules/{id}` and a JSON body such as `{"enabled":false}`. Request an immediate run with `POST /v1/schedules/{id}/run`. Finished one-time plans return `completed: true` and `next_at: null`. Remove a plan with `DELETE /v1/schedules/{id}`.
