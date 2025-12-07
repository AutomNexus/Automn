// ─────────────────────────────────────────────
// 🍂 Automn Server (Hot-Reload + Live Logs)
// ─────────────────────────────────────────────
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { promisify } = require("util");
const db = require("./db");
const { hashPassword, verifyPassword } = require("./security");
const { DEFAULT_ADMIN_PASSWORD, HOST_VERSION, MINIMUM_RUNNER_VERSION } = require("./constants");
const {
  runJob,
  queue,
  getActiveWorkerCount,
  addSubscriber,
  registerRunnerHost,
  unregisterRunnerHost,
  RunnerUnavailableError,
  getRunnerHostConfig,
} = require("./engine");
const { extractNodeDependencies } = require("./runner/package-manager");
const {
  SCRIPT_VARIABLE_ENV_PREFIX,
  GLOBAL_VARIABLE_ENV_PREFIX,
  COLLECTION_VARIABLE_ENV_PREFIX,
  CATEGORY_VARIABLE_ENV_PREFIX,
  serializeJobVariableDefinitions,
} = require("./variable-definitions");

const fsp = fs.promises;

let httpFetch = null;
if (typeof globalThis.fetch === "function") {
  httpFetch = globalThis.fetch.bind(globalThis);
} else {
  try {
    const undici = require("node:undici");
    if (undici && typeof undici.fetch === "function") {
      httpFetch = undici.fetch.bind(undici);
    }
  } catch (err) {
    httpFetch = null;
  }
}

const VARIABLE_MASK = "••••••";
const VARIABLE_KEY_PATH = path.join(__dirname, "data", "variables.key");
let cachedVariableKey = null;

const COOKIE_NAME = "automn_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PASSWORD_MIN_LENGTH = 8;

const REQUEST_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: "16mb" }));
const PORT = process.env.PORT || 8088;

const ENCRYPTION_MAGIC = Buffer.from("AUTOMNENC1");
const ENCRYPTION_SALT_LENGTH = 16;
const ENCRYPTION_IV_LENGTH = 12;
const ENCRYPTION_TAG_LENGTH = 16;
const scryptAsync = promisify(crypto.scrypt);

const BANNED_USERNAMES = new Set(["api", "administrator", "system"]);
const DEFAULT_COLLECTION_ID = "category-general";
const DEFAULT_CATEGORY_ID = DEFAULT_COLLECTION_ID;
const SUPPORTED_SCRIPT_LANGUAGES = new Set([
  "node",
  "javascript",
  "typescript",
  "python",
  "powershell",
  "shell",
]);

const SUPPORTED_HTTP_METHODS = Object.freeze([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const DEFAULT_ACCEPTED_METHODS = Object.freeze(["POST", "GET"]);
const scriptRouteAcceptedMethodRegistry = new Map();

const SCRIPT_PERMISSION_COLUMNS = Object.freeze({
  read: "can_read",
  write: "can_write",
  delete: "can_delete",
  run: "can_run",
  clearLogs: "can_clear_logs",
});

const CATEGORY_PERMISSION_COLUMNS = Object.freeze({
  read: "can_read",
  write: "can_write",
  delete: "can_delete",
  run: "can_run",
  clearLogs: "can_clear_logs",
});

const EMPTY_PERMISSIONS = Object.freeze({
  read: false,
  write: false,
  delete: false,
  run: false,
  clearLogs: false,
  manage: false,
  isOwner: false,
});

const NOTIFICATION_TYPE_VALUES = Object.freeze({
  SYSTEM: "system",
  SUBSCRIPTION: "subscription",
  SCRIPT: "script",
});

const KNOWN_NOTIFICATION_TYPES = new Set(
  Object.values(NOTIFICATION_TYPE_VALUES),
);

const NOTIFICATION_LEVELS = new Set(["info", "warn", "error"]);

const RUNNER_STATUS = Object.freeze({
  PENDING: "pending",
  HEALTHY: "healthy",
  DISABLED: "disabled",
});

const RUNNER_HEALTH_WINDOW_MS = 2 * 60 * 1000;
const MIN_RUNNER_SECRET_LENGTH = 12;

function resolveFrontendDir() {
  const publicDir = path.join(__dirname, "public");
  const distDir = path.join(__dirname, "frontend", "dist");

  const hasIndex = (dir) => {
    try {
      return fs.existsSync(path.join(dir, "index.html"));
    } catch (err) {
      return false;
    }
  };

  if (hasIndex(publicDir)) {
    return publicDir;
  }

  if (hasIndex(distDir)) {
    console.log("Serving frontend from frontend/dist; public/ directory not found.");
    return distDir;
  }

  console.warn(
    "No built frontend detected. Run `npm --prefix frontend run build` to generate static assets.",
  );
  return publicDir;
}


function generateRunnerSecret() {
  try {
    return crypto.randomBytes(24).toString("base64url");
  } catch (err) {
    const fallback = crypto.randomBytes(24).toString("base64");
    return fallback
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
}

function createEmptyNotificationSummary() {
  return {
    total: 0,
    unread: 0,
    byType: {
      [NOTIFICATION_TYPE_VALUES.SYSTEM]: { total: 0, unread: 0 },
      [NOTIFICATION_TYPE_VALUES.SUBSCRIPTION]: { total: 0, unread: 0 },
      [NOTIFICATION_TYPE_VALUES.SCRIPT]: { total: 0, unread: 0 },
    },
  };
}

function normalizeHeaderValue(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.length ? String(value[0]) : "";
  }
  return String(value);
}

function generateScriptToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function sanitizeScriptToken(token) {
  if (!token) return "";
  const str = String(token);
  if (!str) return "";
  if (str.length <= 1) {
    return "****";
  }
  if (str.length <= 5) {
    return `${str[0]}****${str[str.length - 1]}`;
  }
  return `${str.slice(0, 4)}****${str.slice(-1)}`;
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

function normalizeRunnerRuntimesPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const normalized = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (!key) continue;
    if (rawValue === null || rawValue === undefined) {
      normalized[key] = null;
      continue;
    }
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      normalized[key] = trimmed || null;
      continue;
    }
    normalized[key] = String(rawValue);
  }
  return normalized;
}

function deriveVariableKey(source) {
  if (!source) return null;
  const raw = String(source).trim();
  if (!raw) return null;

  const attempts = [
    () => Buffer.from(raw, "base64"),
    () => Buffer.from(raw, "hex"),
  ];

  for (const attempt of attempts) {
    try {
      const buffer = attempt();
      if (buffer.length === 32) {
        return buffer;
      }
    } catch (err) {
      // ignore decoding error, try next strategy
    }
  }

  try {
    return crypto.createHash("sha256").update(raw).digest();
  } catch (err) {
    return null;
  }
}

function ensureVariableKey() {
  if (cachedVariableKey) {
    return cachedVariableKey;
  }

  const envKey = process.env.AUTOMN_VARIABLE_KEY;
  if (envKey) {
    const derived = deriveVariableKey(envKey);
    if (derived) {
      cachedVariableKey = derived;
      return cachedVariableKey;
    }
    console.error("Failed to derive variable encryption key from AUTOMN_VARIABLE_KEY");
  }

  try {
    const stored = fs.readFileSync(VARIABLE_KEY_PATH, "utf8");
    const derived = deriveVariableKey(stored);
    if (derived) {
      cachedVariableKey = derived;
      return cachedVariableKey;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to read variable encryption key", err);
    }
  }

  const generated = crypto.randomBytes(32);
  cachedVariableKey = generated;

  try {
    fs.mkdirSync(path.dirname(VARIABLE_KEY_PATH), { recursive: true });
    fs.writeFileSync(VARIABLE_KEY_PATH, generated.toString("base64"), {
      mode: 0o600,
    });
  } catch (err) {
    console.error("Failed to persist variable encryption key", err);
  }

  return cachedVariableKey;
}

function isRunnerHostFresh(host) {
  if (!host || !host.lastSeenAt) return false;
  const lastSeen = Date.parse(host.lastSeenAt);
  if (!Number.isFinite(lastSeen)) {
    return false;
  }
  return Date.now() - lastSeen <= RUNNER_HEALTH_WINDOW_MS;
}

function sanitizeRunnerHost(host) {
  if (!host) return null;
  const normalized = {
    id: host.id || null,
    name: host.name || null,
    status: host.status || RUNNER_STATUS.PENDING,
    statusMessage: host.statusMessage || null,
    endpoint: host.endpoint || null,
    lastSeenAt: host.lastSeenAt || null,
    maxConcurrency:
      host.maxConcurrency === null || host.maxConcurrency === undefined
        ? null
        : Number(host.maxConcurrency),
    timeoutMs:
      host.timeoutMs === null || host.timeoutMs === undefined
        ? null
        : Number(host.timeoutMs),
    runnerVersion: host.runnerVersion || null,
    runnerOs: host.runnerOs || null,
    runnerPlatform: host.runnerPlatform || null,
    runnerArch: host.runnerArch || null,
    runnerUptime:
      host.runnerUptime === null || host.runnerUptime === undefined
        ? null
        : Number(host.runnerUptime),
    runnerRuntimes:
      host.runnerRuntimes && typeof host.runnerRuntimes === "object"
        ? { ...host.runnerRuntimes }
        : {},
    minimumHostVersion: host.minimumHostVersion || null,
    hostVersion: HOST_VERSION,
    minimumRunnerVersion: MINIMUM_RUNNER_VERSION,
    adminOnly: Boolean(host.adminOnly),
    createdAt: host.createdAt || null,
    updatedAt: host.updatedAt || null,
    disabledAt: host.disabledAt || null,
    isHealthy: false,
    isStale: true,
    isCompatible: true,
    runnerOutdated: false,
    hostOutdatedForRunner: false,
  };

  if (normalized.lastSeenAt) {
    normalized.isStale = !isRunnerHostFresh(host);
  }

  const runnerVersionOk =
    !host.runnerVersion || versionSatisfies(host.runnerVersion, MINIMUM_RUNNER_VERSION);
  const hostVersionOk =
    !host.minimumHostVersion || versionSatisfies(HOST_VERSION, host.minimumHostVersion);

  normalized.isHealthy =
    normalized.status === RUNNER_STATUS.HEALTHY &&
    !normalized.disabledAt &&
    isRunnerHostFresh(host);

  normalized.isCompatible = runnerVersionOk && hostVersionOk;
  normalized.runnerOutdated = !runnerVersionOk;
  normalized.hostOutdatedForRunner = !hostVersionOk;

  return normalized;
}

async function ensureHealthyRunnerAvailability(script = null) {
  const scriptRunnerId =
    script?.runnerHostId ||
    script?.runner_host_id ||
    null;
  const categoryRunnerId =
    script?.categoryDefaultRunnerHostId ||
    script?.category_default_runner_host_id ||
    script?.category?.defaultRunnerHostId ||
    script?.category?.default_runner_host_id ||
    null;
  const inheritCategoryRunner =
    script?.inheritCategoryRunner ??
    (script?.inherit_category_runner !== undefined
      ? script?.inherit_category_runner !== 0
      : true);

  const targetRunnerId =
    scriptRunnerId || (inheritCategoryRunner ? categoryRunnerId : null) || null;

  try {
    if (script) {
      if (!targetRunnerId) {
        throw new RunnerUnavailableError(
          inheritCategoryRunner
            ? "No runner available"
            : "No runners configured",
        );
      }

      const runnerHost = await db.getRunnerHostById(targetRunnerId);
      if (!runnerHost || runnerHost.disabledAt) {
        throw new RunnerUnavailableError();
      }

      if (
        runnerHost.status !== RUNNER_STATUS.HEALTHY ||
        !isRunnerHostFresh(runnerHost)
      ) {
        throw new RunnerUnavailableError();
      }
      return;
    }

    const hasHealthy = await db.hasHealthyRunnerHost(RUNNER_HEALTH_WINDOW_MS);
    if (!hasHealthy) {
      throw new RunnerUnavailableError();
    }
  } catch (err) {
    if (err instanceof RunnerUnavailableError) {
      throw err;
    }
    console.error("Failed to verify runner availability", err);
    throw new RunnerUnavailableError();
  }
}

function extractClientIp(req) {
  const forwarded = normalizeHeaderValue(req.headers["x-forwarded-for"]);
  if (forwarded) {
    const [first] = forwarded.split(",");
    if (first && first.trim()) {
      return first.trim();
    }
  }
  if (typeof req.ip === "string" && req.ip) {
    return req.ip;
  }
  if (req.socket?.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return "";
}

function encryptVariableValue(value) {
  const key = ensureVariableKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptVariableValue(payload) {
  const key = ensureVariableKey();
  const buffer = Buffer.from(payload || "", "base64");
  if (buffer.length < 28) {
    throw new Error("Encrypted payload is malformed");
  }
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function normalizeVariableName(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  if (!trimmed) return "";
  const normalized = trimmed
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized;
}

function computeVariableEnvName(name, prefix = SCRIPT_VARIABLE_ENV_PREFIX) {
  if (!name) return "";
  const effectivePrefix = prefix || SCRIPT_VARIABLE_ENV_PREFIX;
  return `${effectivePrefix}${name}`;
}

function normalizeNotificationLevel(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (NOTIFICATION_LEVELS.has(normalized)) {
    return normalized;
  }
  return "info";
}

function parseNotificationAudience(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseNotificationAudience(entry);
      if (parsed) return parsed;
    }
    return null;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase();
  if (["admins", "admin", "administrators"].includes(normalized)) {
    return { scope: "admins" };
  }

  if (
    [
      "other admins",
      "other admin",
      "other-admins",
      "other-admin",
      "other_admins",
      "other_admin",
    ].includes(normalized)
  ) {
    return { scope: "other-admins" };
  }

  if (["all", "all users", "everyone", "users"].includes(normalized)) {
    return { scope: "all" };
  }

  return { scope: "user", identifier: raw };
}

async function resolveNotificationRecipients(descriptor, options = {}) {
  if (!descriptor || typeof descriptor.scope !== "string") {
    return null;
  }

  const scope = descriptor.scope.toLowerCase();
  const excludeUserId = options.excludeUserId || null;

  if (scope === "admins" || scope === "other-admins") {
    const rows = await dbAll(
      `SELECT id, username FROM users WHERE is_admin=1 AND is_active=1 AND deleted_at IS NULL`,
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    let filteredRows = rows;
    if (scope === "other-admins" && excludeUserId) {
      filteredRows = rows.filter((row) => row.id && row.id !== excludeUserId);
    }

    const userIds = filteredRows.map((row) => row.id).filter(Boolean);
    if (!userIds.length) return null;
    return {
      scope,
      userIds,
      usernames: filteredRows.map((row) => row.username).filter(Boolean),
    };
  }

  if (scope === "all") {
    const rows = await dbAll(
      `SELECT id, username FROM users WHERE is_active=1 AND deleted_at IS NULL`,
    );
    const userIds = Array.isArray(rows) ? rows.map((row) => row.id).filter(Boolean) : [];
    if (!userIds.length) return null;
    return {
      scope: "all",
      userIds,
      usernames: rows.map((row) => row.username).filter(Boolean),
    };
  }

  if (scope === "user") {
    const identifier = typeof descriptor.identifier === "string"
      ? descriptor.identifier.trim()
      : "";
    if (!identifier) return null;

    const row = await dbGet(
      `SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND is_active=1 AND deleted_at IS NULL`,
      [identifier],
    );

    if (!row || !row.id) {
      return null;
    }

    return {
      scope: "user",
      userIds: [row.id],
      usernames: row.username ? [row.username] : [],
      identifier: row.username || identifier,
    };
  }

  return null;
}

function deriveNotificationAudience(notification) {
  if (!notification) return null;

  const direct = notification.audience ?? notification.target ?? null;
  if (direct) {
    const parsed = parseNotificationAudience(direct);
    if (parsed) return parsed;
  }

  const raw = notification.raw || {};
  if (raw && typeof raw === "object") {
    const fallback =
      raw.audience ?? raw.target ?? raw.user ?? raw.scope ?? raw.recipient ?? null;
    if (fallback) {
      const parsed = parseNotificationAudience(fallback);
      if (parsed) return parsed;
    }
  }

  return null;
}

function coerceNotificationMessage(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, 2000);
}

async function storeScriptNotifications(script, notifications, context = {}) {
  if (!script?.id || !Array.isArray(notifications) || notifications.length === 0) {
    return;
  }

  let processed = 0;
  for (const entry of notifications) {
    if (processed >= 50) {
      break;
    }

    const message = coerceNotificationMessage(entry?.message ?? entry?.raw?.message);
    if (!message) {
      continue;
    }

    const audienceDescriptor = deriveNotificationAudience(entry);
    if (!audienceDescriptor) {
      continue;
    }

    let resolved;
    try {
      resolved = await resolveNotificationRecipients(audienceDescriptor, {
        excludeUserId: context.triggeredByUserId || null,
      });
    } catch (err) {
      console.error("Failed to resolve notification recipients", err);
      continue;
    }

    if (!resolved || !Array.isArray(resolved.userIds) || resolved.userIds.length === 0) {
      continue;
    }

    const level = normalizeNotificationLevel(entry?.level);
    const createdAt = new Date().toISOString();
    const metadata = {
      audienceType: resolved.scope,
      audienceValue: audienceDescriptor.identifier || null,
      targetUsernames: Array.isArray(resolved.usernames)
        ? resolved.usernames
        : [],
      scriptName: script.name || null,
      scriptEndpoint: script.endpoint || null,
      runId: context.runId || null,
      triggeredBy: context.triggeredBy || null,
      order: typeof entry?.order === "number" ? entry.order : processed,
    };

    const notificationId = uuidv4();

    try {
      await dbRun(
        `INSERT INTO notifications (id, type, level, message, script_id, created_at, created_by_user_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          notificationId,
          NOTIFICATION_TYPE_VALUES.SCRIPT,
          level,
          message,
          script.id,
          createdAt,
          context.triggeredByUserId || null,
          JSON.stringify(metadata),
        ],
      );
    } catch (err) {
      console.error("Failed to record script notification", err);
      continue;
    }

    for (const userId of resolved.userIds) {
      if (!userId) continue;
      try {
        await dbRun(
          `INSERT OR IGNORE INTO notification_recipients (notification_id, user_id) VALUES (?, ?)`,
          [notificationId, userId],
        );
      } catch (err) {
        console.error("Failed to assign notification recipient", err);
      }
    }

    processed += 1;
  }
}

async function persistScriptNotifications(script, runResult) {
  if (!script?.id || !runResult) return;
  const notifications = Array.isArray(runResult.automnNotifications)
    ? runResult.automnNotifications
    : [];
  if (!notifications.length) return;

  try {
    await storeScriptNotifications(script, notifications, {
      runId: runResult.runId || null,
      triggeredByUserId: runResult.triggeredByUserId || null,
      triggeredBy: runResult.triggeredBy || null,
    });
  } catch (err) {
    console.error("Failed to persist script notifications", err);
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTriggeredValue(raw, fallback) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return fallback;
  return trimmed.slice(0, 255);
}

function cloneInputSnapshot(input) {
  if (input === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(input));
  } catch (err) {
    return input ?? null;
  }
}

function shouldAttemptJsonParse(req, text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  const contentType = normalizeHeaderValue(req?.headers?.["content-type"]).toLowerCase();
  if (contentType.includes("json")) {
    return true;
  }

  const firstChar = trimmed[0];
  const lastChar = trimmed[trimmed.length - 1];
  if ((firstChar === "{" && lastChar === "}") || (firstChar === "[" && lastChar === "]")) {
    return true;
  }
  if (firstChar === "\"" && lastChar === "\"") {
    return true;
  }

  return false;
}

function readRequestBodyBuffer(req, limitBytes = REQUEST_BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== "function") {
      resolve(null);
      return;
    }

    if (req.complete || req.readableEnded || req.readable === false) {
      resolve(null);
      return;
    }

    let size = 0;
    const chunks = [];

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (chunk === undefined || chunk === null) {
        return;
      }
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bufferChunk.length;
      if (size > limitBytes) {
        cleanup();
        const err = new Error("Request body too large");
        err.status = 413;
        err.code = "payload_too_large";
        reject(err);
        return;
      }
      chunks.push(bufferChunk);
    };

    const resolveWithChunks = () => {
      cleanup();
      if (!chunks.length) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    const onEnd = () => {
      resolveWithChunks();
    };

    const onClose = () => {
      resolveWithChunks();
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

async function resolveRequestPayload(req) {
  if (!req) return undefined;
  if (req.body !== undefined) {
    return req.body;
  }

  let rawBuffer;
  try {
    rawBuffer = await readRequestBodyBuffer(req);
  } catch (err) {
    throw err;
  }

  if (!rawBuffer || rawBuffer.length === 0) {
    return undefined;
  }

  const text = rawBuffer.toString("utf8");
  if (!text) {
    return undefined;
  }

  if (shouldAttemptJsonParse(req, text)) {
    try {
      const parsed = JSON.parse(text.trim());
      req.body = parsed;
      return parsed;
    } catch (err) {
      // Fall back to returning text when JSON parsing fails.
    }
  }

  req.body = text;
  return text;
}

function safeSerializeInput(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch (err) {
    return JSON.stringify({
      error: "Failed to serialize input payload",
      message: err.message,
    });
  }
}

async function determineCodeVersionForScript(scriptId) {
  if (!scriptId) return 1;
  try {
    const row = await dbGet(
      "SELECT MAX(version) AS maxVersion FROM script_versions WHERE script_id=?",
      [scriptId],
    );
    const rawValue = row?.maxVersion ?? row?.max_version ?? row?.v ?? 0;
    const numeric = Number(rawValue);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
  } catch (err) {
    console.error("Failed to load script version for run", err);
    return 1;
  }
}

function normalizeRunResultPayload(result, context) {
  const normalizeLevel = (value) => {
    const normalized = typeof value === "string" ? value.toLowerCase().trim() : "";
    if (normalized === "warn" || normalized === "warning") return "warn";
    if (normalized === "error") return "error";
    if (normalized === "success") return "success";
    if (normalized === "debug") return "debug";
    return "info";
  };

  const normalizeLogContext = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (value === undefined || value === null) return {};
    return { value };
  };

  const normalizeLogType = (value) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return normalized || "general";
  };

  const normalizeAutomnLog = (log, index) => {
    const messageValue =
      log?.message === null || log?.message === undefined ? "" : log.message;
    const timestamp =
      typeof log?.timestamp === "string" && log.timestamp.trim()
        ? log.timestamp
        : new Date().toISOString();

    return {
      message: typeof messageValue === "string" ? messageValue : String(messageValue),
      level: normalizeLevel(log?.level),
      type: normalizeLogType(log?.type ?? log?.category),
      context: normalizeLogContext(log?.context),
      order: Number.isFinite(log?.order) ? log.order : index,
      timestamp,
    };
  };

  const normalizeAutomnLogs = (logs) => {
    const parsedLogs = ensureArray(logs);
    if (!parsedLogs.length) return [];
    return parsedLogs.map((log, idx) => normalizeAutomnLog(log, idx));
  };

  const fallbackDuration = Math.max(Date.now() - context.startTimestamp, 0);
  const rawCode = result?.code;
  const numericCodeCandidate = Number.isFinite(rawCode)
    ? rawCode
    : Number(rawCode);
  const normalizedCode = Number.isFinite(numericCodeCandidate)
    ? numericCodeCandidate
    : 1;

  const normalized = {
    runId: result?.runId || context.runId,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string"
      ? result.stderr
      : result?.stderr
        ? String(result.stderr)
        : "",
    code: normalizedCode,
    duration:
      Number.isFinite(result?.duration) && result.duration >= 0
        ? result.duration
        : fallbackDuration,
    returnData:
      result && Object.prototype.hasOwnProperty.call(result, "returnData")
        ? result.returnData
        : null,
    automnLogs: normalizeAutomnLogs(result?.automnLogs),
    automnNotifications: ensureArray(result?.automnNotifications),
    input:
      result && Object.prototype.hasOwnProperty.call(result, "input")
        ? result.input
        : context.inputSnapshot,
    httpMethod: context.httpMethod || null,
    scriptId: context.scriptId || null,
    errorCode:
      typeof result?.errorCode === "string"
        ? result.errorCode
        : typeof result?.code === "string"
          ? result.code
          : null,
  };

  if (!normalized.runId) normalized.runId = context.runId;
  return normalized;
}

function buildFallbackAutomnLogs({
  success,
  failureReason,
  errorCode,
  context,
}) {
  const reasonText = typeof failureReason === "string" ? failureReason : "";
  const normalizedErrorCode =
    typeof errorCode === "string" ? errorCode.toLowerCase().trim() : "";
  const authenticationCodes = new Set(["missing_token", "invalid_token", "unauthorized"]);
  const isAuthenticationIssue =
    authenticationCodes.has(normalizedErrorCode) ||
    reasonText.toLowerCase().includes("authentication");

  const type = isAuthenticationIssue ? "authentication" : "general";
  const level = success ? "success" : isAuthenticationIssue ? "warn" : "error";
  const message = success ? "Run completed successfully" : reasonText || "Run failed";

  const fallbackContext = {};
  if (context?.httpMethod) fallbackContext.httpMethod = context.httpMethod;
  if (context?.scriptId) fallbackContext.scriptId = context.scriptId;
  if (context?.runId) fallbackContext.runId = context.runId;

  return [
    {
      message,
      level,
      type,
      context: fallbackContext,
      order: 0,
      timestamp: new Date().toISOString(),
    },
  ];
}

function normalizeAutomnLogCollection(logs, fallbackDetails) {
  const parsedLogs = ensureArray(logs);
  if (!parsedLogs.length) {
    return buildFallbackAutomnLogs(fallbackDetails);
  }
  return parsedLogs.map((log, idx) => {
    const messageValue =
      log?.message === null || log?.message === undefined ? "" : log.message;
    const levelValue =
      typeof log?.level === "string" ? log.level.toLowerCase().trim() : "";
    const normalizedLevel =
      levelValue === "warn" ||
      levelValue === "warning" ||
      levelValue === "error" ||
      levelValue === "success" ||
      levelValue === "debug"
        ? levelValue === "warning"
          ? "warn"
          : levelValue
        : "info";
    const typeValue =
      typeof log?.type === "string"
        ? log.type.trim().toLowerCase()
        : typeof log?.category === "string"
          ? log.category.trim().toLowerCase()
          : "";
    const normalizedContext =
      log?.context && typeof log.context === "object" && !Array.isArray(log.context)
        ? log.context
        : log?.context === undefined || log?.context === null
          ? {}
          : { value: log.context };
    const timestamp =
      typeof log?.timestamp === "string" && log.timestamp.trim()
        ? log.timestamp
        : new Date().toISOString();

    return {
      message: typeof messageValue === "string" ? messageValue : String(messageValue),
      level: normalizedLevel,
      type: typeValue || "general",
      context: normalizedContext,
      order: Number.isFinite(log?.order) ? log.order : idx,
      timestamp,
    };
  });
}

async function createRunTracker({
  runId,
  script,
  triggeredBy,
  triggeredByUserId,
  input,
  httpMethod,
  codeVersion: providedCodeVersion = null,
}) {
  const scriptId = script?.id || null;
  const codeVersion =
    Number.isFinite(providedCodeVersion) && providedCodeVersion > 0
      ? providedCodeVersion
      : await determineCodeVersionForScript(scriptId);
  const startTimeIso = new Date().toISOString();
  const startTimestamp = Date.now();
  const triggeredLabel = normalizeTriggeredValue(triggeredBy, "API");
  const triggeredUserId =
    typeof triggeredByUserId === "string" && triggeredByUserId.trim()
      ? triggeredByUserId.trim()
      : null;
  const normalizedMethod =
    typeof httpMethod === "string" && httpMethod.trim()
      ? httpMethod.trim().toUpperCase().slice(0, 16)
      : null;

  try {
    await dbRun(
      `INSERT INTO runs (id, script_id, start_time, status, code_version, triggered_by, triggered_by_user_id, http_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        scriptId,
        startTimeIso,
        "running",
        codeVersion,
        triggeredLabel,
        triggeredUserId,
        normalizedMethod,
      ],
    );
  } catch (err) {
    console.error("Failed to record run start", err);
  }

  const inputSnapshot = cloneInputSnapshot(input);
  const context = {
    runId,
    scriptId,
    startTimeIso,
    startTimestamp,
    inputSnapshot,
    httpMethod: normalizedMethod,
  };

  let settled = false;

  const persistOutcome = async (rawResult) => {
    const normalized = normalizeRunResultPayload(rawResult, context);
    const rawStderr =
      typeof normalized.stderr === "string"
        ? normalized.stderr
        : normalized.stderr
          ? String(normalized.stderr)
          : "";
    const trimmedStderr = rawStderr.trim();
    const success = normalized.code === 0 && !trimmedStderr;
    const persistedStderr =
      trimmedStderr || (normalized.code !== 0 ? "Script execution failed" : "");

    normalized.stderr = persistedStderr;
    normalized.automnLogs = normalizeAutomnLogCollection(normalized.automnLogs, {
      success,
      failureReason: persistedStderr,
      errorCode: normalized.errorCode,
      context: {
        httpMethod: normalized.httpMethod || context.httpMethod || null,
        scriptId,
        runId: normalized.runId,
      },
    });
    let returnJson = "null";
    try {
      returnJson = JSON.stringify(normalized.returnData);
    } catch (err) {
      returnJson = JSON.stringify({
        error: "Failed to serialize return payload",
        message: err.message,
      });
    }

    const endTimeIso = new Date().toISOString();

    try {
      await dbRun(
        `UPDATE runs SET end_time=?, duration_ms=?, status=?, return_json=? WHERE id=?`,
        [endTimeIso, normalized.duration, success ? "success" : "error", returnJson, runId],
      );
    } catch (err) {
      console.error("Failed to update run record", err);
    }

    const inputJson = safeSerializeInput(normalized.input);

    try {
      await dbRun(
        `INSERT INTO logs (id, run_id, script_id, start_time, duration_ms, stdout, stderr, exit_code, automn_logs_json, automn_notifications_json, input_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          runId,
          scriptId,
          context.startTimeIso,
          normalized.duration,
          normalized.stdout,
          normalized.stderr,
          normalized.code,
          JSON.stringify(normalized.automnLogs),
          JSON.stringify(normalized.automnNotifications),
          inputJson,
        ],
      );
    } catch (err) {
      console.error("Failed to insert run log", err);
    }
  };

  return {
    runId,
    async complete(result) {
      if (settled) return;
      settled = true;
      await persistOutcome(result);
    },
    async fail(error) {
      if (settled) return;
      settled = true;
      const failureError = normalizeRunFailureError(error);
      const message = failureError?.message || "Runner error";
      await persistOutcome({
        runId,
        stdout: "",
        stderr: message,
        code: 1,
        duration: 0,
        returnData: null,
        automnLogs: [],
        automnNotifications: [],
        input: inputSnapshot,
        errorCode: failureError?.code,
      });
    },
  };
}

async function recordImmediateRunFailure({
  runId,
  script,
  triggeredBy,
  triggeredByUserId,
  httpMethod,
  input,
  error,
  codeVersion = null,
}) {
  try {
    const tracker = await createRunTracker({
      runId,
      script,
      triggeredBy,
      triggeredByUserId,
      input,
      httpMethod,
      codeVersion,
    });
    await tracker.fail(error);
  } catch (err) {
    console.error(`Failed to persist run ${runId || "unknown"} failure:`, err);
  }
}

function mapRunFailureMessage(err) {
  if (!err) return "Script execution failed";
  const rawMessage = typeof err.message === "string" ? err.message : "";
  const code = typeof err.code === "string" ? err.code.toLowerCase() : "";
  const normalizedMessage = rawMessage.toLowerCase();

  if (code === "node_dependency_install_failed") return "Try again later";
  if (code === "missing_token") return "Authentication not provided";
  if (code === "invalid_token") return "Incorrect Credentials";
  if (code === "runner_incompatible") return "Runner does not support runtime";
  if (code === "runner_unavailable") return "Runner offline";
  if (err instanceof RunnerUnavailableError) return "Runner offline";
  if (normalizedMessage.includes("failed to install npm dependencies")) {
    return "Try again later";
  }
  if (normalizedMessage.includes("does not support runtime")) {
    return "Runner does not support runtime";
  }
  if (normalizedMessage.includes("no runner available")) {
    return "Runner offline";
  }
  if (normalizedMessage.includes("authentication")) {
    return "Authentication not provided";
  }
  return rawMessage || "Script execution failed";
}

function normalizeRunFailureError(err) {
  const mappedMessage = mapRunFailureMessage(err);
  if (err instanceof Error) {
    if (mappedMessage && mappedMessage !== err.message) {
      const normalized = new Error(mappedMessage);
      if (err.code !== undefined) normalized.code = err.code;
      if (typeof err.status === "number") normalized.status = err.status;
      if (err.statusCode !== undefined && normalized.status === undefined) {
        normalized.status = err.statusCode;
      }
      return normalized;
    }
    if (typeof err.statusCode === "number" && err.status === undefined) {
      err.status = err.statusCode;
    }
    return err;
  }

  const normalized = new Error(mappedMessage || "Script execution failed");
  if (err && err.code !== undefined) normalized.code = err.code;
  if (typeof err?.status === "number") normalized.status = err.status;
  if (typeof err?.statusCode === "number" && normalized.status === undefined) {
    normalized.status = err.statusCode;
  }
  return normalized;
}

function determineResultFailureMessage(result, includeMetadata = false) {
  if (!result || typeof result !== "object") {
    return "Script execution failed";
  }

  const stderrText =
    typeof result.stderr === "string" ? result.stderr.trim() : "";
  const clientMessage =
    typeof result.clientMessage === "string"
      ? result.clientMessage.trim()
      : "";
  const errorCode =
    typeof result.errorCode === "string"
      ? result.errorCode.trim().toLowerCase()
      : "";

  if (!includeMetadata) {
    if (clientMessage) {
      return clientMessage;
    }
    if (errorCode === "node_dependency_install_failed") {
      return "Try again later";
    }
    if (stderrText.toLowerCase().includes("failed to install npm dependencies")) {
      return "Try again later";
    }
  }

  if (stderrText) {
    return stderrText;
  }
  if (clientMessage) {
    return clientMessage;
  }
  return "Script execution failed";
}

async function notifyAdminsOfBackup(triggeredByUser = null) {
  let admins;
  try {
    admins = await dbAll(
      `SELECT id, username
         FROM users
        WHERE is_admin=1 AND is_active=1 AND deleted_at IS NULL`,
    );
  } catch (err) {
    console.error("Failed to load admin users for backup notification", err);
    return;
  }

  if (!Array.isArray(admins) || admins.length === 0) {
    return;
  }

  const triggeredByUserId = triggeredByUser?.id || null;
  const triggeredByUsername = triggeredByUser?.username || null;

  const recipients = admins.filter(
    (user) => user?.id && user.id !== triggeredByUserId,
  );

  if (recipients.length === 0) {
    return;
  }

  const message = triggeredByUsername
    ? `${triggeredByUsername} downloaded an Automn backup via the UI.`
    : "An administrator downloaded an Automn backup via the UI.";

  const metadata = {
    audienceType: triggeredByUserId ? "other-admins" : "admins",
    audienceValue: null,
    targetUsernames: recipients
      .map((user) => {
        if (typeof user?.username !== "string") return null;
        const trimmed = user.username.trim();
        return trimmed.length ? trimmed : null;
      })
      .filter(Boolean),
    category: "security",
    pinUntilRead: true,
    triggeredBy: triggeredByUsername || null,
    triggeredByUserId: triggeredByUserId || null,
    event: "ui-backup-download",
  };

  const notificationId = uuidv4();
  const createdAt = new Date().toISOString();

  try {
    await dbRun(
      `INSERT INTO notifications (id, type, level, message, script_id, created_at, created_by_user_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        notificationId,
        NOTIFICATION_TYPE_VALUES.SYSTEM,
        "error",
        message,
        null,
        createdAt,
        triggeredByUserId,
        JSON.stringify(metadata),
      ],
    );
  } catch (err) {
    console.error("Failed to create backup notification", err);
    return;
  }

  for (const recipient of recipients) {
    try {
      await dbRun(
        `INSERT OR IGNORE INTO notification_recipients (notification_id, user_id) VALUES (?, ?)`,
        [notificationId, recipient.id],
      );
    } catch (err) {
      console.error("Failed to assign backup notification recipient", err);
    }
  }
}

function parseNotificationMetadata(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (err) {
    // ignore parse errors
  }
  return {};
}

async function loadNotificationSummary(userId) {
  const summary = createEmptyNotificationSummary();
  if (!userId) {
    return summary;
  }

  let rows = [];
  try {
    rows = await dbAll(
      `SELECT n.type AS type,
              COUNT(*) AS total_count,
              SUM(CASE WHEN nr.read_at IS NULL THEN 1 ELSE 0 END) AS unread_count
         FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
        WHERE nr.user_id=?
        GROUP BY n.type`,
      [userId],
    );
  } catch (err) {
    console.error("Failed to load notification summary", err);
    return summary;
  }

  if (!Array.isArray(rows)) {
    return summary;
  }

  for (const row of rows) {
    const typeRaw = typeof row?.type === "string" ? row.type.toLowerCase() : "";
    const total = Number(row?.total_count) || 0;
    const unread = Number(row?.unread_count) || 0;

    summary.total += total;
    summary.unread += unread;

    if (!typeRaw) continue;

    if (!summary.byType[typeRaw]) {
      summary.byType[typeRaw] = { total: 0, unread: 0 };
    }

    summary.byType[typeRaw].total = total;
    summary.byType[typeRaw].unread = unread;
  }

  return summary;
}

function sanitizeVariableApiRow(
  row,
  { envPrefix = SCRIPT_VARIABLE_ENV_PREFIX, scope = "script" } = {},
) {
  if (!row) return null;
  const isSecure = row.is_secure !== 0;
  const envName = row.env_name || computeVariableEnvName(row.name, envPrefix);
  const storedValue = row.value || "";
  const base = {
    id: row.id,
    scriptId: row.script_id || null,
    categoryId: row.category_id || null,
    collectionId: row.category_id || null,
    name: row.name,
    envName,
    isSecure,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    hasValue: Boolean(storedValue),
    scope,
  };

  if (isSecure) {
    base.value = null;
    base.maskedValue = storedValue ? VARIABLE_MASK : "";
  } else {
    base.value = storedValue;
    base.maskedValue = null;
  }

  return base;
}

async function loadScriptVariablesForApi(scriptId) {
  if (!scriptId) return [];
  try {
    const rows = await dbAll(
      `SELECT id, script_id, name, env_name, value, is_secure, created_at, updated_at
         FROM script_variables
        WHERE script_id=?
        ORDER BY name COLLATE NOCASE`,
      [scriptId],
    );
    return rows
      .map((row) =>
        sanitizeVariableApiRow(row, {
          envPrefix: SCRIPT_VARIABLE_ENV_PREFIX,
          scope: "script",
        }),
      )
      .filter(Boolean);
  } catch (err) {
    console.error("Failed to load script variables", err);
    return [];
  }
}

async function loadCategoryVariablesForApi(categoryId) {
  const effectiveCategoryId = categoryId || DEFAULT_CATEGORY_ID;
  try {
    const rows = await dbAll(
      `SELECT id, category_id, name, env_name, value, is_secure, created_at, updated_at
         FROM category_variables
        WHERE category_id=?
        ORDER BY name COLLATE NOCASE`,
      [effectiveCategoryId],
    );
    return rows
      .map((row) =>
        sanitizeVariableApiRow(row, {
          envPrefix: CATEGORY_VARIABLE_ENV_PREFIX,
          scope: "category",
        }),
      )
      .filter(Boolean);
  } catch (err) {
    console.error("Failed to load collection variables", err);
    return [];
  }
}

async function loadGlobalVariablesForApi() {
  try {
    const rows = await dbAll(
      `SELECT id, name, env_name, value, is_secure, created_at, updated_at
         FROM global_variables
        ORDER BY name COLLATE NOCASE`,
    );
    return rows
      .map((row) =>
        sanitizeVariableApiRow(row, {
          envPrefix: GLOBAL_VARIABLE_ENV_PREFIX,
          scope: "global",
        }),
      )
      .filter(Boolean);
  } catch (err) {
    console.error("Failed to load global variables", err);
    return [];
  }
}

function mapExecutionVariables(rows, { envPrefix, contextLabel }) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const envName = row.env_name || computeVariableEnvName(row.name, envPrefix);
      if (!envName) {
        return null;
      }

      let value = "";
      if (row.is_secure) {
        try {
          value = decryptVariableValue(row.value || "");
        } catch (err) {
          console.error(`Failed to decrypt ${contextLabel} variable ${envName}`, err);
          value = "";
        }
      } else {
        value = row.value || "";
      }

      return { envName, value };
    })
    .filter(Boolean);
}

async function loadScriptVariablesForExecution(script) {
  const scriptId = typeof script === "object" ? script?.id : script;
  if (!scriptId) return [];
  const categoryId =
    (typeof script === "object"
      ? script?.category_id || script?.categoryId
      : null) || DEFAULT_CATEGORY_ID;

  try {
    const [scriptRows, categoryRows, globalRows] = await Promise.all([
      dbAll(
        `SELECT name, env_name, value, is_secure
           FROM script_variables
          WHERE script_id=?`,
        [scriptId],
      ),
      dbAll(
        `SELECT name, env_name, value, is_secure
           FROM category_variables
          WHERE category_id=?`,
        [categoryId],
      ),
      dbAll(
        `SELECT name, env_name, value, is_secure
           FROM global_variables`,
      ),
    ]);

    return [
      ...mapExecutionVariables(globalRows, {
        envPrefix: GLOBAL_VARIABLE_ENV_PREFIX,
        contextLabel: "global",
      }),
      ...mapExecutionVariables(categoryRows, {
        envPrefix: CATEGORY_VARIABLE_ENV_PREFIX,
        contextLabel: `category ${categoryId}`,
      }),
      ...mapExecutionVariables(scriptRows, {
        envPrefix: SCRIPT_VARIABLE_ENV_PREFIX,
        contextLabel: `script ${scriptId}`,
      }),
    ];
  } catch (err) {
    console.error("Failed to load execution variables", err);
    return [];
  }
}

async function countScriptVariables(scriptId) {
  if (!scriptId) return 0;
  try {
    const row = await dbGet(
      "SELECT COUNT(*) AS c FROM script_variables WHERE script_id=?",
      [scriptId],
    );
    return Number(row?.c) || 0;
  } catch (err) {
    console.error("Failed to count script variables", err);
    return 0;
  }
}

async function countCategoryVariables(categoryId) {
  const effectiveCategoryId = categoryId || DEFAULT_CATEGORY_ID;
  try {
    const row = await dbGet(
      "SELECT COUNT(*) AS c FROM category_variables WHERE category_id=?",
      [effectiveCategoryId],
    );
    return Number(row?.c) || 0;
  } catch (err) {
    console.error("Failed to count collection variables", err);
    return 0;
  }
}

async function countGlobalVariables() {
  try {
    const row = await dbGet("SELECT COUNT(*) AS c FROM global_variables");
    return Number(row?.c) || 0;
  } catch (err) {
    console.error("Failed to count global variables", err);
    return 0;
  }
}

async function loadScriptVariableById(scriptId, variableId) {
  if (!scriptId || !variableId) return null;
  try {
    return await dbGet(
      `SELECT id, script_id, name, env_name, value, is_secure, created_at, updated_at
         FROM script_variables
        WHERE id=? AND script_id=?`,
      [variableId, scriptId],
    );
  } catch (err) {
    console.error("Failed to load script variable", err);
    return null;
  }
}

async function loadCategoryVariableById(categoryId, variableId) {
  if (!categoryId || !variableId) return null;
  try {
    return await dbGet(
      `SELECT id, category_id, name, env_name, value, is_secure, created_at, updated_at
         FROM category_variables
        WHERE id=? AND category_id=?`,
      [variableId, categoryId],
    );
  } catch (err) {
    console.error("Failed to load collection variable", err);
    return null;
  }
}

async function loadGlobalVariableById(variableId) {
  if (!variableId) return null;
  try {
    return await dbGet(
      `SELECT id, name, env_name, value, is_secure, created_at, updated_at
         FROM global_variables
        WHERE id=?`,
      [variableId],
    );
  } catch (err) {
    console.error("Failed to load global variable", err);
    return null;
  }
}

function extractBearerToken(req) {
  const header = normalizeHeaderValue(req?.headers?.authorization);
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim();
}

function evaluateScriptTokenAccess(req, script, user) {
  const result = { used: false, masked: null };
  if (user) return result;

  const requiresAuth = script?.require_authentication !== 0;
  const storedToken = (script?.run_token || "").trim();
  if (!requiresAuth) {
    if (!storedToken) {
      return result;
    }

    const providedOptional = extractBearerToken(req);
    if (!providedOptional) {
      return result;
    }

    if (providedOptional !== storedToken) {
      const err = new Error("Invalid bearer token");
      err.status = 401;
      err.code = "invalid_token";
      throw err;
    }

    result.used = true;
    result.masked = sanitizeScriptToken(storedToken);
    return result;
  }

  if (!storedToken) {
    return result;
  }

  const provided = extractBearerToken(req);
  if (!provided) {
    const err = new Error("Bearer token required");
    err.status = 401;
    err.code = "missing_token";
    throw err;
  }

  if (provided !== storedToken) {
    const err = new Error("Invalid bearer token");
    err.status = 401;
    err.code = "invalid_token";
    throw err;
  }

  result.used = true;
  result.masked = sanitizeScriptToken(storedToken);
  return result;
}

async function encryptBackupBuffer(buffer, password) {
  if (!password || !password.trim()) {
    return { buffer, filenameSuffix: ".db" };
  }

  const salt = crypto.randomBytes(ENCRYPTION_SALT_LENGTH);
  const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
  const key = await scryptAsync(password, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const encryptedBuffer = Buffer.concat([
    ENCRYPTION_MAGIC,
    salt,
    iv,
    authTag,
    ciphertext,
  ]);

  return { buffer: encryptedBuffer, filenameSuffix: ".automn.enc" };
}

async function decryptBackupBuffer(buffer, password) {
  if (buffer.length < ENCRYPTION_MAGIC.length) {
    return { buffer, encrypted: false };
  }

  if (!ENCRYPTION_MAGIC.equals(buffer.subarray(0, ENCRYPTION_MAGIC.length))) {
    return { buffer, encrypted: false };
  }

  const minimumLength =
    ENCRYPTION_MAGIC.length +
    ENCRYPTION_SALT_LENGTH +
    ENCRYPTION_IV_LENGTH +
    ENCRYPTION_TAG_LENGTH;

  if (buffer.length < minimumLength) {
    throw new Error("Encrypted backup payload is malformed");
  }

  if (!password || !password.trim()) {
    const err = new Error("Backup password is required");
    err.code = "password_required";
    throw err;
  }

  const saltStart = ENCRYPTION_MAGIC.length;
  const saltEnd = saltStart + ENCRYPTION_SALT_LENGTH;
  const ivEnd = saltEnd + ENCRYPTION_IV_LENGTH;
  const tagEnd = ivEnd + ENCRYPTION_TAG_LENGTH;

  const salt = buffer.subarray(saltStart, saltEnd);
  const iv = buffer.subarray(saltEnd, ivEnd);
  const authTag = buffer.subarray(ivEnd, tagEnd);
  const ciphertext = buffer.subarray(tagEnd);

  const key = await scryptAsync(password, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { buffer: decrypted, encrypted: true };
}

// Serve the built frontend (React app)
const frontendDir = resolveFrontendDir();
app.use(express.static(frontendDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

app.get("/script/:endpoint", (req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

function parseEnvBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

const secureCookie = parseEnvBoolean(process.env.AUTOMN_SECURE_COOKIES, false);
if (!secureCookie && process.env.NODE_ENV === "production") {
  console.warn(
    "Secure session cookies are disabled. Set AUTOMN_SECURE_COOKIES=true when serving Automn over HTTPS.",
  );
}
const cookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: secureCookie,
  path: "/",
};

function parseCookies(header = "") {
  return header.split(";").reduce((acc, part) => {
    const [rawName, ...rest] = part.split("=");
    if (!rawName) return acc;
    const name = rawName.trim();
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join("=").trim());
    return acc;
  }, {});
}

function normalizeDbBoolean(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    const numeric = Number(normalized);
    if (!Number.isNaN(numeric)) {
      return numeric !== 0;
    }
    return true;
  }
  return Boolean(value);
}

function sanitizeUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    isAdmin: normalizeDbBoolean(row.is_admin),
    isActive: normalizeDbBoolean(row.is_active),
    mustChangePassword: normalizeDbBoolean(row.must_change_password),
    createdAt: row.created_at || null,
    lastLogin: row.last_login || null,
  };
}

function normalizeUsername(username) {
  if (typeof username !== "string") return "";
  return username.trim();
}

async function loadUserById(userId) {
  if (!userId) return null;
  try {
    const row = await dbGet(
      `SELECT id, username, is_admin, is_active, must_change_password, created_at, last_login
         FROM users
        WHERE id=? AND deleted_at IS NULL`,
      [userId],
    );
    return sanitizeUserRow(row);
  } catch (err) {
    console.error("Failed to load user", err);
    return null;
  }
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function normalizePackageName(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed;
}

function mapPackageRow(row) {
  if (!row) {
    return null;
  }
  return {
    name: row.name || "",
    status: row.status || "unknown",
    message: row.message || null,
    updatedAt: row.updated_at || null,
  };
}

async function loadScriptPackages(scriptId) {
  if (!scriptId) return [];
  const rows = await dbAll(
    `SELECT name, status, message, updated_at FROM script_packages WHERE script_id=? ORDER BY name`,
    [scriptId],
  );
  return Array.isArray(rows)
    ? rows
      .map(mapPackageRow)
      .filter((entry) => entry && entry.name)
    : [];
}

async function replaceScriptPackages(scriptId, packageNames = []) {
  if (!scriptId) return [];

  const normalized = Array.from(
    new Set(
      (Array.isArray(packageNames) ? packageNames : [])
        .map((name) => normalizePackageName(name))
        .filter((name) => Boolean(name)),
    ),
  );

  const existingRows = await dbAll(
    `SELECT name FROM script_packages WHERE script_id=?`,
    [scriptId],
  );
  const existing = new Set(
    Array.isArray(existingRows)
      ? existingRows
        .map((row) => normalizePackageName(row?.name))
        .filter((name) => Boolean(name))
      : [],
  );

  const incoming = new Set(normalized);

  const toDelete = Array.from(existing).filter((name) => !incoming.has(name));
  if (toDelete.length) {
    const placeholders = toDelete.map(() => "?").join(",");
    await dbRun(
      `DELETE FROM script_packages WHERE script_id=? AND name IN (${placeholders})`,
      [scriptId, ...toDelete],
    );
  }

  const toInsert = normalized.filter((name) => !existing.has(name));
  for (const name of toInsert) {
    await dbRun(
      `INSERT INTO script_packages (script_id, name, status, message, updated_at)
         VALUES (?, ?, 'pending', NULL, CURRENT_TIMESTAMP)`,
      [scriptId, name],
    );
  }

  if (!normalized.length) {
    await dbRun(`DELETE FROM script_packages WHERE script_id=?`, [scriptId]);
  }

  return normalized;
}

async function applyPackageStatuses(scriptId, statuses = []) {
  if (!scriptId || !Array.isArray(statuses) || !statuses.length) {
    return;
  }

  for (const entry of statuses) {
    const name = normalizePackageName(entry?.name);
    if (!name) continue;
    const status =
      typeof entry?.status === "string" && entry.status.trim()
        ? entry.status.trim()
        : "unknown";
    const message =
      typeof entry?.message === "string" && entry.message.trim()
        ? entry.message.trim()
        : null;

    await dbRun(
      `UPDATE script_packages
          SET status=?, message=?, updated_at=CURRENT_TIMESTAMP
        WHERE script_id=? AND name=?`,
      [status, message, scriptId, name],
    );
  }
}

async function requestRunnerPackageStatus({
  runnerHostId,
  scriptId,
  packages,
  installMissing = true,
}) {
  if (!runnerHostId || !Array.isArray(packages) || !packages.length) {
    return { packages: [] };
  }

  if (!httpFetch) {
    const error = new Error(
      "HTTP fetch API is not available in this environment. Upgrade Node.js or provide a fetch polyfill."
    );
    error.code = "fetch_unavailable";
    throw error;
  }

  const host = getRunnerHostConfig(runnerHostId);
  if (!host || !host.endpoint) {
    const error = new Error("Runner host offline");
    error.code = "runner_unavailable";
    throw error;
  }

  const target = new URL("/api/packages/status", host.endpoint);
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(host.headers || {}),
  };

  let response;
  try {
    response = await httpFetch(target.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        scriptId,
        packages,
        installMissing,
      }),
    });
  } catch (err) {
    const error = new Error(
      err?.message
        ? `Failed to contact runner host: ${err.message}`
        : "Failed to contact runner host"
    );
    error.code = "runner_fetch_failed";
    error.cause = err;
    throw error;
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (err) {
    bodyText = "";
  }

  if (!response.ok) {
    const message = bodyText
      ? `Runner responded with ${response.status}: ${bodyText}`
      : `Runner responded with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  if (!bodyText) {
    return { packages: [] };
  }

  try {
    const payload = JSON.parse(bodyText);
    return payload && typeof payload === "object" ? payload : { packages: [] };
  } catch (err) {
    const error = new Error("Runner returned an invalid JSON response");
    error.cause = err;
    throw error;
  }
}

async function synchronizeScriptPackages({
  scriptId,
  language,
  code,
  runnerHostId,
  inheritCategoryRunner,
  categoryDefaultRunnerHostId,
  installMissing = true,
}) {
  if (!scriptId) {
    return { packages: [], packageCount: 0, effectiveRunnerHostId: null, checkError: null };
  }

  const normalizedLanguage =
    typeof language === "string" ? language.trim().toLowerCase() : "";
  const supportsPackages = normalizedLanguage === "node";

  if (!supportsPackages) {
    await dbRun(`DELETE FROM script_packages WHERE script_id=?`, [scriptId]);
    return { packages: [], packageCount: 0, effectiveRunnerHostId: null, checkError: null };
  }

  const dependencies = extractNodeDependencies(code || "");
  const packageNames = dependencies
    .map((dep) => (dep?.install ? dep.install.trim() : ""))
    .filter((name) => Boolean(name));

  const normalizedNames = await replaceScriptPackages(scriptId, packageNames);

  const effectiveRunnerHostId =
    runnerHostId || (inheritCategoryRunner ? categoryDefaultRunnerHostId : null) || null;

  let checkError = null;

  if (normalizedNames.length && effectiveRunnerHostId) {
    try {
      const runnerResult = await requestRunnerPackageStatus({
        runnerHostId: effectiveRunnerHostId,
        scriptId,
        packages: normalizedNames,
        installMissing,
      });
      const statuses = Array.isArray(runnerResult?.packages)
        ? runnerResult.packages
        : [];
      checkError = runnerResult?.error || null;
      if (statuses.length) {
        await applyPackageStatuses(scriptId, statuses);
      }
    } catch (err) {
      checkError = err?.message || "Failed to check packages";
      const errorStatuses = normalizedNames.map((name) => ({
        name,
        status: "error",
        message: checkError,
      }));
      await applyPackageStatuses(scriptId, errorStatuses);
    }
  } else if (normalizedNames.length && !effectiveRunnerHostId) {
    checkError = "No runner host configured for package checks";
    const pendingStatuses = normalizedNames.map((name) => ({
      name,
      status: "error",
      message: checkError,
    }));
    await applyPackageStatuses(scriptId, pendingStatuses);
  } else if (!normalizedNames.length) {
    await dbRun(`DELETE FROM script_packages WHERE script_id=?`, [scriptId]);
  }

  const packages = await loadScriptPackages(scriptId);
  return {
    packages,
    packageCount: normalizedNames.length,
    effectiveRunnerHostId,
    checkError,
  };
}

async function findScriptNameConflict(name, excludeId = null) {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const params = [trimmed];
  let sql =
    "SELECT id, name, endpoint FROM scripts WHERE is_draft = 0 AND LOWER(name) = LOWER(?)";
  if (excludeId) {
    sql += " AND id <> ?";
    params.push(excludeId);
  }
  return dbGet(sql, params);
}

async function findScriptEndpointConflict(endpoint, excludeId = null) {
  if (!endpoint) return null;
  const trimmed = String(endpoint).trim();
  if (!trimmed) return null;
  const params = [trimmed];
  let sql =
    "SELECT id, name, endpoint FROM scripts WHERE is_draft = 0 AND LOWER(endpoint) = LOWER(?)";
  if (excludeId) {
    sql += " AND id <> ?";
    params.push(excludeId);
  }
  return dbGet(sql, params);
}

function isBannedUsername(username) {
  if (!username) return false;
  return BANNED_USERNAMES.has(String(username).trim().toLowerCase());
}

function encodePreferenceValue(value) {
  return JSON.stringify({ value });
}

function decodePreferenceValue(serialized) {
  if (serialized === null || serialized === undefined) return null;
  if (serialized === "") return "";
  try {
    const parsed = JSON.parse(serialized);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "value")) {
      return parsed.value;
    }
  } catch (err) {
    // fall back to the raw value
  }
  return serialized;
}

function computeCategoryPermissions(user, categoryRow, permissionRow) {
  if (!user) return { ...EMPTY_PERMISSIONS };

  if (user.isAdmin) {
    return {
      read: true,
      write: true,
      delete: true,
      run: true,
      clearLogs: true,
      manage: true,
      isOwner: false,
    };
  }

  if (!categoryRow) {
    return { ...EMPTY_PERMISSIONS };
  }

  if (categoryRow.id === DEFAULT_CATEGORY_ID) {
    return {
      read: true,
      write: false,
      delete: false,
      run: true,
      clearLogs: false,
      manage: false,
      isOwner: false,
    };
  }

  const direct = permissionRow || {};
  const canWrite = Boolean(direct.can_write);
  const canDelete = Boolean(direct.can_delete);
  const canRun = Boolean(direct.can_run);
  const canClearLogs = Boolean(direct.can_clear_logs);
  const canRead = Boolean(direct.can_read);

  const read = Boolean(
    canRead || canWrite || canDelete || canRun || canClearLogs,
  );

  return {
    read,
    write: canWrite,
    delete: canDelete,
    run: canRun,
    clearLogs: canClearLogs,
    manage: Boolean(canWrite || canDelete),
    isOwner: false,
  };
}

function computeEffectivePermissions(options = {}) {
  const {
    user = null,
    scriptRow = null,
    scriptPermissionRow = null,
    categoryRow = null,
    categoryPermissionRow = null,
  } = options;

  if (!user) return { ...EMPTY_PERMISSIONS };

  if (user.isAdmin) {
    return {
      read: true,
      write: true,
      delete: true,
      run: true,
      clearLogs: true,
      manage: true,
      isOwner: false,
    };
  }

  const isOwner = scriptRow?.owner_id && scriptRow.owner_id === user.id;
  if (isOwner) {
    return {
      read: true,
      write: true,
      delete: true,
      run: true,
      clearLogs: true,
      manage: true,
      isOwner: true,
    };
  }

  const direct = scriptPermissionRow || {};
  let canWrite = Boolean(direct.can_write);
  let canDelete = Boolean(direct.can_delete);
  let canRun = Boolean(direct.can_run);
  let canClearLogs = Boolean(direct.can_clear_logs);
  let canRead = Boolean(direct.can_read);

  if (scriptRow?.inherit_category_permissions !== 0 && categoryRow) {
    const categoryPermissions = computeCategoryPermissions(
      user,
      categoryRow,
      categoryPermissionRow,
    );
    canWrite = canWrite || categoryPermissions.write;
    canDelete = canDelete || categoryPermissions.delete;
    canRun = canRun || categoryPermissions.run;
    canClearLogs = canClearLogs || categoryPermissions.clearLogs;
    canRead =
      canRead || categoryPermissions.read || categoryPermissions.manage;
  }

  return {
    read: Boolean(canRead || canWrite || canDelete || canRun || canClearLogs),
    write: canWrite,
    delete: canDelete,
    run: canRun,
    clearLogs: canClearLogs,
    manage: false,
    isOwner: false,
  };
}

function parseRunHeaders(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error("Failed to parse run headers", err);
    return {};
  }
}

function normalizeAcceptedMethods(value, options = {}) {
  const { fallback = DEFAULT_ACCEPTED_METHODS, ensure = [] } = options;
  const collected = [];

  if (Array.isArray(value)) {
    collected.push(...value);
  } else if (value instanceof Set) {
    collected.push(...value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          collected.push(...parsed);
        } else if (typeof parsed === "string") {
          collected.push(parsed);
        } else {
          collected.push(trimmed);
        }
      } catch (err) {
        collected.push(trimmed);
      }
    }
  } else if (value && typeof value === "object") {
    try {
      for (const entry of Object.values(value)) {
        if (typeof entry === "string") {
          collected.push(entry);
        }
      }
    } catch (err) {
      // ignore
    }
  }

  const normalized = new Set();
  for (const method of collected) {
    if (typeof method !== "string") continue;
    const upper = method.trim().toUpperCase();
    if (!upper) continue;
    if (!SUPPORTED_HTTP_METHODS.includes(upper)) continue;
    normalized.add(upper);
  }

  if (Array.isArray(ensure)) {
    for (const method of ensure) {
      if (typeof method !== "string") continue;
      const upper = method.trim().toUpperCase();
      if (!upper) continue;
      if (!SUPPORTED_HTTP_METHODS.includes(upper)) continue;
      normalized.add(upper);
    }
  }

  if (normalized.size === 0) {
    if (Array.isArray(fallback)) {
      return normalizeAcceptedMethods(fallback, { fallback: null });
    }
    if (typeof fallback === "string") {
      return normalizeAcceptedMethods([fallback], { fallback: null });
    }
    return Array.from(DEFAULT_ACCEPTED_METHODS);
  }

  return SUPPORTED_HTTP_METHODS.filter((method) => normalized.has(method));
}

function mapScriptRow(
  row,
  user = null,
  permissionRow = null,
  categoryPermissionRow = null,
) {
  if (!row) return null;
  const categoryRow = row.category_id
    ? {
      id: row.category_id,
      name: row.category_name || "",
      description: row.category_description || "",
      default_language: row.category_default_language || null,
      is_system: row.category_is_system,
    }
    : null;
  const permissions = computeEffectivePermissions({
    user,
    scriptRow: row,
    scriptPermissionRow: permissionRow,
    categoryRow,
    categoryPermissionRow,
  });
  if (permissions && (user?.isAdmin || permissions.isOwner)) {
    permissions.manage = true;
  }

  let runHeaders = {};
  if (row.run_headers) {
    runHeaders = parseRunHeaders(row.run_headers);
  }

  const acceptedMethods = normalizeAcceptedMethods(row.allowed_methods, {
    ensure: [row.run_method || "POST"],
  });

  const runnerHostId = row.runner_host_id || null;
  const scriptRunner = runnerHostId
    ? {
      id: runnerHostId,
      name: row.script_runner_name || runnerHostId,
      status: row.script_runner_status || RUNNER_STATUS.PENDING,
      statusMessage: row.script_runner_status_message || null,
      adminOnly: normalizeDbBoolean(row.script_runner_admin_only),
    }
    : null;

  const categoryDefaultRunnerHostId =
    row.category_default_runner_host_id || null;
  const categoryDefaultRunner = categoryDefaultRunnerHostId
    ? {
      id: categoryDefaultRunnerHostId,
      name: row.category_runner_name || categoryDefaultRunnerHostId,
      status: row.category_runner_status || RUNNER_STATUS.PENDING,
      statusMessage: row.category_runner_status_message || null,
      adminOnly: normalizeDbBoolean(row.category_runner_admin_only),
    }
    : null;

  const inheritCategoryRunner = row.inherit_category_runner !== 0;
  const resolvedRunner = scriptRunner || (inheritCategoryRunner ? categoryDefaultRunner : null);

  const hasRunToken = Boolean(row.run_token);
  const runTokenPreview = hasRunToken ? sanitizeScriptToken(row.run_token) : null;

  const category = categoryRow
    ? {
      id: categoryRow.id,
      name: categoryRow.name || "",
      description: categoryRow.description || "",
      defaultLanguage: categoryRow.default_language || null,
      isSystem: normalizeDbBoolean(categoryRow.is_system),
    }
    : null;
  const collection = category;

  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    language: row.language,
    timeout: row.timeout,
    code: row.code,
    createdAt: row.created_at || null,
    projectName: category?.name || row.project_name || "",
    isDraft: row.is_draft !== 0,
    isRecycled: Boolean(row.is_recycled),
    recycledAt: row.recycled_at || null,
    runMethod: row.run_method || "POST",
    acceptedMethods,
    runHeaders,
    runBody: row.run_body || "",
    ownerId: row.owner_id || null,
    ownerUsername: row.owner_username || null,
    createdByUserId: row.owner_id || null,
    createdByUsername: row.owner_username || null,
    lastVersionUserId: row.last_version_user_id || null,
    requireAuthentication: row.require_authentication !== 0,
    includeAutomnResponseData: row.expose_automn_response !== 0,
    includeRunIdInResponse: row.expose_run_id !== 0,
    permissions,
    hasApiToken: hasRunToken,
    apiTokenPreview: runTokenPreview,
    variableCount: Number(row.variable_count) || 0,
    packageCount: Number(row.package_count) || 0,
    categoryId: category?.id || null,
    category,
    collectionId: collection?.id || null,
    collection,
    categoryDefaultRunnerHostId,
    collectionDefaultRunnerHostId: categoryDefaultRunnerHostId,
    inheritCategoryPermissions: row.inherit_category_permissions !== 0,
    inheritCollectionPermissions: row.inherit_category_permissions !== 0,
    inheritCategoryRunner,
    inheritCollectionRunner: inheritCategoryRunner,
    runnerHostId,
    runner: scriptRunner,
    categoryDefaultRunner,
    collectionDefaultRunner: categoryDefaultRunner,
    resolvedRunner,
  };
}

async function loadScriptWithOwner(whereClause, params) {
  return dbGet(
    `SELECT s.*, owner.username AS owner_username, vars.variable_count,
            pkgs.package_count,
            c.name AS category_name,
            c.description AS category_description,
            c.default_language AS category_default_language,
            c.default_runner_host_id AS category_default_runner_host_id,
            c.is_system AS category_is_system,
            sr.name AS script_runner_name,
            sr.status AS script_runner_status,
            sr.status_message AS script_runner_status_message,
            sr.admin_only AS script_runner_admin_only,
            cr.name AS category_runner_name,
            cr.status AS category_runner_status,
            cr.status_message AS category_runner_status_message,
            cr.admin_only AS category_runner_admin_only
       FROM scripts s
       LEFT JOIN users owner ON owner.id = s.owner_id
       LEFT JOIN categories c ON c.id = s.category_id
       LEFT JOIN runner_hosts sr ON sr.id = s.runner_host_id
       LEFT JOIN runner_hosts cr ON cr.id = c.default_runner_host_id
       LEFT JOIN (
         SELECT script_id, COUNT(*) AS variable_count
           FROM script_variables
          GROUP BY script_id
       ) vars ON vars.script_id = s.id
       LEFT JOIN (
         SELECT script_id, COUNT(*) AS package_count
           FROM script_packages
          GROUP BY script_id
       ) pkgs ON pkgs.script_id = s.id
       WHERE ${whereClause}`,
    params,
  );
}

async function loadCategoryById(categoryId) {
  if (!categoryId) return null;
  try {
    return await dbGet(
      `SELECT id, name, description, default_language, default_runner_host_id, is_system FROM categories WHERE id=?`,
      [categoryId],
    );
  } catch (err) {
    console.error("Failed to load collection", err);
    return null;
  }
}

async function loadPermissionRow(scriptId, userId) {
  if (!scriptId || !userId) return null;
  try {
    return await dbGet(
      `SELECT can_read, can_write, can_delete, can_run, can_clear_logs FROM script_permissions WHERE script_id=? AND user_id=?`,
      [scriptId, userId],
    );
  } catch (err) {
    console.error("Failed to load script permissions", err);
    return null;
  }
}

async function loadCategoryPermissionRow(categoryId, userId) {
  if (!categoryId || !userId) return null;
  try {
    return await dbGet(
      `SELECT can_read, can_write, can_delete, can_run, can_clear_logs FROM category_permissions WHERE category_id=? AND user_id=?`,
      [categoryId, userId],
    );
  } catch (err) {
    console.error("Failed to load collection permissions", err);
    return null;
  }
}

async function ensureScriptAccess(options = {}) {
  const {
    scriptId = null,
    endpoint = null,
    user = null,
    requiredPermission = null,
    allowRecycled = false,
    allowDraft = false,
  } = options;

  const identifier = scriptId ? { where: "s.id=?", value: scriptId } : { where: "s.endpoint=?", value: endpoint };
  if (!identifier.value) {
    const err = new Error("Script not found");
    err.status = 404;
    throw err;
  }

  const scriptRow = await loadScriptWithOwner(identifier.where, [identifier.value]);
  if (!scriptRow) {
    const err = new Error("Script not found");
    err.status = 404;
    throw err;
  }

  if (!allowRecycled && scriptRow.is_recycled) {
    const err = new Error("Script not found");
    err.status = 404;
    throw err;
  }

  if (!allowDraft && scriptRow.is_draft) {
    const err = new Error("Script not found");
    err.status = 404;
    throw err;
  }

  const permissionRow = await loadPermissionRow(scriptRow.id, user?.id);
  let categoryRow = null;
  let categoryPermissionRow = null;
  const scriptCategoryId = scriptRow.category_id || DEFAULT_CATEGORY_ID;
  if (scriptCategoryId) {
    categoryRow = await loadCategoryById(scriptCategoryId);
    categoryPermissionRow = await loadCategoryPermissionRow(
      categoryRow?.id,
      user?.id,
    );
  }
  const permissions = computeEffectivePermissions({
    user,
    scriptRow,
    scriptPermissionRow: permissionRow,
    categoryRow,
    categoryPermissionRow,
  });
  if (user?.isAdmin || permissions.isOwner) {
    permissions.manage = true;
  }

  if (requiredPermission && user) {
    if (!permissions[requiredPermission]) {
      const err = new Error("You do not have permission to perform this action");
      err.status = 403;
      throw err;
    }
  }

  return { script: scriptRow, permissions, permissionRow };
}

async function ensureCategoryAccess(options = {}) {
  const {
    categoryId = null,
    collectionId = null,
    user = null,
    requiredPermission = null,
  } = options;
  const effectiveCategoryId =
    categoryId || collectionId || DEFAULT_COLLECTION_ID;
  const category = await loadCategoryById(effectiveCategoryId);
  if (!category) {
    const err = new Error("Collection not found");
    err.status = 404;
    throw err;
  }

  const permissionRow = await loadCategoryPermissionRow(category.id, user?.id);
  const permissions = computeCategoryPermissions(user, category, permissionRow);
  const isDefaultCategory = category.id === DEFAULT_CATEGORY_ID;

  if (isDefaultCategory) {
    permissions.read = true;
    permissions.run = true;
  }

  if (requiredPermission && user) {
    if (
      isDefaultCategory &&
      (requiredPermission === "write" || requiredPermission === "read")
    ) {
      // Allow baseline read/write access to the General collection for all users so
      // they can assign scripts to it without granting broader management rights.
    } else if (!permissions[requiredPermission]) {
      const err = new Error("You do not have permission to access this collection");
      err.status = 403;
      throw err;
    }
  }

  return { category, permissions, permissionRow };
}

async function authenticateRequest(req) {
  try {
    const cookies = parseCookies(req.headers?.cookie || "");
    const token = cookies[COOKIE_NAME];
    if (!token) return null;

    const session = await dbGet(
      `SELECT s.id as session_id, s.expires_at, s.user_id, u.username, u.is_admin, u.is_active, u.must_change_password
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
       WHERE s.token=?`,
      [token],
    );

    if (!session) {
      return null;
    }

    if (!session.expires_at || new Date(session.expires_at).getTime() <= Date.now()) {
      await dbRun("DELETE FROM sessions WHERE id=?", [session.session_id]).catch(() => { });
      return null;
    }

    if (!session.is_active) {
      await dbRun("DELETE FROM sessions WHERE id=?", [session.session_id]).catch(() => { });
      return null;
    }

    await dbRun("UPDATE sessions SET last_seen=? WHERE id=?", [new Date().toISOString(), session.session_id]).catch(() => { });

    return {
      sessionId: session.session_id,
      token,
      user: {
        id: session.user_id,
        username: session.username,
        isAdmin: normalizeDbBoolean(session.is_admin),
        isActive: normalizeDbBoolean(session.is_active),
        mustChangePassword: normalizeDbBoolean(session.must_change_password),
      },
    };
  } catch (err) {
    console.error("Failed to authenticate request", err);
    return null;
  }
}

function ensureAuth(options = {}) {
  const { allowPendingPasswordChange = false, requireAdmin = false } = options;
  return async (req, res, next) => {
    const auth = await authenticateRequest(req);
    if (!auth) {
      res.clearCookie(COOKIE_NAME, cookieOptions);
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!allowPendingPasswordChange && auth.user.mustChangePassword) {
      res.status(403).json({
        error: "Password change required",
        code: "password_change_required",
      });
      return;
    }

    if (requireAdmin && !auth.user.isAdmin) {
      res.status(403).json({ error: "Administrator permissions required" });
      return;
    }

    req.user = auth.user;
    req.sessionId = auth.sessionId;
    req.sessionToken = auth.token;
    next();
  };
}

function validatePassword(password) {
  return typeof password === "string" && password.length >= PASSWORD_MIN_LENGTH;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function restoreDatabaseFromFile(filePath) {
  let transactionActive = false;
  let attached = false;
  try {
    await dbRun("BEGIN IMMEDIATE TRANSACTION");
    transactionActive = true;

    await dbRun("ATTACH DATABASE ? AS restore_src", [filePath]);
    attached = true;

    const currentTables = await dbAll(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    const backupTables = await dbAll(
      "SELECT name FROM restore_src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );

    const allowed = new Set(currentTables.map((row) => row.name));
    const skipTables = new Set(["sessions"]);

    for (const table of backupTables) {
      const name = table?.name;
      if (!name || !allowed.has(name) || skipTables.has(name)) continue;
      const quoted = quoteIdentifier(name);
      await dbRun(`DELETE FROM ${quoted}`);
      await dbRun(`INSERT INTO ${quoted} SELECT * FROM restore_src.${quoted}`);
    }

    await dbRun("DELETE FROM sessions");

    await dbRun("COMMIT");
    transactionActive = false;

    await dbRun("DETACH DATABASE restore_src");
    attached = false;
  } catch (err) {
    if (transactionActive) {
      await dbRun("ROLLBACK").catch(() => { });
      transactionActive = false;
    }

    if (attached) {
      await dbRun("DETACH DATABASE restore_src").catch(() => { });
      attached = false;
    }
    throw err;
  }

  await db.ensureAdminAccount();
}

const requireAuthenticated = ensureAuth();
const requireAdmin = ensureAuth({ requireAdmin: true });

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const normalizedUsername =
    typeof username === "string" ? username.trim() : "";

  if (!normalizedUsername || typeof password !== "string") {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  try {
    const userRow = await dbGet(
      `SELECT id, username, password_hash, must_change_password, is_active, is_admin, created_at, last_login
         FROM users WHERE username=? AND deleted_at IS NULL`,
      [normalizedUsername],
    );

    if (!userRow || !userRow.password_hash) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    if (!userRow.is_active) {
      res.status(403).json({ error: "Account is disabled" });
      return;
    }

    const passwordValid = verifyPassword(password, userRow.password_hash);
    if (!passwordValid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const sessionToken = crypto.randomBytes(48).toString("base64url");
    const sessionId = uuidv4();
    const now = new Date();
    const isoNow = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

    await dbRun(
      `INSERT INTO sessions (id, user_id, token, created_at, expires_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, userRow.id, sessionToken, isoNow, expiresAt, isoNow],
    );

    await dbRun(`UPDATE users SET last_login=? WHERE id=?`, [isoNow, userRow.id]).catch(
      () => { },
    );

    res.cookie(COOKIE_NAME, sessionToken, {
      ...cookieOptions,
      maxAge: SESSION_TTL_MS,
    });

    res.json({ user: sanitizeUserRow(userRow) });
  } catch (err) {
    console.error("Login failed", err);
    res.status(500).json({ error: "Failed to login" });
  }
});

app.post(
  "/api/auth/logout",
  ensureAuth({ allowPendingPasswordChange: true }),
  async (req, res) => {
    try {
      if (req.sessionId) {
        await dbRun("DELETE FROM sessions WHERE id=?", [req.sessionId]);
      }
      res.clearCookie(COOKIE_NAME, cookieOptions);
      res.json({ success: true });
    } catch (err) {
      console.error("Logout failed", err);
      res.status(500).json({ error: "Failed to logout" });
    }
  },
);

app.get(
  "/api/auth/me",
  ensureAuth({ allowPendingPasswordChange: true }),
  async (req, res) => {
    const user = await loadUserById(req.user.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({
      user,
      hostVersion: HOST_VERSION,
    });
  },
);

app.post(
  "/api/auth/change-password",
  ensureAuth({ allowPendingPasswordChange: true }),
  async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (typeof currentPassword !== "string" || currentPassword.length === 0) {
      res.status(400).json({ error: "Current password is required" });
      return;
    }

    if (!validatePassword(newPassword)) {
      res.status(400).json({
        error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
      });
      return;
    }

    try {
      const row = await dbGet(
        "SELECT password_hash FROM users WHERE id=? AND deleted_at IS NULL",
        [req.user.id],
      );

      if (!row || !row.password_hash) {
        res.status(400).json({ error: "Account password is not set" });
        return;
      }

      if (!verifyPassword(currentPassword, row.password_hash)) {
        res.status(400).json({ error: "Current password is incorrect" });
        return;
      }

      if (newPassword === currentPassword) {
        res.status(400).json({
          error: "New password must be different from the current password",
        });
        return;
      }

      if (newPassword === DEFAULT_ADMIN_PASSWORD) {
        res.status(400).json({
          error: "New password cannot match the default administrator password",
        });
        return;
      }

      const hashed = hashPassword(newPassword);
      await dbRun(
        "UPDATE users SET password_hash=?, must_change_password=0 WHERE id=? AND deleted_at IS NULL",
        [hashed, req.user.id],
      );

      if (req.sessionId) {
        await dbRun("DELETE FROM sessions WHERE user_id=? AND id<>?", [
          req.user.id,
          req.sessionId,
        ]).catch(() => { });
      } else {
        await dbRun("DELETE FROM sessions WHERE user_id=?", [req.user.id]).catch(
          () => { },
        );
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Password change failed", err);
      res.status(500).json({ error: "Failed to change password" });
    }
  },
);

app.get("/api/preferences", requireAuthenticated, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT key, value FROM user_preferences WHERE user_id=?`,
      [req.user.id],
    );
    const preferences = {};
    for (const row of rows) {
      preferences[row.key] = decodePreferenceValue(row.value);
    }
    res.json({ preferences });
  } catch (err) {
    console.error("Failed to load preferences", err);
    res.status(500).json({ error: "Failed to load preferences" });
  }
});

app.post("/api/preferences", requireAuthenticated, async (req, res) => {
  const { key, value, preferences } = req.body || {};
  const entries = [];

  if (preferences && typeof preferences === "object" && !Array.isArray(preferences)) {
    for (const [entryKey, entryValue] of Object.entries(preferences)) {
      if (typeof entryKey === "string" && entryKey.trim()) {
        entries.push([entryKey.trim(), entryValue]);
      }
    }
  } else if (typeof key === "string" && key.trim()) {
    entries.push([key.trim(), value]);
  } else {
    res.status(400).json({ error: "Preference key is required" });
    return;
  }

  if (!entries.length) {
    res.status(400).json({ error: "No preferences to update" });
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    for (const [entryKey, entryValue] of entries) {
      const serialized = encodePreferenceValue(entryValue);
      await dbRun(
        `INSERT INTO user_preferences (user_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [req.user.id, entryKey, serialized, timestamp],
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to save preferences", err);
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, username, is_admin, is_active, must_change_password, created_at, last_login
         FROM users
        WHERE deleted_at IS NULL
        ORDER BY username COLLATE NOCASE ASC`,
    );
    res.json({ users: rows.map(sanitizeUserRow).filter(Boolean) });
  } catch (err) {
    console.error("Failed to load users", err);
    res.status(500).json({ error: "Failed to load users" });
  }
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const {
    username,
    password,
    isAdmin: isAdminInput = false,
    requirePasswordChange = true,
  } = req.body || {};

  const normalizedUsername =
    typeof username === "string" ? username.trim() : "";

  if (!normalizedUsername) {
    res.status(400).json({ error: "Username is required" });
    return;
  }

  if (isBannedUsername(normalizedUsername)) {
    res.status(400).json({ error: "This username is reserved" });
    return;
  }

  if (!validatePassword(password)) {
    res.status(400).json({
      error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
    });
    return;
  }

  try {
    const existing = await dbGet(
      "SELECT id, deleted_at FROM users WHERE username=?",
      [normalizedUsername],
    );

    const hashed = hashPassword(password);
    const mustChange = requirePasswordChange === false ? 0 : 1;
    const isAdminValue = isAdminInput ? 1 : 0;

    if (existing) {
      if (existing.deleted_at) {
        await dbRun(
          `UPDATE users
              SET password_hash=?,
                  must_change_password=?,
                  is_active=1,
                  is_admin=?,
                  deleted_at=NULL,
                  last_login=NULL
            WHERE id=?`,
          [hashed, mustChange, isAdminValue, existing.id],
        );

        await dbRun("DELETE FROM sessions WHERE user_id=?", [existing.id]);
        await dbRun("DELETE FROM user_preferences WHERE user_id=?", [existing.id]);
        await dbRun("DELETE FROM script_permissions WHERE user_id=?", [existing.id]);

        const user = await loadUserById(existing.id);
        res.status(200).json({ user, restored: true });
        return;
      }

      res.status(409).json({ error: "Username already exists" });
      return;
    }

    const userId = uuidv4();

    await dbRun(
      `INSERT INTO users (id, username, password_hash, must_change_password, is_active, is_admin)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [userId, normalizedUsername, hashed, mustChange, isAdminValue],
    );

    const user = await loadUserById(userId);
    res.status(201).json({ user });
  } catch (err) {
    console.error("Failed to create user", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

app.patch("/api/users/:id", requireAdmin, async (req, res) => {
  const targetId = req.params.id;
  const {
    username,
    isActive,
    isAdmin: isAdminInput,
    mustChangePassword,
    newPassword,
    requirePasswordChange,
  } = req.body || {};

  try {
    const existing = await dbGet(
      `SELECT id, username, is_admin, is_active, must_change_password
         FROM users
        WHERE id=? AND deleted_at IS NULL`,
      [targetId],
    );

    if (!existing) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updates = [];
    const params = [];
    let mustChangeValue = null;
    let shouldClearSessions = false;

    if (typeof username === "string") {
      const normalizedUsername = normalizeUsername(username);
      if (!normalizedUsername) {
        res.status(400).json({ error: "Username is required" });
        return;
      }

      if (isBannedUsername(normalizedUsername)) {
        res.status(400).json({ error: "This username is reserved" });
        return;
      }

      if (normalizedUsername !== existing.username) {
        const conflict = await dbGet(
          `SELECT id FROM users WHERE username=? AND id<>? AND deleted_at IS NULL`,
          [normalizedUsername, targetId],
        );
        if (conflict) {
          res.status(409).json({ error: "Username already exists" });
          return;
        }

        updates.push("username=?");
        params.push(normalizedUsername);
      }
    }

    if (
      typeof isActive === "boolean" &&
      isActive !== normalizeDbBoolean(existing.is_active)
    ) {
      if (!isActive && existing.id === req.user.id) {
        res.status(400).json({ error: "You cannot disable your own account" });
        return;
      }

      if (!isActive) {
        const countRow = await dbGet(
          "SELECT COUNT(*) AS count FROM users WHERE id<>? AND is_active=1 AND deleted_at IS NULL",
          [targetId],
        );
        const activeCount = Number(countRow?.count ?? 0);
        if (!Number.isFinite(activeCount) || activeCount <= 0) {
          res
            .status(400)
            .json({ error: "Cannot disable the only active account" });
          return;
        }
        shouldClearSessions = true;
      }

      updates.push("is_active=?");
      params.push(isActive ? 1 : 0);
    }

    if (
      typeof isAdminInput === "boolean" &&
      isAdminInput !== normalizeDbBoolean(existing.is_admin)
    ) {
      if (!isAdminInput) {
        const countRow = await dbGet(
          "SELECT COUNT(*) AS count FROM users WHERE id<>? AND is_admin=1 AND deleted_at IS NULL",
          [targetId],
        );
        const adminCount = Number(countRow?.count ?? 0);
        if (!Number.isFinite(adminCount) || adminCount <= 0) {
          res.status(400).json({ error: "Cannot remove the only administrator" });
          return;
        }
      }

      updates.push("is_admin=?");
      params.push(isAdminInput ? 1 : 0);
    }

    if (
      typeof mustChangePassword === "boolean" &&
      mustChangePassword !== normalizeDbBoolean(existing.must_change_password)
    ) {
      mustChangeValue = mustChangePassword ? 1 : 0;
    }

    if (typeof newPassword === "string" && newPassword.length > 0) {
      if (!validatePassword(newPassword)) {
        res.status(400).json({
          error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
        });
        return;
      }

      const hashed = hashPassword(newPassword);
      updates.push("password_hash=?");
      params.push(hashed);
      mustChangeValue = requirePasswordChange === false ? 0 : 1;
      shouldClearSessions = true;
    }

    if (mustChangeValue !== null) {
      updates.push("must_change_password=?");
      params.push(mustChangeValue);
    }

    if (!updates.length) {
      const user = await loadUserById(targetId);
      res.json({ user });
      return;
    }

    params.push(targetId);
    await dbRun(`UPDATE users SET ${updates.join(", ")} WHERE id=?`, params);

    if (shouldClearSessions) {
      await dbRun("DELETE FROM sessions WHERE user_id=?", [targetId]).catch(
        () => { },
      );
    }

    const user = await loadUserById(targetId);
    res.json({ user });
  } catch (err) {
    console.error("Failed to update user", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  const targetId = req.params.id;

  try {
    const existing = await dbGet(
      `SELECT id, username, is_admin, is_active FROM users WHERE id=? AND deleted_at IS NULL`,
      [targetId],
    );

    if (!existing) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (existing.id === req.user.id) {
      res.status(400).json({ error: "You cannot delete your own account" });
      return;
    }

    if (existing.is_admin) {
      const countRow = await dbGet(
        "SELECT COUNT(*) AS count FROM users WHERE id<>? AND is_admin=1 AND deleted_at IS NULL",
        [targetId],
      );
      const adminCount = Number(countRow?.count ?? 0);
      if (!Number.isFinite(adminCount) || adminCount <= 0) {
        res.status(400).json({ error: "Cannot remove the only administrator" });
        return;
      }
    }

    if (existing.is_active) {
      const countRow = await dbGet(
        "SELECT COUNT(*) AS count FROM users WHERE id<>? AND is_active=1 AND deleted_at IS NULL",
        [targetId],
      );
      const activeCount = Number(countRow?.count ?? 0);
      if (!Number.isFinite(activeCount) || activeCount <= 0) {
        res
          .status(400)
          .json({ error: "Cannot delete the only active account" });
        return;
      }
    }

    let transactionActive = false;
    try {
      await dbRun("BEGIN IMMEDIATE TRANSACTION");
      transactionActive = true;

      const deletedAt = new Date().toISOString();

      await dbRun("UPDATE scripts SET owner_id=NULL WHERE owner_id=?", [targetId]);
      await dbRun("DELETE FROM script_permissions WHERE user_id=?", [targetId]);
      await dbRun("DELETE FROM sessions WHERE user_id=?", [targetId]);
      await dbRun("DELETE FROM user_preferences WHERE user_id=?", [targetId]);
      await dbRun(
        `UPDATE users
            SET is_active=0,
                is_admin=0,
                must_change_password=0,
                password_hash=NULL,
                last_login=NULL,
                deleted_at=?
          WHERE id=?`,
        [deletedAt, targetId],
      );

      await dbRun("COMMIT");
      transactionActive = false;
    } catch (err) {
      if (transactionActive) {
        await dbRun("ROLLBACK").catch(() => { });
      }
      throw err;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete user", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

app.get("/api/settings/runner-hosts", requireAdmin, async (req, res) => {
  try {
    const hosts = await db.listRunnerHosts();
    const normalized = hosts.map((host) => sanitizeRunnerHost(host)).filter(Boolean);
    res.json({ runnerHosts: normalized, heartbeatWindowMs: RUNNER_HEALTH_WINDOW_MS });
  } catch (err) {
    console.error("Failed to list runner hosts", err);
    res.status(500).json({ error: "Failed to load runner hosts" });
  }
});

app.patch("/api/settings/runner-hosts/:id", requireAdmin, async (req, res) => {
  const hostId = typeof req.params.id === "string" ? req.params.id.trim() : "";
  if (!hostId) {
    res.status(400).json({ error: "Runner host id is required" });
    return;
  }

  const body = req.body || {};
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasAdminOnly = Object.prototype.hasOwnProperty.call(body, "adminOnly");

  if (!hasName && !hasAdminOnly) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }

  const updates = {};

  if (hasName) {
    const normalizedName = typeof body.name === "string" ? body.name.trim() : "";
    if (!normalizedName) {
      res.status(400).json({ error: "Runner name is required" });
      return;
    }
    updates.name = normalizedName;
  }

  if (hasAdminOnly) {
    updates.adminOnly = Boolean(body.adminOnly);
  }

  let existing;
  try {
    existing = await db.getRunnerHostById(hostId, { includeSecret: true });
  } catch (err) {
    console.error("Failed to load runner host", err);
    res.status(500).json({ error: "Failed to update runner host" });
    return;
  }

  if (!existing) {
    res.status(404).json({ error: "Runner host not found" });
    return;
  }

  if (!Object.keys(updates).length) {
    res.json({ runnerHost: sanitizeRunnerHost(existing) });
    return;
  }

  try {
    const updated = await db.updateRunnerHostStatus(hostId, updates);
    res.json({ runnerHost: sanitizeRunnerHost(updated) });
  } catch (err) {
    if (err?.code === "SQLITE_CONSTRAINT") {
      res.status(409).json({ error: "Runner name already exists" });
      return;
    }
    console.error("Failed to update runner host", err);
    res.status(500).json({ error: "Failed to update runner host" });
  }
});

app.post("/api/settings/runner-hosts", requireAdmin, async (req, res) => {
  const { id, name, secret, adminOnly: adminOnlyInput } = req.body || {};
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName) {
    res.status(400).json({ error: "Runner name is required" });
    return;
  }

  const normalizedId = typeof id === "string" ? id.trim() : "";

  let plainSecret = typeof secret === "string" ? secret.trim() : "";
  if (plainSecret && plainSecret.length < MIN_RUNNER_SECRET_LENGTH) {
    res.status(400).json({
      error: `Secret must be at least ${MIN_RUNNER_SECRET_LENGTH} characters long`,
    });
    return;
  }

  if (!plainSecret) {
    plainSecret = generateRunnerSecret();
  }

  let secretHash;
  try {
    secretHash = hashPassword(plainSecret);
  } catch (err) {
    console.error("Failed to hash runner secret", err);
    res.status(500).json({ error: "Failed to prepare runner secret" });
    return;
  }

  try {
    const created = await db.createRunnerHost({
      id: normalizedId || undefined,
      name: normalizedName,
      secretHash,
      status: RUNNER_STATUS.PENDING,
      adminOnly: normalizeDbBoolean(adminOnlyInput),
    });
    const sanitized = sanitizeRunnerHost(created);
    res.status(201).json({ runnerHost: sanitized, secret: plainSecret });
  } catch (err) {
    if (err?.code === "SQLITE_CONSTRAINT") {
      res.status(409).json({ error: "Runner name or id already exists" });
      return;
    }
    console.error("Failed to create runner host", err);
    res.status(500).json({ error: "Failed to create runner host" });
  }
});

app.post(
  "/api/settings/runner-hosts/:id/rotate-secret",
  requireAdmin,
  async (req, res) => {
    const hostId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!hostId) {
      res.status(400).json({ error: "Runner host id is required" });
      return;
    }

    let existing;
    try {
      existing = await db.getRunnerHostById(hostId, { includeSecret: true });
    } catch (err) {
      console.error("Failed to load runner host", err);
      res.status(500).json({ error: "Failed to rotate runner secret" });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: "Runner host not found" });
      return;
    }

    let plainSecret =
      typeof req.body?.secret === "string" ? req.body.secret.trim() : "";
    if (plainSecret && plainSecret.length < MIN_RUNNER_SECRET_LENGTH) {
      res.status(400).json({
        error: `Secret must be at least ${MIN_RUNNER_SECRET_LENGTH} characters long`,
      });
      return;
    }

    if (!plainSecret) {
      plainSecret = generateRunnerSecret();
    }

    let secretHash;
    try {
      secretHash = hashPassword(plainSecret);
    } catch (err) {
      console.error("Failed to hash runner secret", err);
      res.status(500).json({ error: "Failed to rotate runner secret" });
      return;
    }

    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim()
        : "Runner secret rotated by administrator";

    const isDisabled =
      existing.disabledAt || existing.status === RUNNER_STATUS.DISABLED;

    try {
      const updated = await db.updateRunnerHostStatus(hostId, {
        secretHash,
        status: isDisabled ? RUNNER_STATUS.DISABLED : RUNNER_STATUS.PENDING,
        statusMessage: reason,
        endpoint: null,
        lastSeenAt: null,
        maxConcurrency: null,
        timeoutMs: null,
      });

      unregisterRunnerHost(hostId);

      res.json({
        runnerHost: sanitizeRunnerHost(updated),
        secret: plainSecret,
      });
    } catch (err) {
      console.error("Failed to rotate runner secret", err);
      res.status(500).json({ error: "Failed to rotate runner secret" });
    }
  },
);

app.get("/api/runners", requireAuthenticated, async (req, res) => {
  try {
    const hosts = await db.listRunnerHosts();
    let normalized = hosts.map((host) => sanitizeRunnerHost(host)).filter(Boolean);
    if (!req.user?.isAdmin) {
      normalized = normalized.filter((host) => !host.adminOnly);
    }
    res.json({ runnerHosts: normalized });
  } catch (err) {
    console.error("Failed to list runner hosts", err);
    res.status(500).json({ error: "Failed to load runner hosts" });
  }
});

app.post(
  "/api/settings/runner-hosts/:id/disable",
  requireAdmin,
  async (req, res) => {
    const hostId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim()
        : "Disabled by administrator";

    if (!hostId) {
      res.status(400).json({ error: "Runner host id is required" });
      return;
    }

    try {
      const disabled = await db.disableRunnerHost(hostId, { statusMessage: reason });
      if (!disabled) {
        res.status(404).json({ error: "Runner host not found" });
        return;
      }

      unregisterRunnerHost(hostId);
      res.json({ runnerHost: sanitizeRunnerHost(disabled) });
    } catch (err) {
      console.error("Failed to disable runner host", err);
      res.status(500).json({ error: "Failed to disable runner host" });
    }
  },
);

app.post(
  "/api/settings/runner-hosts/:id/disconnect",
  requireAdmin,
  async (req, res) => {
    const hostId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!hostId) {
      res.status(400).json({ error: "Runner host id is required" });
      return;
    }

    let existing;
    try {
      existing = await db.getRunnerHostById(hostId, { includeSecret: true });
    } catch (err) {
      console.error("Failed to load runner host", err);
      res.status(500).json({ error: "Failed to disconnect runner host" });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: "Runner host not found" });
      return;
    }

    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim()
        : "Runner disconnected by administrator";

    const placeholderSecret = generateRunnerSecret();
    let secretHash;
    try {
      secretHash = hashPassword(placeholderSecret);
    } catch (err) {
      console.error("Failed to hash runner secret", err);
      res.status(500).json({ error: "Failed to disconnect runner host" });
      return;
    }

    const isDisabled =
      existing.disabledAt || existing.status === RUNNER_STATUS.DISABLED;

    try {
      const updated = await db.updateRunnerHostStatus(hostId, {
        secretHash,
        status: isDisabled ? RUNNER_STATUS.DISABLED : RUNNER_STATUS.PENDING,
        statusMessage: reason,
        endpoint: null,
        lastSeenAt: null,
        maxConcurrency: null,
        timeoutMs: null,
      });

      unregisterRunnerHost(hostId);

      res.json({
        runnerHost: sanitizeRunnerHost(updated),
        disconnected: true,
      });
    } catch (err) {
      console.error("Failed to disconnect runner host", err);
      res.status(500).json({ error: "Failed to disconnect runner host" });
    }
  },
);

app.post(
  "/api/settings/runner-hosts/:id/enable",
  requireAdmin,
  async (req, res) => {
    const hostId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim()
        : "Re-enabled by administrator";

    if (!hostId) {
      res.status(400).json({ error: "Runner host id is required" });
      return;
    }

    let existing;
    try {
      existing = await db.getRunnerHostById(hostId, { includeSecret: true });
    } catch (err) {
      console.error("Failed to load runner host", err);
      res.status(500).json({ error: "Failed to enable runner host" });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: "Runner host not found" });
      return;
    }

    if (!existing.disabledAt && existing.status !== RUNNER_STATUS.DISABLED) {
      res.status(400).json({ error: "Runner host is not disabled" });
      return;
    }

    try {
      const enabled = await db.updateRunnerHostStatus(hostId, {
        status: RUNNER_STATUS.PENDING,
        statusMessage: reason,
        clearDisabledAt: true,
      });
      res.json({ runnerHost: sanitizeRunnerHost(enabled) });
    } catch (err) {
      console.error("Failed to enable runner host", err);
      res.status(500).json({ error: "Failed to enable runner host" });
    }
  },
);

app.delete("/api/settings/runner-hosts/:id", requireAdmin, async (req, res) => {
  const hostId = typeof req.params.id === "string" ? req.params.id.trim() : "";

  if (!hostId) {
    res.status(400).json({ error: "Runner host id is required" });
    return;
  }

  let existing;
  try {
    existing = await db.getRunnerHostById(hostId);
  } catch (err) {
    console.error("Failed to load runner host", err);
    res.status(500).json({ error: "Failed to delete runner host" });
    return;
  }

  if (!existing) {
    res.status(404).json({ error: "Runner host not found" });
    return;
  }

  try {
    await db.deleteRunnerHost(hostId);
  } catch (err) {
    console.error("Failed to delete runner host", err);
    res.status(500).json({ error: "Failed to delete runner host" });
    return;
  }

  unregisterRunnerHost(hostId);
  res.json({ runnerHost: sanitizeRunnerHost(existing), deleted: true });
});

app.get("/api/settings/global-variables", requireAdmin, async (req, res) => {
  try {
    const variables = await loadGlobalVariablesForApi();
    res.json({
      variables,
      prefix: GLOBAL_VARIABLE_ENV_PREFIX,
      count: variables.length,
    });
  } catch (err) {
    console.error("Failed to load global variables", err);
    res.status(500).json({ error: "Failed to load global variables" });
  }
});

app.post("/api/settings/global-variables", requireAdmin, async (req, res) => {
  const body = req.body || {};
  try {
    const normalizedName = normalizeVariableName(body.name || "");
    if (!normalizedName) {
      res.status(400).json({ error: "Variable name is required" });
      return;
    }

    const envName = computeVariableEnvName(
      normalizedName,
      GLOBAL_VARIABLE_ENV_PREFIX,
    );
    const isSecure = body.isSecure ? 1 : 0;
    const valueProvided = Object.prototype.hasOwnProperty.call(body, "value");
    const rawValue = valueProvided ? body.value : "";
    const stringValue =
      rawValue === null || rawValue === undefined
        ? ""
        : typeof rawValue === "string"
          ? rawValue
          : String(rawValue);
    const storedValue = isSecure ? encryptVariableValue(stringValue) : stringValue;
    const now = new Date().toISOString();
    const id = uuidv4();

    try {
      await dbRun(
        `INSERT INTO global_variables (id, name, env_name, value, is_secure, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, normalizedName, envName, storedValue, isSecure, now, now],
      );
    } catch (err) {
      if (err?.message && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "A variable with this name already exists" });
        return;
      }
      throw err;
    }

    const row = await loadGlobalVariableById(id);
    const count = await countGlobalVariables();
    res.status(201).json({
      variable: sanitizeVariableApiRow(row, {
        envPrefix: GLOBAL_VARIABLE_ENV_PREFIX,
        scope: "global",
      }),
      count,
    });
  } catch (err) {
    console.error("Failed to create global variable", err);
    res.status(500).json({ error: "Failed to create global variable" });
  }
});

app.put(
  "/api/settings/global-variables/:variableId",
  requireAdmin,
  async (req, res) => {
    const body = req.body || {};
    const variableId = req.params.variableId;

    try {
      const existing = await loadGlobalVariableById(variableId);
      if (!existing) {
        res.status(404).json({ error: "Variable not found" });
        return;
      }

      const hasName = Object.prototype.hasOwnProperty.call(body, "name");
      const nextNameRaw = hasName ? body.name : existing.name;
      const normalizedName = normalizeVariableName(nextNameRaw || "");
      if (!normalizedName) {
        res.status(400).json({ error: "Variable name is required" });
        return;
      }

      const hasSecureFlag = Object.prototype.hasOwnProperty.call(body, "isSecure");
      const nextIsSecure = hasSecureFlag
        ? Boolean(body.isSecure)
        : existing.is_secure !== 0;

      const valueProvided = Object.prototype.hasOwnProperty.call(body, "value");
      let storedValue = existing.value || "";

      if (valueProvided) {
        const rawValue = body.value;
        const stringValue =
          rawValue === null || rawValue === undefined
            ? ""
            : typeof rawValue === "string"
              ? rawValue
              : String(rawValue);
        storedValue = nextIsSecure
          ? encryptVariableValue(stringValue)
          : stringValue;
      } else if (existing.is_secure !== 0 && !nextIsSecure) {
        try {
          storedValue = decryptVariableValue(existing.value || "");
        } catch (err) {
          console.error("Failed to decrypt global variable for conversion", err);
          storedValue = "";
        }
      } else if (existing.is_secure === 0 && nextIsSecure) {
        storedValue = encryptVariableValue(existing.value || "");
      }

      const envName = computeVariableEnvName(
        normalizedName,
        GLOBAL_VARIABLE_ENV_PREFIX,
      );

      try {
        await dbRun(
          `UPDATE global_variables
              SET name=?, env_name=?, value=?, is_secure=?, updated_at=?
            WHERE id=?`,
          [
            normalizedName,
            envName,
            storedValue,
            nextIsSecure ? 1 : 0,
            new Date().toISOString(),
            existing.id,
          ],
        );
      } catch (err) {
        if (err?.message && err.message.includes("UNIQUE")) {
          res.status(409).json({ error: "A variable with this name already exists" });
          return;
        }
        throw err;
      }

      const updated = await loadGlobalVariableById(existing.id);
      const count = await countGlobalVariables();
      res.json({
        variable: sanitizeVariableApiRow(updated, {
          envPrefix: GLOBAL_VARIABLE_ENV_PREFIX,
          scope: "global",
        }),
        count,
      });
    } catch (err) {
      console.error("Failed to update global variable", err);
      res.status(500).json({ error: "Failed to update global variable" });
    }
  },
);

app.delete(
  "/api/settings/global-variables/:variableId",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await dbRun("DELETE FROM global_variables WHERE id=?", [
        req.params.variableId,
      ]);

      if (!result?.changes) {
        res.status(404).json({ error: "Variable not found" });
        return;
      }

      const count = await countGlobalVariables();
      res.json({ deleted: true, count });
    } catch (err) {
      console.error("Failed to delete global variable", err);
      res.status(500).json({ error: "Failed to delete global variable" });
    }
  },
);

app.post("/api/settings/runner-hosts/:id/register", async (req, res) => {
  const hostId = typeof req.params.id === "string" ? req.params.id.trim() : "";
  if (!hostId) {
    res.status(400).json({ error: "Runner host id is required" });
    return;
  }

  const secretInput = typeof req.body?.secret === "string" ? req.body.secret.trim() : "";
  if (!secretInput) {
    res.status(400).json({ error: "Runner secret is required" });
    return;
  }

  const endpointInput =
    typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
  if (!endpointInput) {
    res.status(400).json({ error: "Runner endpoint is required" });
    return;
  }

  let normalizedEndpoint;
  try {
    const parsed = new URL(endpointInput);
    if (!parsed.protocol || !parsed.host) {
      throw new Error("Invalid runner endpoint");
    }
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("Invalid protocol");
    }
    normalizedEndpoint = parsed.toString();
  } catch (err) {
    res.status(400).json({ error: "Runner endpoint must be a valid http(s) URL" });
    return;
  }

  let existing;
  try {
    existing = await db.getRunnerHostById(hostId, { includeSecret: true });
  } catch (err) {
    console.error("Failed to load runner host", err);
    res.status(500).json({ error: "Failed to register runner host" });
    return;
  }

  if (!existing) {
    res.status(404).json({ error: "Runner host not found" });
    return;
  }

  if (existing.disabledAt || existing.status === RUNNER_STATUS.DISABLED) {
    res.status(403).json({ error: "Runner host is disabled", code: "runner_disabled" });
    return;
  }

  if (!existing.secretHash || !verifyPassword(secretInput, existing.secretHash)) {
    res.status(401).json({ error: "Invalid runner secret", code: "invalid_secret" });
    return;
  }

  const clientIp = extractClientIp(req);
  const message =
    typeof req.body?.statusMessage === "string" && req.body.statusMessage.trim()
      ? req.body.statusMessage.trim()
      : clientIp
        ? `Heartbeat from ${clientIp}`
        : "Runner heartbeat received";

  const parsedConcurrency = Number.parseInt(req.body?.maxConcurrency, 10);
  const parsedTimeout = Number.parseInt(req.body?.timeoutMs, 10);
  const normalizedConcurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
      ? parsedConcurrency
      : null;
  const normalizedTimeout =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : null;
  const normalizedRunnerVersion = normalizeVersionString(req.body?.version);
  const normalizedMinimumHostVersion = normalizeVersionString(req.body?.minimumHostVersion);
  const normalizedRunnerOs =
    typeof req.body?.os === "string" && req.body.os.trim() ? req.body.os.trim() : null;
  const normalizedRunnerPlatform =
    typeof req.body?.platform === "string" && req.body.platform.trim()
      ? req.body.platform.trim()
      : null;
  const normalizedRunnerArch =
    typeof req.body?.arch === "string" && req.body.arch.trim() ? req.body.arch.trim() : null;
  const parsedUptime = Number.parseInt(req.body?.uptime, 10);
  const normalizedRunnerUptime =
    Number.isFinite(parsedUptime) && parsedUptime >= 0 ? parsedUptime : null;
  const normalizedRuntimes = normalizeRunnerRuntimesPayload(req.body?.runtimes);

  const now = new Date().toISOString();

  let updated;
  try {
    updated = await db.updateRunnerHostStatus(hostId, {
      status: RUNNER_STATUS.HEALTHY,
      statusMessage: message,
      endpoint: normalizedEndpoint,
      lastSeenAt: now,
      maxConcurrency: normalizedConcurrency,
      timeoutMs: normalizedTimeout,
      runnerVersion: normalizedRunnerVersion,
      runnerOs: normalizedRunnerOs,
      runnerPlatform: normalizedRunnerPlatform,
      runnerArch: normalizedRunnerArch,
      runnerUptime: normalizedRunnerUptime,
      runnerRuntimes: normalizedRuntimes,
      minimumHostVersion: normalizedMinimumHostVersion,
      clearDisabledAt: true,
    });
  } catch (err) {
    console.error("Failed to update runner host", err);
    res.status(500).json({ error: "Failed to register runner host" });
    return;
  }

  if (!updated) {
    res.status(404).json({ error: "Runner host not found" });
    return;
  }

  const runnerConfig = {
    id: hostId,
    endpoint: normalizedEndpoint,
    headers: {
      "x-automn-runner-id": hostId,
      "x-automn-runner-name": updated?.name || hostId,
      "x-automn-runner-secret": secretInput,
    },
  };

  if (normalizedConcurrency !== null) {
    runnerConfig.maxConcurrency = normalizedConcurrency;
  }
  if (normalizedTimeout !== null) {
    runnerConfig.timeoutMs = normalizedTimeout;
  }

  registerRunnerHost(runnerConfig);

  const sanitized = sanitizeRunnerHost(updated);

  res.json({
    runnerHost: sanitized,
    registered: true,
    hostVersion: HOST_VERSION,
    minimumRunnerVersion: MINIMUM_RUNNER_VERSION,
  });
});

app.get("/api/data/backup", requireAdmin, async (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const password = normalizeHeaderValue(
    req.headers["x-automn-backup-password"] || req.query?.password,
  );
  const tempPath = path.join(
    os.tmpdir(),
    `automn-backup-${timestamp}-${Math.random().toString(36).slice(2)}.db`,
  );

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      let backup;
      try {
        backup = db.backup(tempPath, (err) => {
          if (err) {
            finish(err);
            return;
          }

          const stepOnce = () => {
            if (settled) return;
            try {
              backup.step(-1, (stepErr, done) => {
                if (settled) return;
                if (stepErr) {
                  finish(stepErr);
                  return;
                }

                if (done) {
                  try {
                    backup.finish(() => finish(null));
                  } catch (finishErr) {
                    finish(finishErr);
                  }
                } else {
                  setImmediate(stepOnce);
                }
              });
            } catch (stepErr) {
              finish(stepErr);
            }
          };

          if (
            !backup ||
            typeof backup.step !== "function" ||
            typeof backup.finish !== "function"
          ) {
            finish(new Error("SQLite backup interface is unavailable"));
            return;
          }

          stepOnce();
        });
      } catch (err) {
        finish(err);
      }
    });

    const fileBuffer = await fsp.readFile(tempPath);
    const { buffer: payloadBuffer, filenameSuffix } = await encryptBackupBuffer(
      fileBuffer,
      password,
    );
    const filename = `automn-backup-${timestamp}${filenameSuffix}`;

    await notifyAdminsOfBackup(req.user);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(payloadBuffer);
  } catch (err) {
    console.error("Backup failed", err);
    res.status(500).json({ error: "Failed to create backup" });
  } finally {
    fsp.unlink(tempPath).catch(() => { });
  }
});

app.post("/api/data/restore", requireAdmin, async (req, res) => {
  const { backup, password = "" } = req.body || {};

  if (typeof backup !== "string" || backup.trim().length === 0) {
    res.status(400).json({ error: "Backup payload is required" });
    return;
  }

  let buffer;
  try {
    buffer = Buffer.from(backup, "base64");
  } catch (err) {
    res.status(400).json({ error: "Backup payload is invalid" });
    return;
  }

  if (!buffer || buffer.length === 0) {
    res.status(400).json({ error: "Backup payload is empty" });
    return;
  }

  try {
    const result = await decryptBackupBuffer(buffer, password);
    buffer = result.buffer;
  } catch (err) {
    if (err.code === "password_required") {
      res.status(400).json({ error: "Backup password is required" });
      return;
    }
    console.error("Failed to decrypt backup", err);
    res.status(400).json({ error: "Invalid backup password or corrupted backup" });
    return;
  }

  const tempPath = path.join(
    os.tmpdir(),
    `automn-restore-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  try {
    await fsp.writeFile(tempPath, buffer);
    await restoreDatabaseFromFile(tempPath);
    refreshScriptRoutes();
    res.json({ restored: true });
  } catch (err) {
    console.error("Restore failed", err);
    res.status(500).json({ error: "Failed to restore database" });
  } finally {
    fsp.unlink(tempPath).catch(() => { });
  }
});

app.use("/api/scripts", requireAuthenticated);
app.use("/api/logs", requireAuthenticated);
app.use("/api/system", requireAuthenticated);
app.use("/api/notifications", requireAuthenticated);
app.use("/api/categories", requireAuthenticated);
app.use("/api/collections", requireAuthenticated);

function unregisterScriptRoute(endpoint) {
  if (!endpoint) return;
  const pathToRemove = `/s/${endpoint}`;
  scriptRouteAcceptedMethodRegistry.delete(pathToRemove);
  if (app._router && app._router.stack) {
    app._router.stack = app._router.stack.filter(
      (layer) => !(layer.route && layer.route.path === pathToRemove)
    );
  }
}
// ─────────────────────────────────────────────
// Register a single dynamic endpoint (hot reload safe)
// ─────────────────────────────────────────────
function registerScriptRoute(script) {
  if (!script) return;

  const endpointKey =
    typeof script.endpoint === "string" && script.endpoint.trim()
      ? script.endpoint.trim()
      : "";
  if (!endpointKey) {
    return;
  }

  unregisterScriptRoute(endpointKey);

  if (script.is_draft) {
    return;
  }
  if (script.is_recycled) {
    return;
  }

  if (!script.run_token && script.id) {
    const newToken = generateScriptToken();
    script.run_token = newToken;
    dbRun("UPDATE scripts SET run_token=? WHERE id=?", [newToken, script.id]).catch(
      (err) => {
        console.error("Failed to assign script token", err);
      },
    );
  }

  const endpoint = `/s/${endpointKey}`;

  const acceptedMethods = normalizeAcceptedMethods(
    script.acceptedMethods || script.allowed_methods,
    {
      ensure: [script.run_method || "POST"],
    },
  );
  const acceptedMethodSet = new Set(acceptedMethods);
  scriptRouteAcceptedMethodRegistry.set(
    endpoint,
    Object.freeze([...acceptedMethods]),
  );

  const logUnsupportedMethodAttempt = async (req, attemptedMethod = null) => {
    try {
      const normalizedMethod =
        typeof attemptedMethod === "string" && attemptedMethod.trim()
          ? attemptedMethod.trim().toUpperCase()
          : typeof req.method === "string" && req.method.trim()
            ? req.method.trim().toUpperCase()
            : "";

      let triggeredByLabel = "API";
      let triggeredByUserId = null;

      const auth = await authenticateRequest(req);
      const user = auth?.user || null;
      if (user) {
        triggeredByLabel = user.username || triggeredByLabel;
        triggeredByUserId = user.id || null;
      } else {
        try {
          const tokenAccess = evaluateScriptTokenAccess(req, script, null);
          if (tokenAccess?.used && tokenAccess?.masked) {
            triggeredByLabel = `Token ${tokenAccess.masked}`;
          }
        } catch (tokenErr) {
          // Ignore token validation errors for unsupported method logging.
        }
      }

      let inputSnapshot;
      if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
        inputSnapshot = req.query || {};
      } else {
        try {
          const payload = await resolveRequestPayload(req);
          inputSnapshot =
            payload === undefined ? {} : cloneInputSnapshot(payload);
        } catch (payloadErr) {
          console.error(
            "Failed to capture request payload for unsupported method",
            payloadErr,
          );
          inputSnapshot = req.body ?? {};
        }
      }

      const label = normalizedMethod || "UNKNOWN";
      const error = new Error(
        `HTTP method ${label} is not allowed for this script`,
      );
      error.status = 405;
      error.code = "method_not_allowed";

      await recordImmediateRunFailure({
        runId: uuidv4(),
        script,
        triggeredBy: triggeredByLabel,
        triggeredByUserId,
        httpMethod: normalizedMethod || null,
        input: inputSnapshot,
        error,
      });
    } catch (err) {
      console.error(
        `Failed to log unsupported method attempt for script ${script?.id || "unknown"
        }`,
        err,
      );
    }
  };

  const respondMethodNotAllowed = (req, res, attemptedMethod = null) => {
    const method =
      attemptedMethod ||
      (typeof req.method === "string" && req.method.trim()
        ? req.method.trim().toUpperCase()
        : "");
    const registryMethods = scriptRouteAcceptedMethodRegistry.get(endpoint);
    const allowedMethods = Array.isArray(registryMethods)
      ? registryMethods
      : acceptedMethods;
    if (allowedMethods.length) {
      res.set("Allow", allowedMethods.join(", "));
    }
    const label = method || "UNKNOWN";
    res.status(405).json({
      error: `HTTP method ${label} is not allowed for this script`,
      allowedMethods,
    });
  };

  const guardMethod = (handler) => async (req, res, ...args) => {
    const method =
      typeof req.method === "string" && req.method.trim()
        ? req.method.trim().toUpperCase()
        : "";
    if (!acceptedMethodSet.has(method)) {
      await logUnsupportedMethodAttempt(req, method);
      respondMethodNotAllowed(req, res, method);
      return;
    }
    return handler(req, res, ...args);
  };

  if (!app._router) {
    app._router = express.Router();
    app.use(app._router);
  }

  if (app._router.stack) {
    app._router.stack = app._router.stack.filter(
      (layer) => !(layer.route && layer.route.path === endpoint)
    );
  }

  console.log(
    `🌀 Registering script endpoint: ${endpoint} [${acceptedMethods.join(", ")}]`,
  );

  // Async runner (used by POST)
  const runAsync = async (req, res) => {
    const httpMethod =
      typeof req.method === "string" && req.method.trim()
        ? req.method.trim().toUpperCase()
        : "POST";
    let parsedRequestBody;
    try {
      parsedRequestBody = await resolveRequestPayload(req);
    } catch (bodyErr) {
      console.error("Failed to read script request payload", bodyErr);
      const statusCode = bodyErr.status || bodyErr.statusCode || 400;
      res.status(statusCode).json({
        error: bodyErr.message || "Failed to read request payload",
        code: bodyErr.code || "invalid_payload",
      });
      return;
    }

    const input = parsedRequestBody === undefined ? {} : parsedRequestBody;
    let runTracker = null;
    const runId = uuidv4();
    let latest = null;
    let triggeredByLabel = "API";
    let triggeredByUserId = null;

    try {
      const auth = await authenticateRequest(req);
      const user = auth?.user || null;

      const access = await ensureScriptAccess({
        endpoint: script.endpoint,
        user,
        requiredPermission: user ? "run" : null,
      });
      latest = access.script;

      triggeredByLabel = user?.username || "API";
      triggeredByUserId = user?.id || null;

      const codeVersion = await determineCodeVersionForScript(latest.id);

      let tokenAccess;
      try {
        tokenAccess = evaluateScriptTokenAccess(req, latest, user);
        if (tokenAccess.used) {
          triggeredByLabel = `Token ${tokenAccess.masked}`;
        }
      } catch (tokenErr) {
        const failureError = normalizeRunFailureError(tokenErr);
        await recordImmediateRunFailure({
          runId,
          script: latest,
          triggeredBy: triggeredByLabel,
          triggeredByUserId,
          httpMethod,
          input,
          error: failureError,
          codeVersion,
        });
        res.status(tokenErr.status || failureError.status || 401).json({
          error: failureError.message,
          code: tokenErr.code || "unauthorized",
        });
        return;
      }

      const executionVariables = await loadScriptVariablesForExecution(latest);
      const jobContext = {
        httpMethod,
        codeVersion,
        scriptName:
          typeof latest.name === "string" && latest.name.trim()
            ? latest.name
            : latest.endpoint || latest.id || "",
      };

      try {
        runTracker = await createRunTracker({
          runId,
          script: latest,
          triggeredBy: triggeredByLabel,
          triggeredByUserId,
          input,
          httpMethod,
          codeVersion,
        });
      } catch (trackerErr) {
        console.error(`Failed to initialize run ${runId} tracker:`, trackerErr);
      }

      try {
        await ensureHealthyRunnerAvailability(latest);
      } catch (availabilityErr) {
        const failureError = normalizeRunFailureError(availabilityErr);
        if (runTracker) {
          try {
            await runTracker.fail(failureError);
          } catch (trackerErr) {
            console.error(`Failed to persist run ${runId} failure:`, trackerErr);
          }
        } else if (latest) {
          await recordImmediateRunFailure({
            runId,
            script: latest,
            triggeredBy: triggeredByLabel,
            triggeredByUserId,
            httpMethod,
            input,
            error: failureError,
            codeVersion,
          });
        }

        const isRunnerUnavailable =
          availabilityErr instanceof RunnerUnavailableError ||
          availabilityErr?.code === "NO_RUNNER_AVAILABLE";
        const statusCode = isRunnerUnavailable
          ? 503
          : failureError.status || availabilityErr.status || 500;
        const payload = {
          error: failureError.message,
        };
        if (isRunnerUnavailable) {
          payload.code = "runner_unavailable";
        } else if (availabilityErr?.code) {
          payload.code = availabilityErr.code;
        }
        res.status(statusCode).json(payload);
        return;
      }

      let jobPromise;
      try {
        jobPromise = runJob(
          {
            ...latest,
            preassignedRunId: runId,
            triggeredBy: triggeredByLabel,
            triggeredByUserId,
            variables: executionVariables,
            jobContext,
          },
          input,
        );
      } catch (dispatchErr) {
        const failureError = normalizeRunFailureError(dispatchErr);
        if (runTracker) {
          try {
            await runTracker.fail(failureError);
          } catch (trackerErr) {
            console.error(`Failed to persist run ${runId} failure:`, trackerErr);
          }
        } else if (latest) {
          await recordImmediateRunFailure({
            runId,
            script: latest,
            triggeredBy: triggeredByLabel,
            triggeredByUserId,
            httpMethod,
            input,
            error: failureError,
            codeVersion,
          });
        }
        if (
          dispatchErr instanceof RunnerUnavailableError ||
          dispatchErr?.code === "NO_RUNNER_AVAILABLE"
        ) {
          res.status(503).json({
            error: failureError.message,
            code: "runner_unavailable",
          });
          return;
        }
        throw dispatchErr;
      }

      jobPromise
        .then(async (result) => {
          if (runTracker) {
            try {
              await runTracker.complete(result);
            } catch (trackerErr) {
              console.error(`Failed to persist run ${runId} result:`, trackerErr);
            }
          }
          await persistScriptNotifications(latest, result);
        })
        .catch(async (err2) => {
          const failureError = normalizeRunFailureError(err2);
          if (runTracker) {
            try {
              await runTracker.fail(failureError);
            } catch (trackerErr) {
              console.error(`Failed to persist run ${runId} failure:`, trackerErr);
            }
          } else if (latest) {
            await recordImmediateRunFailure({
              runId,
              script: latest,
              triggeredBy: triggeredByLabel,
              triggeredByUserId,
              httpMethod,
              input,
              error: failureError,
              codeVersion,
            });
          }
          if (
            err2 instanceof RunnerUnavailableError ||
            err2?.code === "NO_RUNNER_AVAILABLE"
          ) {
            console.error(`Job ${runId} failed to start:`, err2);
          } else {
            console.error(`Job ${runId} failed:`, err2);
          }
        });

      const acceptedPayload = {
        accepted: true,
        message: `Script '${latest.name}' accepted for execution.`,
      };
      if (latest?.expose_run_id !== 0) {
        acceptedPayload.runId = runId;
      }

      res.status(202).json(acceptedPayload);
    } catch (err) {
      const failureError = normalizeRunFailureError(err);
      if (runTracker) {
        try {
          await runTracker.fail(failureError);
        } catch (trackerErr) {
          console.error(
            `Failed to persist run ${runId || "unknown"} failure:`,
            trackerErr,
          );
        }
      } else if (latest) {
        await recordImmediateRunFailure({
          runId,
          script: latest,
          triggeredBy: triggeredByLabel,
          triggeredByUserId,
          httpMethod,
          input,
          error: failureError,
          codeVersion,
        });
      }
      if (
        err instanceof RunnerUnavailableError ||
        err?.code === "NO_RUNNER_AVAILABLE"
      ) {
        res.status(503).json({
          error: failureError.message,
          code: "runner_unavailable",
        });
        return;
      }
      if (failureError.status || err.status) {
        res
          .status(failureError.status || err.status)
          .json({ error: failureError.message });
        return;
      }
      console.error("Failed to queue job:", err);
      res
        .status(500)
        .json(attachRunId(buildErrorPayload(failureError.message)));
    }
  };

  // Sync runner (used by GET)
  const runSync = async (req, res) => {
    const httpMethod =
      typeof req.method === "string" && req.method.trim()
        ? req.method.trim().toUpperCase()
        : "GET";
    const input = req.query || {};
    let runTracker = null;
    const runId = uuidv4();
    let latest = null;
    let triggeredByLabel = "API";
    let triggeredByUserId = null;
    const start = Date.now();

    const shouldIncludeMetadata = () => latest?.expose_automn_response !== 0;
    const shouldIncludeRunId = () => latest?.expose_run_id !== 0;
    const attachRunId = (payload, explicitId = null) => {
      if (!shouldIncludeRunId()) return payload;
      const identifier = explicitId || runId;
      if (!identifier) return payload;
      return { ...payload, runId: identifier };
    };
    const buildErrorPayload = (message, extra = {}) => {
      const base = shouldIncludeMetadata()
        ? { success: false, error: message }
        : { error: message };
      return { ...base, ...extra };
    };

    try {
      const auth = await authenticateRequest(req);
      const user = auth?.user || null;

      const access = await ensureScriptAccess({
        endpoint: script.endpoint,
        user,
        requiredPermission: user ? "run" : null,
      });
      latest = access.script;

      triggeredByLabel = user?.username || "API";
      triggeredByUserId = user?.id || null;

      const codeVersion = await determineCodeVersionForScript(latest.id);

      let tokenAccess;
      try {
        tokenAccess = evaluateScriptTokenAccess(req, latest, user);
        if (tokenAccess.used) {
          triggeredByLabel = `Token ${tokenAccess.masked}`;
        }
      } catch (tokenErr) {
        const failureError = normalizeRunFailureError(tokenErr);
        await recordImmediateRunFailure({
          runId,
          script: latest,
          triggeredBy: triggeredByLabel,
          triggeredByUserId,
          httpMethod,
          input,
          error: failureError,
        });
        res.status(tokenErr.status || failureError.status || 401).json({
          error: failureError.message,
          code: tokenErr.code || "unauthorized",
        });
        return;
      }

      const executionVariables = await loadScriptVariablesForExecution(latest);
      const jobContext = {
        httpMethod,
        codeVersion,
        scriptName:
          typeof latest.name === "string" && latest.name.trim()
            ? latest.name
            : latest.endpoint || latest.id || "",
      };

      try {
        runTracker = await createRunTracker({
          runId,
          script: latest,
          triggeredBy: triggeredByLabel,
          triggeredByUserId,
          input,
          httpMethod,
          codeVersion,
        });
      } catch (trackerErr) {
        console.error(`Failed to initialize run ${runId} tracker:`, trackerErr);
      }

      try {
        await ensureHealthyRunnerAvailability(latest);
      } catch (availabilityErr) {
        const failureError = normalizeRunFailureError(availabilityErr);
        if (runTracker) {
          try {
            await runTracker.fail(failureError);
          } catch (trackerErr) {
            console.error(`Failed to persist run ${runId} failure:`, trackerErr);
          }
        } else if (latest) {
          await recordImmediateRunFailure({
            runId,
            script: latest,
            triggeredBy: triggeredByLabel,
            triggeredByUserId,
            httpMethod,
            input,
            error: failureError,
            codeVersion,
          });
        }

        const isRunnerUnavailable =
          availabilityErr instanceof RunnerUnavailableError ||
          availabilityErr?.code === "NO_RUNNER_AVAILABLE";
        const statusCode = isRunnerUnavailable
          ? 503
          : failureError.status || availabilityErr.status || 500;
        const payload = buildErrorPayload(failureError.message);
        if (isRunnerUnavailable) {
          payload.code = "runner_unavailable";
        } else if (availabilityErr?.code) {
          payload.code = availabilityErr.code;
        }
        res.status(statusCode).json(attachRunId(payload));
        return;
      }

      let result;
      try {
        result = await runJob(
          {
            ...latest,
            preassignedRunId: runId,
            skipQueue: true,
            triggeredBy: triggeredByLabel,
            triggeredByUserId,
            variables: executionVariables,
            jobContext,
          },
          input,
        );
      } catch (dispatchErr) {
        const failureError = normalizeRunFailureError(dispatchErr);
        if (runTracker) {
          try {
            await runTracker.fail(failureError);
          } catch (trackerErr) {
            console.error(`Failed to persist run ${runId} failure:`, trackerErr);
          }
        } else if (latest) {
          await recordImmediateRunFailure({
            runId,
            script: latest,
            triggeredBy: triggeredByLabel,
            triggeredByUserId,
            httpMethod,
            input,
            error: failureError,
            codeVersion,
          });
        }
        if (
          dispatchErr instanceof RunnerUnavailableError ||
          dispatchErr?.code === "NO_RUNNER_AVAILABLE"
        ) {
          const payload = buildErrorPayload(failureError.message, {
            code: "runner_unavailable",
          });
          res.status(503).json(attachRunId(payload));
          return;
        }
        throw dispatchErr;
      }

      if (runTracker) {
        try {
          await runTracker.complete(result);
        } catch (trackerErr) {
          console.error(`Failed to persist run ${runId} result:`, trackerErr);
        }
      }

      await persistScriptNotifications(latest, result);
      const statusCode = result.code === 0 ? 200 : 500;
      const includeMetadata = shouldIncludeMetadata();

      if (includeMetadata) {
        const metadataPayload = {
          success: result.code === 0,
          return: result.returnData,
          stdout: result.stdout,
          stderr: result.stderr,
          automnLogs: result.automnLogs,
          automnNotifications: result.automnNotifications,
          input: result.input ?? input,
          durationMs: Date.now() - start,
        };
        const resolvedRunId = result.runId || runId;
        if (shouldIncludeRunId() && resolvedRunId) {
          metadataPayload.runId = resolvedRunId;
        }
        res.status(statusCode).json(metadataPayload);
        return;
      }

      if (result.code === 0) {
        const minimalPayload = { return: result.returnData };
        if (shouldIncludeRunId()) {
          const resolvedRunId = result.runId || runId;
          if (resolvedRunId) {
            minimalPayload.runId = resolvedRunId;
          }
        }
        res.status(statusCode).json(minimalPayload);
        return;
      }

      const failureMessage = determineResultFailureMessage(
        result,
        includeMetadata
      );
      let errorPayload = attachRunId(
        buildErrorPayload(failureMessage),
        result.runId || runId,
      );
      if (includeMetadata && result.returnData !== undefined) {
        errorPayload = { ...errorPayload, return: result.returnData };
      }
      res.status(statusCode).json(errorPayload);
    } catch (err) {
      const failureError = normalizeRunFailureError(err);
      if (runTracker) {
        try {
          await runTracker.fail(failureError);
        } catch (trackerErr) {
          console.error(
            `Failed to persist run ${runId || "unknown"} failure:`,
            trackerErr,
          );
        }
      } else if (latest) {
        await recordImmediateRunFailure({
          runId,
          script: latest,
          triggeredBy: triggeredByLabel,
          triggeredByUserId,
          httpMethod,
          input,
          error: failureError,
          codeVersion,
        });
      }
      if (
        err instanceof RunnerUnavailableError ||
        err?.code === "NO_RUNNER_AVAILABLE"
      ) {
        const payload = buildErrorPayload(failureError.message, {
          code: "runner_unavailable",
        });
        res.status(503).json(attachRunId(payload));
        return;
      }
      if (failureError.status || err.status) {
        res
          .status(failureError.status || err.status)
          .json({ error: failureError.message });
        return;
      }
      console.error("Sync run failed:", err);
      res.status(500).json(attachRunId(buildErrorPayload(failureError.message)));
    }
  };

  const guardedAsync = guardMethod(runAsync);
  const guardedSync = guardMethod(runSync);

  for (const method of acceptedMethods) {
    switch (method) {
      case "GET":
        app.get(endpoint, guardedSync);
        break;
      case "POST":
        app.post(endpoint, guardedAsync);
        break;
      case "PUT":
        app.put(endpoint, guardedAsync);
        break;
      case "PATCH":
        app.patch(endpoint, guardedAsync);
        break;
      case "DELETE":
        app.delete(endpoint, guardedAsync);
        break;
      default:
        break;
    }
  }

  app.all(endpoint, async (req, res, next) => {
    const method =
      typeof req.method === "string" && req.method.trim()
        ? req.method.trim().toUpperCase()
        : "";
    const registryMethods = scriptRouteAcceptedMethodRegistry.get(endpoint);
    const allowedMethods = Array.isArray(registryMethods)
      ? registryMethods
      : acceptedMethods;
    if (allowedMethods.includes(method)) {
      next();
      return;
    }
    await logUnsupportedMethodAttempt(req, method);
    respondMethodNotAllowed(req, res, method);
  });
}



// ─────────────────────────────────────────────
// Load all existing scripts on startup
// ─────────────────────────────────────────────
function registerDynamicRoutes() {
  db.all("SELECT * FROM scripts WHERE is_recycled = 0 AND is_draft = 0", (err, rows) => {
    if (err) return console.error(err);
    rows.forEach(registerScriptRoute);
  });
}

function refreshScriptRoutes() {
  if (app._router && app._router.stack) {
    app._router.stack = app._router.stack.filter((layer) => {
      if (!layer.route || typeof layer.route.path !== "string") return true;
      return !layer.route.path.startsWith("/s/");
    });
  }
  registerDynamicRoutes();
}

async function ensureAllScriptsHaveToken() {
  try {
    const scripts = await dbAll(
      "SELECT id, run_token FROM scripts WHERE is_draft = 0",
    );
    if (!Array.isArray(scripts)) {
      return;
    }

    for (const row of scripts) {
      if (!row?.id) continue;
      const existing = (row.run_token || "").trim();
      if (existing) continue;

      const newToken = generateScriptToken();
      await dbRun("UPDATE scripts SET run_token=? WHERE id=?", [
        newToken,
        row.id,
      ]);
    }
  } catch (err) {
    console.error("Failed to ensure script tokens", err);
  }
}

// ─────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────
app.get("/", (_, res) => {
  res.send(`
    <h1>🍂 Automn API</h1>
    <ul>
      <li>POST /api/scripts → create/edit script</li>
      <li>GET /api/scripts → list scripts</li>
      <li>DELETE /api/scripts/:endpoint → move script to recycle bin</li>
      <li>DELETE /api/scripts/:id/permanent → permanently delete script</li>
      <li>DELETE /api/scripts/:id/logs → clear script logs</li>
      <li>POST /s/&lt;endpoint&gt; → run script</li>
      <li>GET /api/system/status → system info</li>
      <li>WS /api/ws?runId=&lt;id&gt; → live logs</li>
    </ul>
  `);
});

// ─────────────────────────────────────────────
// Create or update scripts (with versioning + hot reload)
// ─────────────────────────────────────────────
function mapCollectionRowForApi(row, user, permissionRow = null) {
  if (!row) return null;
  const permissions = computeCategoryPermissions(user, row, permissionRow);
  const defaultRunnerHostId = row.default_runner_host_id || null;
  const defaultRunner = defaultRunnerHostId
    ? {
      id: defaultRunnerHostId,
      name: row.default_runner_name || defaultRunnerHostId,
      status: row.default_runner_status || RUNNER_STATUS.PENDING,
      statusMessage: row.default_runner_status_message || null,
      adminOnly: normalizeDbBoolean(row.default_runner_admin_only),
    }
    : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    defaultLanguage: row.default_language || null,
    defaultRunnerHostId,
    defaultRunner,
    isSystem: normalizeDbBoolean(row.is_system),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    scriptCount: Number(row.script_count) || 0,
    permissions,
  };
}

const mapCategoryRowForApi = mapCollectionRowForApi;

// ─────────────────────────────────────────────
// Collections
// ─────────────────────────────────────────────
async function handleListCollections(req, res) {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const rows = await dbAll(
      `SELECT c.*, perms.can_read AS perm_can_read, perms.can_write AS perm_can_write,
              perms.can_delete AS perm_can_delete, perms.can_run AS perm_can_run,
              perms.can_clear_logs AS perm_can_clear_logs,
              dr.name AS default_runner_name,
              dr.status AS default_runner_status,
              dr.status_message AS default_runner_status_message,
              dr.admin_only AS default_runner_admin_only,
              (SELECT COUNT(*) FROM scripts s WHERE s.category_id = c.id) AS script_count
         FROM categories c
         LEFT JOIN category_permissions perms ON perms.category_id = c.id AND perms.user_id = ?
         LEFT JOIN runner_hosts dr ON dr.id = c.default_runner_host_id
        ORDER BY c.is_system DESC, c.name COLLATE NOCASE ASC`,
      [user.id],
    );

    const categories = [];
    for (const row of rows) {
      const category = mapCategoryRowForApi(row, user, {
        can_read: row.perm_can_read,
        can_write: row.perm_can_write,
        can_delete: row.perm_can_delete,
        can_run: row.perm_can_run,
        can_clear_logs: row.perm_can_clear_logs,
      });
      if (!category) continue;
      const hasAccess =
        user.isAdmin ||
        category.permissions.read ||
        category.permissions.write ||
        category.permissions.delete ||
        category.permissions.run ||
        category.permissions.clearLogs;
      if (hasAccess) {
        categories.push(category);
      }
    }

    const collections = categories;
    res.json({ categories, collections });
  } catch (err) {
    console.error("Failed to load collections", err);
    res.status(500).json({ error: "Failed to load collections" });
  }
}

async function handleCreateCollection(req, res) {
  const { name, description, defaultLanguage, defaultRunnerHostId } =
    req.body || {};
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) {
    res.status(400).json({ error: "Collection name is required" });
    return;
  }

  try {
    const existing = await dbGet(
      "SELECT id FROM categories WHERE LOWER(name) = LOWER(?)",
      [trimmedName],
    );
    if (existing) {
      res
        .status(409)
        .json({ error: "A collection with this name already exists" });
      return;
    }

    const trimmedDescription =
      typeof description === "string" ? description.trim() : "";
    let normalizedLanguage =
      typeof defaultLanguage === "string"
        ? defaultLanguage.trim().toLowerCase()
        : "";
    if (!SUPPORTED_SCRIPT_LANGUAGES.has(normalizedLanguage)) {
      normalizedLanguage = null;
    }

    const rawDefaultRunner =
      typeof defaultRunnerHostId === "string"
        ? defaultRunnerHostId.trim()
        : "";
    const normalizedDefaultRunnerId = rawDefaultRunner || null;
    if (normalizedDefaultRunnerId) {
      const runner = await db.getRunnerHostById(normalizedDefaultRunnerId);
      if (!runner) {
        res.status(400).json({ error: "Runner host not found" });
        return;
      }
    }

    const id = uuidv4();
    await dbRun(
      `INSERT INTO categories (id, name, description, default_language, default_runner_host_id, is_system)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [
        id,
        trimmedName,
        trimmedDescription,
        normalizedLanguage,
        normalizedDefaultRunnerId,
      ],
    );

    const row = await dbGet(
      `SELECT c.*, 0 AS script_count,
              dr.name AS default_runner_name,
              dr.status AS default_runner_status,
              dr.status_message AS default_runner_status_message,
              dr.admin_only AS default_runner_admin_only
         FROM categories c
         LEFT JOIN runner_hosts dr ON dr.id = c.default_runner_host_id
        WHERE c.id=?`,
      [id],
    );

    res.status(201).json({
      category: mapCategoryRowForApi(row, req.user, null),
      collection: mapCollectionRowForApi(row, req.user, null),
    });
  } catch (err) {
    if (
      err?.code === "SQLITE_CONSTRAINT" ||
      (typeof err?.message === "string" && err.message.includes("UNIQUE"))
    ) {
      res
        .status(409)
        .json({ error: "A collection with this name already exists" });
      return;
    }
    console.error("Failed to create collection", err);
    res.status(500).json({ error: "Failed to create collection" });
  }
}

app.get("/api/categories", handleListCollections);
app.get("/api/collections", handleListCollections);
app.post("/api/categories", requireAdmin, handleCreateCollection);
app.post("/api/collections", requireAdmin, handleCreateCollection);

async function handleListCollectionVariables(req, res) {
  const categoryId = req.params.id || DEFAULT_COLLECTION_ID;
  try {
    const category = await loadCategoryById(categoryId);
    if (!category) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    const variables = await loadCategoryVariablesForApi(category.id);
    res.json({
      variables,
      prefix: CATEGORY_VARIABLE_ENV_PREFIX,
      categoryVariables: variables,
      collectionVariables: variables,
      categoryPrefix: CATEGORY_VARIABLE_ENV_PREFIX,
      collectionPrefix: COLLECTION_VARIABLE_ENV_PREFIX,
      count: variables.length,
    });
  } catch (err) {
    console.error("Failed to load collection variables", err);
    res.status(500).json({ error: "Failed to load collection variables" });
  }
}

async function handleCreateCollectionVariable(req, res) {
  const categoryId = req.params.id || DEFAULT_COLLECTION_ID;
  const body = req.body || {};

  try {
    const category = await loadCategoryById(categoryId);
    if (!category) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    const normalizedName = normalizeVariableName(body.name || "");
    if (!normalizedName) {
      res.status(400).json({ error: "Variable name is required" });
      return;
    }

    const envName = computeVariableEnvName(
      normalizedName,
      CATEGORY_VARIABLE_ENV_PREFIX,
    );
    const isSecure = body.isSecure ? 1 : 0;
    const valueProvided = Object.prototype.hasOwnProperty.call(body, "value");
    const rawValue = valueProvided ? body.value : "";
    const stringValue =
      rawValue === null || rawValue === undefined
        ? ""
        : typeof rawValue === "string"
          ? rawValue
          : String(rawValue);
    const storedValue = isSecure ? encryptVariableValue(stringValue) : stringValue;
    const now = new Date().toISOString();
    const id = uuidv4();

    try {
      await dbRun(
        `INSERT INTO category_variables (id, category_id, name, env_name, value, is_secure, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          category.id,
          normalizedName,
          envName,
          storedValue,
          isSecure,
          now,
          now,
        ],
      );
    } catch (err) {
      if (err?.message && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "A variable with this name already exists" });
        return;
      }
      throw err;
    }

    const row = await loadCategoryVariableById(category.id, id);
    const count = await countCategoryVariables(category.id);
    const variable = sanitizeVariableApiRow(row, {
      envPrefix: CATEGORY_VARIABLE_ENV_PREFIX,
      scope: "category",
    });
    res.status(201).json({
      variable,
      categoryVariable: variable,
      collectionVariable: variable,
      count,
    });
  } catch (err) {
    console.error("Failed to create collection variable", err);
    res.status(500).json({ error: "Failed to create collection variable" });
  }
}

async function handleUpdateCollectionVariable(req, res) {
  const categoryId = req.params.id || DEFAULT_COLLECTION_ID;
  const body = req.body || {};

  try {
    const category = await loadCategoryById(categoryId);
    if (!category) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    const existing = await loadCategoryVariableById(
      category.id,
      req.params.variableId,
    );
    if (!existing) {
      res.status(404).json({ error: "Variable not found" });
      return;
    }

    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const nextNameRaw = hasName ? body.name : existing.name;
    const normalizedName = normalizeVariableName(nextNameRaw || "");
    if (!normalizedName) {
      res.status(400).json({ error: "Variable name is required" });
      return;
    }

    const hasSecureFlag = Object.prototype.hasOwnProperty.call(body, "isSecure");
    const nextIsSecure = hasSecureFlag
      ? Boolean(body.isSecure)
      : existing.is_secure !== 0;

    const valueProvided = Object.prototype.hasOwnProperty.call(body, "value");
    let storedValue = existing.value || "";

    if (valueProvided) {
      const rawValue = body.value;
      const stringValue =
        rawValue === null || rawValue === undefined
          ? ""
          : typeof rawValue === "string"
            ? rawValue
            : String(rawValue);
      storedValue = nextIsSecure
        ? encryptVariableValue(stringValue)
        : stringValue;
    } else if (existing.is_secure !== 0 && !nextIsSecure) {
      try {
        storedValue = decryptVariableValue(existing.value || "");
      } catch (err) {
        console.error("Failed to decrypt collection variable for conversion", err);
        storedValue = "";
      }
    } else if (existing.is_secure === 0 && nextIsSecure) {
      storedValue = encryptVariableValue(existing.value || "");
    }

    const envName = computeVariableEnvName(
      normalizedName,
      CATEGORY_VARIABLE_ENV_PREFIX,
    );

    try {
      await dbRun(
        `UPDATE category_variables
            SET name=?, env_name=?, value=?, is_secure=?, updated_at=?
          WHERE id=? AND category_id=?`,
        [
          normalizedName,
          envName,
          storedValue,
          nextIsSecure ? 1 : 0,
          new Date().toISOString(),
          existing.id,
          category.id,
        ],
      );
    } catch (err) {
      if (err?.message && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "A variable with this name already exists" });
        return;
      }
      throw err;
    }

    const updated = await loadCategoryVariableById(category.id, existing.id);
    const count = await countCategoryVariables(category.id);
    const variable = sanitizeVariableApiRow(updated, {
      envPrefix: CATEGORY_VARIABLE_ENV_PREFIX,
      scope: "category",
    });
    res.json({
      variable,
      categoryVariable: variable,
      collectionVariable: variable,
      count,
    });
  } catch (err) {
    console.error("Failed to update collection variable", err);
    res.status(500).json({ error: "Failed to update collection variable" });
  }
}

async function handleDeleteCollectionVariable(req, res) {
  const categoryId = req.params.id || DEFAULT_COLLECTION_ID;

  try {
    const category = await loadCategoryById(categoryId);
    if (!category) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    const result = await dbRun(
      "DELETE FROM category_variables WHERE id=? AND category_id=?",
      [req.params.variableId, category.id],
    );

    if (!result?.changes) {
      res.status(404).json({ error: "Variable not found" });
      return;
    }

    const count = await countCategoryVariables(category.id);
    res.json({ deleted: true, count });
  } catch (err) {
    console.error("Failed to delete collection variable", err);
    res.status(500).json({ error: "Failed to delete collection variable" });
  }
}

app.get(
  "/api/categories/:id/variables",
  requireAdmin,
  handleListCollectionVariables,
);
app.get(
  "/api/collections/:id/variables",
  requireAdmin,
  handleListCollectionVariables,
);
app.post(
  "/api/categories/:id/variables",
  requireAdmin,
  handleCreateCollectionVariable,
);
app.post(
  "/api/collections/:id/variables",
  requireAdmin,
  handleCreateCollectionVariable,
);
app.put(
  "/api/categories/:id/variables/:variableId",
  requireAdmin,
  handleUpdateCollectionVariable,
);
app.put(
  "/api/collections/:id/variables/:variableId",
  requireAdmin,
  handleUpdateCollectionVariable,
);
app.delete(
  "/api/categories/:id/variables/:variableId",
  requireAdmin,
  handleDeleteCollectionVariable,
);
app.delete(
  "/api/collections/:id/variables/:variableId",
  requireAdmin,
  handleDeleteCollectionVariable,
);

async function handleUpdateCollection(req, res) {
  const { id } = req.params;
  const body = req.body || {};

  try {
    const category = await loadCategoryById(id);
    if (!category) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    if (normalizeDbBoolean(category.is_system)) {
      res
        .status(400)
        .json({ error: "The default collection cannot be modified" });
      return;
    }

    const updates = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const trimmedName =
        typeof body.name === "string" ? body.name.trim() : "";
      if (!trimmedName) {
        res.status(400).json({ error: "Collection name is required" });
        return;
      }
      const existing = await dbGet(
        "SELECT id FROM categories WHERE LOWER(name)=LOWER(?) AND id<>?",
        [trimmedName, id],
      );
      if (existing) {
        res
          .status(409)
          .json({ error: "A collection with this name already exists" });
        return;
      }
      updates.push("name=?");
      params.push(trimmedName);
    }

    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      const trimmedDescription =
        typeof body.description === "string" ? body.description.trim() : "";
      updates.push("description=?");
      params.push(trimmedDescription);
    }

    if (Object.prototype.hasOwnProperty.call(body, "defaultLanguage")) {
      let normalizedLanguage =
        typeof body.defaultLanguage === "string"
          ? body.defaultLanguage.trim().toLowerCase()
          : "";
      if (!SUPPORTED_SCRIPT_LANGUAGES.has(normalizedLanguage)) {
        normalizedLanguage = null;
      }
      updates.push("default_language=?");
      params.push(normalizedLanguage);
    }

    if (Object.prototype.hasOwnProperty.call(body, "defaultRunnerHostId")) {
      const rawRunnerId =
        typeof body.defaultRunnerHostId === "string"
          ? body.defaultRunnerHostId.trim()
          : "";
      const normalizedRunnerId = rawRunnerId || null;
      if (normalizedRunnerId) {
        const runner = await db.getRunnerHostById(normalizedRunnerId);
        if (!runner) {
          res.status(400).json({ error: "Runner host not found" });
          return;
        }
      }
      updates.push("default_runner_host_id=?");
      params.push(normalizedRunnerId);
    }

    if (updates.length === 0) {
      const current = await dbGet(
        `SELECT c.*, (SELECT COUNT(*) FROM scripts s WHERE s.category_id = c.id) AS script_count,
                dr.name AS default_runner_name,
                dr.status AS default_runner_status,
                dr.status_message AS default_runner_status_message,
                dr.admin_only AS default_runner_admin_only
           FROM categories c
           LEFT JOIN runner_hosts dr ON dr.id = c.default_runner_host_id
          WHERE c.id=?`,
        [id],
      );
      res.json({
        category: mapCategoryRowForApi(current, req.user, null),
        collection: mapCollectionRowForApi(current, req.user, null),
      });
      return;
    }

    updates.push("updated_at=CURRENT_TIMESTAMP");
    params.push(id);

    await dbRun(
      `UPDATE categories SET ${updates.join(", ")} WHERE id=?`,
      params,
    );

    const updated = await dbGet(
      `SELECT c.*, (SELECT COUNT(*) FROM scripts s WHERE s.category_id = c.id) AS script_count,
              dr.name AS default_runner_name,
              dr.status AS default_runner_status,
              dr.status_message AS default_runner_status_message,
              dr.admin_only AS default_runner_admin_only
         FROM categories c
         LEFT JOIN runner_hosts dr ON dr.id = c.default_runner_host_id
        WHERE c.id=?`,
      [id],
    );

    res.json({
      category: mapCategoryRowForApi(updated, req.user, null),
      collection: mapCollectionRowForApi(updated, req.user, null),
    });
  } catch (err) {
    console.error("Failed to update collection", err);
    res.status(500).json({ error: "Failed to update collection" });
  }
}

// Legacy category update handler removed in favor of handleUpdateCollection.
app.put("/api/categories/:id", requireAdmin, handleUpdateCollection);
app.put("/api/collections/:id", requireAdmin, handleUpdateCollection);

async function handleDeleteCollection(req, res) {
  const { id } = req.params;
  try {
    const category = await loadCategoryById(id);
    if (!category) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    if (normalizeDbBoolean(category.is_system)) {
      res
        .status(400)
        .json({ error: "The default collection cannot be deleted" });
      return;
    }

    await dbRun(
      `UPDATE scripts SET category_id=?, project_name=? WHERE category_id=?`,
      [DEFAULT_CATEGORY_ID, "General", category.id],
    );
    await dbRun(`DELETE FROM category_permissions WHERE category_id=?`, [
      category.id,
    ]);
    await dbRun(`DELETE FROM categories WHERE id=?`, [category.id]);

    res.json({ deleted: true });
  } catch (err) {
    console.error("Failed to delete collection", err);
    res.status(500).json({ error: "Failed to delete collection" });
  }
}

app.delete("/api/categories/:id", requireAdmin, handleDeleteCollection);
app.delete("/api/collections/:id", requireAdmin, handleDeleteCollection);

async function handleGetCollectionPermissions(req, res) {
  const { id } = req.params;
  try {
    const category = await loadCategoryById(id);
    if (!category) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    const rows = await dbAll(
      `SELECT cp.user_id, u.username, u.is_admin, cp.can_read, cp.can_write, cp.can_delete, cp.can_run, cp.can_clear_logs
         FROM category_permissions cp
         JOIN users u ON u.id = cp.user_id AND u.deleted_at IS NULL
        WHERE cp.category_id=?
        ORDER BY u.username COLLATE NOCASE ASC`,
      [category.id],
    );

    const users = await dbAll(
      `SELECT id, username, is_admin
         FROM users
        WHERE is_active=1 AND deleted_at IS NULL
        ORDER BY username COLLATE NOCASE ASC`,
    );

    const info = {
      id: category.id,
      name: category.name,
      description: category.description || "",
      defaultLanguage: category.default_language || null,
      isSystem: normalizeDbBoolean(category.is_system),
    };

    res.json({
      category: info,
      collection: info,
      permissions: rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        isAdmin: normalizeDbBoolean(row.is_admin),
        canRead: normalizeDbBoolean(row.can_read),
        canWrite: normalizeDbBoolean(row.can_write),
        canDelete: normalizeDbBoolean(row.can_delete),
        canRun: normalizeDbBoolean(row.can_run),
        canClearLogs: normalizeDbBoolean(row.can_clear_logs),
      })),
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        isAdmin: normalizeDbBoolean(user.is_admin),
      })),
    });
  } catch (err) {
    console.error("Failed to load collection permissions", err);
    res.status(500).json({ error: "Failed to load collection permissions" });
  }
}

async function handleUpdateCollectionPermissions(req, res) {
  const { permissions: entriesInput } = req.body || {};
  if (entriesInput !== undefined && !Array.isArray(entriesInput)) {
    res.status(400).json({ error: "Permissions payload must be an array" });
    return;
  }

  const entries = Array.isArray(entriesInput) ? entriesInput : [];
  const { id } = req.params;

  try {
    const category = await loadCategoryById(id);
    if (!category) {
      res.status(404).json({ error: "Collection not found" });
      return;
    }

    if (normalizeDbBoolean(category.is_system)) {
      res
        .status(400)
        .json({ error: "The default collection permissions cannot be modified" });
      return;
    }

    const normalized = new Map();
    for (const entry of entries) {
      const userId = typeof entry?.userId === "string" ? entry.userId.trim() : "";
      if (!userId) continue;
      const canWrite = Boolean(entry?.canWrite);
      const canDelete = Boolean(entry?.canDelete);
      const canRun = Boolean(entry?.canRun);
      const canClearLogs = Boolean(entry?.canClearLogs);
      const canRead = Boolean(entry?.canRead) || canWrite || canDelete || canRun || canClearLogs;
      normalized.set(userId, {
        userId,
        canRead,
        canWrite,
        canDelete,
        canRun,
        canClearLogs,
      });
    }

    const userIds = Array.from(normalized.keys());
    if (userIds.length) {
      const placeholders = userIds.map(() => "?").join(",");
      const existingUsers = await dbAll(
        `SELECT id FROM users WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        userIds,
      );
      const validIds = new Set(existingUsers.map((row) => row.id));
      for (const userId of userIds) {
        if (!validIds.has(userId)) {
          normalized.delete(userId);
        }
      }
    }

    if (normalized.size === 0) {
      await dbRun(`DELETE FROM category_permissions WHERE category_id=?`, [
        category.id,
      ]);
    } else {
      const keepIds = Array.from(normalized.keys());
      const deletePlaceholders = keepIds.map(() => "?").join(",");
      await dbRun(
        `DELETE FROM category_permissions WHERE category_id=? AND user_id NOT IN (${deletePlaceholders})`,
        [category.id, ...keepIds],
      );
      for (const {
        userId,
        canRead,
        canWrite,
        canDelete,
        canRun,
        canClearLogs,
      } of normalized.values()) {
        await dbRun(
          `INSERT INTO category_permissions (id, category_id, user_id, can_read, can_write, can_delete, can_run, can_clear_logs, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(category_id, user_id) DO UPDATE SET
             can_read=excluded.can_read,
             can_write=excluded.can_write,
             can_delete=excluded.can_delete,
             can_run=excluded.can_run,
             can_clear_logs=excluded.can_clear_logs,
             updated_at=CURRENT_TIMESTAMP`,
          [
            uuidv4(),
            category.id,
            userId,
            canRead ? 1 : 0,
            canWrite ? 1 : 0,
            canDelete ? 1 : 0,
            canRun ? 1 : 0,
            canClearLogs ? 1 : 0,
          ],
        );
      }
    }

    const rows = await dbAll(
      `SELECT cp.user_id, u.username, u.is_admin, cp.can_read, cp.can_write, cp.can_delete, cp.can_run, cp.can_clear_logs
         FROM category_permissions cp
         JOIN users u ON u.id = cp.user_id AND u.deleted_at IS NULL
        WHERE cp.category_id=?
        ORDER BY u.username COLLATE NOCASE ASC`,
      [category.id],
    );

    const info = {
      id: category.id,
      name: category.name,
      description: category.description || "",
      defaultLanguage: category.default_language || null,
      isSystem: normalizeDbBoolean(category.is_system),
    };

    res.json({
      updated: true,
      category: info,
      collection: info,
      permissions: rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        isAdmin: normalizeDbBoolean(row.is_admin),
        canRead: normalizeDbBoolean(row.can_read),
        canWrite: normalizeDbBoolean(row.can_write),
        canDelete: normalizeDbBoolean(row.can_delete),
        canRun: normalizeDbBoolean(row.can_run),
        canClearLogs: normalizeDbBoolean(row.can_clear_logs),
      })),
    });
  } catch (err) {
    console.error("Failed to update collection permissions", err);
    res.status(500).json({ error: "Failed to update collection permissions" });
  }
}

app.get(
  "/api/categories/:id/permissions",
  requireAdmin,
  handleGetCollectionPermissions,
);
app.get(
  "/api/collections/:id/permissions",
  requireAdmin,
  handleGetCollectionPermissions,
);
app.post(
  "/api/categories/:id/permissions",
  requireAdmin,
  handleUpdateCollectionPermissions,
);
app.post(
  "/api/collections/:id/permissions",
  requireAdmin,
  handleUpdateCollectionPermissions,
);

// ─────────────────────────────────────────────
// Create or update scripts (with versioning + hot reload)
// ─────────────────────────────────────────────
app.post("/api/scripts/draft", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const body = req.body || {};
    const preferredCategoryId =
      typeof body.categoryId === "string" && body.categoryId.trim()
        ? body.categoryId.trim()
        : typeof body.collectionId === "string" && body.collectionId.trim()
          ? body.collectionId.trim()
          : null;

    let categoryRecord = null;
    if (preferredCategoryId) {
      try {
        const access = await ensureCategoryAccess({
          categoryId: preferredCategoryId,
          collectionId: preferredCategoryId,
          user,
          requiredPermission: "write",
        });
        categoryRecord = access.category;
      } catch (err) {
        if (!err.status || (err.status !== 403 && err.status !== 404)) {
          throw err;
        }
      }
    }

    if (!categoryRecord) {
      const access = await ensureCategoryAccess({
        categoryId: DEFAULT_CATEGORY_ID,
        user,
        requiredPermission: "write",
      });
      categoryRecord = access.category;
    }

    let language =
      typeof body.language === "string" && body.language.trim()
        ? body.language.trim().toLowerCase()
        : "";
    if (language && !SUPPORTED_SCRIPT_LANGUAGES.has(language)) {
      language = "";
    }
    if (!language && categoryRecord?.default_language) {
      const categoryLanguage = String(categoryRecord.default_language)
        .trim()
        .toLowerCase();
      if (SUPPORTED_SCRIPT_LANGUAGES.has(categoryLanguage)) {
        language = categoryLanguage;
      }
    }
    if (!language) {
      language = "node";
    }

    const inheritCategoryPermissions = true;
    const inheritCategoryRunner = true;
    const categoryId = categoryRecord?.id || DEFAULT_CATEGORY_ID;
    const categoryName = categoryRecord?.name || "";

    const newId = uuidv4();
    const placeholderName = `Draft ${newId.slice(0, 8)}`;
    const placeholderEndpoint = `draft-${newId}`;
    const code = typeof body.code === "string" ? body.code : "";
    const parsedTimeout = Number(body.timeout);
    const timeout = Number.isFinite(parsedTimeout) ? parsedTimeout : 0;

    const serializedAcceptedMethods = JSON.stringify(DEFAULT_ACCEPTED_METHODS);
    await dbRun(
      `INSERT INTO scripts (id,name,endpoint,language,code,timeout,project_name,category_id,inherit_category_permissions,inherit_category_runner,runner_host_id,owner_id,last_version_user_id,is_draft,is_recycled,recycled_at,run_method,allowed_methods,run_headers,run_body,run_token,require_authentication,expose_automn_response,expose_run_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId,
        placeholderName,
        placeholderEndpoint,
        language,
        code,
        timeout,
        categoryName,
        categoryId,
        inheritCategoryPermissions ? 1 : 0,
        inheritCategoryRunner ? 1 : 0,
        null,
        user.id,
        user.id,
        1,
        0,
        null,
        "POST",
        serializedAcceptedMethods,
        "{}",
        "",
        null,
        1,
        0,
        1,
      ],
    );

    const inserted = await loadScriptWithOwner("s.id=?", [newId]);
    const mapped = mapScriptRow(inserted, user);
    if (!mapped) {
      res.status(500).json({ error: "Failed to create draft script" });
      return;
    }

    res.status(201).json({
      ...mapped,
      name: "",
      endpoint: "",
      isDraft: true,
      acceptedMethods: mapped.acceptedMethods || DEFAULT_ACCEPTED_METHODS,
      hasApiToken: false,
      apiTokenPreview: null,
      variableCount: 0,
      packageCount: 0,
      collectionId: mapped.collectionId || categoryId,
      collectionName: mapped.collection?.name || categoryName,
      collection: mapped.collection,
      categoryId,
      category: mapped.category,
      categoryName,
      projectName: categoryName,
      inheritCategoryPermissions,
      inheritCollectionPermissions: inheritCategoryPermissions,
      inheritCategoryRunner,
      inheritCollectionRunner: inheritCategoryRunner,
      runnerHostId: null,
      runner: null,
      resolvedRunner: null,
      runMethod: "POST",
      runHeaders: {},
      runBody: "",
      requireAuthentication: true,
      includeAutomnResponseData: false,
      includeRunIdInResponse: true,
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to create draft script", err);
    res.status(500).json({ error: "Failed to create draft script" });
  }
});

app.delete("/api/scripts/:id/draft", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "write",
      allowDraft: true,
      allowRecycled: true,
    });

    if (!script.is_draft) {
      res.status(400).json({ error: "Script is not a draft" });
      return;
    }

    await dbRun("DELETE FROM logs WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM runs WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM script_versions WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM script_variables WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM script_permissions WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM scripts WHERE id=?", [script.id]);
    unregisterScriptRoute(script.endpoint);
    res.json({ deleted: true });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to discard draft script", err);
    res.status(500).json({ error: "Failed to discard draft script" });
  }
});

app.post("/api/scripts", async (req, res) => {
  const requestBody = req.body || {};
  const {
    id,
    name: inputName,
    endpoint: inputEndpoint,
    language,
    code,
    timeout = 0,
    categoryId: inputCategoryId,
    collectionId: inputCollectionId,
    inheritCategoryPermissions: inputInheritCategoryPermissions,
    inheritCollectionPermissions: inputInheritCollectionPermissions,
    runMethod: inputRunMethod,
    runHeaders: inputRunHeaders,
    runBody: inputRunBody,
    acceptedMethods: inputAcceptedMethods,
    runnerHostId: inputRunnerHostId,
    inheritCategoryRunner: inputInheritCategoryRunner,
    inheritCollectionRunner: inputInheritCollectionRunner,
    includeAutomnResponseData: inputIncludeAutomnResponseData,
    includeRunIdInResponse: inputIncludeRunIdInResponse,
  } = requestBody;

  const name =
    typeof inputName === "string" ? inputName.trim() : "";
  const endpoint =
    typeof inputEndpoint === "string" ? inputEndpoint.trim() : "";

  const normalizeHeaders = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
    try {
      return JSON.stringify(value);
    } catch (err) {
      console.error("Failed to serialize run headers", err);
      return "{}";
    }
  };

  const normalizeBody = (value) => {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch (err) {
      console.error("Failed to serialize run body", err);
      return "";
    }
  };

  let defaultRunMethod =
    typeof inputRunMethod === "string" && inputRunMethod.trim()
      ? inputRunMethod.trim().toUpperCase()
      : "POST";
  const defaultRunHeaders =
    inputRunHeaders !== undefined ? normalizeHeaders(inputRunHeaders) : "{}";
  const defaultRunBody =
    inputRunBody !== undefined ? normalizeBody(inputRunBody) : "";

  const bodyHasAcceptedMethods = Object.prototype.hasOwnProperty.call(
    requestBody,
    "acceptedMethods",
  );

  const bodyHasIncludeAutomnResponseData = Object.prototype.hasOwnProperty.call(
    requestBody,
    "includeAutomnResponseData",
  );
  const bodyHasIncludeRunIdInResponse = Object.prototype.hasOwnProperty.call(
    requestBody,
    "includeRunIdInResponse",
  );

  const trimmedCategoryId =
    typeof inputCategoryId === "string" && inputCategoryId.trim()
      ? inputCategoryId.trim()
      : typeof inputCollectionId === "string" && inputCollectionId.trim()
        ? inputCollectionId.trim()
        : "";

  const inheritPermissionsOverride =
    typeof inputInheritCategoryPermissions === "boolean"
      ? inputInheritCategoryPermissions
      : typeof inputInheritCollectionPermissions === "boolean"
        ? inputInheritCollectionPermissions
        : null;

  const inheritRunnerOverride =
    typeof inputInheritCategoryRunner === "boolean"
      ? inputInheritCategoryRunner
      : typeof inputInheritCollectionRunner === "boolean"
        ? inputInheritCollectionRunner
        : null;

  try {
    if (!name) {
      res.status(400).json({ error: "Script name is required" });
      return;
    }

    if (!endpoint) {
      res.status(400).json({ error: "Script endpoint is required" });
      return;
    }

    const bodyHasRunnerHostId = Object.prototype.hasOwnProperty.call(
      requestBody,
      "runnerHostId",
    );
    const bodyHasInheritCategoryRunner =
      Object.prototype.hasOwnProperty.call(requestBody, "inheritCategoryRunner") ||
      Object.prototype.hasOwnProperty.call(requestBody, "inheritCollectionRunner");

    if (id) {
      const { script: existing } = await ensureScriptAccess({
        scriptId: id,
        user: req.user,
        requiredPermission: "write",
        allowRecycled: true,
        allowDraft: true,
      });

      const existingNameNormalized =
        typeof existing.name === "string" ? existing.name.trim() : "";
      if (existingNameNormalized.toLowerCase() !== name.toLowerCase()) {
        const nameConflict = await findScriptNameConflict(name, id);
        if (nameConflict) {
          res
            .status(409)
            .json({ error: "Another script is already using this name." });
          return;
        }
      }

      const existingEndpointNormalized =
        typeof existing.endpoint === "string" ? existing.endpoint.trim() : "";
      if (existingEndpointNormalized.toLowerCase() !== endpoint.toLowerCase()) {
        const endpointConflict = await findScriptEndpointConflict(endpoint, id);
        if (endpointConflict) {
          res
            .status(409)
            .json({ error: "Another script is already using this endpoint." });
          return;
        }
      }

      const currentCategoryId = existing.category_id || DEFAULT_CATEGORY_ID;
      const requestedCategoryId = trimmedCategoryId || currentCategoryId;
      let categoryRecord = await loadCategoryById(requestedCategoryId);
      if (!categoryRecord) {
        const { category } = await ensureCategoryAccess({
          categoryId: requestedCategoryId,
          user: req.user,
          requiredPermission: "write",
        });
        categoryRecord = category;
      } else if (
        requestedCategoryId !== currentCategoryId || !existing.category_id
      ) {
        await ensureCategoryAccess({
          categoryId: requestedCategoryId,
          user: req.user,
          requiredPermission: "write",
        });
      }

      if (!categoryRecord) {
        categoryRecord = await loadCategoryById(DEFAULT_CATEGORY_ID);
      }

      const inheritCategoryPermissions =
        inheritPermissionsOverride !== null
          ? inheritPermissionsOverride
          : existing.inherit_category_permissions !== 0;

      let inheritCategoryRunner =
        existing.inherit_category_runner !== undefined
          ? existing.inherit_category_runner !== 0
          : true;
      if (bodyHasInheritCategoryRunner) {
        const runnerValue =
          inheritRunnerOverride !== null
            ? inheritRunnerOverride
            : inputInheritCategoryRunner !== undefined
              ? inputInheritCategoryRunner
              : inputInheritCollectionRunner;
        inheritCategoryRunner = Boolean(runnerValue);
      }

      let runnerHostIdToPersist = existing.runner_host_id || null;
      let runnerHostRecord = null;
      if (bodyHasRunnerHostId) {
        const trimmedRunnerHostId =
          typeof inputRunnerHostId === "string"
            ? inputRunnerHostId.trim()
            : "";
        runnerHostIdToPersist = trimmedRunnerHostId || null;
        if (runnerHostIdToPersist) {
          runnerHostRecord = await db.getRunnerHostById(runnerHostIdToPersist);
          if (!runnerHostRecord) {
            res.status(400).json({ error: "Runner host not found" });
            return;
          }
          if (runnerHostRecord.adminOnly && !req.user?.isAdmin) {
            res.status(403).json({
              error: "Runner host is restricted to administrators",
            });
            return;
          }
        }
      }

      if (runnerHostIdToPersist) {
        inheritCategoryRunner = false;
      }

      const effectiveRunnerHostId =
        runnerHostIdToPersist ||
        (inheritCategoryRunner
          ? categoryRecord?.default_runner_host_id || null
          : null) ||
        null;

      if (!effectiveRunnerHostId && inheritCategoryRunner) {
        res.status(400).json({
          error:
            "Scripts must be assigned to a runner host, inherit one from their category, or explicitly disable runner inheritance.",
        });
        return;
      }

      if (effectiveRunnerHostId) {
        if (!runnerHostRecord || runnerHostRecord.id !== effectiveRunnerHostId) {
          runnerHostRecord = await db.getRunnerHostById(effectiveRunnerHostId);
        }

        if (!runnerHostRecord) {
          res.status(400).json({ error: "Runner host not found" });
          return;
        }
      } else {
        runnerHostRecord = null;
      }

      if (!existing.run_token) {
        const refreshedToken = generateScriptToken();
        existing.run_token = refreshedToken;
        await dbRun("UPDATE scripts SET run_token=? WHERE id=?", [
          refreshedToken,
          id,
        ]);
      }

      const versionRow = await dbGet(
        "SELECT MAX(version) as v FROM script_versions WHERE script_id=?",
        [id],
      );
      let baseVersion = Number(versionRow?.v) || 0;
      let lastVersionUserId = existing.last_version_user_id || null;
      const initialVersionAuthorId =
        lastVersionUserId || existing.owner_id || req.user?.id || null;

      if (baseVersion === 0) {
        const seededCreatedAt = existing.created_at || new Date().toISOString();
        await dbRun(
          `INSERT INTO script_versions (id, script_id, version, code, updated_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            id,
            1,
            existing.code || "",
            initialVersionAuthorId,
            seededCreatedAt,
          ],
        );
        baseVersion = 1;
        if (initialVersionAuthorId) {
          lastVersionUserId = initialVersionAuthorId;
        }
      }

      const nextCode = typeof code === "string" ? code : existing.code || "";
      const codeChanged = nextCode !== existing.code;

      let effectiveRunMethod =
        typeof inputRunMethod === "string" && inputRunMethod.trim()
          ? inputRunMethod.trim().toUpperCase()
          : existing.run_method || "POST";
      const effectiveRunHeaders =
        inputRunHeaders !== undefined
          ? normalizeHeaders(inputRunHeaders)
          : existing.run_headers || "{}";
      const effectiveRunBody =
        inputRunBody !== undefined
          ? normalizeBody(inputRunBody)
          : existing.run_body || "";

      const existingAcceptedMethods = normalizeAcceptedMethods(
        existing.allowed_methods || existing.acceptedMethods,
        {
          ensure: [existing.run_method || "POST"],
        },
      );
      const acceptedMethodsToPersist = bodyHasAcceptedMethods
        ? normalizeAcceptedMethods(inputAcceptedMethods, {
          ensure: [effectiveRunMethod],
        })
        : normalizeAcceptedMethods(existingAcceptedMethods, {
          ensure: [effectiveRunMethod],
        });
      const serializedAcceptedMethods = JSON.stringify(acceptedMethodsToPersist);

      const includeAutomnResponse = bodyHasIncludeAutomnResponseData
        ? Boolean(inputIncludeAutomnResponseData)
        : existing.expose_automn_response !== 0;
      const includeRunId = bodyHasIncludeRunIdInResponse
        ? Boolean(inputIncludeRunIdInResponse)
        : existing.expose_run_id !== 0;

      const ownerId = existing.owner_id || req.user?.id || null;
      const versionAuthorId =
        req.user?.id || lastVersionUserId || ownerId || null;
      const persistedVersionAuthorId = codeChanged
        ? versionAuthorId
        : lastVersionUserId || ownerId || versionAuthorId || null;

      await dbRun(
        `UPDATE scripts SET name=?, endpoint=?, language=?, code=?, timeout=?, project_name=?, category_id=?, inherit_category_permissions=?, inherit_category_runner=?, runner_host_id=?, owner_id=?, last_version_user_id=?, is_recycled=0, recycled_at=NULL, run_method=?, allowed_methods=?, run_headers=?, run_body=?, expose_automn_response=?, expose_run_id=?, is_draft=0 WHERE id=?`,
        [
          name,
          endpoint,
          language,
          nextCode,
          timeout,
          categoryRecord?.name || "",
          categoryRecord?.id || DEFAULT_CATEGORY_ID,
          inheritCategoryPermissions ? 1 : 0,
          inheritCategoryRunner ? 1 : 0,
          runnerHostIdToPersist,
          ownerId,
          persistedVersionAuthorId,
          effectiveRunMethod,
          serializedAcceptedMethods,
          effectiveRunHeaders,
          effectiveRunBody,
          includeAutomnResponse ? 1 : 0,
          includeRunId ? 1 : 0,
          id,
        ],
      );

      existing.expose_automn_response = includeAutomnResponse ? 1 : 0;
      existing.expose_run_id = includeRunId ? 1 : 0;
      existing.is_draft = 0;

      let responseVersion = baseVersion;

      if (codeChanged) {
        const nextVersionNumber = baseVersion + 1;
        await dbRun(
          `INSERT INTO script_versions (id, script_id, version, code, updated_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [uuidv4(), id, nextVersionNumber, nextCode, versionAuthorId],
        );
        responseVersion = nextVersionNumber;
        lastVersionUserId = versionAuthorId;
      }

      existing.runner_host_id = runnerHostIdToPersist;
      existing.inherit_category_runner = inheritCategoryRunner ? 1 : 0;
      existing.allowed_methods = serializedAcceptedMethods;
      existing.acceptedMethods = acceptedMethodsToPersist;

      registerScriptRoute({
        ...existing,
        name,
        endpoint,
        language,
        code: nextCode,
        timeout,
        project_name: categoryRecord?.name || "",
        category_id: categoryRecord?.id || DEFAULT_CATEGORY_ID,
        inherit_category_permissions: inheritCategoryPermissions ? 1 : 0,
        inherit_category_runner: inheritCategoryRunner ? 1 : 0,
        owner_id: ownerId,
        last_version_user_id: lastVersionUserId || persistedVersionAuthorId,
        is_recycled: 0,
        is_draft: 0,
        run_method: effectiveRunMethod,
        allowed_methods: serializedAcceptedMethods,
        acceptedMethods: acceptedMethodsToPersist,
        run_headers: effectiveRunHeaders,
        run_body: effectiveRunBody,
        expose_automn_response: includeAutomnResponse ? 1 : 0,
        expose_run_id: includeRunId ? 1 : 0,
      });

      const packageResult = await synchronizeScriptPackages({
        scriptId: id,
        language,
        code: nextCode,
        runnerHostId: runnerHostIdToPersist,
        inheritCategoryRunner,
        categoryDefaultRunnerHostId: categoryRecord?.default_runner_host_id || null,
        installMissing: false,
      });

      res.json({
        updated: true,
        id,
        version: responseVersion,
        endpoint,
        name,
        runMethod: effectiveRunMethod,
        acceptedMethods: acceptedMethodsToPersist,
        runHeaders: JSON.parse(effectiveRunHeaders || "{}"),
        runBody: effectiveRunBody,
        includeAutomnResponseData: includeAutomnResponse,
        includeRunIdInResponse: includeRunId,
        hasApiToken: Boolean(existing.run_token),
        apiTokenPreview: existing.run_token
          ? sanitizeScriptToken(existing.run_token)
          : null,
        variableCount: Number(existing.variable_count) || 0,
        categoryId: categoryRecord?.id || DEFAULT_CATEGORY_ID,
        categoryName: categoryRecord?.name || "",
        inheritCategoryPermissions,
        inheritCategoryRunner,
        runnerHostId: runnerHostIdToPersist,
        categoryDefaultRunnerHostId:
          categoryRecord?.default_runner_host_id || null,
        packageCount: packageResult.packageCount,
        packages: packageResult.packages,
        packageCheckError: packageResult.checkError,
        packageRunnerHostId: packageResult.effectiveRunnerHostId,
      });
      return;
    }

    const nameConflict = await findScriptNameConflict(name);
    if (nameConflict) {
      res
        .status(409)
        .json({ error: "Another script is already using this name." });
      return;
    }

    const endpointConflict = await findScriptEndpointConflict(endpoint);
    if (endpointConflict) {
      res
        .status(409)
        .json({ error: "Another script is already using this endpoint." });
      return;
    }

    const { category: selectedCategory } = await ensureCategoryAccess({
      categoryId: trimmedCategoryId || DEFAULT_CATEGORY_ID,
      user: req.user,
      requiredPermission: "write",
    });

    let inheritCategoryRunner = bodyHasInheritCategoryRunner
      ? Boolean(
        inheritRunnerOverride !== null
          ? inheritRunnerOverride
          : inputInheritCategoryRunner !== undefined
            ? inputInheritCategoryRunner
            : inputInheritCollectionRunner,
      )
      : true;
    let runnerHostIdToPersist = null;
    let runnerHostRecord = null;
    if (bodyHasRunnerHostId) {
      const trimmedRunnerHostId =
        typeof inputRunnerHostId === "string"
          ? inputRunnerHostId.trim()
          : "";
      runnerHostIdToPersist = trimmedRunnerHostId || null;
      if (runnerHostIdToPersist) {
        runnerHostRecord = await db.getRunnerHostById(runnerHostIdToPersist);
        if (!runnerHostRecord) {
          res.status(400).json({ error: "Runner host not found" });
          return;
        }
        if (runnerHostRecord.adminOnly && !req.user?.isAdmin) {
          res.status(403).json({
            error: "Runner host is restricted to administrators",
          });
          return;
        }
      }
    }

    if (runnerHostIdToPersist) {
      inheritCategoryRunner = false;
    }

    const effectiveRunnerHostId =
      runnerHostIdToPersist ||
      (inheritCategoryRunner
        ? selectedCategory?.default_runner_host_id || null
        : null) ||
      null;
    if (!effectiveRunnerHostId && inheritCategoryRunner) {
      res.status(400).json({
        error:
          "Scripts must be assigned to a runner host, inherit one from their category, or explicitly disable runner inheritance.",
      });
      return;
    }

    if (effectiveRunnerHostId) {
      if (!runnerHostRecord || runnerHostRecord.id !== effectiveRunnerHostId) {
        runnerHostRecord = await db.getRunnerHostById(effectiveRunnerHostId);
      }

      if (!runnerHostRecord) {
        res.status(400).json({ error: "Runner host not found" });
        return;
      }
    } else {
      runnerHostRecord = null;
    }

    const inheritCategoryPermissions =
      inheritPermissionsOverride === false ? 0 : 1;

    const includeAutomnResponse = bodyHasIncludeAutomnResponseData
      ? Boolean(inputIncludeAutomnResponseData)
      : false;
    const includeRunId = bodyHasIncludeRunIdInResponse
      ? Boolean(inputIncludeRunIdInResponse)
      : true;

    const defaultAcceptedMethods = normalizeAcceptedMethods(
      bodyHasAcceptedMethods ? inputAcceptedMethods : DEFAULT_ACCEPTED_METHODS,
      { ensure: [defaultRunMethod] },
    );
    const serializedAcceptedMethods = JSON.stringify(defaultAcceptedMethods);

    const newId = uuidv4();
    const ownerId = req.user?.id || null;
    const initialVersionAuthorId = ownerId;
    const initialCode = typeof code === "string" ? code : "";
    const runToken = generateScriptToken();
    await dbRun(
      `INSERT INTO scripts (id,name,endpoint,language,code,timeout,project_name,category_id,inherit_category_permissions,inherit_category_runner,runner_host_id,owner_id,last_version_user_id,is_recycled,recycled_at,run_method,allowed_methods,run_headers,run_body,run_token,require_authentication,expose_automn_response,expose_run_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId,
        name,
        endpoint,
        language,
        initialCode,
        timeout,
        selectedCategory?.name || "",
        selectedCategory?.id || DEFAULT_CATEGORY_ID,
        inheritCategoryPermissions ? 1 : 0,
        inheritCategoryRunner ? 1 : 0,
        runnerHostIdToPersist,
        ownerId,
        initialVersionAuthorId,
        0,
        null,
        defaultRunMethod,
        serializedAcceptedMethods,
        defaultRunHeaders,
        defaultRunBody,
        runToken,
        1,
        includeAutomnResponse ? 1 : 0,
        includeRunId ? 1 : 0,
      ],
    );

    await dbRun(
      `INSERT INTO script_versions (id, script_id, version, code, updated_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [uuidv4(), newId, 1, initialCode, initialVersionAuthorId],
    );

    registerScriptRoute({
      id: newId,
      name,
      endpoint,
      language,
      code: initialCode,
      timeout,
      project_name: selectedCategory?.name || "",
      category_id: selectedCategory?.id || DEFAULT_CATEGORY_ID,
      inherit_category_permissions: inheritCategoryPermissions,
      inherit_category_runner: inheritCategoryRunner ? 1 : 0,
      runner_host_id: runnerHostIdToPersist,
      owner_id: ownerId,
      last_version_user_id: initialVersionAuthorId,
      is_recycled: 0,
      run_method: defaultRunMethod,
      allowed_methods: serializedAcceptedMethods,
      acceptedMethods: defaultAcceptedMethods,
      run_headers: defaultRunHeaders,
      run_body: defaultRunBody,
      run_token: runToken,
      require_authentication: 1,
      expose_automn_response: includeAutomnResponse ? 1 : 0,
      expose_run_id: includeRunId ? 1 : 0,
    });

    const packageResult = await synchronizeScriptPackages({
      scriptId: newId,
      language,
      code: initialCode,
      runnerHostId: runnerHostIdToPersist,
      inheritCategoryRunner,
      categoryDefaultRunnerHostId:
        selectedCategory?.default_runner_host_id || null,
      installMissing: false,
    });

    res.status(201).json({
      id: newId,
      name,
      endpoint,
      version: 1,
      runMethod: defaultRunMethod,
      acceptedMethods: defaultAcceptedMethods,
      runHeaders: JSON.parse(defaultRunHeaders || "{}"),
      runBody: defaultRunBody,
      includeAutomnResponseData: includeAutomnResponse,
      includeRunIdInResponse: includeRunId,
      hasApiToken: true,
      apiTokenPreview: sanitizeScriptToken(runToken),
      variableCount: 0,
      categoryId: selectedCategory?.id || DEFAULT_CATEGORY_ID,
      categoryName: selectedCategory?.name || "",
      inheritCategoryPermissions: Boolean(inheritCategoryPermissions),
      inheritCategoryRunner,
      runnerHostId: runnerHostIdToPersist,
      categoryDefaultRunnerHostId:
        selectedCategory?.default_runner_host_id || null,
      collectionId: selectedCategory?.id || DEFAULT_CATEGORY_ID,
      collectionName: selectedCategory?.name || "",
      inheritCollectionPermissions: Boolean(inheritCategoryPermissions),
      inheritCollectionRunner: inheritCategoryRunner,
      collectionDefaultRunnerHostId:
        selectedCategory?.default_runner_host_id || null,
      packageCount: packageResult.packageCount,
      packages: packageResult.packages,
      packageCheckError: packageResult.checkError,
      packageRunnerHostId: packageResult.effectiveRunnerHostId,
    });
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (
      err?.code === "SQLITE_CONSTRAINT" ||
      (typeof err?.message === "string" && err.message.includes("UNIQUE"))
    ) {
      const message = String(err?.message || "").toLowerCase();
      if (message.includes("scripts.endpoint")) {
        res
          .status(409)
          .json({ error: "Another script is already using this endpoint." });
        return;
      }
      if (message.includes("scripts.name") || message.includes("idx_scripts_name")) {
        res
          .status(409)
          .json({ error: "Another script is already using this name." });
        return;
      }
      res
        .status(409)
        .json({ error: "A unique constraint prevented saving this script." });
      return;
    }
    console.error("Failed to save script", err);
    res.status(500).json({ error: "Failed to save script" });
  }
});

app.get("/api/scripts/:id/variables", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "write",
      allowDraft: true,
    });

    const [scriptVariables, categoryVariables, globalVariables] = await Promise.all([
      loadScriptVariablesForApi(script.id),
      loadCategoryVariablesForApi(script.category_id),
      loadGlobalVariablesForApi(),
    ]);
    const counts = {
      script: scriptVariables.length,
      category: categoryVariables.length,
      global: globalVariables.length,
    };
    counts.total = counts.script + counts.category + counts.global;
    res.json({
      scriptVariables,
      categoryVariables,
      globalVariables,
      jobVariables: serializeJobVariableDefinitions(),
      scriptPrefix: SCRIPT_VARIABLE_ENV_PREFIX,
      categoryPrefix: CATEGORY_VARIABLE_ENV_PREFIX,
      globalPrefix: GLOBAL_VARIABLE_ENV_PREFIX,
      counts,
      count: counts.total,
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to load script variables", err);
    res.status(500).json({ error: "Failed to load script variables" });
  }
});

app.post("/api/scripts/:id/variables", async (req, res) => {
  const body = req.body || {};
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "write",
      allowDraft: true,
    });

    const normalizedName = normalizeVariableName(body.name || "");
    if (!normalizedName) {
      res.status(400).json({ error: "Variable name is required" });
      return;
    }

    const envName = computeVariableEnvName(normalizedName, SCRIPT_VARIABLE_ENV_PREFIX);
    const isSecure = body.isSecure ? 1 : 0;
    const valueProvided = Object.prototype.hasOwnProperty.call(body, "value");
    const rawValue = valueProvided ? body.value : "";
    const stringValue =
      rawValue === null || rawValue === undefined
        ? ""
        : typeof rawValue === "string"
          ? rawValue
          : String(rawValue);
    const storedValue = isSecure ? encryptVariableValue(stringValue) : stringValue;
    const now = new Date().toISOString();
    const id = uuidv4();

    try {
      await dbRun(
        `INSERT INTO script_variables (id, script_id, name, env_name, value, is_secure, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          script.id,
          normalizedName,
          envName,
          storedValue,
          isSecure,
          now,
          now,
        ],
      );
    } catch (err) {
      if (err?.message && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "A variable with this name already exists" });
        return;
      }
      throw err;
    }

    const row = await loadScriptVariableById(script.id, id);
    const count = await countScriptVariables(script.id);
    res.status(201).json({
      variable: sanitizeVariableApiRow(row),
      count,
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to create script variable", err);
    res.status(500).json({ error: "Failed to create script variable" });
  }
});

app.put("/api/scripts/:id/variables/:variableId", async (req, res) => {
  const body = req.body || {};
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "write",
      allowDraft: true,
    });

    const existing = await loadScriptVariableById(
      script.id,
      req.params.variableId,
    );

    if (!existing) {
      res.status(404).json({ error: "Variable not found" });
      return;
    }

    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const nextNameRaw = hasName ? body.name : existing.name;
    const normalizedName = normalizeVariableName(nextNameRaw || "");
    if (!normalizedName) {
      res.status(400).json({ error: "Variable name is required" });
      return;
    }

    const hasSecureFlag = Object.prototype.hasOwnProperty.call(
      body,
      "isSecure",
    );
    const nextIsSecure = hasSecureFlag
      ? Boolean(body.isSecure)
      : existing.is_secure !== 0;

    const valueProvided = Object.prototype.hasOwnProperty.call(body, "value");
    let storedValue = existing.value || "";

    if (valueProvided) {
      const rawValue = body.value;
      const stringValue =
        rawValue === null || rawValue === undefined
          ? ""
          : typeof rawValue === "string"
            ? rawValue
            : String(rawValue);
      storedValue = nextIsSecure
        ? encryptVariableValue(stringValue)
        : stringValue;
    } else if (existing.is_secure !== 0 && !nextIsSecure) {
      try {
        storedValue = decryptVariableValue(existing.value || "");
      } catch (err) {
        console.error("Failed to decrypt variable for conversion", err);
        storedValue = "";
      }
    } else if (existing.is_secure === 0 && nextIsSecure) {
      storedValue = encryptVariableValue(existing.value || "");
    }

    const envName = computeVariableEnvName(normalizedName, SCRIPT_VARIABLE_ENV_PREFIX);

    try {
      await dbRun(
        `UPDATE script_variables
            SET name=?, env_name=?, value=?, is_secure=?, updated_at=?
          WHERE id=? AND script_id=?`,
        [
          normalizedName,
          envName,
          storedValue,
          nextIsSecure ? 1 : 0,
          new Date().toISOString(),
          existing.id,
          script.id,
        ],
      );
    } catch (err) {
      if (err?.message && err.message.includes("UNIQUE")) {
        res.status(409).json({ error: "A variable with this name already exists" });
        return;
      }
      throw err;
    }

    const updated = await loadScriptVariableById(script.id, existing.id);
    const count = await countScriptVariables(script.id);
    res.json({
      variable: sanitizeVariableApiRow(updated),
      count,
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to update script variable", err);
    res.status(500).json({ error: "Failed to update script variable" });
  }
});

app.delete("/api/scripts/:id/variables/:variableId", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "write",
      allowDraft: true,
    });

    const result = await dbRun(
      "DELETE FROM script_variables WHERE id=? AND script_id=?",
      [req.params.variableId, script.id],
    );

    if (!result?.changes) {
      res.status(404).json({ error: "Variable not found" });
      return;
    }

    const count = await countScriptVariables(script.id);
    res.json({ deleted: true, count });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to delete script variable", err);
    res.status(500).json({ error: "Failed to delete script variable" });
  }
});

app.get("/api/scripts/:id/packages", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "read",
      allowDraft: true,
      allowRecycled: true,
    });

    if (!script) {
      res.status(404).json({ error: "Script not found" });
      return;
    }

    const packages = await loadScriptPackages(script.id);
    const packageCount = packages.length;
    const inheritCategoryRunner = script.inherit_category_runner !== 0;
    const runnerHostId = script.runner_host_id || null;
    const categoryDefaultRunnerHostId =
      script.category_default_runner_host_id || null;
    const effectiveRunnerHostId =
      runnerHostId || (inheritCategoryRunner ? categoryDefaultRunnerHostId : null) || null;
    const checkError =
      packages.find((pkg) => pkg.status === "error" && pkg.message)?.message ||
      null;

    res.json({
      scriptId: script.id,
      language: script.language || null,
      packages,
      packageCount,
      runnerHostId,
      inheritCategoryRunner,
      categoryDefaultRunnerHostId,
      effectiveRunnerHostId,
      checkError,
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to load script packages", err);
    res.status(500).json({ error: "Failed to load script packages" });
  }
});

app.post("/api/scripts/:id/packages/check", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "write",
      allowDraft: true,
      allowRecycled: true,
    });

    if (!script) {
      res.status(404).json({ error: "Script not found" });
      return;
    }

    const installMissing = req.body?.installMissing !== false;
    const inheritCategoryRunner = script.inherit_category_runner !== 0;
    const categoryDefaultRunnerHostId =
      script.category_default_runner_host_id || null;

    const result = await synchronizeScriptPackages({
      scriptId: script.id,
      language: script.language,
      code: script.code || "",
      runnerHostId: script.runner_host_id || null,
      inheritCategoryRunner,
      categoryDefaultRunnerHostId,
      installMissing,
    });

    res.json({
      scriptId: script.id,
      packages: result.packages,
      packageCount: result.packageCount,
      installMissing,
      runnerHostId: script.runner_host_id || null,
      inheritCategoryRunner,
      categoryDefaultRunnerHostId,
      effectiveRunnerHostId: result.effectiveRunnerHostId,
      checkError: result.checkError,
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to check script packages", err);
    res.status(500).json({ error: "Failed to check script packages" });
  }
});

app.get("/api/scripts/:id/token", requireAdmin, async (req, res) => {
  try {
    const scriptRow = await dbGet(
      "SELECT id, run_token FROM scripts WHERE id=?",
      [req.params.id],
    );

    if (!scriptRow) {
      res.status(404).json({ error: "Script not found" });
      return;
    }

    const token = scriptRow.run_token || null;
    res.json({
      hasToken: Boolean(token),
      token,
      preview: token ? sanitizeScriptToken(token) : null,
      apiTokenPreview: token ? sanitizeScriptToken(token) : null,
    });
  } catch (err) {
    console.error("Failed to load script token", err);
    res.status(500).json({ error: "Failed to load script token" });
  }
});

app.post("/api/scripts/:id/token/rotate", requireAdmin, async (req, res) => {
  try {
    const scriptRow = await dbGet("SELECT * FROM scripts WHERE id=?", [
      req.params.id,
    ]);

    if (!scriptRow) {
      res.status(404).json({ error: "Script not found" });
      return;
    }

    const newToken = generateScriptToken();
    await dbRun("UPDATE scripts SET run_token=? WHERE id=?", [
      newToken,
      scriptRow.id,
    ]);

    registerScriptRoute({ ...scriptRow, run_token: newToken });

    res.json({
      hasToken: true,
      token: newToken,
      preview: sanitizeScriptToken(newToken),
      apiTokenPreview: sanitizeScriptToken(newToken),
    });
  } catch (err) {
    console.error("Failed to rotate script token", err);
    res.status(500).json({ error: "Failed to rotate script token" });
  }
});
// ─────────────────────────────────────────────
// CRUD helpers
// ─────────────────────────────────────────────
app.get("/api/scripts", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const params = [user.id, user.id];
    let query = `
      SELECT s.*, owner.username AS owner_username,
             perms.can_read AS perm_can_read,
             perms.can_write AS perm_can_write,
             perms.can_delete AS perm_can_delete,
             perms.can_run AS perm_can_run,
             perms.can_clear_logs AS perm_can_clear_logs,
             cperms.can_read AS category_perm_can_read,
             cperms.can_write AS category_perm_can_write,
             cperms.can_delete AS category_perm_can_delete,
             cperms.can_run AS category_perm_can_run,
             cperms.can_clear_logs AS category_perm_can_clear_logs,
             c.name AS category_name,
             c.description AS category_description,
             c.default_language AS category_default_language,
             c.default_runner_host_id AS category_default_runner_host_id,
             c.is_system AS category_is_system,
             vars.variable_count AS variable_count,
             pkgs.package_count AS package_count,
             sr.name AS script_runner_name,
             sr.status AS script_runner_status,
             sr.status_message AS script_runner_status_message,
             sr.admin_only AS script_runner_admin_only,
             cr.name AS category_runner_name,
             cr.status AS category_runner_status,
             cr.status_message AS category_runner_status_message,
             cr.admin_only AS category_runner_admin_only
        FROM scripts s
        LEFT JOIN users owner ON owner.id = s.owner_id
        LEFT JOIN script_permissions perms ON perms.script_id = s.id AND perms.user_id = ?
        LEFT JOIN categories c ON c.id = s.category_id
        LEFT JOIN category_permissions cperms ON cperms.category_id = s.category_id AND cperms.user_id = ?
        LEFT JOIN runner_hosts sr ON sr.id = s.runner_host_id
        LEFT JOIN runner_hosts cr ON cr.id = c.default_runner_host_id
        LEFT JOIN (
          SELECT script_id, COUNT(*) AS variable_count
            FROM script_variables
           GROUP BY script_id
        ) vars ON vars.script_id = s.id
        LEFT JOIN (
          SELECT script_id, COUNT(*) AS package_count
            FROM script_packages
           GROUP BY script_id
        ) pkgs ON pkgs.script_id = s.id
       WHERE s.is_recycled = 0 AND s.is_draft = 0
    `;

    if (!user.isAdmin) {
      query +=
        " AND (s.owner_id = ? OR s.category_id = ? OR perms.can_read = 1 OR perms.can_write = 1 OR perms.can_delete = 1 OR perms.can_run = 1 OR perms.can_clear_logs = 1 OR (s.inherit_category_permissions <> 0 AND (cperms.can_read = 1 OR cperms.can_write = 1 OR cperms.can_delete = 1 OR cperms.can_run = 1 OR cperms.can_clear_logs = 1)))";
      params.push(user.id, DEFAULT_CATEGORY_ID);
    }

    const rows = await dbAll(query, params);
    const scripts = rows.map((row) =>
      mapScriptRow(row, user, {
        can_read: row.perm_can_read,
        can_write: row.perm_can_write,
        can_delete: row.perm_can_delete,
        can_run: row.perm_can_run,
        can_clear_logs: row.perm_can_clear_logs,
      }, {
        can_read: row.category_perm_can_read,
        can_write: row.category_perm_can_write,
        can_delete: row.category_perm_can_delete,
        can_run: row.category_perm_can_run,
        can_clear_logs: row.category_perm_can_clear_logs,
      })
    );

    res.json(scripts.filter(Boolean));
  } catch (err) {
    console.error("Failed to load scripts", err);
    res.status(500).json({ error: "Failed to load scripts" });
  }
});

app.delete("/api/scripts/:endpoint", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      endpoint: req.params.endpoint,
      user: req.user,
      requiredPermission: "delete",
    });

    const recycledAt = new Date().toISOString();
    await dbRun(
      "UPDATE scripts SET is_recycled=1, recycled_at=? WHERE id=?",
      [recycledAt, script.id],
    );
    unregisterScriptRoute(script.endpoint);
    res.json({ recycled: true, endpoint: script.endpoint, recycledAt });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to recycle script", err);
    res.status(500).json({ error: "Failed to recycle script" });
  }
});

app.delete("/api/scripts/:id/permanent", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "clearLogs",
      allowRecycled: true,
    });

    await dbRun("DELETE FROM logs WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM runs WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM script_versions WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM script_variables WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM scripts WHERE id=?", [script.id]);
    unregisterScriptRoute(script.endpoint);
    res.json({ deleted: true });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to permanently delete script", err);
    res.status(500).json({ error: "Failed to permanently delete script" });
  }
});

app.post("/api/scripts/:id/recover", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "write",
      allowRecycled: true,
    });

    await dbRun("UPDATE scripts SET is_recycled=0, recycled_at=NULL WHERE id=?", [script.id]);
    registerScriptRoute({ ...script, is_recycled: 0, recycled_at: null });
    res.json({ recovered: true, endpoint: script.endpoint });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to recover script", err);
    res.status(500).json({ error: "Failed to recover script" });
  }
});

app.delete("/api/scripts/:id/logs", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "clearLogs",
      allowRecycled: true,
    });

    await dbRun("DELETE FROM logs WHERE script_id=?", [script.id]);
    await dbRun("DELETE FROM runs WHERE script_id=?", [script.id]);
    res.json({ cleared: true });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to clear logs", err);
    res.status(500).json({ error: "Failed to clear logs" });
  }
});


//
// Notifications
//
app.get("/api/notifications/summary", async (req, res) => {
  try {
    const summary = await loadNotificationSummary(req.user?.id || null);
    res.json({ summary });
  } catch (err) {
    console.error("Failed to load notification summary", err);
    res.status(500).json({ error: "Failed to load notification summary" });
  }
});

app.get("/api/notifications", async (req, res) => {
  const limitRaw = Number.parseInt(req.query.limit ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, 200)
    : 50;
  const typeRaw = typeof req.query.type === "string"
    ? req.query.type.trim().toLowerCase()
    : "";
  const typeFilter = KNOWN_NOTIFICATION_TYPES.has(typeRaw) ? typeRaw : null;

  try {
    const params = [req.user.id];
    let sql = `SELECT n.id,
                      n.type,
                      n.level,
                      n.message,
                      n.script_id,
                      n.created_at,
                      n.metadata,
                      nr.read_at,
                      s.name AS script_name,
                      s.endpoint AS script_endpoint
                 FROM notification_recipients nr
                 JOIN notifications n ON n.id = nr.notification_id
                 LEFT JOIN scripts s ON s.id = n.script_id
                WHERE nr.user_id=?`;

    if (typeFilter) {
      sql += " AND n.type=?";
      params.push(typeFilter);
    }

    sql += " ORDER BY n.created_at DESC, n.id DESC LIMIT ?";
    params.push(limit);

    const rows = await dbAll(sql, params);

    const notifications = Array.isArray(rows)
      ? rows.map((row) => {
        const typeValue = typeof row?.type === "string"
          ? row.type.toLowerCase()
          : "";
        const type = KNOWN_NOTIFICATION_TYPES.has(typeValue)
          ? typeValue
          : NOTIFICATION_TYPE_VALUES.SCRIPT;
        const metadata = parseNotificationMetadata(row?.metadata);
        const audience = {
          type: metadata?.audienceType || null,
          value: metadata?.audienceValue || null,
          usernames: Array.isArray(metadata?.targetUsernames)
            ? metadata.targetUsernames
            : [],
        };

        return {
          id: row.id,
          type,
          level: normalizeNotificationLevel(row?.level),
          message: row?.message || "",
          createdAt: row?.created_at || null,
          isRead: Boolean(row?.read_at),
          readAt: row?.read_at || null,
          script: row?.script_id
            ? {
              id: row.script_id,
              name: row.script_name || null,
              endpoint: row.script_endpoint || null,
            }
            : null,
          audience,
          metadata,
          isPinned: Boolean(metadata?.pinUntilRead),
        };
      })
      : [];

    const summary = await loadNotificationSummary(req.user.id);

    res.json({ notifications, summary });
  } catch (err) {
    console.error("Failed to load notifications", err);
    res.status(500).json({ error: "Failed to load notifications" });
  }
});

app.post("/api/notifications/read", async (req, res) => {
  const idsInput = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = Array.from(
    new Set(
      idsInput
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );

  if (ids.length === 0) {
    const summary = await loadNotificationSummary(req.user.id);
    res.json({ updated: 0, summary });
    return;
  }

  const placeholders = ids.map(() => "?").join(",");
  const now = new Date().toISOString();

  try {
    const result = await dbRun(
      `UPDATE notification_recipients
          SET read_at=?
        WHERE user_id=? AND notification_id IN (${placeholders}) AND read_at IS NULL`,
      [now, req.user.id, ...ids],
    );

    const summary = await loadNotificationSummary(req.user.id);
    res.json({ updated: result?.changes || 0, summary });
  } catch (err) {
    console.error("Failed to mark notifications as read", err);
    res.status(500).json({ error: "Failed to update notifications" });
  }
});


app.get("/api/scripts/:id/versions", async (req, res) => {
  try {
    await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "read",
      allowRecycled: true,
    });

    const rows = await dbAll(
      `SELECT sv.version,
              sv.created_at,
              sv.updated_by_user_id AS created_by_user_id,
              creator.username AS created_by_username
         FROM script_versions sv
         LEFT JOIN users creator ON creator.id = sv.updated_by_user_id
        WHERE sv.script_id=?
        ORDER BY sv.version DESC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to load versions", err);
    res.status(500).json({ error: "Failed to load versions" });
  }
});

app.get("/api/scripts/:id/versions/:version", async (req, res) => {
  const versionNumber = Number.parseInt(req.params.version, 10);
  if (Number.isNaN(versionNumber)) {
    return res.status(400).json({ error: "Invalid version number" });
  }

  try {
    await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "read",
      allowRecycled: true,
    });

    const row = await dbGet(
      `SELECT sv.version,
              sv.code,
              sv.created_at,
              sv.updated_by_user_id AS created_by_user_id,
              creator.username AS created_by_username
         FROM script_versions sv
         LEFT JOIN users creator ON creator.id = sv.updated_by_user_id
        WHERE sv.script_id=? AND sv.version=?`,
      [req.params.id, versionNumber],
    );
    if (!row) {
      if (versionNumber === 1) {
        const fallbackScript = await loadScriptWithOwner("s.id=?", [
          req.params.id,
        ]);
        if (fallbackScript) {
          res.json({
            version: 1,
            code: fallbackScript.code || "",
            created_at: fallbackScript.created_at || null,
            created_by_user_id:
              fallbackScript.last_version_user_id ||
              fallbackScript.owner_id ||
              null,
            created_by_username: fallbackScript.owner_username || null,
          });
          return;
        }
      }
      res.status(404).json({ error: "Version not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to load version", err);
    res.status(500).json({ error: "Failed to load version" });
  }
});

app.get("/api/scripts/:id/permissions", async (req, res) => {
  try {
    const { script, permissions } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "read",
      allowRecycled: true,
      allowDraft: true,
    });

    const canManage =
      req.user?.isAdmin || permissions.manage || script.owner_id === req.user?.id;
    if (!canManage) {
      res.status(403).json({ error: "Administrator or owner permissions required" });
      return;
    }

    const categoryRow =
      (script.category_id && (await loadCategoryById(script.category_id))) ||
      (await loadCategoryById(DEFAULT_CATEGORY_ID));

    const rows = await dbAll(
      `SELECT sp.user_id, u.username, u.is_admin, sp.can_read, sp.can_write, sp.can_delete, sp.can_run, sp.can_clear_logs
         FROM script_permissions sp
         JOIN users u ON u.id = sp.user_id AND u.deleted_at IS NULL
        WHERE sp.script_id=?
        ORDER BY u.username COLLATE NOCASE ASC`,
      [script.id],
    );

    const activeUsers = await dbAll(
      `SELECT id, username, is_admin FROM users
        WHERE is_active=1 AND deleted_at IS NULL
        ORDER BY username COLLATE NOCASE ASC`,
    );

    res.json({
      script: {
        id: script.id,
        name: script.name,
        endpoint: script.endpoint,
        ownerId: script.owner_id || null,
        ownerUsername: script.owner_username || null,
        requireAuthentication: script.require_authentication !== 0,
        includeAutomnResponseData: script.expose_automn_response !== 0,
        includeRunIdInResponse: script.expose_run_id !== 0,
        categoryId: script.category_id || DEFAULT_CATEGORY_ID,
        categoryName: categoryRow?.name || "",
        inheritCategoryPermissions:
          script.inherit_category_permissions !== 0,
      },
      permissions: rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        isAdmin: normalizeDbBoolean(row.is_admin),
        canRead: normalizeDbBoolean(row.can_read),
        canWrite: normalizeDbBoolean(row.can_write),
        canDelete: normalizeDbBoolean(row.can_delete),
        canRun: normalizeDbBoolean(row.can_run),
        canClearLogs: normalizeDbBoolean(row.can_clear_logs),
      })),
      users: activeUsers
        .filter((user) => user.id !== script.owner_id)
        .map((user) => ({
          id: user.id,
          username: user.username,
          isAdmin: normalizeDbBoolean(user.is_admin),
        })),
      category: categoryRow
        ? {
          id: categoryRow.id,
          name: categoryRow.name,
          description: categoryRow.description || "",
          defaultLanguage: categoryRow.default_language || null,
          isSystem: normalizeDbBoolean(categoryRow.is_system),
        }
        : null,
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to load script permissions", err);
    res.status(500).json({ error: "Failed to load script permissions" });
  }
});

app.post("/api/scripts/:id/permissions", async (req, res) => {
  const {
    permissions: entriesInput,
    requireAuthentication,
    inheritCategoryPermissions: inheritFromCategory,
    includeAutomnResponseData,
    includeRunIdInResponse,
  } = req.body || {};
  if (entriesInput !== undefined && !Array.isArray(entriesInput)) {
    res.status(400).json({ error: "Permissions payload must be an array" });
    return;
  }

  const entries = Array.isArray(entriesInput) ? entriesInput : [];

  try {
    const { script, permissions } = await ensureScriptAccess({
      scriptId: req.params.id,
      user: req.user,
      requiredPermission: "write",
      allowRecycled: true,
      allowDraft: true,
    });

    const canManage =
      req.user?.isAdmin || permissions.manage || script.owner_id === req.user?.id;
    if (!canManage) {
      res.status(403).json({ error: "Administrator or owner permissions required" });
      return;
    }

    if (typeof requireAuthentication === "boolean") {
      const nextValue = requireAuthentication ? 1 : 0;
      if (nextValue !== (script.require_authentication ? 1 : 0)) {
        await dbRun("UPDATE scripts SET require_authentication=? WHERE id=?", [
          nextValue,
          script.id,
        ]);
        script.require_authentication = nextValue;
      }
    }

    if (typeof inheritFromCategory === "boolean") {
      const nextValue = inheritFromCategory ? 1 : 0;
      if (nextValue !== (script.inherit_category_permissions ? 1 : 0)) {
        await dbRun(
          "UPDATE scripts SET inherit_category_permissions=? WHERE id=?",
          [nextValue, script.id],
        );
        script.inherit_category_permissions = nextValue;
      }
    }

    if (typeof includeAutomnResponseData === "boolean") {
      const nextValue = includeAutomnResponseData ? 1 : 0;
      if (nextValue !== (script.expose_automn_response ? 1 : 0)) {
        await dbRun(
          "UPDATE scripts SET expose_automn_response=? WHERE id=?",
          [nextValue, script.id],
        );
        script.expose_automn_response = nextValue;
      }
    }

    if (typeof includeRunIdInResponse === "boolean") {
      const nextValue = includeRunIdInResponse ? 1 : 0;
      if (nextValue !== (script.expose_run_id ? 1 : 0)) {
        await dbRun("UPDATE scripts SET expose_run_id=? WHERE id=?", [
          nextValue,
          script.id,
        ]);
        script.expose_run_id = nextValue;
      }
    }

    const normalized = new Map();
    for (const entry of entries) {
      const userId = typeof entry?.userId === "string" ? entry.userId.trim() : "";
      if (!userId || userId === script.owner_id) continue;
      const canWrite = Boolean(entry?.canWrite);
      const canDelete = Boolean(entry?.canDelete);
      const canRun = Boolean(entry?.canRun);
      const canClearLogs = Boolean(entry?.canClearLogs);
      const canRead = Boolean(entry?.canRead) || canWrite || canDelete || canClearLogs;
      normalized.set(userId, {
        userId,
        canRead,
        canWrite,
        canDelete,
        canRun,
        canClearLogs,
      });
    }

    const userIds = Array.from(normalized.keys());
    if (userIds.length) {
      const placeholders = userIds.map(() => "?").join(",");
      const existingUsers = await dbAll(
        `SELECT id FROM users WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        userIds,
      );
      const validIds = new Set(existingUsers.map((row) => row.id));
      for (const id of Array.from(normalized.keys())) {
        if (!validIds.has(id)) normalized.delete(id);
      }
    }

    if (inheritFromCategory === true) {
      normalized.clear();
    }

    if (normalized.size === 0) {
      await dbRun(`DELETE FROM script_permissions WHERE script_id=?`, [script.id]);
    } else {
      const keepIds = Array.from(normalized.keys());
      const deletePlaceholders = keepIds.map(() => "?").join(",");
      await dbRun(
        `DELETE FROM script_permissions WHERE script_id=? AND user_id NOT IN (${deletePlaceholders})`,
        [script.id, ...keepIds],
      );
      for (const { userId, canRead, canWrite, canDelete, canRun, canClearLogs } of normalized.values()) {
        await dbRun(
          `INSERT INTO script_permissions (id, script_id, user_id, can_read, can_write, can_delete, can_run, can_clear_logs, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(script_id, user_id) DO UPDATE SET
             can_read=excluded.can_read,
             can_write=excluded.can_write,
             can_delete=excluded.can_delete,
             can_run=excluded.can_run,
             can_clear_logs=excluded.can_clear_logs,
             updated_at=CURRENT_TIMESTAMP`,
          [
            uuidv4(),
            script.id,
            userId,
            canRead ? 1 : 0,
            canWrite ? 1 : 0,
            canDelete ? 1 : 0,
            canRun ? 1 : 0,
            canClearLogs ? 1 : 0,
          ],
        );
      }
    }

    const rows = await dbAll(
      `SELECT sp.user_id, u.username, u.is_admin, sp.can_read, sp.can_write, sp.can_delete, sp.can_run, sp.can_clear_logs
         FROM script_permissions sp
         JOIN users u ON u.id = sp.user_id
        WHERE sp.script_id=?
        ORDER BY u.username COLLATE NOCASE ASC`,
      [script.id],
    );

    registerScriptRoute({
      ...script,
      require_authentication: script.require_authentication,
    });

    res.json({
      updated: true,
      script: {
        id: script.id,
        name: script.name,
        endpoint: script.endpoint,
        ownerId: script.owner_id || null,
        ownerUsername: script.owner_username || null,
        requireAuthentication: script.require_authentication !== 0,
        includeAutomnResponseData: script.expose_automn_response !== 0,
        includeRunIdInResponse: script.expose_run_id !== 0,
        categoryId: script.category_id || DEFAULT_CATEGORY_ID,
        inheritCategoryPermissions:
          script.inherit_category_permissions !== 0,
        acceptedMethods: normalizeAcceptedMethods(
          script.allowed_methods || script.acceptedMethods,
          { ensure: [script.run_method || "POST"] },
        ),
      },
      permissions: rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        isAdmin: normalizeDbBoolean(row.is_admin),
        canRead: normalizeDbBoolean(row.can_read),
        canWrite: normalizeDbBoolean(row.can_write),
        canDelete: normalizeDbBoolean(row.can_delete),
        canRun: normalizeDbBoolean(row.can_run),
        canClearLogs: normalizeDbBoolean(row.can_clear_logs),
      })),
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to update script permissions", err);
    res.status(500).json({ error: "Failed to update script permissions" });
  }
});


// ─────────────────────────────────────────────
// System status
// ─────────────────────────────────────────────
app.get("/api/system/status", (_, res) =>
  res.json({
    activeWorkers: getActiveWorkerCount(),
    queuedJobs: queue.length,
    uptimeMs: process.uptime() * 1000,
    timestamp: new Date().toISOString(),
  })
);

// ─────────────────────────────────────────────
// Start server + WebSocket
// ─────────────────────────────────────────────
async function startServer() {
  try {
    await db.schemaReady;
  } catch (err) {
    console.error("Database not ready", err);
    process.exit(1);
  }

  const server = app.listen(PORT, () =>
    console.log(`🍂 Automn running on http://localhost:${PORT}`)
  );

  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, url);
      });
    } else socket.destroy();
  });

  wss.on("connection", async (ws, req, url) => {
    const auth = await authenticateRequest(req);
    if (!auth) {
      ws.close(1008, "Authentication required");
      return;
    }

    if (auth.user.mustChangePassword) {
      ws.close(1008, "Password change required");
      return;
    }

    const runId = url.searchParams.get("runId");
    if (!runId) {
      ws.close(1008, "Missing runId");
      return;
    }

    addSubscriber(runId, ws);
    ws.send(JSON.stringify({ info: `Subscribed to run ${runId}` }));
  });
}

startServer();

//
// LOGS
//

app.get("/api/logs", async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const normalizedSearch =
      typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const normalizedErrorTag =
      typeof req.query.errorTag === "string" ? req.query.errorTag.trim().toLowerCase() : "";
    const collectionId =
      typeof req.query.collectionId === "string" && req.query.collectionId.trim()
        ? req.query.collectionId.trim()
        : null;
    const scriptId =
      typeof req.query.scriptId === "string" && req.query.scriptId.trim()
        ? req.query.scriptId.trim()
        : null;
    const resultFilter =
      typeof req.query.result === "string" && req.query.result.trim()
        ? req.query.result.trim().toLowerCase()
        : null;
    const httpType =
      typeof req.query.httpType === "string" && req.query.httpType.trim()
        ? req.query.httpType.trim().toUpperCase()
        : null;

    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 200;

    const params = [user.id, user.id];
    let whereClause = "WHERE s.is_recycled = 0 AND s.is_draft = 0";

    if (!user.isAdmin) {
      whereClause +=
        " AND (s.owner_id = ? OR s.category_id = ? OR perms.can_read = 1 OR perms.can_write = 1 OR perms.can_delete = 1 OR perms.can_run = 1 OR perms.can_clear_logs = 1 OR (s.inherit_category_permissions <> 0 AND (cperms.can_read = 1 OR cperms.can_write = 1 OR cperms.can_delete = 1 OR cperms.can_run = 1 OR cperms.can_clear_logs = 1)))";
      params.push(user.id, DEFAULT_CATEGORY_ID);
    }

    if (collectionId) {
      whereClause += " AND s.category_id = ?";
      params.push(collectionId);
    }

    if (scriptId) {
      whereClause += " AND s.id = ?";
      params.push(scriptId);
    }

    if (resultFilter) {
      whereClause += " AND LOWER(r.status) = ?";
      params.push(resultFilter);
    }

    if (httpType) {
      whereClause += " AND LOWER(r.http_method) = ?";
      params.push(httpType.toLowerCase());
    }

    const rows = await dbAll(
      `SELECT r.id AS run_id, r.start_time, r.status, r.http_method, r.triggered_by, r.triggered_by_user_id,
              s.id AS script_id, s.name AS script_name, s.endpoint AS script_endpoint, s.category_id,
              c.name AS collection_name,
              u.username AS triggered_by_username, NULL AS triggered_by_display_name,
              l.automn_logs_json, l.stderr
         FROM runs r
         JOIN scripts s ON s.id = r.script_id
         LEFT JOIN categories c ON c.id = s.category_id
         LEFT JOIN users u ON u.id = r.triggered_by_user_id
         LEFT JOIN script_permissions perms ON perms.script_id = s.id AND perms.user_id = ?
         LEFT JOIN category_permissions cperms ON cperms.category_id = s.category_id AND cperms.user_id = ?
         LEFT JOIN logs l ON l.run_id = r.id
        ${whereClause}
        ORDER BY r.start_time DESC
        LIMIT ?`,
      [...params, limit],
    );

    const events = rows
      .map((row) => {
        let parsedLogs = [];
        if (row.automn_logs_json) {
          try {
            const parsed = JSON.parse(row.automn_logs_json);
            if (Array.isArray(parsed)) parsedLogs = parsed;
          } catch (err) {
            parsedLogs = [];
          }
        }

        const normalizedLogs = normalizeAutomnLogCollection(parsedLogs, {
          success: (row.status || "").toLowerCase() === "success",
          failureReason: row.stderr || "",
          errorCode: null,
          context: {
            httpMethod: row.http_method,
            scriptId: row.script_id,
            runId: row.run_id,
          },
        });

        const logTypes = Array.from(
          new Set(
            normalizedLogs
              .map((log) => (typeof log?.type === "string" ? log.type.toLowerCase() : ""))
              .filter(Boolean),
          ),
        );

        const errorTag = logTypes.find((type) => type === "authentication") || logTypes[0] || null;

        const searchableText = [
          row.script_name,
          row.script_endpoint,
          row.collection_name,
          row.triggered_by,
          errorTag,
          ...normalizedLogs.map((log) => log.message || ""),
        ]
          .filter(Boolean)
          .join(" \n ")
          .toLowerCase();

        if (normalizedSearch && !searchableText.includes(normalizedSearch)) {
          return null;
        }

        if (normalizedErrorTag && !logTypes.includes(normalizedErrorTag)) {
          return null;
        }

        const triggeredByName =
          row.triggered_by_display_name || row.triggered_by_username || null;
        const requestOrigin = row.http_method
          ? "API"
          : row.triggered_by || row.triggered_by_username || "Host";

        return {
          runId: row.run_id,
          timestamp: row.start_time,
          scriptId: row.script_id,
          scriptName: row.script_name || row.script_endpoint,
          scriptEndpoint: row.script_endpoint,
          collectionId: row.category_id || null,
          collectionName: row.collection_name || "Uncategorized",
          result: row.status || "unknown",
          httpType: row.http_method || null,
          requestType: row.http_method || row.triggered_by || null,
          requestOrigin,
          triggeredBy: row.triggered_by || null,
          triggeredByUserId: row.triggered_by_user_id || null,
          triggeredByUserName: triggeredByName,
          errorTag,
          errorTags: logTypes,
          message: normalizedLogs[0]?.message || row.stderr || "",
        };
      })
      .filter(Boolean);

    res.json({ events, total: events.length });
  } catch (err) {
    console.error("Failed to load consolidated logs", err);
    res.status(500).json({ error: "Failed to load consolidated logs" });
  }
});

// ─────────────────────────────
// Run history / analytics
// ─────────────────────────────
app.get("/api/logs/:endpoint", async (req, res) => {
  try {
    const { script } = await ensureScriptAccess({
      endpoint: req.params.endpoint,
      user: req.user,
      requiredPermission: "read",
      allowRecycled: true,
    });

    const rows = await dbAll(
      `SELECT
         r.id AS run_id,
         r.start_time,
         r.end_time,
         r.duration_ms,
         r.status,
         r.return_json,
         r.code_version,
         r.triggered_by,
         r.triggered_by_user_id,
         r.http_method,
         l.stdout,
         l.stderr,
         l.exit_code,
         l.automn_logs_json,
         l.automn_notifications_json,
         l.input_json
       FROM runs r
       LEFT JOIN logs l ON l.run_id = r.id
       WHERE r.script_id=?
       ORDER BY r.start_time DESC
       LIMIT 20`,
      [script.id],
    );

    if (!rows || rows.length === 0) {
      res.json({
        endpoint: script.endpoint,
        runs: [],
        totalRuns: 0,
        avgDuration: 0,
        successRate: 0,
        history: [],
      });
      return;
    }

    const runs = rows.map((row) => {
      let returnValue = null;
      try {
        returnValue = JSON.parse(row.return_json || "null");
      } catch (e) {
        returnValue = null;
      }

      let automnLogs = [];
      if (row.automn_logs_json) {
        try {
          const parsed = JSON.parse(row.automn_logs_json);
          if (Array.isArray(parsed)) automnLogs = parsed;
        } catch (e) {
          automnLogs = [];
        }
      }
      automnLogs.sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
      const automnLogTypes = Array.from(
        new Set(
          automnLogs
            .map((log) => (log?.type || "").toLowerCase())
            .filter((type) => type && typeof type === "string"),
        ),
      );
      const hasAuthenticationLog = automnLogTypes.includes("authentication");

      let automnNotifications = [];
      if (row.automn_notifications_json) {
        try {
          const parsed = JSON.parse(row.automn_notifications_json);
          if (Array.isArray(parsed)) automnNotifications = parsed;
        } catch (e) {
          automnNotifications = [];
        }
      }
      automnNotifications.sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));

      let inputPayload = null;
      if (row.input_json) {
        try {
          inputPayload = JSON.parse(row.input_json);
        } catch (e) {
          inputPayload = row.input_json;
        }
      }

      return {
        run_id: row.run_id,
        start_time: row.start_time,
        end_time: row.end_time,
        duration_ms: row.duration_ms,
        status: row.status,
        input: inputPayload,
        return: returnValue,
        stdout: row.stdout || "",
        stderr: row.stderr || "",
        exit_code: row.exit_code,
        code_version: row.code_version,
        http_method: row.http_method || null,
        automn_logs: automnLogs,
        automn_log_types: automnLogTypes,
        has_authentication_log: hasAuthenticationLog,
        automn_notifications: automnNotifications,
        triggered_by: row.triggered_by || null,
        triggered_by_user_id: row.triggered_by_user_id || null,
      };
    });

    const totalRuns = runs.length;
    const avgDuration = totalRuns
      ? Math.round(runs.reduce((acc, item) => acc + (item.duration_ms || 0), 0) / totalRuns)
      : 0;
    const successCount = runs.filter((item) => item.status === "success").length;
    const successRate = totalRuns ? Math.round((successCount / totalRuns) * 100) : 0;

    res.json({
      endpoint: script.endpoint,
      totalRuns,
      avgDuration,
      successRate,
      runs,
      history: runs,
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("Failed to load script logs", err);
    res.status(500).json({ error: "Failed to load script logs" });
  }
});


// ─────────────────────────────────────────────
// Bootstrap existing scripts
// ─────────────────────────────────────────────
ensureAllScriptsHaveToken()
  .catch((err) => console.error("Failed to seed script tokens", err))
  .finally(() => {
    registerDynamicRoutes();
  });
