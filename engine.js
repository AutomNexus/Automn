const crypto = require("crypto");
const { dispatchRemoteRun } = require("./worker");
const { buildJobVariables } = require("./variable-definitions");

const subscribers = new Map();
const logHistory = new Map();
const logHistoryCleanupTimers = new Map();

const LOG_HISTORY_LIMIT = 1000;
const LOG_HISTORY_TTL_MS = 5 * 60 * 1000;

function ensureLogHistory(runId) {
  if (!runId) return null;
  if (!logHistory.has(runId)) {
    logHistory.set(runId, []);
  }
  return logHistory.get(runId);
}

function appendLogHistory(runId, line) {
  if (!runId || !line) return;
  const existingTimer = logHistoryCleanupTimers.get(runId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    logHistoryCleanupTimers.delete(runId);
  }
  const history = ensureLogHistory(runId);
  if (!history) return;
  history.push(line);
  if (history.length > LOG_HISTORY_LIMIT) {
    history.splice(0, history.length - LOG_HISTORY_LIMIT);
  }
}

function scheduleLogHistoryCleanup(runId) {
  if (!runId) return;
  const existingTimer = logHistoryCleanupTimers.get(runId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = setTimeout(() => {
    logHistory.delete(runId);
    logHistoryCleanupTimers.delete(runId);
  }, LOG_HISTORY_TTL_MS);
  if (typeof timer?.unref === "function") {
    timer.unref();
  }
  logHistoryCleanupTimers.set(runId, timer);
}

function deliverBacklog(runId, ws) {
  if (!runId || !ws) return;
  const history = logHistory.get(runId);
  if (!history || !history.length) return;
  for (const line of history) {
    try {
      const payload = JSON.stringify({ runId, line });
      ws.send(payload);
    } catch (err) {
      // Ignore backlog delivery errors and allow normal stream handling to manage the client.
    }
  }
}
const queue = [];
let activeWorkers = 0;
let queueProcessingScheduled = false;

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_RUNNER_REQUEST_TIMEOUT_MS = 60_000;
const envMax = Number.parseInt(process.env.AUTOMN_MAX_WORKERS ?? "", 10);
const MAX_WORKERS =
  Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_WORKERS;

const runnerHosts = new Map();

class RunnerUnavailableError extends Error {
  constructor(message = "No runner available") {
    super(message);
    this.name = "RunnerUnavailableError";
    this.code = "NO_RUNNER_AVAILABLE";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RunnerUnavailableError);
    }
  }
}

function ensureSubscriberSet(runId) {
  if (!subscribers.has(runId)) subscribers.set(runId, new Set());
  return subscribers.get(runId);
}

function removeSubscriber(runId, ws) {
  const clients = subscribers.get(runId);
  if (!clients) return;
  clients.delete(ws);
  if (clients.size === 0) {
    subscribers.delete(runId);
  }
}

function addSubscriber(runId, ws) {
  const clients = ensureSubscriberSet(runId);
  clients.add(ws);
  ws.on("close", () => removeSubscriber(runId, ws));
  deliverBacklog(runId, ws);
}

function broadcastLog(runId, line) {
  appendLogHistory(runId, line);
  const clients = subscribers.get(runId);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify({ runId, line });
  for (const ws of [...clients]) {
    try {
      const openState =
        typeof ws.constructor?.OPEN === "number" ? ws.constructor.OPEN : 1;
      if (typeof ws.readyState === "number" && ws.readyState !== openState) {
        removeSubscriber(runId, ws);
        continue;
      }
      ws.send(payload);
    } catch (err) {
      removeSubscriber(runId, ws);
    }
  }
}

function scheduleQueueProcessing() {
  if (queueProcessingScheduled) return;
  queueProcessingScheduled = true;
  setImmediate(processQueue);
}

function createFailureResult(job, message) {
  const stderrMessage = message || "Runner execution failed";
  return {
    runId: job.id,
    stdout: "",
    stderr: stderrMessage,
    code: 1,
    duration: 0,
    returnData: null,
    automnLogs: [],
    automnNotifications: [],
    input: job.reqBody ?? null,
  };
}

function normalizeResultPayload(job, result) {
  if (!result || typeof result !== "object") {
    return createFailureResult(job, "Runner returned an invalid result payload");
  }

  const normalized = { ...result };
  if (!normalized.runId) normalized.runId = job.id;
  if (normalized.input === undefined) normalized.input = job.reqBody ?? null;
  return normalized;
}

function finalizeJob(job, result) {
  activeWorkers = Math.max(0, activeWorkers - 1);
  job.resolve(normalizeResultPayload(job, result));
  scheduleLogHistoryCleanup(job.id);
  scheduleQueueProcessing();
}

function rejectJob(job, error) {
  const err = error instanceof Error ? error : new Error(String(error || ""));
  if (typeof job.reject === "function") {
    job.reject(err);
    scheduleLogHistoryCleanup(job.id);
    return;
  }
  job.resolve(createFailureResult(job, err.message));
  scheduleLogHistoryCleanup(job.id);
}

function hasRegisteredHosts() {
  for (const host of runnerHosts.values()) {
    if (!host.removed) return true;
  }
  return false;
}

function purgeHostIfDrained(host) {
  if (!host || !host.removed) return;
  if (host.activeJobs > 0) return;
  runnerHosts.delete(host.id);
  if (!hasRegisteredHosts()) {
    rejectPendingJobsDueToNoRunner();
  }
}

function rejectPendingJobsDueToNoRunner() {
  if (hasRegisteredHosts()) return;
  if (!queue.length) return;
  while (queue.length) {
    const job = queue.shift();
    if (!job) continue;
    rejectJob(job, new RunnerUnavailableError());
  }
}

function selectRunnerHost(job = null) {
  const targetRunnerId = job?.targetRunnerId || null;
  if (targetRunnerId) {
    const host = runnerHosts.get(targetRunnerId);
    if (!host || host.removed) {
      return null;
    }
    const max = Number.isFinite(host.maxConcurrency)
      ? host.maxConcurrency
      : Infinity;
    if ((host.activeJobs || 0) >= max) {
      return null;
    }
    host.lastAssigned = Date.now();
    return host;
  }

  const available = [];
  for (const host of runnerHosts.values()) {
    if (host.removed) continue;
    const max = Number.isFinite(host.maxConcurrency)
      ? host.maxConcurrency
      : Infinity;
    if ((host.activeJobs || 0) >= max) continue;
    available.push(host);
  }

  if (!available.length) return null;

  available.sort((a, b) => {
    const activeDiff = (a.activeJobs || 0) - (b.activeJobs || 0);
    if (activeDiff !== 0) return activeDiff;
    return (a.lastAssigned || 0) - (b.lastAssigned || 0);
  });

  const host = available[0];
  host.lastAssigned = Date.now();
  return host;
}

function determineRequestTimeout(host) {
  const numericTimeout = Number(host?.timeoutMs);
  if (Number.isFinite(numericTimeout) && numericTimeout > 0) {
    return numericTimeout;
  }
  return DEFAULT_RUNNER_REQUEST_TIMEOUT_MS;
}

function startRemoteJob(job, host) {
  activeWorkers += 1;
  host.activeJobs = (host.activeJobs || 0) + 1;
  host.lastAssigned = Date.now();

  let settled = false;
  const hostLabel = host.id || host.endpoint;

  const cleanup = () => {
    host.activeJobs = Math.max(0, (host.activeJobs || 0) - 1);
    purgeHostIfDrained(host);
  };

  const complete = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    const code = Number.isFinite(result?.code) ? result.code : "unknown";
    console.log(
      `[engine] Run ${job.id} completed via runner ${hostLabel} with code ${code}`
    );
    finalizeJob(job, result);
  };

  const handleFailure = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    const message = error?.message || String(error || "Runner error");
    console.error(`[engine] Run ${job.id} failed via runner ${hostLabel}:`, error);
    broadcastLog(job.id, `Runner error: ${message}\n`);
    finalizeJob(job, createFailureResult(job, message));
  };

  try {
    dispatchRemoteRun({
      endpoint: host.endpoint,
      job,
      headers: host.headers,
      timeoutMs: determineRequestTimeout(host),
      onRequestStart: () => {
        console.log(
          `[engine] Dispatching run ${job.id} to ${hostLabel} (${host.endpoint})`
        );
      },
      onResponse: (response) => {
        const status = Number.isFinite(response?.statusCode)
          ? response.statusCode
          : "unknown";
        console.log(
          `[engine] Runner ${hostLabel} responded to run ${job.id} with status ${status}`
        );
      },
      onLog: (line) => {
        if (line) broadcastLog(job.id, line);
      },
      onResult: (data) => {
        const code = Number.isFinite(data?.code) ? data.code : "unknown";
        console.log(
          `[engine] Runner ${hostLabel} delivered result for run ${job.id} with code ${code}`
        );
        complete(data);
      },
      onError: (error) => {
        host.lastError = error?.message || String(error || "Runner error");
        host.consecutiveFailures = (host.consecutiveFailures || 0) + 1;
        if (host.autoRemoveOnFailure) {
          host.removed = true;
        }
        handleFailure(error);
      },
    });
  } catch (err) {
    host.lastError = err?.message || String(err || "Runner error");
    host.consecutiveFailures = (host.consecutiveFailures || 0) + 1;
    handleFailure(err);
  }
}

function processQueue() {
  queueProcessingScheduled = false;
  if (!queue.length) return;

  if (!hasRegisteredHosts()) {
    rejectPendingJobsDueToNoRunner();
    return;
  }

  while (activeWorkers < MAX_WORKERS && queue.length) {
    let selectedIndex = -1;
    let selectedHost = null;

    for (let i = 0; i < queue.length; i += 1) {
      const candidate = queue[i];
      const host = selectRunnerHost(candidate);
      if (host) {
        selectedIndex = i;
        selectedHost = host;
        break;
      }
    }

    if (selectedIndex === -1 || !selectedHost) {
      break;
    }

    const [job] = queue.splice(selectedIndex, 1);
    if (!job) {
      continue;
    }
    if (!selectedHost.endpoint) {
      broadcastLog(job.id, "Runner error: runner host missing endpoint\n");
      finalizeJob(job, createFailureResult(job, "Runner host misconfigured"));
      continue;
    }
    startRemoteJob(job, selectedHost);
  }

  if (queue.length) {
    scheduleQueueProcessing();
  }
}

function normalizeRunnerHostConfig(config) {
  if (!config) {
    throw new Error("Runner host configuration is required");
  }

  if (typeof config === "string") {
    return normalizeRunnerHostConfig({ id: config, endpoint: config });
  }

  const { id, endpoint, headers, maxConcurrency, timeoutMs, autoRemoveOnFailure } = config;
  if (!endpoint) {
    throw new Error("Runner host endpoint is required");
  }

  const hostId = id || endpoint;
  const parsedMaxConcurrency = Number.parseInt(maxConcurrency, 10);
  const concurrency = Number.isFinite(parsedMaxConcurrency) && parsedMaxConcurrency > 0
    ? parsedMaxConcurrency
    : Infinity;

  const parsedTimeout = Number.parseInt(timeoutMs, 10);
  const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined;

  return {
    id: hostId,
    endpoint,
    headers: headers && typeof headers === "object" ? { ...headers } : {},
    maxConcurrency: concurrency,
    timeoutMs: timeout,
    autoRemoveOnFailure: Boolean(autoRemoveOnFailure),
  };
}

function registerRunnerHost(config) {
  const normalized = normalizeRunnerHostConfig(config);
  const existing = runnerHosts.get(normalized.id);
  const host = existing || {
    id: normalized.id,
    activeJobs: 0,
    lastAssigned: 0,
    consecutiveFailures: 0,
  };

  host.endpoint = normalized.endpoint;
  host.headers = normalized.headers;
  host.maxConcurrency = normalized.maxConcurrency;
  host.timeoutMs = normalized.timeoutMs;
  host.autoRemoveOnFailure = normalized.autoRemoveOnFailure;
  host.removed = false;
  host.lastSeen = Date.now();

  runnerHosts.set(host.id, host);
  scheduleQueueProcessing();
  return host;
}

function unregisterRunnerHost(id) {
  if (!id) return false;
  const host = runnerHosts.get(id);
  if (!host) return false;
  host.removed = true;
  purgeHostIfDrained(host);
  return true;
}

function getRunnerHostConfig(id) {
  if (!id) return null;
  const host = runnerHosts.get(id);
  if (!host || host.removed || !host.endpoint) {
    return null;
  }
  return {
    id: host.id,
    endpoint: host.endpoint,
    headers: host.headers ? { ...host.headers } : {},
    maxConcurrency: host.maxConcurrency,
    timeoutMs: host.timeoutMs,
  };
}

function listRunnerHosts() {
  const hosts = [];
  for (const host of runnerHosts.values()) {
    hosts.push({
      id: host.id,
      endpoint: host.endpoint,
      activeJobs: host.activeJobs || 0,
      maxConcurrency: host.maxConcurrency,
      removed: Boolean(host.removed),
      lastSeen: host.lastSeen || 0,
      lastError: host.lastError || null,
      consecutiveFailures: host.consecutiveFailures || 0,
    });
  }
  return hosts;
}

function runJob(script, reqBody) {
  const scriptRunnerId =
    script?.runnerHostId || script?.runner_host_id || null;
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

  if (!targetRunnerId) {
    throw new RunnerUnavailableError(
      inheritCategoryRunner ? "No runner available" : "No runners configured",
    );
  }

  const host = runnerHosts.get(targetRunnerId);
  if (!host || host.removed) {
    throw new RunnerUnavailableError();
  }

  return new Promise((resolve, reject) => {
    const baseVariables = Array.isArray(script?.variables) ? script.variables : [];
    const jobVariables = buildJobVariables({
      httpMethod: script?.jobContext?.httpMethod,
      scriptName:
        typeof script?.jobContext?.scriptName === "string" &&
        script.jobContext.scriptName.trim()
          ? script.jobContext.scriptName.trim()
          : script?.name || script?.endpoint || script?.id || "",
      scriptVersion: script?.jobContext?.codeVersion,
      targetRunnerId,
      targetRunnerName: host?.name || null,
    });
    const combinedVariables = [...baseVariables, ...jobVariables];
    const runtimeJobContext = {
      ...(script?.jobContext || {}),
      targetRunnerId,
      targetRunnerName: host?.name || null,
    };
    const runtimeScript = {
      ...script,
      variables: combinedVariables,
      jobContext: runtimeJobContext,
    };

    const job = {
      id: script.preassignedRunId || crypto.randomUUID(),
      script: runtimeScript,
      reqBody,
      resolve,
      reject,
      targetRunnerId,
    };

    if (script?.skipQueue) {
      queue.unshift(job);
    } else {
      queue.push(job);
    }
    scheduleQueueProcessing();
  });
}

function getActiveWorkerCount() {
  return activeWorkers;
}

module.exports = {
  runJob,
  queue,
  getActiveWorkerCount,
  addSubscriber,
  registerRunnerHost,
  unregisterRunnerHost,
  getRunnerHostConfig,
  listRunnerHosts,
  RunnerUnavailableError,
};

const envRunnerHosts = process.env.AUTOMN_RUNNER_HOSTS;
if (envRunnerHosts) {
  const entries = envRunnerHosts
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const entry of entries) {
    try {
      registerRunnerHost({ endpoint: entry });
    } catch (err) {
      console.error(`Failed to register runner host '${entry}':`, err);
    }
  }
}
