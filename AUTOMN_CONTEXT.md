# Automn Development Context

This document gives maintainers and future contributors a fast tour of the Automn codebase, the services that make up the platform, and the areas that typically require extra care during development. External pull requests are on pause while we focus on the 0.2.x roadmap, but this context should help anyone preparing local changes or long-lived forks.

## Platform overview
Automn provides a self-hosted control plane for automating scripts across remote execution runners. The host bundles an Express API, React UI, and job engine for scheduling, monitoring, and auditing runs. Runners register with the host, execute scripts in isolated workspaces, and stream real-time logs back to the control plane.

### Host control plane
- **`server.js`** – Entry point that wires the Express API, authentication, session cookies, encrypted variable storage, and runner management endpoints. It also serves the compiled frontend bundle and exposes a WebSocket bridge at `/api/ws` for live run logs.
- **`engine.js`** – Coordinates run scheduling, tracks subscribers per run, enforces runner availability checks, and surfaces structured failures when dispatching jobs.
- **`worker.js`** – Handles outbound HTTP(S) requests to registered runners, normalises headers, streams newline-delimited frames, and exposes cancellation helpers.
- **`db.js`** – Bootstraps SQLite migrations and provides helpers for users, sessions, scripts, collections, permissions, variables, and run history.
- **`security.js`** – Houses password hashing/verification helpers and session token utilities shared across the host.

### Remote runner service (`runner/`)
- **`runner/service.js`** – Small Node.js server that registers with the host, exposes status and reset endpoints, and orchestrates script execution by delegating to the execution core.
- **`runner/core.js`** – Implements the execution pipeline for supported languages (Node.js, Python, PowerShell). It injects helper globals (`AutomnReturn`, `AutomnLog`, `AutomnRunLog`, `AutomnNotify`), prepares temporary workspaces, installs npm dependencies when necessary, and streams structured results back to the host.
- The runner persists registration state, secrets, and cached script artifacts under configurable directories so they survive restarts.

### Frontend (`frontend/`)
- Vite + React single-page application. `src/App.jsx` holds the tabbed interface for scripts, analytics, variables, permissions, runner management, and future agent tooling.
- Shared utilities under `src/utils` wrap authenticated API requests; `src/hooks/useLiveLogs.js` consumes WebSocket streams and normalises Automn log frames.
- Tailwind and CSS modules are available for styling; production builds are emitted during `npm run build` or Docker image creation.

## Repository structure
```
.
├── AGENTS.md                # Contribution guidelines and local workflow hints
├── AUTOMN_CONTEXT.md        # This document
├── Dockerfile               # Builds the host service + frontend bundle
├── docker-compose.yml       # Host + runner stack with persistent volumes
├── constants.js             # Default admin password and semantic versions
├── db.js / engine.js / worker.js / server.js
├── docs/
│   └── runner.md            # Runner service reference
├── frontend/                # React application
├── runner/                  # Runner service (Dockerfile, service.js, core.js)
└── security.js, variable-definitions.js, etc.
```

## Development tips
- **Environment** – Use Node.js 20 and `npm`. Run `npm install` at the root and `npm --prefix frontend install` in the frontend workspace.
- **Local stack** – `docker compose up --build` launches the host plus a runner. Outside Docker, run `node server.js` and `node runner/service.js` with the appropriate environment variables.
- **Frontend dev** – Start the host (`npm run dev`) and the Vite dev server (`npm --prefix frontend run dev -- --host`) to work on the UI with live reload.
- **Database** – SQLite files live under `./data`. Deleting the directory resets the environment; the host will recreate the schema and seed an admin account on boot.
- **Secrets** – The default admin password is `scriptfall`. Change it immediately in any persistent environment. Variable encryption relies on `AUTOMN_VARIABLE_KEY`; provide it via environment variables for production.

## Extension ideas
- **Agents & integrations** – The settings UI reserves an “Agents” tab. Future work can implement agent registration, lifecycle management, and execution bridging similar to runners.
- **RBAC improvements** – Existing per-script/collection permissions can evolve into role-based access controls or environment-scoped policies.
- **Runner ecosystems** – Add support for per-language dependency managers (Python virtualenvs, PowerShell modules) and richer health checks.
- **Packaging** – Multi-stage builds, distroless images, or orchestrator manifests (Kubernetes, Nomad) would improve deployment portability.

## Releasing Automn
- Update `constants.js` with the host and minimum runner semantic versions.
- Document notable changes in `README.md` and supporting docs.
- Validate Docker builds (`docker compose build`) and smoke-test host/runner registration.
- Tag releases using `v<major>.<minor>.<patch>` once verification is complete.

Use this context as a jumping-off point when planning enhancements or exploring unfamiliar corners of the platform.
