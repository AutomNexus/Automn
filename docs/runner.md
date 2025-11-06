# Automn Runner Service

Automn runners execute scripts on behalf of the Automn control plane. Each runner is a lightweight Node.js service that registers with the host, streams live logs, and returns structured results. This guide covers the runner lifecycle, configuration, and HTTP interface for release **v0.2.0**.

## Lifecycle at a glance
1. An Automn administrator creates a runner entry in the host UI (**Settings → Runners**). The host issues a runner **ID** and **secret**.
2. The runner service starts (Docker, VM, or bare metal) with environment variables pointing at the host URL and network endpoint.
3. An operator visits the runner UI (`GET /`) and submits the secret, unless the secret is provided via `AUTOMN_RUNNER_SECRET`.
4. The runner registers with the host, persists state locally, and begins sending heartbeats at the configured cadence.
5. The host dispatches jobs to `POST /api/run`. The runner streams newline-delimited log frames and emits a final `result` payload when execution completes.

The host no longer embeds an execution engine—every script runs on a registered runner service.

## Host ↔ runner handshake
- Registration payload includes `AUTOMN_RUNNER_ID`, the endpoint URL (public URL + endpoint path), optional `statusMessage`, `maxConcurrency`, and `timeoutMs` values.
- POST the payload plus `secret` to:
  ```
  {AUTOMN_HOST_URL}/api/settings/runner-hosts/{AUTOMN_RUNNER_ID}/register
  ```
- On success the runner locks the setup UI, records the registration timestamps, and starts heartbeats based on `AUTOMN_RUNNER_HEARTBEAT_MS` (default 60s).
- The host validates `x-automn-runner-secret` on every job dispatch. Keep the secret private—anyone with the value can impersonate the runner.

## HTTP interface
| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Operator UI. Before registration it exposes a secret entry form; afterwards it shows status only. |
| `GET` | `/status` | JSON diagnostics covering configuration, registration timestamps, heartbeat details, and whether the secret originates from environment variables. |
| `GET` | `/ui/reregister` | Manual retry of the registration request. Useful immediately after restoring host connectivity. |
| `POST` | `/ui/register` | Stores the secret submitted via the HTML form (only available when `AUTOMN_RUNNER_SECRET` is unset). |
| `POST` | `/api/run` | Job execution endpoint. Requires header `x-automn-runner-secret`. Body: `{ "runId", "script", "reqBody" }`. Streams newline-delimited frames such as `{ "type": "log", "line" }` and final `{ "type": "result", "data": { ... } }`. |
| `POST` | `/internal/reset` | Resets or rotates the secret. Requires JSON `{ "token": "<AUTOMN_RUNNER_RESET_TOKEN>", "secret"?: "newSecret" }`. |

### Execution payloads
- `script`: Object maintained by the host (language, code, timeout, metadata).
- `reqBody`: Optional JSON payload forwarded from the host trigger.
- `runId`: Optional override. If omitted, the runner generates a UUID so results can still be correlated.

Log frames are forwarded verbatim; the final `result` payload includes `runId`, `stdout`, `stderr`, `code`, `duration`, `returnData`, `automnLogs`, `automnNotifications`, and the original `input`.

## Environment variables
| Variable | Purpose |
| --- | --- |
| `AUTOMN_HOST_URL` | Base URL of the Automn host (e.g. `http://automn:8088`). Must be reachable from the runner. |
| `AUTOMN_RUNNER_ID` | Identifier generated in the host UI. |
| `AUTOMN_RUNNER_PUBLIC_URL` / `AUTOMN_RUNNER_ENDPOINT_URL` | Controls how the host reaches the runner. Set the full endpoint URL or provide the public URL plus `AUTOMN_RUNNER_ENDPOINT_PATH` (default `/api/run`). |
| `AUTOMN_RUNNER_STATE_DIR` | Directory for persisted state (`runner-state.json`, registration metadata). Persist across restarts. |
| `AUTOMN_RUNNER_SCRIPTS_DIR` | Directory for generated scripts. Useful for caching Node.js dependencies. |
| `AUTOMN_RUNNER_WORKDIR` | Directory used as the per-run working tree. |
| `AUTOMN_RUNNER_HEARTBEAT_MS` | Interval (ms) between heartbeats. Default `60000`. |

When these directories are not provided explicitly, the runner stores runtime data under `runner/data/`, creating `state/runner-state.json`, `scripts/`, and `script_workdir/` alongside the service code. Persist them between restarts when running outside Docker.

### Optional tuning
| Variable | Description |
| --- | --- |
| `AUTOMN_RUNNER_SECRET` | Pre-configures the runner secret, disabling the UI form. |
| `AUTOMN_RUNNER_STATUS_MESSAGE` | Human-friendly status text reported to the host/UI. |
| `AUTOMN_RUNNER_MAX_CONCURRENCY` | Advertised concurrency cap respected by the host scheduler. |
| `AUTOMN_RUNNER_LOCAL_MAX_CONCURRENCY` | Local safeguard limiting simultaneous executions regardless of host configuration. |
| `AUTOMN_RUNNER_TIMEOUT_MS` | Upper bound (ms) for host → runner HTTP requests. |
| `AUTOMN_RUNNER_RESET_TOKEN` | Enables the `/internal/reset` endpoint for secret rotation. Provide a long random string. |
| `PORT` / `AUTOMN_RUNNER_PORT` | HTTP listen port (default `3030`). |
| `PYTHON_VERSION`, `POWERSHELL_VERSION` (build args) | Pin interpreter versions when building the runner Docker image. |

## Docker Compose example
The repository includes a compose stack with named volumes:

```yaml
  automn_runner:
    build:
      context: .
      dockerfile: runner/Dockerfile
      args:
        PYTHON_VERSION: ${AUTOMN_RUNNER_PYTHON_VERSION:-}
        POWERSHELL_VERSION: ${AUTOMN_RUNNER_POWERSHELL_VERSION:-}
    container_name: automn_runner
    depends_on:
      - automn
    environment:
      - NODE_ENV=production
      - AUTOMN_HOST_URL=http://automn:8088
      - AUTOMN_RUNNER_ID=default
      - AUTOMN_RUNNER_PUBLIC_URL=http://automn_runner:3030
      - AUTOMN_RUNNER_ENDPOINT_PATH=/api/run
      - AUTOMN_RUNNER_STATE_DIR=/app/state
      - AUTOMN_RUNNER_SCRIPTS_DIR=/app/scripts
      - AUTOMN_RUNNER_WORKDIR=/app/script_workdir
      - AUTOMN_RUNNER_HEARTBEAT_MS=60000
    ports:
      - "3030:3030"
    volumes:
      - automn_runner_state:/app/state
      - automn_runner_scripts:/app/scripts
      - automn_runner_workdir:/app/script_workdir
```

Update `AUTOMN_RUNNER_ID` (and optionally `AUTOMN_RUNNER_SECRET`) to match the entry created in the host UI. After the stack starts, open `http://localhost:3030/` to complete registration.

To pin language runtimes, export `AUTOMN_RUNNER_PYTHON_VERSION` (e.g. `3.11`) and/or `AUTOMN_RUNNER_POWERSHELL_VERSION` (e.g. `7.4.2`) before running `docker compose up`. Custom PowerShell versions are downloaded from the official release feed.

## Secret rotation & recovery
1. **Planned rotation**
   - Generate a new secret in the host UI.
   - Call `POST /internal/reset` with `{ "token": "<AUTOMN_RUNNER_RESET_TOKEN>", "secret": "<new secret>" }`.
   - The runner stores the new secret, re-registers immediately, and reflects the status via `/status` and the UI.
2. **Manual reset (no reset token)**
   - Stop the runner service.
   - Remove the persisted state file (default `${AUTOMN_RUNNER_STATE_DIR}/runner-state.json`).
   - Restart the service and enter the new secret through the UI.
3. **Emergency lockout**
   - Disable the runner from the host UI to block new dispatches.
   - Rotate the secret using one of the methods above.
   - Verify `/status` reports a recent `registeredAt` timestamp and no `lastRegistrationError`.

## Deploying outside Docker
- Install Node.js 20 or later.
- Copy `package.json`, `package-lock.json`, and the `runner/` directory to the target host.
- Run `npm ci --omit=dev` followed by `NODE_ENV=production node runner/service.js` with the required environment variables.
- Ensure the configured endpoint URL is reachable from the Automn host (DNS, firewall, reverse proxy).

With these pieces in place, Automn runners provide resilient, auditable script execution at the edge of your infrastructure.
