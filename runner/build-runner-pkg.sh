#!/usr/bin/env bash
set -euo pipefail

# This script bundles the Automn runner into a standalone executable using pkg and
# produces a tarball that can be deployed as a systemd service on Ubuntu hosts.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PKG_VERSION="${PKG_VERSION:-5.11.0}"
PKG_TARGET="${PKG_TARGET:-node20-linux-x64}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/dist/runner-pkg}"
STAGING_DIR="$OUTPUT_DIR/stage"
TARBALL_NAME="automn-runner-${PKG_TARGET//\//-}.tar.gz"

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "node_modules directory is missing. Run \"npm install\" before packaging." >&2
  exit 1
fi

PKG_BIN="$ROOT_DIR/node_modules/.bin/pkg"
if [ -x "$PKG_BIN" ]; then
  PKG_CMD="$PKG_BIN"
else
  PKG_CMD="npx --yes pkg@${PKG_VERSION}"
fi

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

echo "Building runner binary for target ${PKG_TARGET}..."
$PKG_CMD runner/service.js \
  --targets "$PKG_TARGET" \
  --output "$STAGING_DIR/automn-runner" \
  --assets "runner/public/**/*" \
  --compress Brotli

mkdir -p "$STAGING_DIR/state" "$STAGING_DIR/scripts" "$STAGING_DIR/script_workdir" "$STAGING_DIR/data"

cat > "$STAGING_DIR/automn-runner.service" <<'SERVICE'
[Unit]
Description=Automn Runner Service
After=network.target

[Service]
Type=simple
EnvironmentFile=-/etc/automn/runner.env
WorkingDirectory=/opt/automn-runner
ExecStart=/opt/automn-runner/automn-runner
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
SERVICE

cat > "$STAGING_DIR/runner.env.example" <<'ENVFILE'
# Automn runner configuration
# Copy to /etc/automn/runner.env and adjust values for your environment.
AUTOMN_HOST_URL=http://automn-host:8088
AUTOMN_RUNNER_ID=your-runner-id
AUTOMN_RUNNER_SECRET=your-runner-secret
AUTOMN_RUNNER_PUBLIC_URL=http://your-runner-host:3030
AUTOMN_RUNNER_ENDPOINT_URL=http://your-runner-host:3030/api/run
AUTOMN_RUNNER_PORT=3030
# Uncomment to override default working directories
# AUTOMN_RUNNER_STATE_DIR=/opt/automn-runner/state
# AUTOMN_RUNNER_SCRIPTS_DIR=/opt/automn-runner/scripts
# AUTOMN_RUNNER_WORKDIR=/opt/automn-runner/script_workdir
ENVFILE

cat > "$STAGING_DIR/README.txt" <<'README'
Automn Runner deployment package
================================

Contents
- automn-runner: Standalone runner binary built with pkg (Node.js runtime included).
- automn-runner.service: systemd unit template for Ubuntu hosts.
- runner.env.example: Sample environment configuration file.
- data/, scripts/, script_workdir/, state/: Directories used by the runner for state and script storage.

How to deploy on Ubuntu
1) Transfer automn-runner-*.tar.gz to the target host and extract to /opt/automn-runner:
   sudo mkdir -p /opt/automn-runner
   sudo tar -xzf automn-runner-*.tar.gz -C /opt/automn-runner

2) Configure environment variables:
   sudo mkdir -p /etc/automn
   sudo cp /opt/automn-runner/runner.env.example /etc/automn/runner.env
   sudo chmod 640 /etc/automn/runner.env
   # Edit /etc/automn/runner.env with your host URL, runner ID, and secret.

3) Install the systemd unit:
   sudo cp /opt/automn-runner/automn-runner.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now automn-runner

4) Verify the service:
   systemctl status automn-runner
   curl http://localhost:3030/status

Variables
- Set PKG_TARGET to change the pkg target (default node20-linux-x64).
- Set PKG_VERSION to control the pkg version used when a local binary is not present.
- Set OUTPUT_DIR to change where the staging directory and final tarball are written.
README

tar -czf "$OUTPUT_DIR/$TARBALL_NAME" -C "$STAGING_DIR" .

echo "Runner package created at $OUTPUT_DIR/$TARBALL_NAME"
