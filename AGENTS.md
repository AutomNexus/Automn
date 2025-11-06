# Automn Repository Guide

Thanks for working on Automn! These notes capture the conventions we follow for the host, runner, and frontend packages. External contributions are temporarily paused, but keep this guide handy if you're maintaining a fork or preparing future changes for when the window reopens.

## Supported environment
- Target **Node.js 20** for the host and runner services.
- Install dependencies with `npm install` in the repository root and `npm --prefix frontend install` for the React workspace.
- Prefer `npm` scripts over `yarn`/`pnpm`; CI mirrors this setup.

## Development workflow
- `npm run dev` starts the host API with live reload.
- `npm --prefix frontend run dev -- --host` serves the Vite frontend on port 5173.
- `docker compose up --build` launches a production-like stack (host + runner) with persistent volumes.
- Describe any manual verification you performed in PR descriptions. There is no automated test suite yet.

## Coding standards
- Use double quotes and trailing semicolons in JavaScript/TypeScript files to match the existing style.
- Prefer `const`/`let` (no `var`). Keep helper utilities pure whenever possible to aid determinism in the job engine.
- Mirror existing validation helpers in `server.js` when adding new endpoints instead of duplicating schema logic.
- Avoid wrapping imports in `try/catch` blocks; bubble errors instead.

## Frontend notes
- Co-locate component styles with their React components. Tailwind and PostCSS are already configured.
- Run `npm --prefix frontend run build` before committing significant UI changes to ensure the production bundle compiles.
- For PRs that change visible UI, attach a screenshot captured from the running dev server.

## Security reminders
- Never commit real secrets or private keys. Use `.env.example` style placeholders when documenting configuration.
- Rotate the default admin password when running Automn in production.

If you discover new gotchas, extend this document to help the next contributor move faster. Happy automating!
