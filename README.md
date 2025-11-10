# Automn

Automn is a self-hosted automation control plane for authoring, scheduling, and auditing scripts across remote execution runners. The host exposes an Express API, a bundled React UI, and a job engine that keeps execution state, logs, and notifications in sync.

## Who is this for?

Currently, Automn is in a very early prototype phase, though feature rich and working well as a product for my needs.

Automn is seeded from similar projects I've created over the years, though this is the first attempt at decoupling the runner from the host with runner-to-host feedback. My previous projects were desktop based script runners designed to add a UI for running scripts easily with parameters, or just running scripts organized in a system tray context menu.

This project is best suited for hobbiest home labbers who want a way to quickly spin up script based APIs or webhooks.

Some examples I use it for:

  - To receive webhooks from jellyfin when it adds a new TV show or Movie. It'll retrieve the items image from jellyfin and use it to send a pushover notification for a pro looking notification
  - Replaces a NodeJS/Express project I was running on my home PC as a service where it could listen to commands such as /shutdown /sleep /mute etc. I used this mostly for a Siri integration, now I can much more easily update my scripts without having to rebuild my windows service every time - I just update the script in Automn! 
  - Trigger backup processes with some logging and notifications
  - Start and stop by openVPN container via a command (so I could have a switch in home assistant).

I'd love to keep developing Automn and seeing how strong it can become.

## Features
- **Centralised automation hub** – manage script versions, environment variables, collections, permissions, and audit trails from the web UI.
- **Remote runner orchestration** – register runners with configurable concurrency/timeouts and stream live execution logs back to the host.
- **Language-aware execution** – built-in helpers for Node.js, Python, and PowerShell scripts with structured return, log, and notification primitives.
- **Secure by default** – encrypted variable storage, scrypt hashed credentials, signed session cookies, and shared-secret runner authentication.
- **Docker-ready deployment** – ship the host and runners together with persistent volumes and optional language runtime pins.

## Quick Start with Docker Hub

In this example, the Automn host and Automn runner will run on the same docker host. Ensure the IP addresses match your dockers host IP.

If using this in production, it's highly advisable you put the host and runners behind a reverse proxy and apply an SSL certificate.

```docker-compose.yml
services:
  automn-host:
    image: automnexus/automn:latest
    container_name: automn
    ports:
      - "8088:8088"
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
    restart: unless-stopped

  automn-runner:
    image: automnexus/automn-runner:latest
    container_name: automn-runner
    ports:
      - "3030:3030"
    volumes:
      - ./runner-state:/app/state
      - ./runner-scripts:/app/scripts
      - ./runner-workdir:/app/script_workdir
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - AUTOMN_RUNNER_ID=default
      - AUTOMN_HOST_URL=http://<Automn Host IP>:8088
      - AUTOMN_RUNNER_PUBLIC_URL=http://<Automn Runner IP>:3030
```

- Browse to the host: http://<Automn Host IP>:8088 and login with user: admin and password: scriptfall (You'll need to update the password)
- Go to **SETTINGS**, and in the UI tab turn off all system icons, maybe one day they'll be good enough that I'd not suggest this.
- While in settings, go to the **RUNNERS** tab and click **+ ADD RUNNER**
- Give it any name you like, the **Runner ID** must match what you put in AUTOMN_RUNNER_ID in the docker compose (default is default) and leave the secret blank - Click **CREATE RUNNER**
  - Copy the **Runner secret**
- Browse to the runner: http://<Automn Runner IP>:3030 and paste in the **Runner secret** you copied in the previous step
- For the docker build, you can leave the runtime executables section as is, just click **Register runner**

At this point you can test your runner. Head over and create the following test script:


| **Field**                | **Value**                          |
|---------------------------|------------------------------------|
| **Name**                  | test                               |
| **Endpoint**              | test-endpoint                      |
| **Collection**             | General                            |
| **Runner**                | **Select the runner you created above** |
| **Language**              | Node JS                            |
| **Timeout (s)**           | 0                                  |
| **Allowed HTTP methods**  | POST, GET                          |


Add the code:
```
AutomnLog("Testing if " + process.env.AUTOMN_JOB_VAR_TARGET_RUNNER + " will run " + process.env.AUTOMN_JOB_VAR_SCRIPT_NAME, "info");
AutomnReturn({ success: true, message: "That couldn't have gone any better!" });
```

- Select **Run Script**, leave it as is (POST is fine) and click **RUN SCRIPT** or browse to: http://<Automn Host IP>:8088/s/test-endpoint to trigger the script
- Check the analytics tab, you should see a success posting with a return payload of:

{
  "success": true,
  "message": "That couldn't have gone any better!"
}

Have fun!!!

## Quick start with Docker Compose (Build yourself)
```bash
docker compose up --build -d
```

The compose stack builds the host and runner images locally, publishes the host UI/API on **http://localhost:8088**, and exposes the runner UI on **http://localhost:3030**. Named volumes persist database files, audit logs, runner state, and cached script artifacts between restarts.

Environment variables you should change before production:

| Variable | Service | Purpose |
| --- | --- | --- |
| `AUTOMN_VARIABLE_KEY` | `automn` | 32-byte secret used to encrypt stored environment variables. Rotate and back up securely. |
| `AUTOMN_SECURE_COOKIES` | `automn` | Set to `true` when Automn is served over HTTPS to mark auth cookies as `Secure`. Defaults to `false` for HTTP setups. |
| `AUTOMN_RUNNER_ID` | `automn_runner` | Identifier generated when you create a runner in the host UI. |
| `AUTOMN_RUNNER_PUBLIC_URL` | `automn_runner` | URL the host uses to reach the runner. Update if you expose the runner outside the compose network. |
| `AUTOMN_RUNNER_SECRET` | `automn_runner` | (Optional) Pre-configure the registration secret instead of entering it through the runner UI. |

Once the stack is running:
1. Open `http://localhost:8088` and sign in with the default admin password `scriptfall` (rotate immediately).
2. Navigate to **Settings → Runners**, create a runner, and copy the generated ID and secret.
3. Visit `http://localhost:3030`, submit the secret, and confirm the runner reports as **Healthy** in the host UI.
4. Create collections, scripts, and environment variables; trigger jobs directly from the UI or via HTTP `POST /s/<endpoint>`.

## Manual installation
Automn targets **Node.js 20** for both the host and runner.

1. Clone the repository and install dependencies:
   ```bash
   npm install
   npm --prefix frontend install
   npm run build
   ```
2. Launch the host:
   ```bash
   NODE_ENV=production node server.js
   ```
3. (Optional) Prepare a runner host:
   ```bash
   npm run runner:install
   NODE_ENV=production node runner/service.js
   ```
   Provide the same environment variables described in the Docker section so the runner can register with the host.

## Configuration reference
| Setting | Location | Notes |
| --- | --- | --- |
| Host port | `PORT` env var (default `8088`) | Host stores data under `./data` and logs under `./logs`. |
| Runner endpoint | `AUTOMN_RUNNER_PUBLIC_URL`/`AUTOMN_RUNNER_ENDPOINT_PATH` | Determines where the host POSTs job payloads. |
| Runner concurrency | `AUTOMN_RUNNER_MAX_CONCURRENCY` | Advertised to the host scheduler; can differ from the local concurrency guard `AUTOMN_RUNNER_LOCAL_MAX_CONCURRENCY`. |
| Runner timeout | `AUTOMN_RUNNER_TIMEOUT_MS` | Caps host → runner HTTP requests (default inherited from the host). |
| Variable encryption key | `AUTOMN_VARIABLE_KEY` | If unset, the host generates a key on first boot and stores it under `./data/variables.key`. |
| Session cookie security | `AUTOMN_SECURE_COOKIES` | Toggle to `true` behind HTTPS to emit `Secure` session cookies. Defaults to `false` for local HTTP deployments. |

Refer to [`docs/runner.md`](docs/runner.md) for the full runner API surface and lifecycle, and [`AUTOMN_CONTEXT.md`](AUTOMN_CONTEXT.md) for a deeper architectural tour.

## Architecture overview
- **Host API & UI (`server.js`)** – REST endpoints for authentication, script/category/variable management, run scheduling, notifications, and static asset serving. `/api/ws` streams structured run logs to the frontend.
- **Job engine (`engine.js`)** – Coordinates the execution queue, chooses healthy runners, propagates live logs, and collapses transport errors into structured run results.
- **Runner transport (`worker.js`)** – Handles HTTP streaming to runners, normalises headers, and enforces cancellation timeouts.
- **Persistence (`db.js`)** – SQLite schema/migrations covering users, sessions, scripts, collections, permissions, runs, and audit logs.
- **Runner service (`runner/`)** – Standalone Node.js service that registers with the host, executes scripts inside isolated workspaces, and exposes operational endpoints for status and secret rotation.
- **Frontend (`frontend/`)** – React + Vite single-page app for managing scripts, runs, analytics, variables, permissions, and runner health.

## Development workflow
- Use **Node.js 20** and `npm`. The root and `frontend/` workspaces maintain separate lockfiles.
- `npm run dev` starts the host API with hot reloading; `npm --prefix frontend run dev -- --host` serves the SPA on port 5173.
- `docker compose up --build` mirrors production by bundling the frontend and launching a runner.
- Before submitting changes, lint/format with your editor defaults and describe manual verification steps in your PR.

## Security checklist
1. Change the default admin password immediately after the first login.
2. Provide `AUTOMN_VARIABLE_KEY` via environment variables rather than relying on the generated on-disk key.
3. Terminate TLS in front of the host and runner before exposing them to the internet.
4. Restrict inbound traffic to the runner and rotate the runner secret regularly.
5. Persist and back up `./data`, `./logs`, and the runner state directories or volumes.

## Contributing
Automn remains open source under the MIT license, but we are pausing external contributions while the 0.2.x series stabilises. Please feel free to fork the code or file bug reports, but hold off on submitting pull requests until we announce that the contribution window has reopened.

## License
Automn is released under the [MIT License](LICENSE).
