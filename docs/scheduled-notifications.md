# Scheduled notifications

Open **Plugin management → Scheduled notifications**, select an installed task such as wttr.in weather or certificate expiry, and fill in its options. Choose an enabled Topic or use the server's default route. Set an interval in minutes and an optional first run in your local time zone.

The server stores the schedule and its encrypted plugin inputs. A task can produce several messages or none, such as when there are no expiring certificates. The most recent run shows how many messages entered the delivery queue. Delivery attempts are visible in notification history. After downtime, an overdue schedule executes once and starts a new interval after completing. Pausing or deleting a schedule prevents an in-progress run from queuing its result. Messages already submitted follow the normal delivery policy. Deleting a Topic also removes schedules that target it.

The marketplace searches public GitHub repositories with the `anser-plugin` repository topic. Search sends the submitted keyword to the GitHub API. Administrators can set the optional `ANSER_GITHUB_TOKEN` environment variable to authenticate requests to GitHub.

All schedule operations require global administrator permission. Create and list schedules at `/v1/schedules`. Pause or resume with `PUT /v1/schedules/{id}` and a JSON body like `{"enabled":false}`. Request the next run immediately with `POST /v1/schedules/{id}/run` and remove a schedule with `DELETE /v1/schedules/{id}`.
