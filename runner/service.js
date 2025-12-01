"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const {
  executeScript,
  LOG_MARKER,
  RETURN_MARKER,
  NOTIFY_MARKER,
  resolvePythonCommand,
  resolvePowerShellLauncher,
  resetPythonCommandCache,
  rehydratePackageCache,
  clearPackageCache,
  getPackageCacheSummary,
} = require("./core");
const { checkNodePackageStatus } = require("./package-manager");

const app = express();

const FAVICON_CANDIDATE_PATHS = [
  path.join(__dirname, "public", "automnR-logo-no-text.png"),
];

const DEFAULT_PORT = 3030;
const DEFAULT_HEARTBEAT_INTERVAL = 60_000;
const MIN_SECRET_LENGTH = 12;
const RUNNER_VERSION = "0.2.14";
const MINIMUM_HOST_VERSION = "0.2.0";

const runtimeExecutableEnv = {
  node: normalizeExecutableValue(process.env.AUTOMN_RUNNER_NODE_PATH || ""),
  python: normalizeExecutableValue(process.env.AUTOMN_RUNNER_PYTHON_PATH || ""),
  powershell: normalizeExecutableValue(
    process.env.AUTOMN_RUNNER_POWERSHELL_PATH ||
    process.env.AUTOMN_POWERSHELL_PATH ||
    ""
  ),
};

const runtimeVersionCache = {
  node: (process.version || "").replace(/^v/, "") || null,
  python: null,
  pwsh: null,
};

const RUNTIME_VERSION_PATTERN = /\b\d+(?:\.\d+){0,3}\b/;

const isPowerShellVersionOutput = (line) =>
  /\b(powershell|psversion)\b/i.test(line) || /^[0-9]+(?:\.[0-9]+){0,3}$/.test(line);

const EXECUTABLE_KEYS = ["node", "python", "powershell"];

function normalizeExecutableValue(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^"(.+)"$/, "$1");
}

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STRUCTURED_LOG_LEVELS = new Set(["info", "warn", "error"]);

function normalizeRunnerLogLevel(value, fallback = "info") {
  if (!value || typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (STRUCTURED_LOG_LEVELS.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function formatRunnerContext(context) {
  if (!context || typeof context !== "object") {
    return "";
  }
  let keys;
  try {
    keys = Object.keys(context);
  } catch (err) {
    return "";
  }
  if (!keys.length) {
    return "";
  }
  try {
    return JSON.stringify(context);
  } catch (err) {
    return String(context);
  }
}

function formatRunnerLogLine(line, stream = "stdout") {
  if (!line) {
    return null;
  }
  const normalized = typeof line === "string" ? line.replace(/\r$/, "") : "";
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith(LOG_MARKER)) {
    const payloadText = normalized.slice(LOG_MARKER.length);
    try {
      const payload = JSON.parse(payloadText);
      const level = normalizeRunnerLogLevel(payload?.level, "info");
      const message = typeof payload?.message === "string" ? payload.message : "";
      const contextText = formatRunnerContext(payload?.context);
      const combined = contextText ? `${message} ${contextText}`.trim() : message || contextText;
      return { level, message: combined || "" };
    } catch (err) {
      return { level: "info", message: normalized };
    }
  }

  if (normalized.startsWith(NOTIFY_MARKER)) {
    const payloadText = normalized.slice(NOTIFY_MARKER.length);
    try {
      const payload = JSON.parse(payloadText);
      const level = normalizeRunnerLogLevel(payload?.level, "info");
      const audience = typeof payload?.audience === "string" ? payload.audience.trim() : "";
      const message = typeof payload?.message === "string" ? payload.message : "";
      const prefix = audience ? `[notify:${audience}]` : "[notify]";
      return { level, message: `${prefix} ${message}`.trim() };
    } catch (err) {
      return { level: "info", message: normalized };
    }
  }

  if (normalized.startsWith(RETURN_MARKER)) {
    return null;
  }

  const level = stream === "stderr" ? "error" : "info";
  return { level, message: normalized };
}

function logPackageCacheLine(line, meta = {}) {
  if (!line) {
    return;
  }
  const rawText = typeof line === "string" ? line : String(line || "");
  const trimmed = rawText.trimEnd();
  if (!trimmed) {
    return;
  }
  if (meta.stream === "stderr") {
    console.error(trimmed);
  } else {
    console.log(trimmed);
  }
}

function normalizeVersionString(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/^v/i, "") : null;
}

function compareVersions(a, b) {
  const normalize = (input) =>
    String(input || "")
      .split(".")
      .map((segment) => {
        const parsed = Number.parseInt(segment, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });

  const left = normalize(a);
  const right = normalize(b);
  const maxLength = Math.max(left.length, right.length);

  for (let i = 0; i < maxLength; i += 1) {
    const leftValue = left[i] || 0;
    const rightValue = right[i] || 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function versionSatisfies(value, minimum) {
  if (!value || !minimum) return true;
  return compareVersions(normalizeVersionString(value), normalizeVersionString(minimum)) >= 0;
}

function updateRuntimeVersion(key, rawValue) {
  if (!key) return;
  const normalized = normalizeVersionString(rawValue);
  if (!normalized) return;
  runtimeVersionCache[key] = normalized;
}

function detectRuntimeVersion(command, args, key, options = {}) {
  if (!command || !key) {
    return;
  }
  try {
    const child = execFile(command, args, { timeout: 3000 }, (error, stdout, stderr) => {
      if (error) {
        return;
      }
      const output = stdout || stderr;
      if (!output) return;
      const line = output.toString().trim();
      if (!line) return;
      const { validateOutput, versionPattern } = options;
      if (typeof validateOutput === "function" && !validateOutput(line)) {
        return;
      }
      const pattern = versionPattern instanceof RegExp ? versionPattern : RUNTIME_VERSION_PATTERN;
      const match = pattern ? line.match(pattern) : null;
      const candidate = match ? match[1] || match[0] : null;
      if (!candidate) {
        return;
      }
      updateRuntimeVersion(key, candidate);
    });
    if (child && typeof child.once === "function") {
      child.once("error", () => { });
    }
  } catch (err) {
    // Silently ignore runtime detection failures; metadata is best-effort.
  }
}

function getRunnerMetadata() {
  const machineArch = typeof os.machine === "function" ? os.machine() : process.arch;
  const runtimes = Object.entries(runtimeVersionCache).reduce((acc, [key, value]) => {
    if (value) {
      const normalizedKey = key === "pwsh" ? "powershell" : key;
      acc[normalizedKey] = value;
    }
    return acc;
  }, {});
  return {
    version: RUNNER_VERSION,
    minimumHostVersion: MINIMUM_HOST_VERSION,
    os: os.platform(),
    platform: process.arch,
    arch: machineArch,
    uptime: Math.floor(os.uptime()),
    runtimes,
  };
}

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUrl(value) {
  if (Array.isArray(value)) {
    if (!value.length) return "";
    return normalizeUrl(value[0]);
  }
  if (!value || typeof value !== "string") return "";
  return value.trim();
}

function resolveEndpointUrl({ endpointUrl, publicUrl, endpointPath }) {
  const explicit = normalizeUrl(endpointUrl);
  const normalizedPath = endpointPath
    ? endpointPath.startsWith("/")
      ? endpointPath
      : `/${endpointPath}`
    : "";
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (normalizedPath && (!url.pathname || url.pathname === "/")) {
        url.pathname = normalizedPath;
      }
      return url.toString();
    } catch (err) {
      return explicit;
    }
  }

  const base = normalizeUrl(publicUrl);
  if (!base) return "";

  try {
    const url = new URL(base);
    if (normalizedPath) {
      url.pathname = normalizedPath;
    }
    return url.toString();
  } catch (err) {
    // Fallback: attempt to concatenate manually
    if (!normalizedPath) return base;
    const separator = base.endsWith("/") || normalizedPath.startsWith("/") ? "" : "/";
    return `${base}${separator}${normalizedPath}`;
  }
}

const defaultDataRoot =
  normalizeUrl(process.env.AUTOMN_RUNNER_DATA_DIR) ||
  path.join(__dirname, "data");
const defaultStateDir =
  normalizeUrl(process.env.AUTOMN_RUNNER_STATE_DIR) ||
  path.join(defaultDataRoot, "state");

const config = {
  port:
    parseInteger(process.env.AUTOMN_RUNNER_PORT) ||
    parseInteger(process.env.PORT) ||
    DEFAULT_PORT,
  hostUrl: normalizeUrl(process.env.AUTOMN_HOST_URL || process.env.AUTOMN_RUNNER_HOST_URL),
  runnerId: normalizeUrl(process.env.AUTOMN_RUNNER_ID),
  statusMessage: process.env.AUTOMN_RUNNER_STATUS_MESSAGE || "Runner heartbeat", // defaults to friendly message
  maxConcurrency: parseInteger(process.env.AUTOMN_RUNNER_MAX_CONCURRENCY),
  timeoutMs: parseInteger(process.env.AUTOMN_RUNNER_TIMEOUT_MS),
  heartbeatInterval:
    parseInteger(process.env.AUTOMN_RUNNER_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_INTERVAL,
  endpointUrl: resolveEndpointUrl({
    endpointUrl: process.env.AUTOMN_RUNNER_ENDPOINT_URL,
    publicUrl: process.env.AUTOMN_RUNNER_PUBLIC_URL,
    endpointPath: process.env.AUTOMN_RUNNER_ENDPOINT_PATH || "/api/run",
  }),
  stateFile:
    normalizeUrl(process.env.AUTOMN_RUNNER_STATE_FILE) ||
    path.join(defaultStateDir, "runner-state.json"),
  scriptsDir:
    normalizeUrl(process.env.AUTOMN_RUNNER_SCRIPTS_DIR) ||
    path.join(defaultDataRoot, "scripts"),
  workdirDir:
    normalizeUrl(process.env.AUTOMN_RUNNER_WORKDIR) ||
    path.join(defaultDataRoot, "script_workdir"),
  resetToken: normalizeUrl(process.env.AUTOMN_RUNNER_RESET_TOKEN),
  localMaxConcurrency: parseInteger(process.env.AUTOMN_RUNNER_LOCAL_MAX_CONCURRENCY),
  runtimeExecutables: {
    node: runtimeExecutableEnv.node,
    python: runtimeExecutableEnv.python,
    powershell: runtimeExecutableEnv.powershell,
  },
};

rehydratePackageCache({
  workdirRoot: config.workdirDir,
  onLog: logPackageCacheLine,
})
  .then((outcome) => {
    const restored = Array.isArray(outcome?.rehydrated)
      ? outcome.rehydrated.length
      : 0;
    if (restored > 0) {
      console.log(
        `[runner] Rehydrated npm package cache for ${restored} script${restored === 1 ? "" : "s"}.`
      );
    }
  })
  .catch((err) => {
    console.error("[runner] Failed to rehydrate npm package cache", err);
  });

const inMemoryState = {
  secretSource: process.env.AUTOMN_RUNNER_SECRET ? "env" : "state",
  secret: process.env.AUTOMN_RUNNER_SECRET || null,
  lockedAt: null,
  registeredAt: null,
  lastRegistrationError: null,
  lastRegistrationAttempt: null,
  lastRegistrationStatus: null,
  lastRegistrationResponse: null,
  hostUrl: config.hostUrl || null,
  runnerId: config.runnerId || null,
};

function readStateFromDisk(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function writeStateToDisk(file, payload) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("[runner] Failed to persist runner state", err);
  }
}

const persistedState = config.stateFile ? readStateFromDisk(config.stateFile) : {};
if (inMemoryState.secretSource === "state" && persistedState.secret) {
  inMemoryState.secret = persistedState.secret;
}
const persistedExecutables =
  persistedState.runtimeExecutables &&
    typeof persistedState.runtimeExecutables === "object" &&
    !Array.isArray(persistedState.runtimeExecutables)
    ? persistedState.runtimeExecutables
    : null;
if (persistedExecutables) {
  for (const key of EXECUTABLE_KEYS) {
    if (runtimeExecutableEnv[key]) {
      continue;
    }
    const persistedValue = normalizeExecutableValue(persistedExecutables[key]);
    config.runtimeExecutables[key] = persistedValue;
  }
}
if (!config.endpointUrl && persistedState.endpointUrl) {
  config.endpointUrl = persistedState.endpointUrl;
}
if (!config.hostUrl && persistedState.hostUrl) {
  config.hostUrl = persistedState.hostUrl;
}
if (!config.runnerId && persistedState.runnerId) {
  config.runnerId = persistedState.runnerId;
}
if (!inMemoryState.lockedAt && persistedState.lockedAt) {
  inMemoryState.lockedAt = persistedState.lockedAt;
}
if (!inMemoryState.registeredAt && persistedState.registeredAt) {
  inMemoryState.registeredAt = persistedState.registeredAt;
}
if (!inMemoryState.hostUrl && persistedState.hostUrl) {
  inMemoryState.hostUrl = persistedState.hostUrl;
}
if (!inMemoryState.runnerId && persistedState.runnerId) {
  inMemoryState.runnerId = persistedState.runnerId;
}
if (!inMemoryState.lastRegistrationStatus && persistedState.lastRegistrationStatus) {
  inMemoryState.lastRegistrationStatus = persistedState.lastRegistrationStatus;
}
if (!inMemoryState.lastRegistrationResponse && persistedState.lastRegistrationResponse) {
  inMemoryState.lastRegistrationResponse = persistedState.lastRegistrationResponse;
}
if (!inMemoryState.lastRegistrationError && persistedState.lastRegistrationError) {
  inMemoryState.lastRegistrationError = persistedState.lastRegistrationError;
}
if (!inMemoryState.lastRegistrationAttempt && persistedState.lastRegistrationAttempt) {
  inMemoryState.lastRegistrationAttempt = persistedState.lastRegistrationAttempt;
}

refreshRuntimeDetections();

function persistState() {
  if (inMemoryState.secretSource === "env") {
    const payload = {
      lockedAt: inMemoryState.lockedAt,
      registeredAt: inMemoryState.registeredAt,
      hostUrl: inMemoryState.hostUrl,
      runnerId: inMemoryState.runnerId,
      lastRegistrationStatus: inMemoryState.lastRegistrationStatus,
      lastRegistrationResponse: inMemoryState.lastRegistrationResponse,
      lastRegistrationAttempt: inMemoryState.lastRegistrationAttempt,
      lastRegistrationError: inMemoryState.lastRegistrationError,
      endpointUrl: config.endpointUrl || null,
      runtimeExecutables: EXECUTABLE_KEYS.reduce((acc, key) => {
        acc[key] = config.runtimeExecutables[key] || null;
        return acc;
      }, {}),
    };
    writeStateToDisk(config.stateFile, payload);
    return;
  }

  const payload = {
    secret: inMemoryState.secret || null,
    lockedAt: inMemoryState.lockedAt || null,
    registeredAt: inMemoryState.registeredAt || null,
    hostUrl: inMemoryState.hostUrl || null,
    runnerId: inMemoryState.runnerId || null,
    lastRegistrationStatus: inMemoryState.lastRegistrationStatus || null,
    lastRegistrationResponse: inMemoryState.lastRegistrationResponse || null,
    lastRegistrationAttempt: inMemoryState.lastRegistrationAttempt || null,
    lastRegistrationError: inMemoryState.lastRegistrationError || null,
    endpointUrl: config.endpointUrl || null,
    runtimeExecutables: EXECUTABLE_KEYS.reduce((acc, key) => {
      if (runtimeExecutableEnv[key]) {
        return acc;
      }
      acc[key] = config.runtimeExecutables[key] || null;
      return acc;
    }, {}),
  };
  writeStateToDisk(config.stateFile, payload);
}

function getSecret() {
  return inMemoryState.secret || null;
}

function isLocked() {
  return Boolean(inMemoryState.lockedAt);
}

function secretIsConfigurable() {
  return inMemoryState.secretSource !== "env";
}

function executableIsEnvManaged(key) {
  return Boolean(runtimeExecutableEnv[key]);
}

function getRuntimeExecutables() {
  return EXECUTABLE_KEYS.reduce((acc, key) => {
    acc[key] = config.runtimeExecutables[key] || null;
    return acc;
  }, {});
}

function runtimeExecutablesConfigurable() {
  return EXECUTABLE_KEYS.some((key) => !executableIsEnvManaged(key));
}

function setRuntimeExecutables(updates = {}) {
  if (!updates || typeof updates !== "object") {
    return getRuntimeExecutables();
  }

  let changed = false;
  for (const key of EXECUTABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      continue;
    }
    if (executableIsEnvManaged(key)) {
      const attempted = normalizeExecutableValue(updates[key]);
      if (attempted) {
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        throw new Error(`${label} executable is managed via environment variables`);
      }
      continue;
    }
    const normalized = normalizeExecutableValue(updates[key]);
    const current = config.runtimeExecutables[key] || null;
    if (normalized !== current) {
      config.runtimeExecutables[key] = normalized;
      changed = true;
    }
  }

  if (changed) {
    refreshRuntimeDetections();
  }
  persistState();
  return getRuntimeExecutables();
}

function refreshRuntimeDetections() {
  runtimeVersionCache.python = null;
  runtimeVersionCache.pwsh = null;

  resetPythonCommandCache();
  const executables = getRuntimeExecutables();

  const pythonCommand = resolvePythonCommand(executables.python);
  if (pythonCommand) {
    detectRuntimeVersion(pythonCommand, ["--version"], "python", {
      validateOutput: (line) => /\bpython\b/i.test(line),
    });
  }

  const seenPwshCommands = new Set();
  try {
    const launcher = resolvePowerShellLauncher(executables.powershell);
    if (launcher && launcher.command) {
      seenPwshCommands.add(launcher.command);
      const args = Array.isArray(launcher.args) ? [...launcher.args] : [];
      const filteredArgs = args.filter(
        (arg) => !(typeof arg === "string" && arg.toLowerCase() === "-file"),
      );
      filteredArgs.push("-Command", "$PSVersionTable.PSVersion.ToString()");
      detectRuntimeVersion(launcher.command, filteredArgs, "pwsh", {
        validateOutput: isPowerShellVersionOutput,
      });
    }
  } catch (err) {
    // Ignore launcher resolution failures; runtime metadata is best-effort.
  }

  const fallbackPwshCandidates = ["pwsh", "powershell"];
  for (const candidate of fallbackPwshCandidates) {
    if (seenPwshCommands.has(candidate)) {
      continue;
    }
    detectRuntimeVersion(candidate, ["--version"], "pwsh", {
      validateOutput: isPowerShellVersionOutput,
    });
  }
}

async function ensureDirectories() {
  const targetDirs = [config.scriptsDir, config.workdirDir, path.dirname(config.stateFile || "")];
  await Promise.all(
    targetDirs
      .filter((dir) => dir && typeof dir === "string")
      .map(async (dir) => {
        try {
          await fs.promises.mkdir(dir, { recursive: true });
        } catch (err) {
          if (err && err.code !== "EEXIST") {
            console.error(`[runner] Failed to create directory '${dir}'`, err);
          }
        }
      }),
  );
}

function summarizeRegistrationState() {
  return {
    runnerId: inMemoryState.runnerId || null,
    hostUrl: inMemoryState.hostUrl || null,
    endpointUrl: config.endpointUrl || null,
    secretConfigured: Boolean(getSecret()),
    secretSource: inMemoryState.secretSource,
    locked: isLocked(),
    registeredAt: inMemoryState.registeredAt,
    lastRegistrationAttempt: inMemoryState.lastRegistrationAttempt,
    lastRegistrationError: inMemoryState.lastRegistrationError,
    lastRegistrationStatus: inMemoryState.lastRegistrationStatus,
    lastRegistrationResponse: inMemoryState.lastRegistrationResponse,
  };
}

function validateSecret(secret) {
  const normalized = typeof secret === "string" ? secret.trim() : "";
  if (!normalized) {
    return { ok: false, error: "Secret is required" };
  }
  if (normalized.length < MIN_SECRET_LENGTH) {
    return { ok: false, error: `Secret must be at least ${MIN_SECRET_LENGTH} characters` };
  }
  return { ok: true, value: normalized };
}

async function setSecret(secret) {
  if (!secretIsConfigurable()) {
    throw new Error("Runner secret is managed via environment variables and cannot be changed");
  }
  const validation = validateSecret(secret);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  inMemoryState.secret = validation.value;
  inMemoryState.lockedAt = null;
  inMemoryState.registeredAt = null;
  inMemoryState.lastRegistrationError = null;
  inMemoryState.lastRegistrationStatus = null;
  inMemoryState.lastRegistrationResponse = null;
  persistState();
}

async function clearSecret() {
  if (!secretIsConfigurable()) {
    throw new Error("Runner secret is managed via environment variables and cannot be cleared");
  }
  inMemoryState.secret = null;
  inMemoryState.lockedAt = null;
  inMemoryState.registeredAt = null;
  inMemoryState.lastRegistrationError = null;
  inMemoryState.lastRegistrationStatus = null;
  inMemoryState.lastRegistrationResponse = null;
  persistState();
}

function buildRegistrationPayload() {
  const secret = getSecret();
  if (!secret) return null;
  const runnerId = inMemoryState.runnerId || config.runnerId;
  const hostUrl = inMemoryState.hostUrl || config.hostUrl;
  if (!runnerId || !hostUrl) return null;
  const endpointUrl = config.endpointUrl;
  if (!endpointUrl) return null;
  const payload = {
    url: `${hostUrl.replace(/\/$/, "")}/api/settings/runner-hosts/${encodeURIComponent(runnerId)}/register`,
    body: {
      secret,
      endpoint: endpointUrl,
      statusMessage: config.statusMessage,
    },
    runnerId,
    hostUrl,
  };
  if (config.maxConcurrency !== null) {
    payload.body.maxConcurrency = config.maxConcurrency;
  }
  if (config.timeoutMs !== null) {
    payload.body.timeoutMs = config.timeoutMs;
  }
  return payload;
}

async function performRegistration(reason = "scheduled") {
  const payload = buildRegistrationPayload();
  if (!payload) {
    return {
      ok: false,
      error:
        "Runner is missing configuration. Ensure host URL, runner id, endpoint URL, and secret are provided.",
    };
  }

  if (typeof fetch !== "function") {
    return { ok: false, error: "Global fetch API is unavailable in this runtime" };
  }

  const requestBody = { ...payload.body };
  if (reason && typeof reason === "string" && reason.trim()) {
    requestBody.statusMessage = `${config.statusMessage} (${reason})`;
  }
  Object.assign(requestBody, getRunnerMetadata());

  inMemoryState.lastRegistrationAttempt = new Date().toISOString();
  persistState();

  try {
    const response = await fetch(payload.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(requestBody),
    });

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (err) {
      parsed = { raw: text };
    }

    if (!response.ok) {
      const baseMessage = parsed?.error || `${response.status} ${response.statusText}`;
      let message = baseMessage;
      if (response.status === 404) {
        const runnerHint = payload.runnerId ? ` with id "${payload.runnerId}"` : "";
        const hostHint = payload.hostUrl ? ` on ${payload.hostUrl}` : "";
        message =
          `${baseMessage}. Ensure a runner${runnerHint} exists${hostHint} (Settings → Runners) ` +
          "and that the configured secret matches.";
      }
      inMemoryState.lastRegistrationError = message;
      inMemoryState.lastRegistrationStatus = "error";
      inMemoryState.lastRegistrationResponse = parsed || { error: message };
      persistState();
      console.error("[runner] Registration failed:", message);
      return { ok: false, error: message, response: parsed };
    }

    inMemoryState.lastRegistrationError = null;
    inMemoryState.lastRegistrationStatus = "ok";
    inMemoryState.lastRegistrationResponse = parsed;
    inMemoryState.registeredAt = new Date().toISOString();
    if (!inMemoryState.lockedAt) {
      inMemoryState.lockedAt = inMemoryState.registeredAt;
    }
    inMemoryState.secret = getSecret();
    inMemoryState.runnerId = inMemoryState.runnerId || config.runnerId;
    inMemoryState.hostUrl = inMemoryState.hostUrl || config.hostUrl;
    persistState();
    const hostVersion = typeof parsed?.hostVersion === "string" ? parsed.hostVersion : null;
    const hostMinimumRunnerVersion =
      typeof parsed?.minimumRunnerVersion === "string" ? parsed.minimumRunnerVersion : null;
    if (hostVersion && !versionSatisfies(hostVersion, MINIMUM_HOST_VERSION)) {
      console.warn(
        `[runner] Host version ${hostVersion} is below required minimum ${MINIMUM_HOST_VERSION}`,
      );
    }
    if (hostMinimumRunnerVersion && !versionSatisfies(RUNNER_VERSION, hostMinimumRunnerVersion)) {
      console.warn(
        `[runner] Runner version ${RUNNER_VERSION} is below host minimum ${hostMinimumRunnerVersion}`,
      );
    }
    console.log("[runner] Registration successful");
    return { ok: true, response: parsed };
  } catch (err) {
    const message = err?.message || "Registration request failed";
    inMemoryState.lastRegistrationError = message;
    inMemoryState.lastRegistrationStatus = "network-error";
    persistState();
    console.error("[runner] Registration error:", err);
    return { ok: false, error: message };
  }
}

let heartbeatTimer = null;

function scheduleHeartbeat() {
  if (!config.heartbeatInterval || config.heartbeatInterval <= 0) {
    return;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = setInterval(() => {
    performRegistration("heartbeat").catch((err) => {
      console.error("[runner] Scheduled heartbeat failed", err);
    });
  }, config.heartbeatInterval);
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/favicon.ico", (req, res) => {
  const existingPath = FAVICON_CANDIDATE_PATHS.find((assetPath) =>
    fs.existsSync(assetPath)
  );

  if (existingPath) {
    res.sendFile(existingPath);
    return;
  }

  res.status(404).end();
});

app.get("/status", (req, res) => {
  res.json({
    runner: summarizeRegistrationState(),
    config: {
      endpointUrl: config.endpointUrl,
      hostUrl: inMemoryState.hostUrl || config.hostUrl || null,
      runnerId: inMemoryState.runnerId || config.runnerId || null,
      heartbeatInterval: config.heartbeatInterval,
      scriptsDir: config.scriptsDir,
      workdirDir: config.workdirDir,
      secretManagedByEnv: !secretIsConfigurable(),
    },
  });
});

function renderPage({ title, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/png" href="/favicon.ico" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --runner-bg: #0f172a;
        --runner-text: #e2e8f0;
        --runner-muted: rgba(203, 213, 225, 0.7);
        --runner-header-bg: #1e293b;
        --runner-header-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        --runner-section-bg: rgba(15, 23, 42, 0.75);
        --runner-section-border: rgba(148, 163, 184, 0.25);
        --runner-input-bg: rgba(15, 23, 42, 0.8);
        --runner-input-border: rgba(148, 163, 184, 0.3);
        --runner-input-text: #f8fafc;
        --runner-input-focus: #38bdf8;
        --runner-button-bg: linear-gradient(135deg, #38bdf8, #0ea5e9);
        --runner-button-text: #f8fafc;
        --runner-button-shadow: 0 10px 25px rgba(14, 165, 233, 0.35);
        --runner-button-hover-shadow: 0 16px 32px rgba(14, 165, 233, 0.45);
        --runner-status-card-bg: rgba(30, 41, 59, 0.8);
        --runner-status-card-border: rgba(148, 163, 184, 0.15);
        --runner-status-card-accent: #38bdf8;
        --runner-status-card-text: #cbd5f5;
        --runner-alert-error-bg: rgba(239, 68, 68, 0.16);
        --runner-alert-error-border: rgba(239, 68, 68, 0.35);
        --runner-alert-error-text: #fecaca;
        --runner-alert-success-bg: rgba(34, 197, 94, 0.16);
        --runner-alert-success-border: rgba(34, 197, 94, 0.35);
        --runner-alert-success-text: #bbf7d0;
        --runner-link: #38bdf8;
        --runner-locked: #34d399;
      }

      @media (prefers-color-scheme: light) {
        :root {
          color-scheme: light;
          --runner-bg: #f8fafc;
          --runner-text: #0f172a;
          --runner-muted: #475569;
          --runner-header-bg: #e2e8f0;
          --runner-header-shadow: 0 1px 6px rgba(148, 163, 184, 0.3);
          --runner-section-bg: rgba(255, 255, 255, 0.92);
          --runner-section-border: rgba(148, 163, 184, 0.35);
          --runner-input-bg: rgba(255, 255, 255, 0.95);
          --runner-input-border: rgba(148, 163, 184, 0.45);
          --runner-input-text: #0f172a;
          --runner-input-focus: #0ea5e9;
          --runner-button-bg: linear-gradient(135deg, #0284c7, #0ea5e9);
          --runner-button-text: #ffffff;
          --runner-button-shadow: 0 10px 20px rgba(14, 116, 144, 0.25);
          --runner-button-hover-shadow: 0 18px 30px rgba(14, 116, 144, 0.28);
          --runner-status-card-bg: rgba(248, 250, 252, 0.95);
          --runner-status-card-border: rgba(148, 163, 184, 0.35);
          --runner-status-card-accent: #0369a1;
          --runner-status-card-text: #1f2937;
          --runner-alert-error-bg: rgba(239, 68, 68, 0.12);
          --runner-alert-error-border: rgba(239, 68, 68, 0.35);
          --runner-alert-error-text: #991b1b;
          --runner-alert-success-bg: rgba(34, 197, 94, 0.12);
          --runner-alert-success-border: rgba(34, 197, 94, 0.35);
          --runner-alert-success-text: #166534;
          --runner-link: #0ea5e9;
          --runner-locked: #047857;
        }
      }

      body {
        font-family: system-ui, sans-serif;
        margin: 0;
        padding: 0;
        background: var(--runner-bg);
        color: var(--runner-text);
      }

      header {
        padding: 1.5rem 2rem;
        background: var(--runner-header-bg);
        box-shadow: var(--runner-header-shadow);
      }

      main { padding: 2rem; max-width: 720px; margin: 0 auto; }
      h1 { margin: 0; font-size: 1.75rem; }

      section {
        background: var(--runner-section-bg);
        border: 1px solid var(--runner-section-border);
        border-radius: 12px;
        padding: 1.5rem;
        margin-bottom: 1.5rem;
      }

      label { display: block; margin-bottom: 0.5rem; font-weight: 600; }

      input[type="password"],
      input[type="text"] {
        width: 100%;
        padding: 0.75rem 1rem;
        border-radius: 8px;
        border: 1px solid var(--runner-input-border);
        background: var(--runner-input-bg);
        color: var(--runner-input-text);
      }

      input[type="password"]:focus,
      input[type="text"]:focus {
        outline: 2px solid var(--runner-input-focus);
        outline-offset: 2px;
      }

      button {
        background: var(--runner-button-bg);
        color: var(--runner-button-text);
        border: none;
        padding: 0.75rem 1.5rem;
        font-weight: 600;
        border-radius: 999px;
        cursor: pointer;
        box-shadow: var(--runner-button-shadow);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      button:hover {
        transform: translateY(-1px);
        box-shadow: var(--runner-button-hover-shadow);
      }

      .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }

      .status-card {
        background: var(--runner-status-card-bg);
        border-radius: 10px;
        padding: 1rem;
        border: 1px solid var(--runner-status-card-border);
      }

      .status-card h3 { margin: 0 0 0.5rem; font-size: 1rem; color: var(--runner-status-card-accent); }
      .status-card p { margin: 0; font-size: 0.9rem; color: var(--runner-status-card-text); word-break: break-word; }

      .alert { border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
      .alert-error { background: var(--runner-alert-error-bg); border: 1px solid var(--runner-alert-error-border); color: var(--runner-alert-error-text); }
      .alert-success { background: var(--runner-alert-success-bg); border: 1px solid var(--runner-alert-success-border); color: var(--runner-alert-success-text); }
      .muted { color: var(--runner-muted); font-size: 0.9rem; }
      .locked { color: var(--runner-locked); font-weight: 600; }
      a { color: var(--runner-link); }
    </style>
  </head>
  <body>
    <header>
      <h1>${title}</h1>
    </header>
    <main>
      ${body}
    </main>
  </body>
</html>`;
}

function formatTimestamp(ts) {
  if (!ts) return "–";
  try {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return ts;
    return date.toISOString();
  } catch (err) {
    return ts;
  }
}

function renderStatusCards() {
  const summary = summarizeRegistrationState();
  const cards = [
    { label: "Runner ID", value: summary.runnerId || "Not configured" },
    { label: "Host URL", value: summary.hostUrl || "Not configured" },
    { label: "Endpoint", value: summary.endpointUrl || "Not configured" },
    { label: "Secret source", value: summary.secretSource === "env" ? "Environment" : summary.secretConfigured ? "Stored securely" : "Not set" },
    { label: "Locked since", value: formatTimestamp(inMemoryState.lockedAt) },
    { label: "Last registration", value: formatTimestamp(summary.lastRegistrationAttempt) },
  ];

  return `<div class="status-grid">${cards
    .map(
      (card) => `<div class="status-card"><h3>${card.label}</h3><p>${card.value || "–"}</p></div>`,
    )
    .join("")}</div>`;
}

function renderHomePage({ error = null, success = null } = {}) {
  const secret = getSecret();
  const summary = summarizeRegistrationState();
  const locked = summary.locked;
  const executables = getRuntimeExecutables();
  const packageCache = getPackageCacheSummary(config.workdirDir);
  let body = "";

  if (error) {
    body += `<div class="alert alert-error">${error}</div>`;
  } else if (success) {
    body += `<div class="alert alert-success">${success}</div>`;
  }

  body += renderStatusCards();

  if (!secret && secretIsConfigurable()) {
    body += `
      <section>
        <h2>Register with Automn</h2>
        <p class="muted">Enter the runner secret provided by your Automn host to register this runner.</p>
        <form method="post" action="/ui/register">
          <label for="secret">Runner secret</label>
          <input type="password" id="secret" name="secret" required minlength="${MIN_SECRET_LENGTH}" autocomplete="off" />
          <div style="margin-top: 1.25rem;"><button type="submit">Register runner</button></div>
        </form>
      </section>
    `;
  } else if (!secret) {
    body += `
      <section>
        <h2>Secret managed externally</h2>
        <p class="muted">The runner secret is provided via environment variables. No changes can be made from this interface.</p>
      </section>
    `;
  } else if (!locked) {
    const lastError = summary.lastRegistrationError
      ? `<div class="alert alert-error">${summary.lastRegistrationError}</div>`
      : "";
    body += `
      <section>
        <h2>Registration pending</h2>
        ${lastError}
        <p class="muted">The runner secret has been stored. Registration will complete when the host acknowledges this runner. The runner retries automatically; you can also <a href="/ui/reregister">trigger a retry now</a>.</p>
      </section>
    `;
  } else {
    body += `
      <section>
        <h2 class="locked">Runner locked</h2>
        <p class="muted">This runner successfully registered with the host and is now locked. To rotate secrets, use the documented reset procedure.</p>
        <p class="muted">Last host response: ${summary.lastRegistrationStatus || "unknown"}${summary.lastRegistrationError ? ` (error: ${summary.lastRegistrationError})` : ""
      }</p>
      </section>
    `;
  }

  if (!locked) {
    if (runtimeExecutablesConfigurable()) {
      const fieldMeta = [
        {
          key: "node",
          label: "Node executable",
          placeholder: "node",
        },
        {
          key: "python",
          label: "Python executable",
          placeholder: "python3",
        },
        {
          key: "powershell",
          label: "PowerShell executable",
          placeholder: "powershell.exe",
        },
      ];
      const fieldsHtml = fieldMeta
        .map((field) => {
          const managed = executableIsEnvManaged(field.key);
          const value = executables[field.key] || "";
          const disabledAttr = managed ? " disabled" : "";
          const helperText = managed
            ? "Managed via environment variables."
            : "Leave blank to use the default command from PATH.";
          const managedSuffix = managed ? " <span class=\"muted\">(managed via environment)</span>" : "";
          return `
            <label for="runtime-${field.key}">${field.label}${managedSuffix}</label>
            <input type="text" id="runtime-${field.key}" name="${field.key}" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder)}" autocomplete="off"${disabledAttr} />
            <p class="muted">${helperText}</p>
          `;
        })
        .join("");

      body += `
        <section>
          <h2>Runtime executables</h2>
          <p class="muted">Set explicit executables for Node.js, Python, or PowerShell. Leave fields blank to rely on the system PATH.</p>
          <form method="post" action="/ui/runtime-executables">
            ${fieldsHtml}
            <div style="margin-top: 1.25rem;"><button type="submit">Save executables</button></div>
          </form>
        </section>
      `;
    } else {
      body += `
        <section>
          <h2>Runtime executables</h2>
          <p class="muted">Executable paths are managed via environment variables.</p>
          <ul class="muted">
            <li>Node: ${escapeHtml(executables.node || "Managed externally")}</li>
            <li>Python: ${escapeHtml(executables.python || "Managed externally")}</li>
            <li>PowerShell: ${escapeHtml(executables.powershell || "Managed externally")}</li>
          </ul>
        </section>
      `;
    }
  }

  const cachedScripts = Number(packageCache?.scriptCount) || 0;
  const cachedPackages = Number(packageCache?.packageCount) || 0;
  const cacheSummaryText =
    cachedPackages > 0
      ? `${cachedPackages} package${cachedPackages === 1 ? "" : "s"} across ${cachedScripts} script${cachedScripts === 1 ? "" : "s"}`
      : "No cached packages";

  body += `
    <section>
      <h2>Package cache</h2>
      <p class="muted">${cacheSummaryText}. Cached dependencies are restored automatically when the runner starts.</p>
      <form method="post" action="/ui/package-cache/clear">
        <button type="submit">Clear package cache</button>
      </form>
    </section>
  `;

  body += `
    <section>
      <h2>Diagnostics</h2>
      <ul class="muted">
        <li>Version: ${process.env.AUTOMN_RUNNER_VERSION || "unknown"}</li>
        <li>Host URL: ${summary.hostUrl || config.hostUrl || "not configured"}</li>
        <li>Endpoint URL: ${summary.endpointUrl || "not configured"}</li>
        <li>Heartbeat interval: ${config.heartbeatInterval || "disabled"} ms</li>
        <li>Scripts directory: ${config.scriptsDir}</li>
        <li>Work directory: ${config.workdirDir}</li>
      </ul>
    </section>
  `;

  return renderPage({ title: "Automn Runner", body });
}

app.get("/", (req, res) => {
  res.set("content-type", "text/html; charset=utf-8");
  res.send(renderHomePage());
});

app.get("/ui/reregister", async (req, res) => {
  const outcome = await performRegistration("manual");
  const message = outcome.ok
    ? { success: "Registration attempt sent to host." }
    : { error: outcome.error || "Registration failed" };
  res.set("content-type", "text/html; charset=utf-8");
  res.send(renderHomePage(message));
});

app.post("/ui/register", async (req, res) => {
  if (!secretIsConfigurable()) {
    res.status(403).set("content-type", "text/html; charset=utf-8").send(
      renderHomePage({ error: "Runner secret is managed via environment variables." }),
    );
    return;
  }

  try {
    await setSecret(req.body?.secret);
  } catch (err) {
    res.status(400).set("content-type", "text/html; charset=utf-8").send(
      renderHomePage({ error: err?.message || "Failed to store secret" }),
    );
    return;
  }

  const outcome = await performRegistration("initial");
  const payload = outcome.ok
    ? { success: "Registration request sent. Awaiting confirmation from host." }
    : { error: outcome.error || "Registration failed" };
  res.set("content-type", "text/html; charset=utf-8");
  res.send(renderHomePage(payload));
});

app.post("/ui/runtime-executables", (req, res) => {
  if (isLocked()) {
    res
      .status(403)
      .set("content-type", "text/html; charset=utf-8")
      .send(renderHomePage({ error: "Runner is locked. Executable paths cannot be changed." }));
    return;
  }

  if (!runtimeExecutablesConfigurable()) {
    res
      .status(403)
      .set("content-type", "text/html; charset=utf-8")
      .send(renderHomePage({ error: "Executable paths are managed via environment variables." }));
    return;
  }

  try {
    setRuntimeExecutables({
      node: req.body?.node,
      python: req.body?.python,
      powershell: req.body?.powershell,
    });
  } catch (err) {
    res
      .status(400)
      .set("content-type", "text/html; charset=utf-8")
      .send(
        renderHomePage({
          error: err?.message || "Failed to update runtime executables",
        }),
      );
    return;
  }

  res
    .set("content-type", "text/html; charset=utf-8")
    .send(renderHomePage({ success: "Runtime executables updated." }));
});

app.post("/ui/package-cache/clear", async (req, res) => {
  try {
    await clearPackageCache({
      workdirRoot: config.workdirDir,
      onLog: logPackageCacheLine,
    });
    res
      .set("content-type", "text/html; charset=utf-8")
      .send(
        renderHomePage({
          success: "Package cache cleared. Dependencies will reinstall as needed.",
        })
      );
  } catch (err) {
    res
      .status(500)
      .set("content-type", "text/html; charset=utf-8")
      .send(
        renderHomePage({
          error: err?.message || "Failed to clear package cache",
        })
      );
  }
});

app.post("/internal/reset", async (req, res) => {
  if (!config.resetToken) {
    res.status(404).json({ error: "Reset endpoint disabled" });
    return;
  }

  const provided = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!provided || provided !== config.resetToken) {
    res.status(403).json({ error: "Invalid reset token" });
    return;
  }

  const newSecret = typeof req.body?.secret === "string" ? req.body.secret.trim() : "";

  try {
    if (newSecret) {
      await setSecret(newSecret);
      const outcome = await performRegistration("secret-rotation");
      res.json({
        reset: true,
        secretUpdated: true,
        registration: summarizeRegistrationState(),
        registrationResult: outcome,
      });
    } else {
      await clearSecret();
      res.json({ reset: true, secretCleared: true, runner: summarizeRegistrationState() });
    }
  } catch (err) {
    res.status(400).json({ error: err?.message || "Failed to reset secret" });
  }
});

let activeRuns = 0;

app.post("/api/packages/status", async (req, res) => {
  const requestSecret = normalizeUrl(req.headers["x-automn-runner-secret"]);
  const configuredSecret = getSecret();

  if (!configuredSecret) {
    res.status(503).json({ error: "Runner secret not configured" });
    return;
  }

  if (!requestSecret || requestSecret !== configuredSecret) {
    res.status(401).json({ error: "Invalid runner secret" });
    return;
  }

  const rawPackages = Array.isArray(req.body?.packages) ? req.body.packages : [];
  const packages = rawPackages
    .map((pkg) => (typeof pkg === "string" ? pkg.trim() : ""))
    .filter((pkg) => Boolean(pkg));

  const scriptId =
    typeof req.body?.scriptId === "string" ? req.body.scriptId.trim() : "";
  const directoryKey =
    typeof req.body?.directoryKey === "string"
      ? req.body.directoryKey.trim()
      : "";
  const installMissing = req.body?.installMissing !== false;

  if (!packages.length) {
    res.json({
      scriptId: scriptId || null,
      packages: [],
      installMissing,
      error: null,
    });
    return;
  }

  try {
    const result = await checkNodePackageStatus({
      scriptIdentifier: scriptId || null,
      packages,
      workdirRoot: config.workdirDir,
      directoryKey: directoryKey || null,
      installMissing,
      onLog: logPackageCacheLine,
    });

    res.json({
      scriptId: scriptId || null,
      packages: Array.isArray(result?.packages) ? result.packages : [],
      installMissing,
      error: result?.error || null,
    });
  } catch (err) {
    console.error("[runner] Failed to report package status", err);
    res
      .status(500)
      .json({ error: err?.message || "Failed to check package status" });
  }
});

function checkLocalConcurrency() {
  if (!config.localMaxConcurrency || config.localMaxConcurrency <= 0) {
    return true;
  }
  return activeRuns < config.localMaxConcurrency;
}

function streamMessage(res, payload) {
  try {
    res.write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    console.error("[runner] Failed to stream payload", err);
  }
}

app.post("/api/run", async (req, res) => {
  const requestSecret = normalizeUrl(req.headers["x-automn-runner-secret"]);
  const configuredSecret = getSecret();

  if (!configuredSecret) {
    res.status(503).json({ error: "Runner secret not configured" });
    return;
  }

  if (!requestSecret || requestSecret !== configuredSecret) {
    res.status(401).json({ error: "Invalid runner secret" });
    return;
  }

  if (!checkLocalConcurrency()) {
    res.status(429).json({ error: "Runner is at capacity" });
    return;
  }

  const runId = normalizeUrl(req.body?.runId) || crypto.randomUUID();
  const script = req.body?.script;
  const reqBody = req.body?.reqBody || {};

  const scriptDescriptor =
    script?.name ||
    script?.slug ||
    script?.id ||
    script?.versionId ||
    script?.preassignedRunId ||
    "unknown-script";

  if (!script || typeof script !== "object") {
    res.status(400).json({ error: "Script payload is required" });
    return;
  }

  res.setHeader("Content-Type", "application/jsonl; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let clientAborted = false;
  const markAborted = () => {
    clientAborted = true;
  };

  req.on("aborted", markAborted);
  res.on("close", () => {
    if (!res.writableEnded) {
      markAborted();
    }
  });

  activeRuns += 1;
  console.log(
    `[runner] Starting run ${runId} for ${scriptDescriptor} (active: ${activeRuns})`
  );

  const logBuffers = { stdout: "", stderr: "" };

  const emitLineToConsole = (line, stream) => {
    const formatted = formatRunnerLogLine(line, stream);
    if (!formatted || formatted.message === undefined || formatted.message === null) {
      return;
    }
    const prefix = `[runner][${runId}][${scriptDescriptor}]`;
    const target =
      formatted.level === "error"
        ? console.error
        : formatted.level === "warn"
          ? console.warn
          : console.log;
    const message = String(formatted.message);
    const output = message ? `${prefix} ${message}` : prefix;
    target(output);
  };

  const flushLogBuffer = (stream, { includeRemainder = false } = {}) => {
    const buffer = logBuffers[stream];
    if (typeof buffer !== "string" || buffer.length === 0) {
      if (includeRemainder) {
        logBuffers[stream] = "";
      }
      return;
    }
    const parts = buffer.split("\n");
    const remainder = parts.pop();
    for (const part of parts) {
      emitLineToConsole(part, stream);
    }
    if (includeRemainder && remainder) {
      emitLineToConsole(remainder, stream);
      logBuffers[stream] = "";
    } else {
      logBuffers[stream] = remainder || "";
    }
  };

  const flushAllLogBuffers = (includeRemainder = false) => {
    flushLogBuffer("stdout", { includeRemainder });
    flushLogBuffer("stderr", { includeRemainder });
  };

  const onLog = (chunk, meta = {}) => {
    if (!chunk) {
      return;
    }
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    if (!clientAborted) {
      streamMessage(res, { type: "log", line: text });
    }
    const stream = meta.stream === "stderr" ? "stderr" : "stdout";
    logBuffers[stream] += text;
    flushLogBuffer(stream);
  };

  try {
    const result = await executeScript({
      script,
      reqBody,
      onLog,
      runId,
      scriptsRoot: config.scriptsDir,
      workdirRoot: config.workdirDir,
      executables: getRuntimeExecutables(),
    });
    flushAllLogBuffers(true);
    const exitCode = Number.isFinite(result?.code) ? result.code : "unknown";
    console.log(
      `[runner] Completed run ${runId} for ${scriptDescriptor} with code ${exitCode}`
    );
    if (!clientAborted) {
      streamMessage(res, { type: "result", data: result });
    }
  } catch (err) {
    flushAllLogBuffers(true);
    console.error(`[runner] Execution failed for run ${runId}`, err);
    if (!clientAborted) {
      const message = err?.message || "Runner execution failed";
      streamMessage(res, {
        type: "result",
        data: {
          runId,
          stdout: "",
          stderr: message,
          code: 1,
          duration: 0,
          returnData: null,
          automnLogs: [],
          automnNotifications: [],
          input: reqBody ?? null,
        },
      });
    }
  } finally {
    flushAllLogBuffers(true);
    if (!clientAborted && !res.writableEnded) {
      res.end();
    }
    activeRuns = Math.max(0, activeRuns - 1);
    console.log(
      `[runner] Finished run ${runId} for ${scriptDescriptor} (active: ${activeRuns})`
    );
  }
});

app.use((err, req, res, next) => {
  console.error("[runner] Unhandled error", err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: "Runner internal error" });
});

async function bootstrap() {
  await ensureDirectories();

  inMemoryState.runnerId = config.runnerId || inMemoryState.runnerId || null;
  inMemoryState.hostUrl = config.hostUrl || inMemoryState.hostUrl || null;
  persistState();

  if (getSecret() && config.hostUrl && (config.runnerId || inMemoryState.runnerId)) {
    await performRegistration("startup");
  }

  scheduleHeartbeat();

  app.listen(config.port, () => {
    console.log(`[runner] Listening on port ${config.port}`);
  });
}

bootstrap().catch((err) => {
  console.error("[runner] Failed to start runner service", err);
  process.exit(1);
});

