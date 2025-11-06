"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const fsp = fs.promises;

const WINDOWS_SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

const activeWindowsChildren = new Set();
let windowsCleanupInitialized = false;

let cachedNpmInvocation = null;
const packageCacheStateByRoot = new Map();

const builtinModuleNames = new Set([
  ...Module.builtinModules,
  ...Module.builtinModules.map((name) => name.replace(/^node:/, "")),
]);

function isTruthyEnv(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (!value) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function sanitizeExecutable(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^"(.+)"$/, "$1");
}

function sanitizeIdentifier(value) {
  return (value || "anonymous").replace(/[^a-zA-Z0-9-_]/g, "-");
}

function prepareSpawnOptions(baseOptions = {}) {
  if (process.platform !== "win32") {
    return baseOptions;
  }

  const options = { ...baseOptions };
  if (typeof options.windowsHide !== "boolean") {
    options.windowsHide = true;
  }
  if (typeof options.detached !== "boolean") {
    const shouldDetach = isTruthyEnv(process.env.AUTOMN_RUNNER_WINDOWS_DETACHED);
    if (shouldDetach) {
      options.detached = true;
    }
  }
  return options;
}

function cleanupWindowsChildren() {
  if (!activeWindowsChildren.size) return;
  for (const child of Array.from(activeWindowsChildren)) {
    try {
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
    } catch (err) {
      // Ignore cleanup errors—process may have already exited or never started.
    }
  }
  activeWindowsChildren.clear();
}

function ensureWindowsChildCleanup(child) {
  if (process.platform !== "win32" || !child) {
    return;
  }

  activeWindowsChildren.add(child);

  const unregister = () => {
    activeWindowsChildren.delete(child);
  };

  child.once("exit", unregister);
  child.once("error", unregister);
  child.once("close", unregister);

  if (windowsCleanupInitialized) {
    return;
  }

  windowsCleanupInitialized = true;

  process.on("exit", () => {
    cleanupWindowsChildren();
  });

  const handleSignal = (signal) => {
    cleanupWindowsChildren();
    const exitCode = WINDOWS_SIGNAL_EXIT_CODES[signal];
    if (Number.isFinite(exitCode)) {
      process.exit(exitCode);
    }
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

function resolveWorkdirRoot(rootDir) {
  const base =
    typeof rootDir === "string" && rootDir.trim()
      ? rootDir.trim()
      : path.join(__dirname, "script_workdir");
  return path.resolve(base);
}

function computePackageCacheFile(rootDir) {
  const parent = path.resolve(rootDir, "..", "state");
  fs.mkdirSync(parent, { recursive: true });
  return path.join(parent, "npm-package-cache.json");
}

function ensurePackageCacheState(rootDir) {
  const root = resolveWorkdirRoot(rootDir);
  let state = packageCacheStateByRoot.get(root);
  if (!state) {
    state = {
      root,
      file: computePackageCacheFile(root),
      loaded: false,
      data: { scripts: {} },
    };
    packageCacheStateByRoot.set(root, state);
  }
  if (!state.loaded) {
    try {
      const raw = fs.readFileSync(state.file, "utf8");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          state.data = parsed;
        }
      }
    } catch (err) {
      state.data = { scripts: {} };
    }
    state.loaded = true;
  }
  if (!state.data || typeof state.data !== "object") {
    state.data = { scripts: {} };
  }
  if (!state.data.scripts || typeof state.data.scripts !== "object") {
    state.data.scripts = {};
  }
  return state;
}

function persistPackageCacheState(state) {
  if (!state || !state.file) return;
  try {
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    fs.writeFileSync(state.file, JSON.stringify(state.data, null, 2));
  } catch (err) {
    console.error("[runner] Failed to persist npm package cache", err);
  }
}

function rememberScriptDependencies({
  workdirRoot,
  scriptIdentifier,
  directoryKey,
  packages,
}) {
  if (!Array.isArray(packages) || !packages.length) {
    return;
  }
  const state = ensurePackageCacheState(workdirRoot);
  const normalizedDirectory = directoryKey || sanitizeIdentifier(scriptIdentifier);
  if (!normalizedDirectory) return;

  const entryKey = normalizedDirectory;
  const entry = state.data.scripts[entryKey] || {
    scriptId: scriptIdentifier || normalizedDirectory,
    directory: normalizedDirectory,
    packages: [],
    updatedAt: null,
  };

  entry.scriptId = scriptIdentifier || entry.scriptId || normalizedDirectory;
  entry.directory = normalizedDirectory;
  const packageSet = new Set((entry.packages || []).filter(Boolean));
  for (const pkg of packages) {
    if (pkg && typeof pkg === "string") {
      packageSet.add(pkg);
    }
  }
  entry.packages = Array.from(packageSet).sort();
  entry.updatedAt = new Date().toISOString();

  state.data.scripts[entryKey] = entry;
  persistPackageCacheState(state);
}

function getPackageCacheSummary(workdirRoot) {
  const state = ensurePackageCacheState(workdirRoot);
  const entries = Object.values(state.data.scripts || {});
  const packageSet = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry.packages)) continue;
    for (const pkg of entry.packages) {
      if (pkg && typeof pkg === "string") {
        packageSet.add(pkg);
      }
    }
  }
  return {
    scriptCount: entries.length,
    packageCount: packageSet.size,
    entries: entries.map((entry) => ({
      scriptId: entry.scriptId || null,
      directory: entry.directory || null,
      packages: Array.isArray(entry.packages) ? [...entry.packages] : [],
      updatedAt: entry.updatedAt || null,
    })),
  };
}

async function clearPackageCache({ workdirRoot, onLog } = {}) {
  const state = ensurePackageCacheState(workdirRoot);
  state.data = { scripts: {} };
  state.loaded = true;
  try {
    await fsp.rm(state.file, { force: true });
  } catch (err) {
    // ignore inability to remove cache file
  }

  let entries = [];
  try {
    entries = await fsp.readdir(state.root, { withFileTypes: true });
  } catch (err) {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue;
    const scriptDir = path.join(state.root, entry.name);
    const targets = [
      path.join(scriptDir, "node_modules"),
      path.join(scriptDir, "package-lock.json"),
    ];
    for (const target of targets) {
      try {
        await fsp.rm(target, { force: true, recursive: true });
      } catch (err) {
        if (onLog) {
          onLog(
            `[runner] Failed to remove ${target}: ${err.message}\n`,
            { stream: "stderr" }
          );
        }
      }
    }
  }

  try {
    persistPackageCacheState(state);
  } catch (err) {
    // already logged in persist helper
  }
}

function dependencyIsSatisfied(request, workDir) {
  try {
    require.resolve(request, { paths: [workDir, __dirname] });
    return true;
  } catch (err) {
    return false;
  }
}

function ensurePackageManifest(workDir, scriptId) {
  fs.mkdirSync(workDir, { recursive: true });
  const pkgPath = path.join(workDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    const pkg = {
      name: `automn-script-${sanitizeIdentifier(scriptId)}`,
      private: true,
      version: "1.0.0",
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
}

async function rehydratePackageCache({ workdirRoot, onLog } = {}) {
  const state = ensurePackageCacheState(workdirRoot);
  const entries = Object.values(state.data.scripts || {});
  const rehydrated = [];

  for (const entry of entries) {
    const packages = Array.isArray(entry.packages)
      ? entry.packages.filter((pkg) => pkg && typeof pkg === "string")
      : [];
    if (!packages.length) continue;

    const scriptDir = path.join(state.root, entry.directory || "");
    try {
      fs.mkdirSync(scriptDir, { recursive: true });
    } catch (err) {
      // ignore inability to create directory
    }

    const nodeModulesPath = path.join(scriptDir, "node_modules");
    let needsInstall = !fs.existsSync(nodeModulesPath);
    if (!needsInstall) {
      needsInstall = packages.some((pkg) => !dependencyIsSatisfied(pkg, scriptDir));
    }

    if (!needsInstall) {
      continue;
    }

    const label = entry.scriptId || entry.directory || "unknown-script";
    if (onLog) {
      onLog(
        `[runner] Reinstalling npm dependencies for ${label}: ${packages.join(", ")}\n`
      );
    }

    try {
      ensurePackageManifest(scriptDir, label);
      await installDependencies(packages, scriptDir, onLog);
      rehydrated.push({ scriptId: label, packages });
    } catch (err) {
      if (onLog) {
        onLog(
          `[runner] Failed to reinstall npm dependencies for ${label}: ${err.message}\n`,
          { stream: "stderr" }
        );
      }
    }
  }

  return { rehydrated };
}

function getPackageSpecifier(moduleName) {
  if (!moduleName || typeof moduleName !== "string") return null;
  const spec = moduleName.trim();
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:")) {
    const plain = spec.slice(5);
    if (builtinModuleNames.has(plain)) return null;
  }

  const [firstSegment] = spec.split("/");
  if (builtinModuleNames.has(firstSegment)) return null;

  const installName = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];

  if (!installName || builtinModuleNames.has(installName)) return null;
  return { request: spec, install: installName };
}

function extractNodeDependencies(source) {
  if (typeof source !== "string" || !source.trim()) return [];
  const specs = new Map();
  const patterns = [
    /import\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+[^'";]*?from\s+["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const regex of patterns) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source))) {
      const spec = getPackageSpecifier(match[1]);
      if (!spec) continue;
      if (!specs.has(spec.install)) specs.set(spec.install, new Set());
      specs.get(spec.install).add(spec.request);
    }
  }

  return Array.from(specs.entries()).map(([install, requests]) => ({
    install,
    requests: Array.from(requests),
  }));
}

function usesNodeEsmSyntax(source) {
  if (typeof source !== "string") return false;

  const sanitized = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, (_, prefix) => prefix);

  const modulePatterns = [
    /\bimport\s+(?:[^'";]+?\s+from\s+)?['"][^'"\n]+['"]/,
    /\bimport\s*\(/,
    /\bexport\s+(?:default|\{|\*)/,
    /\bimport\.meta\b/,
  ];

  return modulePatterns.some((regex) => regex.test(sanitized));
}

function formatCommandLine(command, args = []) {
  const parts = [command, ...(Array.isArray(args) ? args : [])]
    .filter((part) => Boolean(part))
    .map((part) => {
      if (typeof part !== "string") return String(part);
      return /\s/.test(part) ? `"${part}"` : part;
    });
  return parts.join(" ").trim();
}

function summarizeOutput(output, { maxLines = 20, maxLength = 2000 } = {}) {
  if (!output) {
    return "";
  }

  const text = String(output).trim();
  if (!text) {
    return "";
  }

  const lines = text.split(/\r?\n/);
  const relevantLines = lines.slice(-maxLines);
  let summary = relevantLines.join("\n");
  let truncated = relevantLines.length < lines.length;

  if (summary.length > maxLength) {
    summary = summary.slice(summary.length - maxLength);
    truncated = true;
  }

  return truncated ? `…${summary}` : summary;
}

function shouldRetryWithLegacyPeerDeps(error) {
  if (!error) {
    return false;
  }

  const combined = [error.stderr, error.stdout]
    .filter((chunk) => Boolean(chunk))
    .map((chunk) => String(chunk).toLowerCase())
    .join("\n");

  if (!combined) {
    return false;
  }

  return (
    combined.includes("eresolve") ||
    combined.includes("could not resolve dependency") ||
    combined.includes("peer dep") ||
    combined.includes("peer dependency") ||
    combined.includes("unable to resolve dependency tree")
  );
}

function createNpmArgs(deps, { useLegacyPeerDeps = false } = {}) {
  const args = [
    "install",
    ...deps,
    "--no-audit",
    "--no-fund",
    "--loglevel",
    "error",
    "--save",
    "--progress=false",
    "--prefer-offline",
  ];

  if (useLegacyPeerDeps) {
    args.push("--legacy-peer-deps");
  }

  return args;
}

function getWindowsExecutableExtensions() {
  const raw = typeof process.env.PATHEXT === "string" ? process.env.PATHEXT : "";
  const defaults = [".exe", ".cmd", ".bat", ".com"];
  if (!raw) {
    return defaults;
  }
  const parsed = raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => Boolean(ext));
  if (!parsed.length) {
    return defaults;
  }
  return parsed.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
}

function resolveWindowsCommandPath(command) {
  const sanitized = sanitizeExecutable(command || "");
  if (!sanitized) {
    return null;
  }

  const hasDirectory = /[\\/]/.test(sanitized);
  const extensions = getWindowsExecutableExtensions();
  const candidates = [];

  const appendCandidates = (basePath) => {
    if (!basePath) {
      return;
    }
    const normalizedBase = basePath.replace(/^"(.+)"$/, "$1");
    const existingExt = path.extname(normalizedBase);
    if (existingExt) {
      candidates.push(normalizedBase);
      return;
    }
    for (const ext of extensions) {
      candidates.push(`${normalizedBase}${ext}`);
    }
  };

  if (hasDirectory || path.isAbsolute(sanitized)) {
    appendCandidates(sanitized);
  } else {
    const pathEntries = typeof process.env.PATH === "string" ? process.env.PATH : "";
    if (pathEntries) {
      for (const entry of pathEntries.split(path.delimiter)) {
        const trimmedEntry = entry.trim().replace(/^"(.+)"$/, "$1");
        if (!trimmedEntry) {
          continue;
        }
        appendCandidates(path.join(trimmedEntry, sanitized));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(candidate);
      if (stats && stats.isFile()) {
        return candidate;
      }
    } catch (err) {
      // Ignore filesystem errors; we'll continue probing.
    }
  }

  return null;
}

function resolveBundledNpmCli() {
  const execDir = path.dirname(process.execPath || "");
  if (!execDir) {
    return null;
  }

  const candidates = [
    path.join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(execDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    } catch (err) {
      // Ignore filesystem errors; continue searching for a bundled CLI script.
    }
  }

  try {
    const npmCli = require.resolve("npm/bin/npm-cli.js");
    if (npmCli && fs.existsSync(npmCli)) {
      return npmCli;
    }
  } catch (err) {
    // It's possible the global npm package cannot be resolved; fall through to other strategies.
  }

  return null;
}

function resolveNpmInvocation() {
  if (cachedNpmInvocation) {
    return cachedNpmInvocation;
  }

  const envOverride = sanitizeExecutable(process.env.AUTOMN_RUNNER_NPM_PATH || "");
  if (envOverride) {
    cachedNpmInvocation = { command: envOverride, args: [] };
    return cachedNpmInvocation;
  }

  const execDir = path.dirname(process.execPath || "");
  const platformExecutables = process.platform === "win32"
    ? ["npm.cmd", "npm.exe", "npm.bat"]
    : ["npm"];

  for (const executable of platformExecutables) {
    if (!executable) {
      continue;
    }

    try {
      const absolute = path.resolve(execDir, executable);
      if (fs.existsSync(absolute)) {
        cachedNpmInvocation = { command: absolute, args: [] };
        return cachedNpmInvocation;
      }
    } catch (err) {
      // Ignore filesystem errors and keep probing fallbacks.
    }
  }

  if (process.platform === "win32") {
    const resolvedWindows = resolveWindowsCommandPath("npm");
    if (resolvedWindows) {
      cachedNpmInvocation = { command: resolvedWindows, args: [] };
      return cachedNpmInvocation;
    }
  }

  const bundledCli = resolveBundledNpmCli();
  if (bundledCli) {
    cachedNpmInvocation = { command: process.execPath, args: [bundledCli] };
    return cachedNpmInvocation;
  }

  cachedNpmInvocation = { command: "npm", args: [] };
  return cachedNpmInvocation;
}

function commandExists(command, args) {
  if (process.platform === "win32") {
    return Boolean(resolveWindowsCommandPath(command));
  }

  try {
    const options = { stdio: "ignore" };
    if (process.platform === "win32") {
      options.windowsHide = true;
    } else {
      options.timeout = 1500;
    }

    const result = childProcess.spawnSync(command, args, options);
    if (result.error) {
      return false;
    }
    return result.status === 0;
  } catch (err) {
    return false;
  }
}

function createNpmInstallEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_progress: "false",
    npm_config_update_notifier: "false",
    npm_config_yes: "true",
  };
}

async function runNpmInstallInvocation({
  invocation,
  npmArgs,
  workDir,
  onLog,
  attempt,
}) {
  if (!invocation || !invocation.command) {
    const error = new Error("No npm command provided");
    error.launchFailure = true;
    throw error;
  }

  const baseArgs = Array.isArray(invocation.args)
    ? [...invocation.args, ...npmArgs]
    : [...npmArgs];

  let spawnCommand = invocation.command;
  let spawnArgs = baseArgs;
  const displayCommand = invocation.command;
  const displayArgs = [...baseArgs];

  const collectOutput = { stdout: [], stderr: [] };

  const options = prepareSpawnOptions({
    cwd: workDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: createNpmInstallEnv(),
  });

  if (
    process.platform === "win32" &&
    typeof invocation.command === "string" &&
    /\.(cmd|bat)$/i.test(invocation.command)
  ) {
    options.shell = process.env.ComSpec || "cmd.exe";
  }

  return new Promise((resolve, reject) => {
    let installer;

    try {
      installer = childProcess.spawn(spawnCommand, spawnArgs, options);
    } catch (err) {
      err.launchFailure = true;
      err.invocation = invocation;
      err.spawnArgs = displayArgs;
      err.actualSpawn = { command: spawnCommand, args: spawnArgs };
      reject(err);
      return;
    }

    ensureWindowsChildCleanup(installer);

    const cleanup = () => {
      if (installer.stdout) installer.stdout.removeAllListeners("data");
      if (installer.stderr) installer.stderr.removeAllListeners("data");
      installer.removeAllListeners("close");
      installer.removeAllListeners("error");
    };

    const emit = (chunk, stream = "stdout") => {
      if (!chunk) {
        return;
      }
      const text = chunk.toString();
      if (!text) {
        return;
      }
      if (stream === "stderr") {
        collectOutput.stderr.push(text);
      } else {
        collectOutput.stdout.push(text);
      }
      if (text.trim() && onLog) {
        onLog(`[npm] ${text}`, { stream });
      }
    };

    if (installer.stdout) {
      installer.stdout.on("data", (chunk) => emit(chunk, "stdout"));
    }
    if (installer.stderr) {
      installer.stderr.on("data", (chunk) => emit(chunk, "stderr"));
    }

    installer.on("close", (code) => {
      cleanup();
      if (code === 0) {
        resolve();
        return;
      }

      const commandLine = formatCommandLine(
        invocation.command,
        displayArgs
      );
      const stderrText = summarizeOutput(collectOutput.stderr.join(""));
      const stdoutText = summarizeOutput(collectOutput.stdout.join(""));

      const messageLines = [
        `npm install exited with code ${code}${commandLine ? ` (${commandLine})` : ""}.`,
      ];
      if (stderrText) {
        messageLines.push(`stderr:\n${stderrText}`);
      } else if (stdoutText) {
        messageLines.push(`stdout:\n${stdoutText}`);
      }

      const error = new Error(messageLines.join("\n"));
      error.exitCode = code;
      error.command = displayCommand;
      error.args = displayArgs;
      error.stdout = stdoutText;
      error.stderr = stderrText;
      error.invocation = invocation;
      error.spawnArgs = displayArgs;
      error.actualSpawn = { command: spawnCommand, args: spawnArgs };
      error.attempt = attempt;
      reject(error);
    });

    installer.on("error", (err) => {
      cleanup();
      err.launchFailure = true;
      err.invocation = invocation;
      err.spawnArgs = displayArgs;
      err.actualSpawn = { command: spawnCommand, args: spawnArgs };
      reject(err);
    });
  });
}

function buildAggregateNpmError(deps, errors) {
  const uniqueMessages = errors
    .map((err) => {
      if (!err) {
        return null;
      }

      if (err.launchFailure) {
        const commandLine = formatCommandLine(
          err.invocation?.command,
          err.spawnArgs || []
        );
        return commandLine
          ? `Launch failure (${commandLine}): ${err.message}`
          : `Launch failure: ${err.message}`;
      }

      if (typeof err.exitCode === "number") {
        const commandLine = formatCommandLine(
          err.invocation?.command,
          err.spawnArgs || []
        );
        const header = commandLine
          ? `npm exited with code ${err.exitCode} while running ${commandLine}.`
          : `npm exited with code ${err.exitCode}.`;
        const detail = summarizeOutput(err.stderr || err.stdout || "");
        return detail ? `${header}\n${detail}` : header;
      }

      return err.message || null;
    })
    .filter((message) => Boolean(message));

  const summaryLines = uniqueMessages.slice(-3);
  const headline = deps.length
    ? `Unable to install npm dependencies (${deps.join(", ")}).`
    : "Unable to install npm dependencies.";
  const message = summaryLines.length
    ? `${headline}\n${summaryLines.join("\n")}`
    : headline;

  const aggregate = new Error(message);
  aggregate.attempts = errors;
  return aggregate;
}

async function installDependencies(deps, workDir, onLog) {
  if (!Array.isArray(deps) || !deps.length) {
    return;
  }

  const baseInvocation = resolveNpmInvocation();
  const npmCandidates = [];
  const seenCommands = new Set();
  const appendCandidate = (command, args = []) => {
    if (!command) {
      return;
    }
    const key = `${command}:::${Array.isArray(args) ? args.join(" ") : ""}`;
    if (seenCommands.has(key)) {
      return;
    }
    seenCommands.add(key);
    npmCandidates.push({ command, args: Array.isArray(args) ? args : [] });
  };

  if (baseInvocation && baseInvocation.command) {
    appendCandidate(baseInvocation.command, baseInvocation.args || []);
  }

  if (process.platform === "win32") {
    appendCandidate("npm.cmd");
    appendCandidate("npm.exe");
    appendCandidate("npm.bat");
  } else {
    appendCandidate("npm");
  }

  const npxExecutables = process.platform === "win32"
    ? ["npx.cmd", "npx.exe", "npx.bat", "npx"]
    : ["npx"];
  for (const executable of npxExecutables) {
    appendCandidate(executable, ["--yes", "npm@latest"]);
  }

  if (!npmCandidates.length) {
    throw new Error("No npm executable candidates available");
  }

  const errors = [];

  for (const invocation of npmCandidates) {
    let lastError = null;
    let requireLegacyRetry = false;

    for (const useLegacyPeerDeps of [false, true]) {
      if (useLegacyPeerDeps && !requireLegacyRetry) {
        continue;
      }

      try {
        await runNpmInstallInvocation({
          invocation,
          npmArgs: createNpmArgs(deps, { useLegacyPeerDeps }),
          workDir,
          onLog,
          attempt: { useLegacyPeerDeps },
        });
        cachedNpmInvocation = invocation;
        return;
      } catch (err) {
        errors.push(err);
        lastError = err;

        if (err && err.launchFailure) {
          if (onLog) {
            onLog(
              `[npm] Failed to launch npm via "${invocation.command}": ${err.message}. Trying fallback...\n`,
              { stream: "stderr" }
            );
          }
          break;
        }

        if (!useLegacyPeerDeps && shouldRetryWithLegacyPeerDeps(err)) {
          requireLegacyRetry = true;
          if (onLog) {
            onLog(
              "[npm] Peer dependency conflict detected; retrying with --legacy-peer-deps...\n",
              { stream: "stdout" }
            );
          }
          continue;
        }

        break;
      }
    }

    if (lastError && !lastError.launchFailure) {
      // Attempted this invocation and failed without a launch error; try next candidate.
      continue;
    }
  }

  throw buildAggregateNpmError(deps, errors);
}

class NodeDependencyInstallError extends Error {
  constructor(message, { missing = [], workDir = null, cause = null } = {}) {
    super(message);
    this.name = "NodeDependencyInstallError";
    this.code = "NODE_DEPENDENCY_INSTALL_FAILED";
    this.missing = Array.isArray(missing) ? missing : [];
    this.workDir = workDir;
    this.cause = cause;
  }
}

async function ensureNodeDependencies(script, workDir, onLog, options = {}) {
  const scriptIdentifier = script.id || script.preassignedRunId || "anonymous";
  ensurePackageManifest(workDir, scriptIdentifier);

  const dependencies = extractNodeDependencies(script.code);
  if (!dependencies.length) {
    return { installed: [], dependencies: [] };
  }

  const allInstalls = dependencies
    .map((dep) => dep.install)
    .filter((name) => typeof name === "string" && name);
  const uniqueInstalls = Array.from(new Set(allInstalls));

  const missingInstalls = [];

  for (const dep of dependencies) {
    const satisfied = dep.requests.some((request) =>
      dependencyIsSatisfied(request, workDir)
    );

    if (!satisfied) {
      missingInstalls.push(dep.install);
    }
  }

  const uniqueMissing = Array.from(new Set(missingInstalls));
  if (uniqueMissing.length) {
    if (onLog) {
      onLog(`Installing npm dependencies: ${uniqueMissing.join(", ")}\n`, {
        stream: "stdout",
      });
    }

    try {
      await installDependencies(uniqueMissing, workDir, onLog);
    } catch (err) {
      const baseMessage = uniqueMissing.length
        ? `Failed to install npm dependencies: ${uniqueMissing.join(", ")}`
        : "Failed to install npm dependencies";
      const detail = err && err.message ? err.message : "";
      const combinedMessage = detail
        ? `${baseMessage}\n${detail}`
        : baseMessage;
      throw new NodeDependencyInstallError(combinedMessage, {
        missing: uniqueMissing,
        workDir,
        cause: err,
      });
    }
  }

  if (uniqueInstalls.length) {
    rememberScriptDependencies({
      workdirRoot: options.workdirRoot,
      scriptIdentifier: options.scriptIdentifier || scriptIdentifier,
      directoryKey: options.directoryKey || path.basename(workDir),
      packages: uniqueInstalls,
    });
  }

  return { installed: uniqueMissing, dependencies: uniqueInstalls };
}

async function checkNodePackageStatus({
  scriptIdentifier,
  packages,
  workdirRoot,
  directoryKey,
  installMissing = false,
  onLog,
}) {
  const normalizedPackages = Array.isArray(packages)
    ? Array.from(
        new Set(
          packages
            .map((pkg) => (typeof pkg === "string" ? pkg.trim() : ""))
            .filter((pkg) => Boolean(pkg))
        )
      )
    : [];

  if (!normalizedPackages.length) {
    return { packages: [] };
  }

  const root = resolveWorkdirRoot(workdirRoot);
  const directory = directoryKey || sanitizeIdentifier(scriptIdentifier || "anonymous");
  const workDir = path.join(root, directory);

  ensurePackageManifest(workDir, scriptIdentifier || directory);

  const statuses = [];
  const missing = [];

  for (const pkg of normalizedPackages) {
    const satisfied = dependencyIsSatisfied(pkg, workDir);
    statuses.push({
      name: pkg,
      status: satisfied ? "installed" : "not_installed",
      message: satisfied ? null : "Package not present",
    });
    if (!satisfied) {
      missing.push(pkg);
    }
  }

  if (installMissing && missing.length) {
    if (onLog) {
      onLog(
        `[runner] Installing npm packages for ${directory}: ${missing.join(", ")}\n`
      );
    }
    try {
      await installDependencies(missing, workDir, onLog);
      for (const status of statuses) {
        if (missing.includes(status.name)) {
          status.status = "installed";
          status.message = "Installed";
        }
      }
    } catch (err) {
      const errorMessage = err?.message || "Failed to install package";
      for (const status of statuses) {
        if (missing.includes(status.name)) {
          status.status = "error";
          status.message = errorMessage;
        }
      }
      return {
        packages: statuses,
        error: errorMessage,
        workDir,
      };
    }
  }

  rememberScriptDependencies({
    workdirRoot: root,
    scriptIdentifier: scriptIdentifier || directory,
    directoryKey: directory,
    packages: normalizedPackages,
  });

  return { packages: statuses, workDir };
}

module.exports = {
  sanitizeExecutable,
  sanitizeIdentifier,
  prepareSpawnOptions,
  ensureWindowsChildCleanup,
  resolveWorkdirRoot,
  rememberScriptDependencies,
  getPackageCacheSummary,
  clearPackageCache,
  rehydratePackageCache,
  extractNodeDependencies,
  usesNodeEsmSyntax,
  ensureNodeDependencies,
  NodeDependencyInstallError,
  checkNodePackageStatus,
  resolveNpmInvocation,
  installDependencies,
  dependencyIsSatisfied,
  commandExists,
  ensurePackageManifest,
  formatCommandLine,
};
