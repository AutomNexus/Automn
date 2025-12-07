const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const fsp = fs.promises;

const {
  sanitizeExecutable,
  sanitizeIdentifier,
  prepareSpawnOptions,
  ensureWindowsChildCleanup,
  getPackageCacheSummary,
  clearPackageCache,
  rehydratePackageCache,
  extractNodeDependencies,
  usesNodeEsmSyntax,
  ensureNodeDependencies,
  NodeDependencyInstallError,
  commandExists,
  formatCommandLine,
} = require("./package-manager");

const powerShellLauncherCache = new Map();
const pythonCommandCache = new Map();
const shellCommandCache = new Map();

function resolveWindowsShellExecutable() {
  const override = sanitizeExecutable(
    process.env.COMSPEC || process.env.ComSpec || ""
  );
  if (override) {
    return override;
  }
  return "cmd.exe";
}

function shouldWrapWindowsCommand(command) {
  if (process.platform !== "win32") {
    return false;
  }
  const normalized = sanitizeExecutable(command || "");
  if (!normalized) {
    return false;
  }
  const ext = path.extname(normalized).toLowerCase();
  if (!ext) {
    return true;
  }
  return ext === ".cmd" || ext === ".bat" || ext === ".ps1";
}

function createSpawnCommandPlan(command, args = []) {
  const sanitizedCommand = sanitizeExecutable(command || "") || command;
  const normalizedArgs = Array.isArray(args) ? args : [];
  const displayCommandLine = formatCommandLine(
    sanitizedCommand,
    normalizedArgs
  );

  if (process.platform === "win32" && shouldWrapWindowsCommand(command)) {
    const shellExecutable = resolveWindowsShellExecutable();
    return {
      command: shellExecutable,
      args: ["/d", "/s", "/c", displayCommandLine],
      displayCommandLine,
      shellWrapped: true,
      originalCommand: sanitizedCommand,
      originalArgs: normalizedArgs,
    };
  }

  return {
    command: sanitizedCommand,
    args: normalizedArgs,
    displayCommandLine,
    shellWrapped: false,
    originalCommand: sanitizedCommand,
    originalArgs: normalizedArgs,
  };
}

function resolvePythonCommand(preferredExecutable) {
  const sanitizedPreferred = sanitizeExecutable(preferredExecutable || "");
  const cacheKey = sanitizedPreferred || "<auto>";
  if (pythonCommandCache.has(cacheKey)) {
    return pythonCommandCache.get(cacheKey);
  }

  const probeArgs = ["--version"];
  const candidates = [];
  const seen = new Set();
  const addCandidate = (command, args = probeArgs) => {
    const sanitized = sanitizeExecutable(command || "");
    if (!sanitized) {
      return;
    }
    const key = `${sanitized.toLowerCase()}::${Array.isArray(args) ? args.join("\u0000") : ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ command: sanitized, args: Array.isArray(args) ? args : probeArgs });
  };

  if (sanitizedPreferred) {
    addCandidate(sanitizedPreferred);
  }

  addCandidate("python3");
  addCandidate("python");
  if (process.platform === "win32") {
    addCandidate("py");
    addCandidate("py", ["-3", "--version"]);
  }

  let resolved = null;
  for (const candidate of candidates) {
    if (commandExists(candidate.command, candidate.args)) {
      resolved = candidate.command;
      break;
    }
  }

  pythonCommandCache.set(cacheKey, resolved);
  return resolved;
}

function resetPythonCommandCache() {
  pythonCommandCache.clear();
}

function resolvePowerShellLauncher(preferredExecutable = null) {
  const preferred = sanitizeExecutable(preferredExecutable || "");
  const envCandidatesRaw = [
    process.env.AUTOMN_RUNNER_POWERSHELL_PATH,
    process.env.AUTOMN_POWERSHELL_PATH,
  ];
  const envCandidates = envCandidatesRaw
    .map((value) => sanitizeExecutable(value || ""))
    .filter((value) => Boolean(value));

  const cacheKey = JSON.stringify({
    preferred: preferred || null,
    env: envCandidates,
    platform: process.platform,
  });

  if (powerShellLauncherCache.has(cacheKey)) {
    return powerShellLauncherCache.get(cacheKey);
  }

  const baseArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"];
  const baseProbe = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit"];
  const windowsArgs = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ];
  const windowsProbe = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "exit",
  ];

  const baseCandidates = [];
  const seenCommands = new Set();
  const addCandidate = (command, args, probe) => {
    if (!command) {
      return;
    }
    const key = command.toLowerCase();
    if (seenCommands.has(key)) {
      return;
    }
    seenCommands.add(key);
    baseCandidates.push({ command, args, probe });
  };

  const addPreferred = (command) => {
    if (!command) return;
    if (process.platform === "win32") {
      addCandidate(command, windowsArgs, windowsProbe);
    } else {
      addCandidate(command, baseArgs, baseProbe);
    }
  };

  addPreferred(preferred);
  for (const candidate of envCandidates) {
    addPreferred(candidate);
  }

  addCandidate("pwsh", baseArgs, baseProbe);

  if (process.platform === "win32") {
    const ensureWindowsPathCandidate = (candidatePath) => {
      const normalized = sanitizeExecutable(candidatePath);
      if (!normalized) {
        return;
      }
      try {
        if (!fs.existsSync(normalized)) {
          return;
        }
      } catch (err) {
        return;
      }
      addCandidate(normalized, windowsArgs, windowsProbe);
    };

    const systemRoot = sanitizeExecutable(
      process.env.SystemRoot || process.env.WINDIR || ""
    );
    if (systemRoot) {
      ensureWindowsPathCandidate(
        path.join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe"
        )
      );
      ensureWindowsPathCandidate(
        path.join(
          systemRoot,
          "Sysnative",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe"
        )
      );
    }

    const programFiles = [
      sanitizeExecutable(process.env["ProgramFiles"] || ""),
      sanitizeExecutable(process.env["ProgramFiles(x86)"] || ""),
    ];

    for (const baseDir of programFiles) {
      if (!baseDir) {
        continue;
      }
      ensureWindowsPathCandidate(path.join(baseDir, "PowerShell", "7", "pwsh.exe"));
      ensureWindowsPathCandidate(
        path.join(baseDir, "PowerShell", "7-preview", "pwsh.exe")
      );
    }

    addCandidate("powershell", windowsArgs, windowsProbe);
    addCandidate("powershell.exe", windowsArgs, windowsProbe);
  } else {
    addCandidate("powershell", baseArgs, baseProbe);
  }

  for (const candidate of baseCandidates) {
    if (commandExists(candidate.command, candidate.probe)) {
      const launcher = {
        command: candidate.command,
        args: candidate.args,
      };
      powerShellLauncherCache.set(cacheKey, launcher);
      return launcher;
    }
  }

  const fallbackLauncher = {
    command: "pwsh",
    args: process.platform === "win32" ? windowsArgs : baseArgs,
  };
  powerShellLauncherCache.set(cacheKey, fallbackLauncher);
  return fallbackLauncher;
}

function resolveShellExecutable(preferredExecutable = null) {
  const preferred = sanitizeExecutable(preferredExecutable || "");
  const cacheKey = preferred || process.platform;

  if (shellCommandCache.has(cacheKey)) {
    return shellCommandCache.get(cacheKey);
  }

  const candidates = [];
  const addCandidate = (command) => {
    if (!command) return;
    const sanitized = sanitizeExecutable(command);
    if (!sanitized) return;
    candidates.push(sanitized);
  };

  addCandidate(preferred);
  addCandidate("bash");
  addCandidate("sh");
  if (process.platform === "win32") {
    addCandidate(resolveWindowsShellExecutable());
  }

  let resolved = null;
  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      resolved = candidate;
      break;
    }
  }

  shellCommandCache.set(cacheKey, resolved);
  return resolved;
}

const RETURN_MARKER = "__SCRIPTRETURN__";
const LOG_MARKER = "__SCRIPTLOG__";
const NOTIFY_MARKER = "__SCRIPTNOTIFY__";

function bufferFromChunk(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk === undefined || chunk === null) return Buffer.alloc(0);
  return Buffer.from(String(chunk));
}

function bufferLooksUtf16(buffer) {
  if (!buffer || buffer.length < 2) return false;
  const sampleLength = Math.min(buffer.length - (buffer.length % 2), 32);
  if (sampleLength < 2) return false;

  let pairs = 0;
  let zeroPairs = 0;
  for (let i = 0; i < sampleLength; i += 2) {
    pairs += 1;
    if (buffer[i + 1] === 0) zeroPairs += 1;
  }

  return pairs > 0 && zeroPairs / pairs >= 0.6;
}

function createStreamDecoder(language) {
  if (language !== "powershell") {
    return {
      write(chunk) {
        if (chunk === undefined || chunk === null) return "";
        if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
        return String(chunk);
      },
      flush() {
        return "";
      },
    };
  }

  let remainder = Buffer.alloc(0);
  let detectedUtf16 = false;
  let needsSwap = false;
  let pendingBomRemoval = false;

  const decodeChunk = (inputBuffer) => {
    if (!inputBuffer.length) return "";

    if (!detectedUtf16 && inputBuffer.length >= 2) {
      const first = inputBuffer[0];
      const second = inputBuffer[1];
      if (first === 0xff && second === 0xfe) {
        detectedUtf16 = true;
        pendingBomRemoval = true;
      } else if (first === 0xfe && second === 0xff) {
        detectedUtf16 = true;
        needsSwap = true;
        pendingBomRemoval = true;
      } else if (bufferLooksUtf16(inputBuffer)) {
        detectedUtf16 = true;
      }
    }

    let utf8Text = "";
    try {
      utf8Text = inputBuffer.toString("utf8");
    } catch (err) {
      utf8Text = "";
    }

    const hasNull = utf8Text.includes("\u0000");
    if (!detectedUtf16 && !hasNull) {
      return utf8Text;
    }

    if (!detectedUtf16) {
      detectedUtf16 = true;
    }

    let working = inputBuffer;
    if (needsSwap && working.length >= 2) {
      working = Buffer.from(working);
      working.swap16();
    }

    if (working.length % 2 === 1) {
      remainder = working.slice(working.length - 1);
      working = working.slice(0, -1);
    }

    if (!working.length) return "";

    let text = working.toString("utf16le");
    if (pendingBomRemoval) {
      pendingBomRemoval = false;
      text = text.replace(/^\uFEFF/, "");
    }

    return text.replace(/\u0000/g, "");
  };

  return {
    write(chunk) {
      let buffer = bufferFromChunk(chunk);
      if (!buffer.length) return "";

      if (remainder.length) {
        buffer = Buffer.concat([remainder, buffer]);
        remainder = Buffer.alloc(0);
      }

      const decoded = decodeChunk(buffer);
      return decoded;
    },
    flush() {
      if (!remainder.length) return "";
      const buffer = remainder;
      remainder = Buffer.alloc(0);
      const decoded = decodeChunk(buffer);
      remainder = Buffer.alloc(0);
      return decoded;
    },
  };
}

function extractReturnPayload(stdout) {
  if (typeof stdout !== "string") {
    return {
      strippedStdout: "",
      returnData: null,
      hadMarker: false,
      parseError: null,
    };
  }

  const markerIndex = stdout.indexOf(RETURN_MARKER);
  if (markerIndex === -1) {
    return {
      strippedStdout: stdout,
      returnData: null,
      hadMarker: false,
      parseError: null,
    };
  }

  const afterMarker = stdout.slice(markerIndex + RETURN_MARKER.length);
  const newlineIdx = afterMarker.indexOf("\n");
  let payload = newlineIdx === -1 ? afterMarker : afterMarker.slice(0, newlineIdx);
  let remainder = newlineIdx === -1 ? "" : afterMarker.slice(newlineIdx + 1);

  if (payload.endsWith("\r")) {
    payload = payload.slice(0, -1);
  }

  let returnData = null;
  let parseError = null;
  try {
    returnData = JSON.parse(payload);
  } catch (err) {
    parseError = err;
  }

  const strippedStdout = `${stdout.slice(0, markerIndex)}${remainder}`;
  return {
    strippedStdout,
    returnData,
    hadMarker: true,
    parseError,
  };
}

function extractStructuredNotifications(rawOutput) {
  if (!rawOutput) {
    return { cleanedStdout: "", notifications: [] };
  }

  const notifications = [];
  let cleaned = "";
  let remaining = rawOutput || "";

  while (remaining.length) {
    const idx = remaining.indexOf(NOTIFY_MARKER);
    if (idx === -1) {
      cleaned += remaining;
      break;
    }

    cleaned += remaining.slice(0, idx);
    remaining = remaining.slice(idx + NOTIFY_MARKER.length);

    const newlineIdx = remaining.indexOf("\n");
    let jsonPart = newlineIdx === -1 ? remaining : remaining.slice(0, newlineIdx);
    if (newlineIdx === -1) {
      remaining = "";
    } else {
      remaining = remaining.slice(newlineIdx + 1);
    }

    if (jsonPart.endsWith("\r")) jsonPart = jsonPart.slice(0, -1);

    if (notifications.length >= 50) {
      cleaned += jsonPart;
      if (newlineIdx !== -1) cleaned += "\n";
      continue;
    }

    try {
      const parsed = JSON.parse(jsonPart);
      const audienceSource =
        typeof parsed?.audience === "string"
          ? parsed.audience
          : typeof parsed?.target === "string"
          ? parsed.target
          : typeof parsed?.user === "string"
          ? parsed.user
          : typeof parsed?.scope === "string"
          ? parsed.scope
          : null;
      const audience =
        audienceSource && audienceSource.trim()
          ? audienceSource.trim().slice(0, 256)
          : null;
      let messageValue = parsed?.message;
      if (messageValue === null || messageValue === undefined) {
        messageValue = parsed?.text;
      }
      const message =
        messageValue === null || messageValue === undefined
          ? ""
          : String(messageValue).slice(0, 2000);
      const levelValue =
        typeof parsed?.level === "string"
          ? parsed.level
          : typeof parsed?.type === "string"
          ? parsed.type
          : "info";
      const normalizedLevel = String(levelValue || "info")
        .toLowerCase()
        .trim();
      const level =
        normalizedLevel === "error" || normalizedLevel === "warn"
          ? normalizedLevel
          : "info";

      notifications.push({
        order: notifications.length,
        audience,
        message,
        level,
        raw: parsed,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      cleaned += NOTIFY_MARKER + jsonPart;
    }

    if (newlineIdx !== -1) cleaned += "\n";
  }

  return { cleanedStdout: cleaned, notifications };
}

function extractStructuredLogs(rawOutput) {
  const marker = LOG_MARKER;
  const logs = [];
  let cleaned = "";
  let remaining = rawOutput || "";

  const normalizeLevel = (value) => {
    const normalized = typeof value === "string" ? value.toLowerCase().trim() : "";
    if (normalized === "warn" || normalized === "warning") return "warn";
    if (normalized === "error") return "error";
    if (normalized === "success") return "success";
    if (normalized === "debug") return "debug";
    return "info";
  };

  const normalizeType = (value) => {
    const rawType =
      typeof value === "string"
        ? value
        : typeof value?.category === "string"
          ? value.category
          : null;
    const normalized = rawType ? rawType.trim().toLowerCase() : "";
    return normalized || "general";
  };

  const normalizeContext = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (value === undefined || value === null) return {};
    return { value };
  };

  while (remaining.length) {
    const idx = remaining.indexOf(marker);
    if (idx === -1) {
      cleaned += remaining;
      break;
    }

    cleaned += remaining.slice(0, idx);
    remaining = remaining.slice(idx + marker.length);

    const newlineIdx = remaining.indexOf("\n");
    let jsonPart = newlineIdx === -1 ? remaining : remaining.slice(0, newlineIdx);
    if (newlineIdx === -1) {
      remaining = "";
    } else {
      remaining = remaining.slice(newlineIdx + 1);
    }

    if (jsonPart.endsWith("\r")) jsonPart = jsonPart.slice(0, -1);

    try {
      const parsed = JSON.parse(jsonPart);
      const messageValue =
        parsed.message === null || parsed.message === undefined
          ? ""
          : parsed.message;
      logs.push({
        message: typeof messageValue === "string" ? messageValue : String(messageValue),
        level: normalizeLevel(parsed.level),
        type: normalizeType(parsed.type ?? parsed.category),
        context: normalizeContext(parsed.context),
        order: logs.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      cleaned += marker + jsonPart;
    }

    if (newlineIdx !== -1) cleaned += "\n";
  }

  return { cleanedStdout: cleaned, logs };
}

function safeCloneInput(input) {
  try {
    return JSON.parse(JSON.stringify(input ?? {}));
  } catch (err) {
    return input ?? null;
  }
}

function safeStringifyInput(input) {
  try {
    return JSON.stringify(input ?? {});
  } catch (err) {
    return JSON.stringify({
      error: "Failed to serialize input payload",
      message: err.message,
    });
  }
}

async function executeScript({
  script,
  reqBody = {},
  onLog,
  runId: providedRunId,
  scriptsRoot = path.join(__dirname, "scripts"),
  workdirRoot = path.join(__dirname, "script_workdir"),
  executables = {},
}) {
  const inputSnapshot = safeCloneInput(reqBody);
  const runId = providedRunId || script?.preassignedRunId || uuidv4();

  if (!script || typeof script !== "object") {
    return {
      runId,
      stdout: "",
      stderr: "Invalid script payload",
      code: 1,
      duration: 0,
      returnData: null,
      automnLogs: [],
      automnNotifications: [],
      input: inputSnapshot,
    };
  }

  if (!script.language || typeof script.code !== "string") {
    return {
      runId,
      stdout: "",
      stderr: "Unsupported language",
      code: 1,
      duration: 0,
      returnData: null,
      automnLogs: [],
      automnNotifications: [],
      input: inputSnapshot,
    };
  }

  const extMap = {
    python: "py",
    powershell: "ps1",
    shell: "sh",
  };
  let ext = "txt";

  const runtimeExecutables = {
    node: sanitizeExecutable(executables.node || ""),
    python: sanitizeExecutable(executables.python || ""),
    powershell: sanitizeExecutable(executables.powershell || ""),
    shell: sanitizeExecutable(executables.shell || ""),
  };

  const scriptIdentifier = script.id || script.preassignedRunId || runId;
  let workingDirectory = scriptsRoot;
  let cleanupTarget = null;

  try {
    if (script.language === "node") {
      workingDirectory = path.join(
        workdirRoot,
        sanitizeIdentifier(scriptIdentifier)
      );
      try {
        await ensureNodeDependencies(script, workingDirectory, onLog, {
          workdirRoot,
          scriptIdentifier,
          directoryKey: path.basename(workingDirectory),
        });
      } catch (err) {
        if (
          err instanceof NodeDependencyInstallError ||
          err?.code === "NODE_DEPENDENCY_INSTALL_FAILED"
        ) {
          const missing = Array.isArray(err?.missing) ? err.missing : [];
          const detailMessage = err?.message
            ? String(err.message)
            : missing.length
            ? `Failed to install npm dependencies: ${missing.join(", ")}`
            : "Failed to install npm dependencies";
          if (onLog) {
            onLog(`${detailMessage}\n`, { stream: "stderr" });
          }
          return {
            runId,
            stdout: "",
            stderr: detailMessage,
            code: 90,
            duration: 0,
            returnData: null,
            automnLogs: [
              { level: "error", message: detailMessage, type: "system" },
            ],
            automnNotifications: [],
            input: inputSnapshot,
            clientMessage: "Try again later",
            errorCode: err?.code || "NODE_DEPENDENCY_INSTALL_FAILED",
          };
        }
        throw err;
      }
      ext = usesNodeEsmSyntax(script.code) ? "mjs" : "cjs";
    } else {
      ext = extMap[script.language] || ext;
      await fsp.mkdir(scriptsRoot, { recursive: true });
    }

    const tmpPath = path.join(workingDirectory, `${uuidv4()}.${ext}`);
    cleanupTarget = tmpPath;

    const injected = {
      node: `
      global.AutomnRunId = ${JSON.stringify(runId)};
      const AUTOMN_RETURN_MARKER = ${JSON.stringify(RETURN_MARKER)};
      const AUTOMN_LOG_MARKER = ${JSON.stringify(LOG_MARKER)};
      const AUTOMN_NOTIFY_MARKER = ${JSON.stringify(NOTIFY_MARKER)};
      const normalizeNotifyLevel = (value) => {
        const normalized = typeof value === "string" ? value.toLowerCase() : "";
        return normalized === "warn" || normalized === "error" ? normalized : "info";
      };
      const serializeRunLogValue = (value) => {
        if (typeof value === "string") return value;
        try { return JSON.stringify(value, null, 2); }
        catch (err) { return String(value); }
      };
      global.AutomnReturn = (data) => {
        try { console.log(AUTOMN_RETURN_MARKER + JSON.stringify(data)); }
        catch(e){ console.error("Failed to serialize AutomnReturn data:", e); }
      };
      global.AutomnLog = (message, level = "info", context = {}, type = "general") => {
        try { console.log(AUTOMN_LOG_MARKER + JSON.stringify({ message, level, context, type })); }
        catch(e){ console.error("Failed to serialize AutomnLog data:", e); }
      };
      global.AutomnRunLog = (...values) => {
        try {
          const output = values.map(serializeRunLogValue).join(" ");
          console.log(output);
        }
        catch(e){ console.error("Failed to serialize AutomnRunLog data:", e); }
      };
      global.AutomnNotify = (audience, message, level = "info") => {
        try {
          const payload = {
            audience,
            message,
            level: normalizeNotifyLevel(level),
          };
          console.log(AUTOMN_NOTIFY_MARKER + JSON.stringify(payload));
        }
        catch(e){ console.error("Failed to serialize AutomnNotify data:", e); }
      };
      ${script.code}
    `,
      python: `
import json,sys,os
AUTOMN_RUN_ID = ${JSON.stringify(runId)}
AUTOMN_RETURN_MARKER = ${JSON.stringify(RETURN_MARKER)}
AUTOMN_LOG_MARKER = ${JSON.stringify(LOG_MARKER)}
AUTOMN_NOTIFY_MARKER = ${JSON.stringify(NOTIFY_MARKER)}
def AutomnReturn(data):
  try: print(AUTOMN_RETURN_MARKER+json.dumps(data))
  except Exception as e: print("Failed to serialize AutomnReturn data:",e,file=sys.stderr)
def AutomnLog(message, level="info", context=None, log_type="general"):
  try: print(AUTOMN_LOG_MARKER+json.dumps({"message": message, "level": level, "context": context, "type": log_type}))
  except Exception as e: print("Failed to serialize AutomnLog data:",e,file=sys.stderr)
def AutomnNotify(audience, message, level="info"):
  try:
    normalized_level = level.lower() if isinstance(level, str) else "info"
    payload = {
      "audience": audience,
      "message": message,
      "level": normalized_level if normalized_level in ("warn", "error") else "info"
    }
    print(AUTOMN_NOTIFY_MARKER+json.dumps(payload))
  except Exception as e:
    print("Failed to serialize AutomnNotify data:",e,file=sys.stderr)
def _automn_run_log_value(value):
  if isinstance(value, str):
    return value
  try:
    return json.dumps(value, indent=2)
  except Exception:
    return str(value)
def AutomnRunLog(*values):
  try:
    print(" ".join(_automn_run_log_value(v) for v in values))
  except Exception as e:
    print("Failed to serialize AutomnRunLog data:",e,file=sys.stderr)
${script.code}
    `,
      powershell: `
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
if (-not $PSDefaultParameterValues) { $global:PSDefaultParameterValues = @{} }
$PSDefaultParameterValues["Out-File:Encoding"] = "utf8"
$Global:AutomnRunId = "${runId}"
$AutomnReturnMarker = ${JSON.stringify(RETURN_MARKER)}
$AutomnLogMarker = ${JSON.stringify(LOG_MARKER)}
$AutomnNotifyMarker = ${JSON.stringify(NOTIFY_MARKER)}
$AutomnJsonDepth = 32
$AutomnInternalInputEnvKeys = @("AUTOMN_INTERNAL_INPUT_JSON", "AUTOMN_INPUT_JSON", "INPUT_JSON")
$Global:AutomnInternalInputJson = $null
$Global:AutomnInternalInput = $null
$Global:AutomnInternalInputError = $null
foreach ($AutomnInternalInputEnvKey in $AutomnInternalInputEnvKeys) {
  $candidate = [System.Environment]::GetEnvironmentVariable($AutomnInternalInputEnvKey)
  if (-not [string]::IsNullOrWhiteSpace($candidate)) {
    $Global:AutomnInternalInputJson = $candidate
    break
  }
}
if (-not [string]::IsNullOrWhiteSpace($Global:AutomnInternalInputJson)) {
  try {
    $Global:AutomnInternalInput = $Global:AutomnInternalInputJson | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    $Global:AutomnInternalInputError = $_.Exception.Message
  }
}
function AutomnGetInternalInputJson {
  return $Global:AutomnInternalInputJson
}
function AutomnGetInternalInput {
  return $Global:AutomnInternalInput
}
function AutomnGetInternalInputError {
  return $Global:AutomnInternalInputError
}
function AutomnHasInternalInputError {
  return -not [string]::IsNullOrWhiteSpace($Global:AutomnInternalInputError)
}
function AutomnReturn([object]$data) {
  try { Write-Output ($AutomnReturnMarker + (ConvertTo-Json $data -Depth $AutomnJsonDepth -Compress)) }
  catch { Write-Error "Failed to serialize AutomnReturn data: $_" }
}
function AutomnLog {
  param(
    [Parameter(Mandatory=$true)][string]$Message,
    [string]$Level = "info",
    $Context = $null,
    [string]$Type = "general"
  )
  try {
    $payload = @{ message = $Message; level = $Level; context = $Context; type = $Type } | ConvertTo-Json -Depth $AutomnJsonDepth -Compress
    Write-Output ($AutomnLogMarker + $payload)
  }
  catch { Write-Error "Failed to serialize AutomnLog data: $_" }
}
function AutomnRunLog {
  param(
    [Parameter(ValueFromRemainingArguments=$true)][object[]]$Values
  )
  if (-not $Values) { $Values = @() }
  try {
    $formatted = @()
    foreach ($value in $Values) {
      if ($value -is [string]) {
        $formatted += $value
        continue
      }
      try {
        $formatted += ($value | ConvertTo-Json -Depth $AutomnJsonDepth -Compress)
      }
      catch {
        $formatted += ($value | Out-String).Trim()
      }
    }
    Write-Output ($formatted -join " ")
  }
  catch { Write-Error "Failed to serialize AutomnRunLog data: $_" }
}
function AutomnNotify {
  param(
    [Parameter(Mandatory=$true)]$Audience,
    [Parameter(Mandatory=$true)]$Message,
    [string]$Level = "info"
  )
  try {
    $normalized = if ($Level -eq "warn" -or $Level -eq "error") { $Level } else { "info" }
    $payload = @{ audience = $Audience; message = $Message; level = $normalized } | ConvertTo-Json -Depth $AutomnJsonDepth -Compress
    Write-Output ($AutomnNotifyMarker + $payload)
  }
  catch { Write-Error "Failed to serialize AutomnNotify data: $_" }
}
${script.code}
    `,
      shell: `#!/bin/sh
AUTOMN_RETURN_MARKER=${JSON.stringify(RETURN_MARKER)}
AUTOMN_LOG_MARKER=${JSON.stringify(LOG_MARKER)}
AUTOMN_NOTIFY_MARKER=${JSON.stringify(NOTIFY_MARKER)}

automn_normalize_json() {
  node - <<'NODE' "$1"
    const raw = process.argv[2];
    try {
      const parsed = JSON.parse(raw);
      process.stdout.write(JSON.stringify(parsed));
    } catch (err) {
      const fallback = raw === undefined ? null : raw;
      process.stdout.write(JSON.stringify(fallback));
    }
NODE
}

automn_normalize_level() {
  node - <<'NODE' "$1"
    const value = (process.argv[2] || "").toString().toLowerCase();
    const normalized =
      value === "warn" ||
      value === "error" ||
      value === "success" ||
      value === "debug"
        ? value
        : "info";
    process.stdout.write(JSON.stringify(normalized));
NODE
}

automn_normalize_log_type() {
  node - <<'NODE' "$1"
    const raw = process.argv[2];
    const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    process.stdout.write(JSON.stringify(normalized || "general"));
NODE
}

AutomnReturn() {
  local payload;
  payload=$(automn_normalize_json "$1");
  printf "%s%s\n" "$AUTOMN_RETURN_MARKER" "$payload";
}

AutomnLog() {
  local message level normalizedContext logType;
  message=$(automn_normalize_json "$1");
  level=$(automn_normalize_level "$2");
  if [ -n "$3" ]; then
    normalizedContext=$(automn_normalize_json "$3");
  else
    normalizedContext="null";
  fi
  logType=$(automn_normalize_log_type "$4");
  printf "%s{\"message\":%s,\"level\":%s,\"context\":%s,\"type\":%s}\n" "$AUTOMN_LOG_MARKER" "$message" "$level" "$normalizedContext" "$logType";
}

AutomnRunLog() {
  printf "%s\n" "$@";
}

AutomnNotify() {
  local audience message level;
  audience=$(automn_normalize_json "$1");
  message=$(automn_normalize_json "$2");
  level=$(automn_normalize_level "$3");
  printf "%s{\"audience\":%s,\"message\":%s,\"level\":%s}\n" "$AUTOMN_NOTIFY_MARKER" "$audience" "$message" "$level";
}

${script.code}
    `,
    };

    await fsp.mkdir(path.dirname(tmpPath), { recursive: true });
    await fsp.writeFile(tmpPath, injected[script.language] || script.code);

    const commandResolvers = {
      node: () => ({
        command: runtimeExecutables.node || "node",
        args: [tmpPath],
      }),
      python: () => ({
        command: resolvePythonCommand(runtimeExecutables.python),
        args: [tmpPath],
      }),
      powershell: () => {
        const launcher = resolvePowerShellLauncher(runtimeExecutables.powershell);
        return {
          command: launcher.command,
          args: [...launcher.args, tmpPath],
        };
      },
      shell: () => {
        const shellExecutable = resolveShellExecutable(runtimeExecutables.shell);
        if (!shellExecutable) {
          return null;
        }
        return {
          command: shellExecutable,
          args: [tmpPath],
        };
      },
    };

    const resolved = commandResolvers[script.language]?.();
    const cmd = resolved?.command;
    const args = resolved?.args;

    if (!cmd) {
      return {
        runId,
        stdout: "",
        stderr: "Unsupported language",
        code: 1,
        duration: 0,
        returnData: null,
        automnLogs: [],
        automnNotifications: [],
        input: inputSnapshot,
      };
    }

    const start = Date.now();

    return await new Promise((resolve) => {
      const variableEnv = Array.isArray(script.variables)
        ? script.variables.reduce((acc, variable) => {
            if (!variable || !variable.envName) {
              return acc;
            }
            acc[variable.envName] = variable.value ?? "";
            return acc;
          }, {})
        : {};

      let inputEnvJson;
      try {
        inputEnvJson = JSON.stringify(reqBody ?? {});
      } catch (err) {
        inputEnvJson = safeStringifyInput(reqBody ?? {});
      }

      const envForChild = {
        ...process.env,
        ...variableEnv,
        AUTOMN_RUN_ID: runId,
      };

      const inputEnvKeys = [
        "AUTOMN_INTERNAL_INPUT_JSON",
        "AUTOMN_INPUT_JSON",
        "INPUT_JSON",
      ];

      for (const key of inputEnvKeys) {
        envForChild[key] = inputEnvJson;
      }

      const spawnOptions = {
        env: envForChild,
      };

      if (script.language === "node") {
        spawnOptions.cwd = workingDirectory;
      }

      const child = childProcess.spawn(
        cmd,
        args,
        prepareSpawnOptions(spawnOptions)
      );
      ensureWindowsChildCleanup(child);

      let stdout = "";
      let stderr = "";

      let sawReturnMarker = false;
      let forceTerminateTimer = null;
      let forceKillTimer = null;

      const clearForceTermination = () => {
        if (forceTerminateTimer) {
          clearTimeout(forceTerminateTimer);
          forceTerminateTimer = null;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
      };

      const scheduleForceTermination = () => {
        if (forceTerminateTimer || settled) {
          return;
        }
        forceTerminateTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          try {
            child.kill("SIGTERM");
          } catch (err) {
            // ignore inability to signal the child; process may already be gone
          }
          forceKillTimer = setTimeout(() => {
            if (settled) {
              return;
            }
            try {
              child.kill("SIGKILL");
            } catch (err) {
              // ignore inability to forcibly terminate the child
            }
          }, 1000);
        }, 300);
      };

      const stdoutDecoder = createStreamDecoder(script.language);
      const stderrDecoder = createStreamDecoder(script.language);

      const flushStdout = () => {
        const remaining = stdoutDecoder.flush();
        if (!remaining) return;
        stdout += remaining;
        if (onLog) onLog(remaining, { stream: "stdout" });
      };

      const flushStderr = () => {
        const remaining = stderrDecoder.flush();
        if (!remaining) return;
        stderr += remaining;
        if (onLog) onLog(remaining, { stream: "stderr" });
      };

      child.stdout.on("data", (d) => {
        const text = stdoutDecoder.write(d);
        if (!text) return;
        stdout += text;
        if (onLog) onLog(text, { stream: "stdout" });
        if (!sawReturnMarker && stdout.includes(RETURN_MARKER)) {
          sawReturnMarker = true;
          scheduleForceTermination();
        }
      });
      child.stdout.on("close", flushStdout);

      child.stderr.on("data", (d) => {
        const text = stderrDecoder.write(d);
        if (!text) return;
        stderr += text;
        if (onLog) onLog(text, { stream: "stderr" });
      });
      child.stderr.on("close", flushStderr);

      const timer =
        script.timeout > 0
          ? setTimeout(() => {
              try {
                child.kill("SIGTERM");
                stderr += "\nTimeout exceeded.";
                if (onLog) onLog("Timeout exceeded.\n", { stream: "stderr" });
              } catch (e) {
                stderr += `\nTimeout error: ${e.message}`;
              }
            }, script.timeout * 1000)
          : null;

      let settled = false;

      const finalize = (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        flushStdout();
        flushStderr();
        if (timer) clearTimeout(timer);
        const duration = Date.now() - start;

        const exitCode =
          typeof code === "number"
            ? code
            : signal
            ? 1
            : 0;

        const {
          strippedStdout,
          returnData,
          parseError,
          hadMarker,
        } = extractReturnPayload(stdout);

        let stderrOutput = stderr;
        if (parseError) {
          const details = parseError.message ? `: ${parseError.message}` : "";
          const parseMessage = `Bad return JSON${details}`;
          stderrOutput = stderrOutput
            ? `${stderrOutput}\n${parseMessage}`
            : parseMessage;
        }

        const {
          cleanedStdout: stdoutWithoutNotifications,
          notifications: automnNotifications,
        } = extractStructuredNotifications(strippedStdout);

        const { cleanedStdout, logs: automnLogs } = extractStructuredLogs(
          stdoutWithoutNotifications
        );

        let displayStdout = cleanedStdout;
        if (hadMarker) {
          displayStdout = displayStdout.replace(/^\s*\n/, "");
        }
        displayStdout = displayStdout.trimEnd();

        const finalReturnData = parseError ? null : returnData;

        resolve({
          runId,
          stdout: displayStdout,
          stderr: stderrOutput,
          code: exitCode,
          duration,
          returnData: finalReturnData,
          automnLogs,
          automnNotifications,
          input: inputSnapshot,
        });
      };

      child.on("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        flushStdout();
        flushStderr();
        if (timer) clearTimeout(timer);
        const duration = Date.now() - start;
        const message = err?.message || String(err);
        resolve({
          runId,
          stdout: "",
          stderr: message,
          code: 1,
          duration,
          returnData: null,
          automnLogs: [],
          automnNotifications: [],
          input: inputSnapshot,
        });
      });

      child.on("exit", finalize);
      child.on("close", finalize);
    });
  } catch (err) {
    const message = err?.message || String(err);
    return {
      runId,
      stdout: "",
      stderr: message,
      code: 1,
      duration: 0,
      returnData: null,
      automnLogs: [],
      automnNotifications: [],
      input: inputSnapshot,
    };
  } finally {
    if (cleanupTarget) {
      fsp.unlink(cleanupTarget).catch(() => {});
    }
  }
}

module.exports = {
  executeScript,
  sanitizeIdentifier,
  extractNodeDependencies,
  usesNodeEsmSyntax,
  ensureNodeDependencies,
  extractReturnPayload,
  extractStructuredLogs,
  extractStructuredNotifications,
  resolvePowerShellLauncher,
  resolvePythonCommand,
  resolveShellExecutable,
  resetPythonCommandCache,
  rehydratePackageCache,
  clearPackageCache,
  getPackageCacheSummary,
  NodeDependencyInstallError,
  RETURN_MARKER,
  LOG_MARKER,
  NOTIFY_MARKER,
};

