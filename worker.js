const http = require("http");
const https = require("https");
const { URL } = require("url");

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    normalized[String(key)] = value;
  }
  return normalized;
}

function dispatchRemoteRun({
  endpoint,
  job,
  headers = {},
  timeoutMs,
  onLog,
  onResult,
  onEvent,
  onError,
  onRequestStart,
  onResponse,
}) {
  if (!endpoint) {
    throw new Error("Runner endpoint is required");
  }
  if (!job || !job.id) {
    throw new Error("A job with an id is required to dispatch to a runner");
  }

  const targetUrl = new URL(endpoint);
  const payload = JSON.stringify({
    runId: job.id,
    script: job.script,
    reqBody: job.reqBody,
  });

  const requestHeaders = {
    "content-type": "application/json",
    accept: "application/json",
    "content-length": Buffer.byteLength(payload),
    ...normalizeHeaders(headers),
  };

  const requestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || undefined,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method: "POST",
    headers: requestHeaders,
  };

  const transport = targetUrl.protocol === "https:" ? https : http;

  let finished = false;
  let resultDelivered = false;
  let pendingBuffer = "";

  const finish = (callback, value) => {
    if (finished) return;
    finished = true;
    if (typeof callback === "function") {
      callback(value);
    }
  };

  const finishWithError = (err) => {
    const error = err instanceof Error ? err : new Error(String(err || "Runner error"));
    finish(onError, error);
  };

  const finishWithResult = (result) => {
    resultDelivered = true;
    finish(onResult, result);
  };

  if (typeof onRequestStart === "function") {
    try {
      onRequestStart();
    } catch (err) {
      // Ignore logging callback errors to avoid breaking dispatch
    }
  }

  const request = transport.request(requestOptions, (response) => {
    if (typeof onResponse === "function") {
      try {
        onResponse(response);
      } catch (err) {
        // Ignore logging callback errors to avoid breaking dispatch
      }
    }

    if (response.statusCode && response.statusCode >= 400) {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", finishWithError);
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const message = body ? `${response.statusCode}: ${body}` : `${response.statusCode}`;
        const error = new Error(`Runner responded with status ${message}`);
        error.statusCode = response.statusCode;
        finishWithError(error);
      });
      return;
    }

    response.setEncoding("utf8");

    const processMessage = (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (err) {
        const parseError = new Error("Runner emitted an invalid JSON message");
        parseError.raw = trimmed;
        finishWithError(parseError);
        return;
      }

      if (!message || typeof message !== "object") {
        if (typeof onEvent === "function") onEvent(message);
        return;
      }

      if (message.type === "log") {
        if (typeof onLog === "function" && typeof message.line === "string") {
          onLog(message.line);
        }
        return;
      }

      if (message.type === "result") {
        finishWithResult(message.data);
        return;
      }

      if (typeof onEvent === "function") {
        onEvent(message);
      }
    };

    response.on("data", (chunk) => {
      if (finished) return;
      pendingBuffer += chunk;

      let newlineIndex;
      while ((newlineIndex = pendingBuffer.indexOf("\n")) !== -1) {
        const segment = pendingBuffer.slice(0, newlineIndex);
        pendingBuffer = pendingBuffer.slice(newlineIndex + 1);
        processMessage(segment);
        if (finished) return;
      }
    });

    response.on("end", () => {
      if (finished) return;
      if (pendingBuffer) {
        processMessage(pendingBuffer);
        pendingBuffer = "";
        if (finished) return;
      }
      if (!resultDelivered) {
        finishWithError(new Error("Runner stream ended without delivering a result"));
      }
    });

    response.on("error", finishWithError);
  });

  request.on("error", finishWithError);

  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    request.setTimeout(timeoutMs, () => {
      finishWithError(new Error("Runner request timed out"));
      request.destroy();
    });
  }

  request.write(payload);
  request.end();

  return {
    abort(reason) {
      if (finished) return;
      const error =
        reason instanceof Error ? reason : new Error(String(reason || "Runner aborted"));
      finishWithError(error);
      request.destroy(error);
    },
  };
}

module.exports = {
  dispatchRemoteRun,
};
