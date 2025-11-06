export function resolveBackendUrl(path) {
  if (!path || typeof path !== "string") {
    return path;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  if (typeof window === "undefined") {
    return path;
  }

  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}

export function resolveBackendWebSocketUrl(path) {
  if (!path || typeof path !== "string") {
    return path;
  }

  if (/^wss?:\/\//i.test(path)) {
    return path;
  }

  if (typeof window === "undefined") {
    return path;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}`;

  try {
    return new URL(path, base).toString();
  } catch {
    return path;
  }
}
