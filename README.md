# Status monitor

Discord uptime monitor for Baxen projects. One process checks every configured URL, edits one Discord message per project, and posts an alert after three consecutive failures.

It does not open a database and does not call authenticated routes.

## Projects

Put the list in `projects.json` (`PROJECTS_FILE`, default `./projects.json`) or inline it as `PROJECTS_JSON`. When `PROJECTS_JSON` is set, the file is not read. On Render, set `PROJECTS_JSON` because `projects.json` is not part of the image.

```bash
cp projects.example.json projects.json
```

Each project has an `id`, `name`, `discord_status_channel_id`, optional `environment`, and one or more checks (`id`, `name`, `url`, optional `importance`, optional `expect`). `importance` is `critical` unless you set `dependency`. `expect` is a small JSON object; a 2xx response is still a failure when any listed field does not match. Duplicate project or check ids are rejected. Production URLs must be https, except localhost.

The status card for a project is posted in that project's channel. `DISCORD_STATUS_CHANNEL_ID` is only a fallback when a project leaves the field out. The embed footer starts with `status-monitor:<project id>`, which is how the process finds that message again after a restart. Alerts go to `DISCORD_ALERT_CHANNEL_ID` when that is set, and otherwise to the same channel as the project's status card.

A failed request is retried once. The third consecutive failed cycle posts a down alert. Two successful cycles after that post a recovery. A still-down reminder goes out on the reminder interval.

## Run

```bash
cd apps/status-monitor
cp .env.example .env
npm ci
npm test
npm run dev
```

`GET /health` on `PORT` (8080 locally) returns `{ "status": "ok", "service": "status-monitor" }`. Any other path returns 404. That route is for an external watchdog. It does not check Discord or the projects.

## GitHub Actions

The private repo runs one check every 30 minutes on GitHub-hosted runners, then exits. Stop the local `npm run dev` after this is running, or both will edit the same cards.

Repository secrets, not files in git:

- `DISCORD_BOT_TOKEN`
- `PROJECTS_JSON` — the contents of `projects.json`

A down alert still waits for 3 failed checks, which is about 90 minutes on this schedule. GitHub can start a run a few minutes late. Uptime counts and the dashboard message id are kept in the Actions cache between runs. The footer marker still lets a later run find the existing card if that cache is dropped.

## Render

Use a **Background Worker**, not a free Web Service. A free web service sleeps when nobody visits it, so the checks would stop. A worker stays running.

1. Push this folder to a Git remote Render can read. Do not commit `.env` or `projects.json`.
2. In Render, create a Background Worker. Set the root directory to `apps/status-monitor` if the repo is the whole Baxen tree. Runtime is Docker. `render.yaml` in this folder describes that service.
3. Add environment variables:
   - `DISCORD_BOT_TOKEN` — the same token as in `.env`
   - `PROJECTS_JSON` — the full contents of `projects.json`
4. Optionally add a persistent disk mounted at `/data` and set `DATA_DIR=/data`. That keeps message ids and uptime across deploys. Without the disk, a restart still finds the existing cards by the `status-monitor:<id>` footer, and the uptime numbers start over.
5. Deploy, then stop the local `npm run dev`. Two processes would both edit the same cards.

Logs should show `monitoring_started`, then `check_finished` for each project. `dashboard_failed` means the bot still cannot see that channel.

## Discord

The bot needs View Channel, Send Messages, Embed Links, and Read Message History in the status channel and the alert channel. It does not need Administrator.
