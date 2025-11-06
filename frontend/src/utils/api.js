import { resolveBackendUrl } from "./network";

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export async function apiRequest(path, options = {}) {
  const { skipJson = false, ...rest } = options;
  const requestInit = {
    credentials: "include",
    ...rest,
  };

  const headers = new Headers(requestInit.headers || {});

  if (
    requestInit.body &&
    isPlainObject(requestInit.body) &&
    !(requestInit.body instanceof FormData)
  ) {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    requestInit.body = JSON.stringify(requestInit.body);
  }

  requestInit.headers = headers;

  const response = await fetch(resolveBackendUrl(path), requestInit);

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  const shouldParseJson = !skipJson && contentType.includes("application/json");

  if (shouldParseJson) {
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error || response.statusText || "Request failed",
    );
    error.status = response.status;
    error.data = payload;
    throw error;
  }

  if (skipJson) {
    return response;
  }

  if (payload !== null) {
    return payload;
  }

  if (contentType.includes("application/json")) {
    return {};
  }

  return payload;
}
