import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import ScriptEditor from "./components/ScriptEditor";
import ScriptAnalytics from "./components/ScriptAnalytics";
import ScriptTokenManager from "./components/ScriptTokenManager";
import ScriptVersions from "./components/ScriptVersions";
import ScriptPermissions from "./components/ScriptPermissions";
import ScriptVariables from "./components/ScriptVariables";
import ScriptPackages from "./components/ScriptPackages";
import RunScriptModal from "./components/RunScriptModal";
import { useNotificationDialog } from "./components/NotificationDialogProvider";
import SettingsUsers from "./components/SettingsUsers";
import SettingsRunnerHosts from "./components/SettingsRunnerHosts";
import SettingsData from "./components/SettingsData";
import SettingsCategories from "./components/SettingsCategories";
import SettingsGlobalVariables from "./components/SettingsGlobalVariables";
import { apiRequest } from "./utils/api";
import { DEFAULT_THEME_ID, THEMES, THEME_ORDER } from "./utils/themes";

const DEFAULT_COLLECTION_ID = "category-general";
const DEFAULT_CATEGORY_ID = DEFAULT_COLLECTION_ID;
const SUPPORTED_HTTP_METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"];
const DEFAULT_ACCEPTED_METHODS = ["POST", "GET"];

const createImageIcon = (src, alt) => ({ type: "image", src, alt });
const createEmojiIcon = (label) => ({ type: "emoji", label });

const LANGUAGE_ICONS = {
  node: createImageIcon("/nodejs.svg", "Node.js"),
  javascript: createImageIcon("/nodejs.svg", "JavaScript"),
  typescript: createImageIcon("/nodejs.svg", "TypeScript"),
  python: createImageIcon("/python.svg", "Python"),
  powershell: createImageIcon("/powershell.svg", "PowerShell"),
  shell: createEmojiIcon("💻"),
};

const DEFAULT_SCRIPT_ICON = createEmojiIcon("📄");

const LANGUAGE_TEXT_LABELS = {
  node: "JS>",
  javascript: "JS>",
  typescript: "TS>",
  python: "PY>",
  powershell: "PS>",
  shell: "SH>",
  default: "SC>",
};

const LANGUAGE_ACCENTS = {
  javascript: {
    border: "rgba(250, 204, 21, 0.75)",
    background: "rgba(250, 204, 21, 0.12)",
    hover: "rgba(250, 204, 21, 0.18)",
    text: "var(--color-sidebar-text)",
  },
  node: {
    border: "rgba(34, 197, 94, 0.7)",
    background: "rgba(34, 197, 94, 0.12)",
    hover: "rgba(34, 197, 94, 0.18)",
    text: "var(--color-sidebar-text)",
  },
  typescript: {
    border: "rgba(59, 130, 246, 0.7)",
    background: "rgba(59, 130, 246, 0.12)",
    hover: "rgba(59, 130, 246, 0.18)",
    text: "var(--color-sidebar-text)",
  },
  python: {
    border: "rgba(56, 189, 248, 0.8)",
    background: "rgba(56, 189, 248, 0.16)",
    hover: "rgba(56, 189, 248, 0.24)",
    text: "var(--color-sidebar-text)",
  },
  powershell: {
    border: "rgba(129, 140, 248, 0.8)",
    background: "rgba(129, 140, 248, 0.16)",
    hover: "rgba(129, 140, 248, 0.24)",
    text: "var(--color-sidebar-text)",
  },
  shell: {
    border: "rgba(148, 163, 184, 0.7)",
    background: "rgba(148, 163, 184, 0.12)",
    hover: "rgba(148, 163, 184, 0.18)",
    text: "var(--color-sidebar-text)",
  },
  default: {
    border: "rgba(148, 163, 184, 0.7)",
    background: "rgba(148, 163, 184, 0.12)",
    hover: "rgba(148, 163, 184, 0.18)",
    text: "var(--color-sidebar-text)",
  },
};

const SIDEBAR_ICON_OPTIONS = [
  {
    id: "icons-left",
    label: "Icons (left)",
    description: "Show language icons on the left side of each script.",
  },
  {
    id: "icons-right",
    label: "Icons (right)",
    description: "Keep language icons but align them to the far right.",
  },
  {
    id: "colored-items",
    label: "Coloured list items",
    description: "Highlight each script row using its language colour.",
  },
  {
    id: "text",
    label: "Text (JS>, PS>, PY>)",
    description: "Replace icons with short language prefixes.",
  },
  {
    id: "none",
    label: "None",
    description: "Do not show any language indicator in the list.",
  },
];

const NOTIFICATION_TYPE_LABELS = {
  system: "System",
  subscription: "Subscriptions",
  script: "Scripts",
};

const NOTIFICATION_LEVEL_CLASSNAMES = {
  info: "notification-level--info",
  warn: "notification-level--warn",
  error: "notification-level--error",
};

const SYSTEM_ICON_DEFAULTS = {
  recycle: true,
  settings: true,
  notifications: true,
};

const SETTINGS_TABS = [
  { id: "ui", label: "UI" },
  { id: "collections", label: "Collections" },
  { id: "global-variables", label: "Global Variables" },
  { id: "data", label: "Data" },
  { id: "users", label: "Users" },
  { id: "runners", label: "Runners" },
];

const ADMIN_ONLY_SETTINGS_TABS = new Set([
  "collections",
  "global-variables",
  "data",
  "users",
  "runners",
]);

const LOGIN_THEME_ID = "automn";

const normalizeRunnerHost = (host) => {
  if (!host || typeof host !== "object") {
    return null;
  }

  const id = host.id || "";
  const name = host.name || id;

  return {
    id,
    name,
    status: host.status || "pending",
    statusMessage: host.statusMessage || null,
    adminOnly: Boolean(host.adminOnly),
    disabledAt: host.disabledAt || null,
    isHealthy: Boolean(host.isHealthy),
    isStale: Boolean(host.isStale),
  };
};

const isNotificationPinned = (notification) => {
  if (!notification || typeof notification !== "object") return false;
  if (typeof notification.isPinned === "boolean") {
    return notification.isPinned;
  }
  const metadata = notification.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  return Boolean(metadata.pinUntilRead);
};

const coerceNotificationTimestamp = (value) => {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

const sortNotificationsForDisplay = (items) => {
  if (!Array.isArray(items)) return [];
  const copy = [...items];
  copy.sort((a, b) => {
    const aPinned = isNotificationPinned(a) && !a?.isRead;
    const bPinned = isNotificationPinned(b) && !b?.isRead;
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    const aTime = coerceNotificationTimestamp(a?.createdAt);
    const bTime = coerceNotificationTimestamp(b?.createdAt);
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    const aId = typeof a?.id === "string" ? a.id : "";
    const bId = typeof b?.id === "string" ? b.id : "";
    if (aId && bId) {
      return bId.localeCompare(aId);
    }
    if (aId) return -1;
    if (bId) return 1;
    return 0;
  });
  return copy;
};

const VALID_SIDEBAR_ICON_IDS = new Set(
  SIDEBAR_ICON_OPTIONS.map((option) => option.id),
);

const getDefaultUiPreferences = () => ({
  themeId: DEFAULT_THEME_ID,
  sidebarIconStyle: "icons-left",
  systemIcons: { ...SYSTEM_ICON_DEFAULTS },
  showSidebarEndpoints: true,
});

const createEmptyNotificationSummary = () => ({
  total: 0,
  unread: 0,
  byType: {
    system: { total: 0, unread: 0 },
    subscription: { total: 0, unread: 0 },
    script: { total: 0, unread: 0 },
  },
});

function normalizeNotificationSummary(summary) {
  const base = createEmptyNotificationSummary();
  if (!summary || typeof summary !== "object") {
    return base;
  }

  const normalized = createEmptyNotificationSummary();
  normalized.total = Number(summary.total) || 0;
  normalized.unread = Number(summary.unread) || 0;

  const byTypeInput =
    summary.byType && typeof summary.byType === "object" ? summary.byType : {};
  const typeKeys = new Set([
    ...Object.keys(normalized.byType),
    ...Object.keys(byTypeInput),
  ]);

  for (const key of typeKeys) {
    const source = byTypeInput[key] || {};
    const total = Number(source.total) || 0;
    const unread = Number(source.unread) || 0;
    normalized.byType[key] = { total, unread };
  }

  return normalized;
}

function formatNotificationTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSystemIcons(value) {
  if (!isPlainObject(value)) {
    return { ...SYSTEM_ICON_DEFAULTS };
  }

  const normalized = { ...SYSTEM_ICON_DEFAULTS };
  for (const [key, flag] of Object.entries(value)) {
    if (typeof flag === "boolean") {
      normalized[key] = flag;
    }
  }
  return normalized;
}

function areSystemIconStatesEqual(first, second) {
  const allKeys = new Set([
    ...Object.keys(first || {}),
    ...Object.keys(second || {}),
  ]);

  for (const key of allKeys) {
    if ((first || {})[key] !== (second || {})[key]) {
      return false;
    }
  }

  return true;
}

const getLanguageKey = (language) => {
  if (!language) return "";
  return String(language).toLowerCase();
};

const getScriptIcon = (language) => {
  const key = getLanguageKey(language);
  return LANGUAGE_ICONS[key] || DEFAULT_SCRIPT_ICON;
};

const getLanguageLabel = (language) => {
  const key = getLanguageKey(language);
  return LANGUAGE_TEXT_LABELS[key] || LANGUAGE_TEXT_LABELS.default;
};

const getLanguageAccent = (language) => {
  const key = getLanguageKey(language);
  return LANGUAGE_ACCENTS[key] || LANGUAGE_ACCENTS.default;
};

const renderScriptIcon = (icon, className = "h-4 w-4 flex-shrink-0") => {
  if (icon.type === "image") {
    return (
      <img
        src={icon.src}
        alt=""
        aria-hidden="true"
        className={className}
      />
    );
  }

  return (
    <span aria-hidden="true" className={className}>
      {icon.label}
    </span>
  );
};

const parseEndpointFromPath = (path) => {
  if (!path) return null;
  const match = path.match(/^\/script\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const readRouteEndpoint = () => {
  if (typeof window === "undefined") return null;
  return parseEndpointFromPath(window.location.pathname);
};

const buildPathForEndpoint = (endpoint) =>
  endpoint ? `/script/${encodeURIComponent(endpoint)}` : "/";

export default function App() {
  const { confirm, alert } = useNotificationDialog();
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID);
  const [scripts, setScripts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selected, setSelected] = useState(null);
  const [activeTab, setActiveTab] = useState("analytics");
  const [collapsedCategories, setCollapsedCategories] = useState({});
  const [isRecycleOpen, setIsRecycleOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isNotificationCenterOpen, setIsNotificationCenterOpen] = useState(false);
  const [analyticsRefreshKey, setAnalyticsRefreshKey] = useState(0);
  const [isRunningScript, setIsRunningScript] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState(null);
  const [isDraftInitializing, setIsDraftInitializing] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("ui");
  const [routeEndpoint, setRouteEndpoint] = useState(() => readRouteEndpoint());
  const [hasLoadedScripts, setHasLoadedScripts] = useState(false);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  const [runModalScript, setRunModalScript] = useState(null);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [runnerHosts, setRunnerHosts] = useState([]);
  const [runnersLoaded, setRunnersLoaded] = useState(false);
  const [runnerLoadError, setRunnerLoadError] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [hostVersion, setHostVersion] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: "admin", password: "" });
  const [loginError, setLoginError] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);
  const [sidebarIconStyle, setSidebarIconStyle] = useState("icons-left");
  const [systemIcons, setSystemIcons] = useState(() => ({
    ...SYSTEM_ICON_DEFAULTS,
  }));
  const [notifications, setNotifications] = useState([]);
  const [notificationSummary, setNotificationSummary] = useState(() =>
    createEmptyNotificationSummary(),
  );
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState("");
  const [showReadNotifications, setShowReadNotifications] = useState(true);
  const [showSidebarEndpoints, setShowSidebarEndpoints] = useState(true);
  const [uiPreferencesLoaded, setUiPreferencesLoaded] = useState(false);
  const lastSavedUiPreferencesRef = useRef(getDefaultUiPreferences());
  const previousUserIdRef = useRef(null);
  const notificationsInitializedRef = useRef(false);
  const authCheckedRef = useRef(false);
  const draftIdRef = useRef(null);
  const [variablesRefreshKey, setVariablesRefreshKey] = useState(0);

  const visibleSettingsTabs = useMemo(() => {
    if (currentUser?.isAdmin) {
      return SETTINGS_TABS;
    }
    return SETTINGS_TABS.filter((tab) => !ADMIN_ONLY_SETTINGS_TABS.has(tab.id));
  }, [currentUser]);

  useEffect(() => {
    const hasActiveTab = visibleSettingsTabs.some((tab) => tab.id === settingsTab);
    if (!hasActiveTab) {
      const fallbackTab = visibleSettingsTabs[0]?.id || "ui";
      if (settingsTab !== fallbackTab) {
        setSettingsTab(fallbackTab);
      }
    }
  }, [visibleSettingsTabs, settingsTab]);

  const supportsPackageManagement = useMemo(() => {
    if (!selected?.id) {
      return false;
    }
    const language =
      typeof selected.language === "string"
        ? selected.language.trim().toLowerCase()
        : "";
    if (language === "node") {
      return true;
    }
    return (Number(selected?.packageCount) || 0) > 0;
  }, [selected?.id, selected?.language, selected?.packageCount]);

  const availableTabs = useMemo(() => {
    const tabs = [];
    if (!isCreating) {
      tabs.push("analytics");
    }
    tabs.push("editor");
    if (supportsPackageManagement) {
      tabs.push("packages");
    }
    if (
      selected?.permissions?.write ||
      selected?.permissions?.manage ||
      isCreating
    ) {
      tabs.push("variables");
    }
    if (!isCreating) {
      tabs.push("versions");
    }
    if (selected?.permissions?.manage || isCreating) {
      tabs.push("security");
    }
    return tabs;
  }, [
    isCreating,
    selected?.permissions?.write,
    selected?.permissions?.manage,
    supportsPackageManagement,
  ]);

  const handleAuthError = useCallback(
    (error) => {
      if (!error) return;
      if (error.status === 403 && error?.data?.code === "password_change_required") {
        setIsChangingPassword(true);
        setAuthMessage(
          error?.data?.error || "You must change your password before continuing.",
        );
        setAuthChecked(true);
        authCheckedRef.current = true;
      } else if (error.status === 401) {
        const wasAuthChecked = authCheckedRef.current;
        setCurrentUser(null);
        setAuthChecked(true);
        authCheckedRef.current = true;
        if (wasAuthChecked) {
          setAuthMessage("Your session has expired. Please log in.");
        } else {
          setAuthMessage("");
        }
      } else if (error.status === 403) {
        setAuthMessage(error?.data?.error || "Access denied.");
        setAuthChecked(true);
        authCheckedRef.current = true;
      } else {
        setAuthMessage(error?.data?.error || error.message || "Authentication failed.");
        setAuthChecked(true);
        authCheckedRef.current = true;
      }
    },
    [authCheckedRef],
  );

  useEffect(() => {
    authCheckedRef.current = authChecked;
  }, [authChecked]);

  const discardDraft = useCallback(
    async (draftId) => {
      if (!draftId) return;
      try {
        await apiRequest(`/api/scripts/${encodeURIComponent(draftId)}/draft`, {
          method: "DELETE",
        });
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          handleAuthError(err);
        } else {
          console.error("Failed to discard draft script", err);
        }
      }
    },
    [handleAuthError],
  );

  useEffect(() => {
    draftIdRef.current = activeDraftId;
  }, [activeDraftId]);

  useEffect(() => {
    return () => {
      if (draftIdRef.current) {
        discardDraft(draftIdRef.current);
      }
    };
  }, [discardDraft]);

  useEffect(() => {
    if (!isCreating && activeDraftId) {
      discardDraft(activeDraftId);
      setActiveDraftId(null);
      setDraftError("");
    }
  }, [isCreating, activeDraftId, discardDraft]);

  const fetchNotificationSummary = useCallback(async () => {
    if (!currentUser) {
      setNotificationSummary(createEmptyNotificationSummary());
      return;
    }

    try {
      const data = await apiRequest("/api/notifications/summary");
      if (data?.summary) {
        setNotificationSummary(normalizeNotificationSummary(data.summary));
      } else {
        setNotificationSummary(createEmptyNotificationSummary());
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        console.error("Failed to load notification summary", err);
      }
    }
  }, [currentUser, handleAuthError]);

  const fetchNotifications = useCallback(async () => {
    if (!currentUser) {
      setNotifications([]);
      setNotificationsError("");
      setNotificationsLoading(false);
      return;
    }

    setNotificationsLoading(true);
    setNotificationsError("");

    try {
      const data = await apiRequest(`/api/notifications`);
      const list = Array.isArray(data?.notifications)
        ? sortNotificationsForDisplay(data.notifications)
        : [];
      setNotifications(list);
      if (data?.summary) {
        setNotificationSummary(normalizeNotificationSummary(data.summary));
      }
      notificationsInitializedRef.current = true;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        console.error("Failed to load notifications", err);
        setNotificationsError(
          err?.data?.error || err.message || "Failed to load notifications.",
        );
      }
    } finally {
      setNotificationsLoading(false);
    }
  }, [currentUser, handleAuthError]);

  useEffect(() => {
    if (!availableTabs.includes(activeTab)) {
      setActiveTab(
        availableTabs[0] || (isCreating ? "editor" : "analytics"),
      );
    }
  }, [availableTabs, activeTab, isCreating]);

  useEffect(() => {
    if (!currentUser) {
      setNotifications([]);
      setNotificationsError("");
      setNotificationSummary(createEmptyNotificationSummary());
      notificationsInitializedRef.current = false;
      setIsNotificationsOpen(false);
      setIsNotificationCenterOpen(false);
      setShowReadNotifications(true);
      return;
    }

    fetchNotificationSummary();
  }, [currentUser, fetchNotificationSummary]);

  useEffect(() => {
    if (!currentUser) return undefined;

    const intervalId = setInterval(() => {
      fetchNotificationSummary();
    }, 60000);

    return () => clearInterval(intervalId);
  }, [currentUser, fetchNotificationSummary]);

  useEffect(() => {
    if ((!isNotificationsOpen && !isNotificationCenterOpen) || !currentUser)
      return;
    fetchNotifications();
  }, [
    isNotificationsOpen,
    isNotificationCenterOpen,
    currentUser,
    fetchNotifications,
  ]);

  const handleOpenNotificationCenter = useCallback(() => {
    setIsNotificationCenterOpen(true);
  }, []);

  const handleCloseNotificationCenter = useCallback(() => {
    setIsNotificationCenterOpen(false);
  }, []);

  useEffect(() => {
    if (!isNotificationCenterOpen) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        handleCloseNotificationCenter();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isNotificationCenterOpen, handleCloseNotificationCenter]);

  const canDeleteScript = Boolean(
    selected?.permissions?.delete || selected?.permissions?.manage,
  );
  const canClearLogs = Boolean(
    selected?.permissions?.clearLogs || selected?.permissions?.manage,
  );
  const unreadNotifications = notificationSummary?.unread || 0;
  const totalNotifications = notificationSummary?.total || 0;

  const unreadNotificationItems = useMemo(
    () => notifications.filter((item) => !item.isRead),
    [notifications],
  );

  const hasUnreadNotifications = unreadNotificationItems.length > 0;

  const unreadNotificationIds = useMemo(
    () => unreadNotificationItems.map((item) => item.id),
    [unreadNotificationItems],
  );

  const filteredNotifications = useMemo(
    () =>
      showReadNotifications
        ? notifications
        : notifications.filter((item) => !item.isRead),
    [notifications, showReadNotifications],
  );

  const resolveAudienceLabel = useCallback((audience) => {
    if (!audience || typeof audience !== "object") return null;
    const type = audience.type;
    if (type === "admins") return "Admins";
    if (type === "other-admins") return "Other admins";
    if (type === "all") return "All users";
    if (type === "user") {
      return audience.value || (audience.usernames && audience.usernames[0]) || "Direct";
    }
    return null;
  }, []);

  const handleToggleShowReadNotifications = useCallback(() => {
    setShowReadNotifications((prev) => !prev);
  }, []);

  const fetchCurrentUser = useCallback(async () => {
    try {
      const data = await apiRequest("/api/auth/me");
      const user = data?.user || null;
      setCurrentUser(user);
      setHostVersion(data?.hostVersion || null);
      setIsChangingPassword(user?.mustChangePassword ?? false);
      setAuthChecked(true);
      return user;
    } catch (err) {
      handleAuthError(err);
      setHostVersion(null);
      setAuthChecked(true);
      return null;
    }
  }, [handleAuthError]);

  const handleMarkNotificationsRead = useCallback(
    async (ids) => {
      const candidates = Array.isArray(ids) ? ids : [ids];
      const uniqueIds = Array.from(
        new Set(
          candidates
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter(Boolean),
        ),
      );

      if (!uniqueIds.length) {
        return;
      }

      const readTimestamp = new Date().toISOString();

      try {
        const data = await apiRequest("/api/notifications/read", {
          method: "POST",
          body: { ids: uniqueIds },
        });

        if (data?.summary) {
          setNotificationSummary(normalizeNotificationSummary(data.summary));
        }

        setNotifications((prev) =>
          sortNotificationsForDisplay(
            prev.map((item) =>
              uniqueIds.includes(item.id)
                ? {
                    ...item,
                    isRead: true,
                    readAt: item.readAt || readTimestamp,
                  }
                : item,
            ),
          ),
        );
        setNotificationsError("");
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          handleAuthError(err);
        } else {
          console.error("Failed to update notifications", err);
          setNotificationsError(
            err?.data?.error || err.message || "Failed to update notifications.",
          );
        }
      }
    },
    [handleAuthError],
  );

  const handleLoginInputChange = (event) => {
    const { name, value } = event.target;
    setLoginForm((prev) => ({ ...prev, [name]: value }));
    if (loginError) setLoginError("");
    if (authMessage) setAuthMessage("");
  };

  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    if (isLoggingIn) return;

    const username = loginForm.username.trim();
    if (!username || !loginForm.password) {
      setLoginError("Username and password are required.");
      return;
    }

    setIsLoggingIn(true);
    setLoginError("");
    setAuthMessage("");

    try {
      const data = await apiRequest("/api/auth/login", {
        method: "POST",
        body: { username, password: loginForm.password },
      });
      const user = data?.user || null;
      setCurrentUser(user);
      setIsChangingPassword(user?.mustChangePassword ?? false);
      setLoginForm((prev) => ({ ...prev, password: "" }));
      setAuthChecked(true);
      setAuthMessage("");
      setHasLoadedScripts(false);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        setLoginError(err?.data?.error || "Invalid credentials");
      } else {
        setLoginError("Unable to sign in. Please try again.");
        console.error("Login failed", err);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch (err) {
      console.error("Failed to log out", err);
    } finally {
      setCurrentUser(null);
      setScripts([]);
      setSelected(null);
      setIsCreating(false);
      setIsChangingPassword(false);
      setAuthMessage("");
      setHasLoadedScripts(false);
      setIsNotificationCenterOpen(false);
      setShowReadNotifications(true);
      setRunnerHosts([]);
      setRunnersLoaded(false);
      setRunnerLoadError("");
      setHostVersion(null);
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setPasswordError("");
      setPasswordSuccess("");
      setLoginError("");
    }
  };

  const handlePasswordInputChange = (event) => {
    const { name, value } = event.target;
    setPasswordForm((prev) => ({ ...prev, [name]: value }));
    if (passwordError) setPasswordError("");
    if (passwordSuccess) setPasswordSuccess("");
  };

  useEffect(() => {
    if (!currentUser) {
      previousUserIdRef.current = null;
      const loginDefaults = getDefaultUiPreferences();
      setThemeId(LOGIN_THEME_ID);
      setSidebarIconStyle(loginDefaults.sidebarIconStyle);
      setSystemIcons({ ...loginDefaults.systemIcons });
      setShowSidebarEndpoints(loginDefaults.showSidebarEndpoints);
      lastSavedUiPreferencesRef.current = {
        themeId: LOGIN_THEME_ID,
        sidebarIconStyle: loginDefaults.sidebarIconStyle,
        systemIcons: { ...loginDefaults.systemIcons },
        showSidebarEndpoints: loginDefaults.showSidebarEndpoints,
      };
      setUiPreferencesLoaded(false);
      return;
    }

    let isCancelled = false;
    const currentUserId = currentUser.id || currentUser.username || null;
    const previousUserId = previousUserIdRef.current;
    previousUserIdRef.current = currentUserId;

    if (previousUserId !== currentUserId) {
      const defaults = getDefaultUiPreferences();
      setThemeId(defaults.themeId);
      setSidebarIconStyle(defaults.sidebarIconStyle);
      setSystemIcons({ ...defaults.systemIcons });
      setShowSidebarEndpoints(defaults.showSidebarEndpoints);
    }

    setUiPreferencesLoaded(false);

    (async () => {
      try {
        const data = await apiRequest("/api/preferences");
        if (isCancelled) return;

        const preferences = data?.preferences || {};

        const preferredTheme = preferences["ui.theme"];
        const nextThemeId =
          typeof preferredTheme === "string" && THEMES[preferredTheme]
            ? preferredTheme
            : DEFAULT_THEME_ID;

        const preferredSidebarIconStyle = preferences["ui.sidebarIconStyle"];
        const nextSidebarIconStyle =
          typeof preferredSidebarIconStyle === "string" &&
          VALID_SIDEBAR_ICON_IDS.has(preferredSidebarIconStyle)
            ? preferredSidebarIconStyle
            : "icons-left";

        const nextSystemIcons = normalizeSystemIcons(preferences["ui.systemIcons"]);

        const preferredShowSidebarEndpoints =
          preferences["ui.showSidebarEndpoints"];
        const nextShowSidebarEndpoints =
          typeof preferredShowSidebarEndpoints === "boolean"
            ? preferredShowSidebarEndpoints
            : true;

        lastSavedUiPreferencesRef.current = {
          themeId: nextThemeId,
          sidebarIconStyle: nextSidebarIconStyle,
          systemIcons: { ...nextSystemIcons },
          showSidebarEndpoints: nextShowSidebarEndpoints,
        };

        setThemeId(nextThemeId);
        setSidebarIconStyle(nextSidebarIconStyle);
        setSystemIcons(nextSystemIcons);
        setShowSidebarEndpoints(nextShowSidebarEndpoints);
      } catch (err) {
        if (!isCancelled) {
          if (err?.status === 401 || err?.status === 403) {
            handleAuthError(err);
          } else {
            console.error("Failed to load preferences", err);
          }
          const defaults = getDefaultUiPreferences();
          lastSavedUiPreferencesRef.current = {
            themeId: defaults.themeId,
            sidebarIconStyle: defaults.sidebarIconStyle,
            systemIcons: { ...defaults.systemIcons },
            showSidebarEndpoints: defaults.showSidebarEndpoints,
          };
          setThemeId(defaults.themeId);
          setSidebarIconStyle(defaults.sidebarIconStyle);
          setSystemIcons({ ...defaults.systemIcons });
          setShowSidebarEndpoints(defaults.showSidebarEndpoints);
        }
      } finally {
        if (!isCancelled) {
          setUiPreferencesLoaded(true);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [currentUser, handleAuthError]);

  const handlePasswordSubmit = async (event) => {
    event.preventDefault();
    if (isUpdatingPassword) return;

    if (!passwordForm.currentPassword) {
      setPasswordError("Current password is required.");
      return;
    }

    if (!passwordForm.newPassword || passwordForm.newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters long.");
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }

    setIsUpdatingPassword(true);
    setPasswordError("");
    setPasswordSuccess("");

    try {
      await apiRequest("/api/auth/change-password", {
        method: "POST",
        body: {
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        },
      });
      setPasswordSuccess("Password updated successfully.");
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      const user = await fetchCurrentUser();
      if (user && !user.mustChangePassword) {
        setIsChangingPassword(false);
        setAuthMessage("");
        setHasLoadedScripts(false);
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
        setPasswordError(err?.data?.error || "Unable to change password.");
      } else {
        setPasswordError(err?.data?.error || err.message || "Failed to change password.");
        console.error("Password change failed", err);
      }
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  useEffect(() => {
    fetchCurrentUser();
  }, [fetchCurrentUser]);

  useEffect(() => {
    if (isChangingPassword) {
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setPasswordError("");
      setPasswordSuccess("");
    }
  }, [isChangingPassword]);

  const themeOptions = useMemo(
    () => THEME_ORDER.map((id) => THEMES[id]).filter(Boolean),
    [],
  );
  const activeThemeId = THEMES[themeId] ? themeId : DEFAULT_THEME_ID;
  const resolvedThemeId = !currentUser || isChangingPassword
    ? LOGIN_THEME_ID
    : activeThemeId;

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = resolvedThemeId;
    }
  }, [resolvedThemeId]);

  useEffect(() => {
    if (activeTab === "security" && !selected?.permissions?.manage) {
      setActiveTab("analytics");
    }
  }, [activeTab, selected?.permissions?.manage]);

  const navigateToEndpoint = useCallback((endpoint) => {
    if (typeof window === "undefined") return;
    const targetPath = buildPathForEndpoint(endpoint);
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, "", targetPath);
    }
    setRouteEndpoint(endpoint || null);
  }, []);

  const openSettings = useCallback(() => {
    setIsSettingsOpen(true);
    setSettingsTab("ui");
    setSelected(null);
    setIsCreating(false);
    setIsRecycleOpen(false);
    setActiveTab("analytics");
    navigateToEndpoint(null);
  }, [navigateToEndpoint]);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  const triggerAnalyticsRefresh = useCallback(() => {
    setAnalyticsRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handlePopState = () => {
      setRouteEndpoint(readRouteEndpoint());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const getCategoryKey = useCallback(
    (categoryName) => (categoryName?.trim() || "General").toLowerCase(),
    [],
  );

  const ensureCategoryExpanded = useCallback(
    (categoryName) => {
      const key = getCategoryKey(categoryName);
      setCollapsedCategories((prev) => {
        if (prev?.[key] === false) return prev;
        return { ...prev, [key]: false };
      });
    },
    [getCategoryKey],
  );

  const loadScripts = useCallback(
    async (focusId = null) => {
      if (!currentUser || isChangingPassword) {
        setScripts([]);
        setSelected(null);
        setHasLoadedScripts(true);
        return;
      }

      try {
        const data = await apiRequest("/api/scripts");
        const normalized = (Array.isArray(data) ? data : []).map((script) => {
          const rawCategoryName =
            (script.category && script.category.name) ||
            script.categoryName ||
            "";
          const categoryName = rawCategoryName.trim();
          const categoryId = script.category?.id || script.categoryId || null;
          const categoryDefaultRunnerHostId =
            script.categoryDefaultRunnerHostId ||
            script.category?.defaultRunnerHostId ||
            null;
          const categoryDefaultRunner =
            normalizeRunnerHost(script.categoryDefaultRunner) ||
            normalizeRunnerHost(script.category?.defaultRunner) ||
            null;
          const scriptRunner = normalizeRunnerHost(script.runner);
          const resolvedRunner =
            normalizeRunnerHost(script.resolvedRunner) ||
            scriptRunner ||
            categoryDefaultRunner;

          const acceptedMethods = Array.isArray(script.acceptedMethods)
            ? script.acceptedMethods
                .map((method) =>
                  typeof method === "string" ? method.toUpperCase() : "",
                )
                .filter((method) => SUPPORTED_HTTP_METHODS.includes(method))
            : DEFAULT_ACCEPTED_METHODS;

          const mappedCategory = script.category
            ? {
                id: script.category.id,
                name: (script.category.name || "").trim(),
                description: script.category.description || "",
                defaultLanguage: script.category.defaultLanguage || null,
                defaultRunnerHostId:
                  script.category.defaultRunnerHostId ||
                  categoryDefaultRunnerHostId ||
                  null,
                defaultRunner:
                  normalizeRunnerHost(script.category.defaultRunner) ||
                  categoryDefaultRunner,
                isSystem: Boolean(script.category.isSystem),
              }
            : categoryId
            ? {
                id: categoryId,
                name: categoryName,
                description: "",
                defaultLanguage: null,
                defaultRunnerHostId: categoryDefaultRunnerHostId,
                defaultRunner: categoryDefaultRunner,
                isSystem: false,
              }
            : null;

          return {
            ...script,
            category: mappedCategory,
            categoryId,
            categoryName,
            categoryDefaultRunnerHostId,
            categoryDefaultRunner,
            packageCount: Number(script.packageCount) || 0,
            packageCheckError: script.packageCheckError || null,
            packageRunnerHostId: script.packageRunnerHostId || null,
            inheritCategoryPermissions:
              script.inheritCategoryPermissions === undefined
                ? true
                : Boolean(script.inheritCategoryPermissions),
            inheritCategoryRunner:
              script.inheritCategoryRunner === undefined
                ? true
                : Boolean(script.inheritCategoryRunner),
            acceptedMethods:
              acceptedMethods.length > 0
                ? acceptedMethods
                : DEFAULT_ACCEPTED_METHODS,
            runMethod: script.runMethod || "POST",
            runHeaders: script.runHeaders || {},
            runBody: script.runBody ?? "",
            hasApiToken: Boolean(script.hasApiToken),
            apiTokenPreview: script.apiTokenPreview || null,
            requireAuthentication:
              script.requireAuthentication === undefined
                ? true
                : Boolean(script.requireAuthentication),
            includeAutomnResponseData:
              script.includeAutomnResponseData === undefined
                ? false
                : Boolean(script.includeAutomnResponseData),
            includeRunIdInResponse:
              script.includeRunIdInResponse === undefined
                ? true
                : Boolean(script.includeRunIdInResponse),
            runnerHostId: script.runnerHostId || null,
            runner: scriptRunner,
            resolvedRunner,
          };
        });

        setScripts(normalized);
        setSelected((prev) => {
          if (focusId) {
            const focused = normalized.find((script) => script.id === focusId);
            if (focused) return focused;
          }

          if (routeEndpoint) {
            const routed = normalized.find(
              (script) => script.endpoint === routeEndpoint,
            );
            if (routed) return routed;
            return null;
          }

          if (prev && !prev.id) {
            return prev;
          }

          if (prev?.isDraft) {
            return prev;
          }

          if (prev?.id) {
            return normalized.find((script) => script.id === prev.id) || null;
          }

          return null;
        });
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          handleAuthError(err);
        } else {
          console.error(err);
        }
      } finally {
        setHasLoadedScripts(true);
      }
    },
    [currentUser, isChangingPassword, routeEndpoint, handleAuthError],
  );

  const loadCategories = useCallback(async () => {
    if (!currentUser || isChangingPassword) {
      setCategories([]);
      setCategoriesLoaded(true);
      return;
    }

    try {
      const response = await apiRequest("/api/collections");
      const list = Array.isArray(response?.collections)
        ? response.collections
        : Array.isArray(response?.categories)
        ? response.categories
        : [];
      const normalized = list.map((category) => ({
        id: category.id,
        name: (category.name || "").trim(),
        description: category.description || "",
        defaultLanguage: category.defaultLanguage || null,
        defaultRunnerHostId: category.defaultRunnerHostId || null,
        defaultRunner: normalizeRunnerHost(category.defaultRunner),
        isSystem: Boolean(category.isSystem),
        permissions: {
          read: Boolean(category.permissions?.read),
          write: Boolean(category.permissions?.write),
          delete: Boolean(category.permissions?.delete),
          run: Boolean(category.permissions?.run),
          clearLogs: Boolean(category.permissions?.clearLogs),
          manage: Boolean(category.permissions?.manage),
        },
        scriptCount: Number(category.scriptCount) || 0,
      }));
      setCategories(normalized);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        console.error(err);
      }
    } finally {
      setCategoriesLoaded(true);
    }
  }, [currentUser, isChangingPassword, handleAuthError]);

  const loadRunnerHosts = useCallback(async () => {
    if (!currentUser || isChangingPassword) {
      setRunnerHosts([]);
      setRunnerLoadError("");
      setRunnersLoaded(true);
      return;
    }

    setRunnerLoadError("");
    setRunnersLoaded(false);

    try {
      const response = await apiRequest("/api/runners");
      const list = Array.isArray(response?.runnerHosts)
        ? response.runnerHosts
        : [];
      const normalized = list
        .map((runner) => normalizeRunnerHost(runner))
        .filter(Boolean)
        .map((runner) => ({
          ...runner,
          name: runner.name || runner.id,
        }))
        .sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", undefined, {
            sensitivity: "base",
          }),
        );
      setRunnerHosts(normalized);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        setRunnerLoadError(
          err?.data?.error || err.message || "Failed to load runner hosts.",
        );
      }
      setRunnerHosts([]);
    } finally {
      setRunnersLoaded(true);
    }
  }, [currentUser, isChangingPassword, handleAuthError]);

  useEffect(() => {
    if (!currentUser || isChangingPassword) {
      setScripts([]);
      setSelected(null);
      return;
    }
    loadScripts();
  }, [currentUser, isChangingPassword, loadScripts]);

  useEffect(() => {
    loadScripts();
  }, [loadScripts]);

  useEffect(() => {
    if (!currentUser || isChangingPassword) {
      setCategories([]);
      setCategoriesLoaded(true);
      return;
    }
    loadCategories();
  }, [currentUser, isChangingPassword, loadCategories]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    loadRunnerHosts();
  }, [loadRunnerHosts]);

  const isSearching = searchTerm.trim().length > 0;

  const persistUserPreferences = useCallback(
    async (preferenceMap) => {
      if (!currentUser) return;
      try {
        await apiRequest("/api/preferences", {
          method: "POST",
          body: { preferences: preferenceMap },
        });
      } catch (err) {
        console.error("Failed to save preferences", err);
      }
    },
    [currentUser],
  );

  useEffect(() => {
    if (!currentUser || !uiPreferencesLoaded) {
      return;
    }

    const pendingPreferences = {
      themeId: activeThemeId,
      sidebarIconStyle,
      systemIcons,
      showSidebarEndpoints,
    };

    const lastSaved = lastSavedUiPreferencesRef.current;
    if (
      lastSaved &&
      lastSaved.themeId === pendingPreferences.themeId &&
      lastSaved.sidebarIconStyle === pendingPreferences.sidebarIconStyle &&
      areSystemIconStatesEqual(lastSaved.systemIcons, pendingPreferences.systemIcons) &&
      lastSaved.showSidebarEndpoints === pendingPreferences.showSidebarEndpoints
    ) {
      return;
    }

    const timeoutId = setTimeout(() => {
      lastSavedUiPreferencesRef.current = {
        themeId: pendingPreferences.themeId,
        sidebarIconStyle: pendingPreferences.sidebarIconStyle,
        systemIcons: { ...pendingPreferences.systemIcons },
        showSidebarEndpoints: pendingPreferences.showSidebarEndpoints,
      };

      persistUserPreferences({
        "ui.theme": pendingPreferences.themeId,
        "ui.sidebarIconStyle": pendingPreferences.sidebarIconStyle,
        "ui.systemIcons": pendingPreferences.systemIcons,
        "ui.showSidebarEndpoints": pendingPreferences.showSidebarEndpoints,
      });
    }, 150);

    return () => clearTimeout(timeoutId);
  }, [
    activeThemeId,
    sidebarIconStyle,
    systemIcons,
    showSidebarEndpoints,
    currentUser,
    uiPreferencesLoaded,
    persistUserPreferences,
  ]);

  const groupedScripts = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    const stripEmoji = (value = "") =>
      value
        .replace(
          /([\u2600-\u26FF]|[\u2700-\u27BF]|[\u{1F000}-\u{1FAFF}]|[\u{1F300}-\u{1F5FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}])/gu,
          "",
        )
        .replace(/\uFE0F/gu, "")
        .trim();

    const normalizeCategoryName = (category) => {
      const stripped = stripEmoji(category);
      return stripped.length > 0 ? stripped : category;
    };

    const groups = scripts
      .filter((script) => !script.isRecycled)
      .reduce((acc, script) => {
        const category = script.categoryName ? script.categoryName : "General";
        const key = getCategoryKey(category);
        if (!acc[key]) acc[key] = { display: category, scripts: [] };
        acc[key].scripts.push(script);
        return acc;
      }, {});

    const entries = Object.entries(groups)
      .map(([key, { display, scripts: projectScripts }]) => {
        const filtered = query
          ? projectScripts.filter((script) => {
              const name = (script.name || "").toLowerCase();
              const endpoint = (script.endpoint || "").toLowerCase();
              return name.includes(query) || endpoint.includes(query);
            })
          : projectScripts;

        if (filtered.length === 0) return null;

        return {
          key,
          display,
          scripts: [...filtered].sort((a, b) =>
            (a.name || a.endpoint || "").localeCompare(
              b.name || b.endpoint || "",
              undefined,
              { sensitivity: "base" },
            ),
          ),
        };
      })
      .filter(Boolean);

    const generalEntries = entries.filter(({ key }) => key === "general");
    const otherEntries = entries
      .filter(({ key }) => key !== "general")
      .sort((entryA, entryB) =>
        normalizeCategoryName(entryA.display).localeCompare(
          normalizeCategoryName(entryB.display),
          undefined,
          { sensitivity: "base" },
        ),
      );

    return [...generalEntries, ...otherEntries];
  }, [scripts, searchTerm, getCategoryKey]);

  useEffect(() => {
    setCollapsedCategories((prev) => {
      const next = {};
      groupedScripts.forEach(({ key }) => {
        next[key] = Object.prototype.hasOwnProperty.call(prev, key)
          ? prev[key]
          : true;
      });

      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (
        prevKeys.length !== nextKeys.length ||
        nextKeys.some((key) => prev[key] !== next[key])
      ) {
        return next;
      }
      return prev;
    });
  }, [groupedScripts]);

  const recycledScripts = useMemo(
    () =>
      scripts
        .filter((script) => script.isRecycled)
        .sort((a, b) =>
          (a.name || a.endpoint || "").localeCompare(
            b.name || b.endpoint || "",
            undefined,
            { sensitivity: "base" },
          ),
        ),
    [scripts],
  );

  const recycledCount = recycledScripts.length;

  const writableCategories = useMemo(() => {
    if (!Array.isArray(categories)) return [];
    if (currentUser?.isAdmin) return categories;
    return categories.filter(
      (category) =>
        category.id === DEFAULT_CATEGORY_ID || category.permissions?.write,
    );
  }, [categories, currentUser?.isAdmin]);

  useEffect(() => {
    if (!routeEndpoint) {
      if (!isCreating) {
        setSelected((prev) => (prev && !prev.id ? prev : null));
      }
      setIsRecycleOpen(false);
      return;
    }

    const match = scripts.find((script) => script.endpoint === routeEndpoint);
    if (match) {
      closeSettings();
      const isDifferentScript = match.id !== selected?.id;
      setSelected(match);
      setIsRecycleOpen(Boolean(match.isRecycled));
      setIsCreating(false);
      if (!match.isRecycled) {
        ensureCategoryExpanded(match.categoryName || "General");
      }
      if (isDifferentScript) {
        setActiveTab("analytics");
      }
    } else if (hasLoadedScripts) {
      setSelected(null);
    }
  }, [
    routeEndpoint,
    scripts,
    ensureCategoryExpanded,
    isCreating,
    hasLoadedScripts,
    closeSettings,
    selected?.id,
  ]);

  const handleSelect = (script) => {
    if (!script) return;
    closeSettings();
    setIsRecycleOpen(false);
    setIsCreating(false);
    setSelected(script);
    setActiveTab("analytics");
    ensureCategoryExpanded(script.categoryName || "General");
    navigateToEndpoint(script.endpoint);
  };

  const handleSelectRecycled = (script) => {
    if (!script) return;
    closeSettings();
    setIsRecycleOpen(true);
    setIsCreating(false);
    setSelected(script);
    setActiveTab("analytics");
    navigateToEndpoint(script.endpoint);
  };

  const toggleCategory = (categoryKey) => {
    setCollapsedCategories((prev) => ({
      ...prev,
      [categoryKey]: !(prev?.[categoryKey] ?? true),
    }));
  };

  const handleCreate = useCallback(async () => {
    if (isDraftInitializing) {
      return;
    }

    closeSettings();
    setIsRecycleOpen(false);
    setDraftError("");
    setIsDraftInitializing(true);

    try {
      if (activeDraftId) {
        await discardDraft(activeDraftId);
        setActiveDraftId(null);
      }

      const payload = {};
      const preferredCategoryId =
        selected?.collectionId ||
        selected?.categoryId ||
        selected?.collection?.id ||
        selected?.category?.id ||
        "";
      if (preferredCategoryId) {
        payload.categoryId = preferredCategoryId;
      }
      if (selected?.language) {
        payload.language = String(selected.language).toLowerCase();
      }

      const draft = await apiRequest("/api/scripts/draft", {
        method: "POST",
        body: payload,
      });

      setActiveDraftId(draft?.id || null);
      const basePermissions =
        draft?.permissions && typeof draft.permissions === "object"
          ? draft.permissions
          : {};
      setSelected({
        ...draft,
        name: "",
        endpoint: "",
        isDraft: true,
        variableCount: Number(draft?.variableCount) || 0,
        packageCount: Number(draft?.packageCount) || 0,
        packageCheckError: draft?.packageCheckError || null,
        permissions: {
          ...basePermissions,
          write: true,
          manage: true,
        },
      });
      setIsCreating(true);
      setActiveTab("editor");
      navigateToEndpoint(null);
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        handleAuthError(err);
      } else {
        setDraftError(
          err?.data?.error || err?.message || "Failed to start a new script.",
        );
      }
      setIsCreating(false);
    } finally {
      setIsDraftInitializing(false);
    }
  }, [
    isDraftInitializing,
    closeSettings,
    setIsRecycleOpen,
    activeDraftId,
    discardDraft,
    selected?.collectionId,
    selected?.categoryId,
    selected?.collection?.id,
    selected?.category?.id,
    selected?.language,
    apiRequest,
    handleAuthError,
    navigateToEndpoint,
    setActiveTab,
  ]);

  const handleSaved = (result) => {
    closeSettings();
    const focusId = result?.id || selected?.id || null;
    const endpoint = result?.endpoint || selected?.endpoint || null;
    setActiveDraftId(null);
    setDraftError("");
    setIsCreating(false);
    loadScripts(focusId);
    setActiveTab("analytics");
    if (endpoint) {
      navigateToEndpoint(endpoint);
    } else {
      navigateToEndpoint(null);
    }
  };

  const applyScriptUpdates = useCallback(
    (scriptId, updates = {}) => {
      if (!scriptId) return;
      setScripts((prev) =>
        prev.map((item) => (item.id === scriptId ? { ...item, ...updates } : item)),
      );
      setSelected((prev) =>
        prev?.id === scriptId ? { ...prev, ...updates } : prev,
      );
      setRunModalScript((prev) =>
        prev?.id === scriptId ? { ...prev, ...updates } : prev,
      );
    },
    [setScripts, setSelected, setRunModalScript],
  );

  const handleTokenChanged = useCallback(
    (scriptId, updates = {}) => {
      applyScriptUpdates(scriptId, updates);
    },
    [applyScriptUpdates],
  );

  const handleSecurityUpdated = useCallback(
    (scriptId, updates = {}) => {
      applyScriptUpdates(scriptId, updates);
    },
    [applyScriptUpdates],
  );

  const handleVariablesChanged = useCallback(
    (scriptId, updates = {}) => {
      if (scriptId) {
        setVariablesRefreshKey((key) => key + 1);
        applyScriptUpdates(scriptId, updates);
      }
    },
    [applyScriptUpdates],
  );

  const handlePackagesChanged = useCallback(
    (scriptId, updates = {}) => {
      if (scriptId) {
        applyScriptUpdates(scriptId, updates);
      }
    },
    [applyScriptUpdates],
  );

  const handleOpenRunModal = (script) => {
    if (!script?.id || !script?.endpoint) return;
    setRunModalScript(script);
    setIsRunModalOpen(true);
  };

  const handleCloseRunModal = () => {
    if (isRunningScript) return;
    setRunModalScript(null);
    setIsRunModalOpen(false);
  };

  const handleRecycle = async (script) => {
    if (!script?.endpoint) return;
    const label = script.name || script.endpoint;
    const confirmed = await confirm({
      title: `Move "${label}" to the recycle bin?`,
      message: "You can restore this script later from the recycle bin.",
      tone: "warn",
      confirmLabel: "Move to recycle bin",
    });
    if (!confirmed) return;

    try {
      await apiRequest(`/api/scripts/${encodeURIComponent(script.endpoint)}`, {
        method: "DELETE",
      });
      setSelected(null);
      setActiveTab("analytics");
      setIsRecycleOpen(true);
      setIsCreating(false);
      closeSettings();
      navigateToEndpoint(null);
      await loadScripts();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        await alert({
          title: "Failed to recycle script",
          message: err?.data?.error || err.message || "An unexpected error occurred.",
          tone: "danger",
          confirmLabel: "Dismiss",
        });
      }
    }
  };

  const handlePermanentDelete = async (script) => {
    if (!script?.id) return;
    const label = script.name || script.endpoint;
    const confirmed = await confirm({
      title: `Permanently delete "${label}"?`,
      message:
        "This will remove the script, its settings, and all logs. This cannot be undone.",
      tone: "danger",
      confirmLabel: "Delete script",
    });
    if (!confirmed) return;

    try {
      await apiRequest(`/api/scripts/${script.id}/permanent`, {
        method: "DELETE",
      });
      setSelected(null);
      setActiveTab("analytics");
      setIsRecycleOpen(false);
      setIsCreating(false);
      closeSettings();
      navigateToEndpoint(null);
      await loadScripts();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        await alert({
          title: "Failed to delete script",
          message: err?.data?.error || err.message || "An unexpected error occurred.",
          tone: "danger",
          confirmLabel: "Dismiss",
        });
      }
    }
  };

  const handleRestore = async (script) => {
    if (!script?.id) return;

    try {
      const responseBody = await apiRequest(`/api/scripts/${script.id}/recover`, {
        method: "POST",
      });

      const restoredEndpoint = responseBody?.endpoint || script.endpoint;

      setIsRecycleOpen(false);
      setIsCreating(false);
      setSelected((prev) =>
        prev && prev.id === script.id ? { ...prev, isRecycled: false } : prev,
      );
      closeSettings();
      navigateToEndpoint(restoredEndpoint);
      await loadScripts(script.id);
      setActiveTab("analytics");
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        await alert({
          title: "Failed to restore script",
          message: err?.data?.error || err.message || "An unexpected error occurred.",
          tone: "danger",
          confirmLabel: "Dismiss",
        });
      }
    }
  };

  const handleClearLogs = async (script) => {
    if (!script?.id) return;
    const label = script.name || script.endpoint;
    const confirmed = await confirm({
      title: `Clear all logs for "${label}"?`,
      message: "This will permanently remove all stored logs for the script.",
      tone: "warn",
      confirmLabel: "Clear logs",
    });
    if (!confirmed) return;

    try {
      await apiRequest(`/api/scripts/${script.id}/logs`, {
        method: "DELETE",
      });
      triggerAnalyticsRefresh();
      setActiveTab("analytics");
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        await alert({
          title: "Failed to clear logs",
          message: err?.data?.error || err.message || "An unexpected error occurred.",
          tone: "danger",
          confirmLabel: "Dismiss",
        });
      }
    }
  };

  const persistRunDefaults = useCallback(
    async (script, { method, headers, bodyRaw }) => {
      if (!script?.id) return;

      const payload = {
        id: script.id,
        name: script.name || "",
        endpoint: script.endpoint,
        language: script.language,
        timeout: Number.isFinite(script.timeout)
          ? script.timeout
          : Number(script.timeout) || 0,
        code: script.code || "",
        categoryId: script.categoryId || null,
        inheritCategoryPermissions:
          script?.inheritCategoryPermissions === undefined
            ? true
            : Boolean(script.inheritCategoryPermissions),
        runMethod: method,
        runHeaders: headers,
        runBody: bodyRaw || "",
      };

      await apiRequest("/api/scripts", {
        method: "POST",
        body: payload,
      });

      setScripts((prev) =>
        prev.map((item) =>
          item.id === script.id
            ? {
                ...item,
                runMethod: method,
                runHeaders: headers,
                runBody: bodyRaw || "",
              }
            : item,
        ),
      );
      setSelected((prev) =>
        prev?.id === script.id
          ? {
              ...prev,
              runMethod: method,
              runHeaders: headers,
              runBody: bodyRaw || "",
            }
          : prev,
      );
      setRunModalScript((prev) =>
        prev?.id === script.id
          ? {
              ...prev,
              runMethod: method,
              runHeaders: headers,
              runBody: bodyRaw || "",
            }
          : prev,
      );
    },
    [setScripts, setSelected, setRunModalScript],
  );

  const handleRunScript = async (script, runConfig) => {
    if (!script?.id || !script?.endpoint || isRunningScript) return;
    if (!runConfig) return;

    const { method, headers, body, bodyRaw, saveAsDefault } = runConfig;

    if (saveAsDefault) {
      try {
        await persistRunDefaults(script, { method, headers, bodyRaw });
      } catch (err) {
        await alert({
          title: "Failed to save defaults",
          message: err?.message || "An unexpected error occurred.",
          tone: "danger",
          confirmLabel: "Dismiss",
        });
        return;
      }
    }

    const normalizedMethod = method?.toUpperCase?.() || "POST";
    const allowedMethods = Array.isArray(script.acceptedMethods)
      ? script.acceptedMethods
          .map((value) =>
            typeof value === "string" ? value.toUpperCase() : "",
          )
          .filter((value) => SUPPORTED_HTTP_METHODS.includes(value))
      : DEFAULT_ACCEPTED_METHODS;
    const allowedMethodSet = new Set(allowedMethods);
    if (allowedMethodSet.size > 0 && !allowedMethodSet.has(normalizedMethod)) {
      await alert({
        title: "HTTP method not allowed",
        message: `This script only accepts ${allowedMethods.join(", ")} requests.`,
        tone: "danger",
        confirmLabel: "Dismiss",
      });
      return;
    }

    setIsRunningScript(true);
    setActiveTab("analytics");

    try {
      const basePath = `/s/${encodeURIComponent(script.endpoint)}`;
      const requestHeaders = { ...(headers || {}) };
      const hasContentType = Object.keys(requestHeaders).some(
        (key) => key.toLowerCase() === "content-type",
      );

      if (normalizedMethod !== "GET" && !hasContentType) {
        requestHeaders["Content-Type"] = "application/json";
      }

      const payload = body === undefined ? {} : body;
      let path = basePath;
      const options = {
        method: normalizedMethod,
      };
      if (normalizedMethod === "GET") {
        const params = new URLSearchParams();
        const appendValue = (key, value) => {
          if (value === undefined) return;
          if (Array.isArray(value)) {
            params.append(key, JSON.stringify(value));
          } else if (value !== null && typeof value === "object") {
            params.append(key, JSON.stringify(value));
          } else {
            params.append(key, String(value));
          }
        };

        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          Object.entries(payload).forEach(([key, value]) => appendValue(key, value));
        } else if (payload !== null && payload !== undefined) {
          appendValue("value", payload);
        }

        const queryString = params.toString();
        if (queryString) {
          path = `${basePath}?${queryString}`;
        }
      } else {
        options.body = payload ?? {};
      }

      if (Object.keys(requestHeaders).length > 0) {
        options.headers = requestHeaders;
      }

      const responseBody = await apiRequest(path, options);

      if (responseBody?.error) {
        throw new Error(responseBody.error);
      }

      triggerAnalyticsRefresh();
      fetchNotificationSummary();
      setRunModalScript(null);
      setIsRunModalOpen(false);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        handleAuthError(err);
      } else {
        await alert({
          title: "Failed to run script",
          message: err?.data?.error || err.message || "An unexpected error occurred.",
          tone: "danger",
          confirmLabel: "Dismiss",
        });
      }
    } finally {
      setIsRunningScript(false);
    }
  };

  const isSelectedRecycled = Boolean(selected?.isRecycled);
  const hasNonRecycled = scripts.some((script) => !script.isRecycled);
  const noVisibleScripts = groupedScripts.length === 0;
  const noResultsMessage = isSearching
    ? `No scripts match "${searchTerm}".`
    : hasNonRecycled
    ? "No scripts available."
    : "No scripts yet.";
  const selectedLanguageIcon = selected
    ? getScriptIcon(selected.language)
    : null;
  const selectedLanguageLabel = selected
    ? getLanguageLabel(selected.language)
    : null;
  const selectedLanguageAccent = selected
    ? getLanguageAccent(selected.language)
    : null;

  const renderAuthShell = (content) => (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{
        background: "var(--color-app-bg)",
        color: "var(--color-app-text)",
      }}
    >
      <div className="w-full max-w-md space-y-6 rounded-lg border border-slate-800 bg-slate-950/70 p-6 shadow-2xl">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/automn-logo-stacked.png" alt="Automn" className="h-14 w-auto" />
        </div>
        {content}
      </div>
    </div>
  );

  if (!authChecked) {
    return renderAuthShell(
      <div className="space-y-3 text-center text-sm text-slate-300">
        <p>Checking your session…</p>
      </div>,
    );
  }

  if (isChangingPassword && currentUser) {
    return renderAuthShell(
      <div className="space-y-5">
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-semibold text-slate-100">Update your password</h1>
          <p className="text-sm text-slate-400">
            The account <span className="font-semibold text-slate-100">{currentUser.username}</span>
            {" "}must set a new password before continuing.
          </p>
        </div>
        {authMessage && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {authMessage}
          </div>
        )}
        {passwordError && (
          <div className="rounded border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {passwordError}
          </div>
        )}
        {passwordSuccess && (
          <div className="rounded border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            {passwordSuccess}
          </div>
        )}
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-200">
            Current password
            <input
              type="password"
              name="currentPassword"
              value={passwordForm.currentPassword}
              onChange={handlePasswordInputChange}
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
            />
          </label>
          <label className="block text-sm font-medium text-slate-200">
            New password
            <input
              type="password"
              name="newPassword"
              value={passwordForm.newPassword}
              onChange={handlePasswordInputChange}
              autoComplete="new-password"
              minLength={8}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
            />
          </label>
          <label className="block text-sm font-medium text-slate-200">
            Confirm new password
            <input
              type="password"
              name="confirmPassword"
              value={passwordForm.confirmPassword}
              onChange={handlePasswordInputChange}
              autoComplete="new-password"
              minLength={8}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
            />
          </label>
          <p className="text-xs text-slate-400">Passwords must be at least 8 characters long.</p>
          <button
            type="submit"
            disabled={isUpdatingPassword}
            className="w-full rounded border border-sky-500/60 bg-sky-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isUpdatingPassword ? "Updating…" : "Save new password"}
          </button>
        </form>
        <div className="text-center">
          <button
            type="button"
            onClick={handleLogout}
            className="text-xs font-semibold uppercase tracking-wide text-slate-400 transition hover:text-slate-200"
          >
            Sign out
          </button>
        </div>
      </div>,
    );
  }

  if (!currentUser) {
    return renderAuthShell(
      <div className="space-y-5">
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-semibold text-slate-100">Sign in to Automn</h1>
        </div>
        {authMessage && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {authMessage}
          </div>
        )}
        {loginError && (
          <div className="rounded border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {loginError}
          </div>
        )}
        <form onSubmit={handleLoginSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-200">
            Username
            <input
              name="username"
              value={loginForm.username}
              onChange={handleLoginInputChange}
              autoComplete="username"
              autoFocus
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
            />
          </label>
          <label className="block text-sm font-medium text-slate-200">
            Password
            <input
              type="password"
              name="password"
              value={loginForm.password}
              onChange={handleLoginInputChange}
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
            />
          </label>
          <button
            type="submit"
            disabled={isLoggingIn}
            className="w-full rounded border border-sky-500/60 bg-sky-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoggingIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>,
    );
  }

  return (
    <div
      className="flex min-h-screen flex-col md:h-screen md:flex-row"
      style={{
        background: "var(--color-app-bg)",
        color: "var(--color-app-text)",
      }}
    >
      {/* Sidebar */}
      <aside
        className="flex flex-col border-b md:w-64 md:flex-shrink-0 md:border-b-0 md:border-r"
        style={{
          background: "var(--color-sidebar-bg)",
          borderColor: "var(--color-sidebar-border)",
          color: "var(--color-sidebar-text)",
        }}
      >
        <div
          className="flex flex-col items-center gap-3 border-b px-6 py-6 text-center"
          style={{
            borderColor: "var(--color-sidebar-border)",
            background: "var(--color-sidebar-top-bg)",
            color: "var(--color-sidebar-top-text, var(--color-sidebar-text))",
          }}
        >
          <img
            src="/automn-logo-stacked.png"
            alt="Automn"
            className="h-16 w-auto"
          />
        </div>

        <div className="md:flex-1 md:overflow-y-auto">
          <div
            className="sticky top-0 z-10 border-b px-4 py-3"
            style={{
              background: "var(--color-sidebar-bg)",
              borderColor: "var(--color-sidebar-border)",
            }}
          >
            <input
              type="search"
              autoComplete="off"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search scripts..."
              className="w-full rounded border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent-soft)] placeholder:text-[color:var(--color-input-placeholder)]"
              style={{
                background: "var(--color-input-bg)",
                borderColor: "var(--color-input-border)",
                color: "var(--color-input-text)",
              }}
            />
          </div>

          {noVisibleScripts ? (
            <div className="px-4 py-3 text-sm text-slate-500">{noResultsMessage}</div>
          ) : (
            <div className="divide-y divide-slate-800">
              {groupedScripts.map(({ key, display, scripts: categoryScripts }) => {
                const isCollapsed = isSearching
                  ? false
                  : collapsedCategories[key] ?? true;
                return (
                  <div key={key} className="py-1">
                    <button
                      onClick={() => !isSearching && toggleCategory(key)}
                      className={`w-full flex items-center justify-between px-4 py-2 text-xs font-semibold uppercase tracking-wide transition-colors ${
                        isSearching
                          ? "text-slate-300"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span>{isCollapsed ? "▸" : "▾"}</span>
                        <span>{display}</span>
                      </span>
                      <span className="text-[10px] bg-slate-800 text-slate-300 rounded-full px-2 py-0.5">
                        {categoryScripts.length}
                      </span>
                    </button>
                    {!isCollapsed && (
                      <div className="space-y-1">
                        {categoryScripts.map((script) => {
                          const icon = getScriptIcon(script.language);
                          const label = getLanguageLabel(script.language);
                          const accent = getLanguageAccent(script.language);
                          const isActive = selected?.id === script.id;
                          const colored =
                            sidebarIconStyle === "colored-items" && !isActive;
                          const listItemClasses = [
                            "px-6 py-2 cursor-pointer rounded-r-lg border-l-2 transition-colors",
                            isActive
                              ? "bg-slate-800 text-sky-300 border-sky-500"
                              : "text-gray-300",
                          ];
                          if (!isActive && !colored) {
                            listItemClasses.push("hover:bg-slate-800/60");
                          }
                          if (!colored) {
                            listItemClasses.push("border-transparent");
                          } else {
                            listItemClasses.push("sidebar-script-item");
                          }
                          const accentStyle = colored
                            ? {
                                "--sidebar-script-accent-border": accent.border,
                                "--sidebar-script-accent-bg": accent.background,
                                "--sidebar-script-accent-hover": accent.hover,
                                "--sidebar-script-accent-text": accent.text,
                              }
                            : undefined;
                          const leadingElements = [];
                          if (sidebarIconStyle === "icons-left") {
                            leadingElements.push(
                              <span
                                key="icon"
                                className="flex h-5 w-5 flex-shrink-0 items-center justify-center"
                              >
                                {renderScriptIcon(icon)}
                              </span>,
                            );
                          }
                          if (sidebarIconStyle === "text") {
                            leadingElements.push(
                              <span
                                key="label"
                                className="flex h-5 flex-shrink-0 items-center rounded bg-[color:var(--color-sidebar-badge-bg)] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-sidebar-badge-text)]"
                              >
                                {label}
                              </span>,
                            );
                          }
                          const trailingIcon =
                            sidebarIconStyle === "icons-right" ? (
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-end">
                                {renderScriptIcon(icon)}
                              </span>
                            ) : null;
                          return (
                            <div
                              key={script.id}
                              onClick={() => handleSelect(script)}
                              className={listItemClasses.join(" ")}
                              data-colored={colored ? "true" : undefined}
                              style={accentStyle}
                            >
                              <div
                                className={`text-sm font-medium flex items-center ${
                                  trailingIcon ? "justify-between gap-3" : "gap-2"
                                }`}
                              >
                                <span className="flex min-w-0 items-center gap-2">
                                  {leadingElements}
                                  <span className="truncate">
                                    {script.name || script.endpoint}
                                  </span>
                                </span>
                                {trailingIcon}
                              </div>
                              {showSidebarEndpoints && script.endpoint && (
                                <div className="text-xs text-slate-400">
                                  /s/{script.endpoint}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="px-4 pb-5 pt-4">
            <button
              onClick={handleCreate}
              disabled={isDraftInitializing}
              className={`inline-flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                isDraftInitializing
                  ? "cursor-not-allowed border-slate-700 bg-slate-800 text-slate-400 opacity-75"
                  : "border-slate-700 bg-slate-800 text-slate-100 hover:border-sky-500/60 hover:bg-slate-700 focus:ring-sky-500/60"
              }`}
            >
              <span aria-hidden="true" className="text-base text-sky-300">
                ＋
              </span>
              <span>{isDraftInitializing ? "Creating…" : "New Script"}</span>
            </button>
            {draftError && (
              <div className="mt-2 rounded border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {draftError}
              </div>
            )}
          </div>
        </div>

        <div
          className="border-t"
          style={{ borderColor: "var(--color-divider)" }}
        >
          <button
            onClick={() =>
              setIsRecycleOpen((prev) => {
                const next = !prev;
                if (next) {
                  setIsNotificationsOpen(false);
                }
                return next;
              })
            }
            className={`w-full px-4 py-3 flex items-center justify-between text-sm font-medium transition-colors ${
              isRecycleOpen ? "bg-slate-800 text-sky-300" : "text-slate-300 hover:text-slate-100"
            }`}
          >
            <span className="flex items-center gap-2">
              {systemIcons.recycle && (
                <span role="img" aria-hidden="true">
                  🗑️
                </span>
              )}
              <span>Recycle Bin</span>
            </span>
            <span
              className="text-[11px] rounded-full px-2 py-0.5"
              style={{
                background: "var(--color-sidebar-badge-bg)",
                color: "var(--color-sidebar-badge-text)",
              }}
            >
              {recycledCount}
            </span>
          </button>
          {isRecycleOpen && (
            <div className="max-h-48 overflow-y-auto divide-y divide-slate-800">
              {recycledCount === 0 ? (
                <div className="px-4 py-3 text-xs text-slate-500">No recycled scripts.</div>
              ) : (
                recycledScripts.map((script) => {
                  const icon = getScriptIcon(script.language);
                  const label = getLanguageLabel(script.language);
                  const accent = getLanguageAccent(script.language);
                  const isActive = selected?.id === script.id;
                  const colored =
                    sidebarIconStyle === "colored-items" && !isActive;
                  const buttonClasses = [
                    "w-full px-4 py-2 text-left text-sm transition-colors",
                    isActive
                      ? "bg-slate-800 text-sky-300"
                      : "text-slate-300",
                  ];
                  if (!isActive && !colored) {
                    buttonClasses.push("hover:bg-slate-800/60");
                  }
                  if (colored) {
                    buttonClasses.push("sidebar-script-item rounded-md border-l-2");
                  }
                  const accentStyle = colored
                    ? {
                        "--sidebar-script-accent-border": accent.border,
                        "--sidebar-script-accent-bg": accent.background,
                        "--sidebar-script-accent-hover": accent.hover,
                        "--sidebar-script-accent-text": accent.text,
                      }
                    : undefined;
                  const leadingElements = [];
                  if (sidebarIconStyle === "icons-left") {
                    leadingElements.push(
                      <span
                        key="icon"
                        className="flex h-5 w-5 flex-shrink-0 items-center justify-center"
                      >
                        {renderScriptIcon(icon)}
                      </span>,
                    );
                  }
                  if (sidebarIconStyle === "text") {
                    leadingElements.push(
                      <span
                        key="label"
                        className="flex h-5 flex-shrink-0 items-center rounded bg-[color:var(--color-sidebar-badge-bg)] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-sidebar-badge-text)]"
                      >
                        {label}
                      </span>,
                    );
                  }
                  const trailingIcon =
                    sidebarIconStyle === "icons-right" ? (
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-end">
                        {renderScriptIcon(icon)}
                      </span>
                    ) : null;
                  return (
                    <button
                      key={script.id}
                      onClick={() => handleSelectRecycled(script)}
                      className={buttonClasses.join(" ")}
                      data-colored={colored ? "true" : undefined}
                      style={accentStyle}
                    >
                      <div
                        className={`font-medium flex items-center ${
                          trailingIcon ? "justify-between gap-3" : "gap-2"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {leadingElements}
                          <span className="truncate">
                            {script.name || script.endpoint}
                          </span>
                        </span>
                        {trailingIcon}
                      </div>
                      {showSidebarEndpoints && script.endpoint && (
                        <div className="text-xs text-slate-500">
                          /s/{script.endpoint}
                        </div>
                      )}
                      <div className="text-[10px] uppercase tracking-wide text-amber-300">
                        In recycle bin
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        <div
          className="border-t"
          style={{ borderColor: "var(--color-divider)" }}
        >
          <button
            onClick={() =>
              setIsNotificationsOpen((prev) => {
                const next = !prev;
                if (next) {
                  setIsRecycleOpen(false);
                  if (!notificationsInitializedRef.current) {
                    fetchNotifications();
                  }
                }
                return next;
              })
            }
            className={`w-full px-4 py-3 flex items-center justify-between text-sm font-medium transition-colors ${
              isNotificationsOpen
                ? "bg-slate-800 text-sky-300"
                : "text-slate-300 hover:text-slate-100"
            }`}
          >
            <span className="flex items-center gap-2">
              {systemIcons.notifications && (
                <span role="img" aria-hidden="true">
                  🔔
                </span>
              )}
              <span>Notifications</span>
            </span>
            <span
              className="text-[11px] rounded-full px-2 py-0.5"
              style={{
                background: "var(--color-sidebar-badge-bg)",
                color: "var(--color-sidebar-badge-text)",
              }}
            >
              {unreadNotifications}
            </span>
          </button>
          {isNotificationsOpen && (
            <div className="border-t border-slate-800">
              <div className="space-y-3 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={handleOpenNotificationCenter}
                    className="rounded border border-slate-700 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-300 transition hover:border-sky-500 hover:text-sky-300"
                  >
                    View all
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMarkNotificationsRead(unreadNotificationIds)}
                    disabled={unreadNotificationIds.length === 0}
                    className={`rounded border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition ${
                      unreadNotificationIds.length === 0
                        ? "cursor-not-allowed border-slate-800 text-slate-600"
                        : "border-slate-700 text-slate-300 hover:border-sky-500 hover:text-sky-300"
                    }`}
                  >
                    Mark all as read
                  </button>
                </div>
                {notificationsLoading ? (
                  <div className="text-xs text-slate-500 dark:text-slate-400">Loading notifications…</div>
                ) : notificationsError ? (
                  <div className="text-xs text-red-300">{notificationsError}</div>
                ) : hasUnreadNotifications ? (
                  <ul className="max-h-60 space-y-2 overflow-y-auto pr-1">
                    {unreadNotificationItems.map((notification) => {
                      const levelKey = (notification.level || "info").toLowerCase();
                      const levelClassName =
                        NOTIFICATION_LEVEL_CLASSNAMES[levelKey] ||
                        NOTIFICATION_LEVEL_CLASSNAMES.info;
                      const levelLabel = (notification.level || "info").toUpperCase();
                      const audienceLabel = resolveAudienceLabel(notification.audience);
                      const typeLabel =
                        NOTIFICATION_TYPE_LABELS[notification.type] || "Notification";
                      const isUnread = !notification.isRead;
                      const isPinned = isNotificationPinned(notification) && isUnread;
                      return (
                        <li
                          key={notification.id}
                          className={`notification-card${
                            isUnread ? " notification-card--unread" : ""
                          } rounded border p-3 text-sm transition`}
                        >
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span
                              className={`notification-level font-semibold uppercase ${levelClassName}`}
                            >
                              {levelLabel}
                            </span>
                            <div className="flex items-center gap-1">
                              {isPinned && (
                                <span className="notification-pill rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide">
                                  Pinned
                                </span>
                              )}
                              <span className="notification-pill rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide">
                                {typeLabel}
                              </span>
                            </div>
                          </div>
                          <div className="notification-timestamp text-[11px]">
                            {formatNotificationTimestamp(notification.createdAt)}
                          </div>
                          <div
                            className="notification-message mt-1 text-sm"
                            style={{
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                            title={notification.message || "—"}
                          >
                            {notification.message || "—"}
                          </div>
                          {audienceLabel && (
                            <div className="notification-meta mt-1 text-[11px]">
                              For {audienceLabel}
                            </div>
                          )}
                          {notification.script && (
                            <div className="notification-meta mt-1 text-[11px]">
                              Script: {notification.script.name || notification.script.endpoint}
                            </div>
                          )}
                          {!notification.isRead && (
                            <div className="mt-2 text-right">
                              <button
                                type="button"
                                onClick={() => handleMarkNotificationsRead([notification.id])}
                                className="notification-action text-[11px] font-semibold uppercase tracking-wide transition-colors"
                              >
                                Mark as read
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {totalNotifications > 0
                      ? "You're all caught up."
                      : "No notifications yet."}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div
          className="border-t px-6 py-4 text-xs"
          style={{
            borderColor: "var(--color-divider)",
            color: "var(--color-text-muted)",
          }}
        >
          <div className="text-center">
            <p>
              Signed in as{" "}
              <span className="font-semibold text-[color:var(--color-text-strong)]">
                {currentUser?.username || ""}
              </span>
            </p>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => (isSettingsOpen ? closeSettings() : openSettings())}
              className="inline-flex items-center justify-center gap-2 rounded border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent-soft)] hover:bg-[color:var(--color-surface-3)]"
              style={{
                borderColor: isSettingsOpen
                  ? "var(--color-accent-soft)"
                  : "var(--color-panel-border)",
                color: isSettingsOpen
                  ? "var(--color-accent)"
                  : "var(--color-text-strong)",
                background: isSettingsOpen
                  ? "var(--color-surface-3)"
                  : "var(--color-surface-2)",
              }}
            >
              {systemIcons.settings && <span aria-hidden="true">⚙️</span>}
              <span>Settings</span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center justify-center gap-2 rounded border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent-soft)] hover:bg-[color:var(--color-surface-3)]"
              style={{
                borderColor: "var(--color-panel-border)",
                color: "var(--color-text-strong)",
                background: "var(--color-surface-2)",
              }}
            >
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex flex-1 min-w-0 flex-col min-h-0">
        {isSettingsOpen ? (
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
            <div
              className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4"
              style={{ borderColor: "var(--color-divider)" }}
            >
              <div>
                <h2 className="text-xl font-semibold text-slate-100">Settings</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Personalize Automn and configure system behavior.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className="inline-flex items-center gap-1 rounded-full border px-3 py-1 font-semibold uppercase tracking-wide"
                    style={{
                      borderColor: "var(--color-panel-border)",
                      color: "var(--color-text-strong)",
                      background: "var(--color-surface-2)",
                    }}
                  >
                    <span className="text-[10px]">🔄</span>
                    <span>Host version</span>
                    <span className="font-mono text-[11px] text-slate-200">
                      {hostVersion || "Unknown"}
                    </span>
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={closeSettings}
                className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:border-sky-500 hover:text-sky-300"
              >
                Close
              </button>
            </div>
        <div className="flex flex-1 flex-col min-h-0">
          <nav
            className="border-b"
            style={{ borderColor: "var(--color-divider)" }}
            aria-label="Settings sections"
          >
            <div className="flex flex-wrap items-center gap-4 px-4">
              {visibleSettingsTabs.map((tab) => {
                const isActive = settingsTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSettingsTab(tab.id)}
                    className={`whitespace-nowrap border-b-2 pb-3 pt-4 text-xs font-semibold uppercase tracking-wide transition-colors ${
                      isActive
                        ? "border-sky-400 text-sky-300"
                        : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </nav>
          <div className="flex-1 overflow-y-auto p-4">
                {settingsTab === "ui" && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-100">
                        Theme
                      </h3>
                      <p className="mt-1 text-sm text-slate-400">
                        Choose how Automn should look. Theme changes are saved to
                        your account.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {themeOptions.map((theme) => {
                        const isActive = activeThemeId === theme.id;
                        return (
                          <button
                            key={theme.id}
                            type="button"
                            onClick={() => setThemeId(theme.id)}
                            className={`flex h-full flex-col justify-between rounded-lg border p-3 text-left transition-shadow ${
                              isActive
                                ? "border-sky-500 shadow-lg"
                                : "border-slate-800 hover:border-sky-500"
                            }`}
                            style={{
                              background: "var(--color-surface-1)",
                              color: "var(--color-app-text)",
                              boxShadow: isActive
                                ? "0 20px 35px -15px var(--color-accent-soft)"
                                : "0 0 0 rgba(0,0,0,0)",
                            }}
                            aria-pressed={isActive}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="space-y-1">
                                <div className="text-sm font-semibold text-slate-100">
                                  {theme.name}
                                </div>
                                <p className="text-xs text-slate-400 leading-snug">
                                  {theme.description}
                                </p>
                              </div>
                              {theme.preview && (
                                <div
                                  className="flex h-10 w-16 overflow-hidden rounded border"
                                  style={{ borderColor: "var(--color-border)" }}
                                  aria-hidden="true"
                                >
                                  <div
                                    className="w-2/5"
                                    style={{ background: theme.preview.sidebar }}
                                  />
                                  <div
                                    className="relative flex-1"
                                    style={{ background: theme.preview.surface }}
                                  >
                                    <span
                                      className="absolute bottom-1 right-2 h-4 w-4 rounded-full"
                                      style={{
                                        background: theme.preview.accent,
                                        boxShadow:
                                          "0 0 12px rgba(0,0,0,0.15)",
                                      }}
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                              <span
                                className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                                  isActive
                                    ? "border-sky-500 bg-sky-300"
                                    : "border-slate-700"
                                }`}
                                aria-hidden="true"
                              >
                                {isActive && (
                                  <span
                                    className="text-[10px] font-semibold"
                                    style={{ color: "var(--color-sidebar-bg)" }}
                                  >
                                    ✓
                                  </span>
                                )}
                              </span>
                              <span>{
                                isActive ? "Active theme" : "Use theme"
                              }</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-slate-100">
                        Sidebar language indicators
                      </h3>
                      <p className="mt-1 text-sm text-slate-400">
                        Decide how script languages should appear throughout the
                        sidebar lists.
                      </p>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        {SIDEBAR_ICON_OPTIONS.map((option) => {
                          const isActive = sidebarIconStyle === option.id;
                          return (
                            <label
                              key={option.id}
                              className="flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-all hover:shadow-md"
                              style={{
                                background: isActive
                                  ? "var(--color-surface-1)"
                                  : "var(--color-surface-2)",
                                borderColor: isActive
                                  ? "var(--color-accent)"
                                  : "var(--color-panel-border)",
                                boxShadow: isActive
                                  ? "0 0 0 1px var(--color-accent-soft)"
                                  : "none",
                              }}
                            >
                              <input
                                type="radio"
                                name="sidebar-icon-style"
                                value={option.id}
                                checked={isActive}
                                onChange={() => setSidebarIconStyle(option.id)}
                                className="sr-only"
                              />
                              <span
                                className="mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border"
                                style={{
                                  background: isActive
                                    ? "var(--color-accent)"
                                    : "transparent",
                                  borderColor: isActive
                                    ? "var(--color-accent)"
                                    : "var(--color-panel-border)",
                                  color: isActive
                                    ? "var(--color-app-bg)"
                                    : "var(--color-app-text)",
                                }}
                                aria-hidden="true"
                              >
                                {isActive && (
                                  <span className="text-[10px] font-bold">✓</span>
                                )}
                              </span>
                              <span className="space-y-1">
                                <span
                                  className="block text-sm font-semibold"
                                  style={{ color: "var(--color-app-text)" }}
                                >
                                  {option.label}
                                </span>
                                <span
                                  className="block text-xs"
                                  style={{ color: "var(--color-text-muted)" }}
                                >
                                  {option.description}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-slate-100">
                        System icons
                      </h3>
                      <p className="mt-1 text-sm text-slate-400">
                        Control whether Automn shows icons next to core sidebar
                        actions.
                      </p>
                      <div className="mt-3 space-y-3">
                        <label
                          className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm transition-all hover:shadow-sm"
                          style={{
                            background: "var(--color-surface-1)",
                            borderColor: "var(--color-panel-border)",
                          }}
                        >
                          <span className="flex flex-col gap-1">
                            <span
                              className="font-semibold"
                              style={{ color: "var(--color-app-text)" }}
                            >
                              Recycle bin icon
                            </span>
                            <span
                              className="text-xs"
                              style={{ color: "var(--color-text-muted)" }}
                            >
                              Show the recycle emoji beside the recycle bin
                              toggle.
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] text-[color:var(--color-accent)] focus:ring-[color:var(--color-accent)]"
                            checked={systemIcons.recycle}
                            onChange={(event) =>
                              setSystemIcons((prev) => ({
                                ...prev,
                                recycle: event.target.checked,
                              }))
                            }
                          />
                        </label>
                        <label
                          className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm transition-all hover:shadow-sm"
                          style={{
                            background: "var(--color-surface-1)",
                            borderColor: "var(--color-panel-border)",
                          }}
                        >
                          <span className="flex flex-col gap-1">
                            <span
                              className="font-semibold"
                              style={{ color: "var(--color-app-text)" }}
                            >
                              Notifications button icon
                            </span>
                            <span
                              className="text-xs"
                              style={{ color: "var(--color-text-muted)" }}
                            >
                              Show the bell icon next to the notifications panel.
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] text-[color:var(--color-accent)] focus:ring-[color:var(--color-accent)]"
                            checked={systemIcons.notifications}
                            onChange={(event) =>
                              setSystemIcons((prev) => ({
                                ...prev,
                                notifications: event.target.checked,
                              }))
                            }
                          />
                        </label>
                        <label
                          className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm transition-all hover:shadow-sm"
                          style={{
                            background: "var(--color-surface-1)",
                            borderColor: "var(--color-panel-border)",
                          }}
                        >
                          <span className="flex flex-col gap-1">
                            <span
                              className="font-semibold"
                              style={{ color: "var(--color-app-text)" }}
                            >
                              Settings button icon
                            </span>
                            <span
                              className="text-xs"
                              style={{ color: "var(--color-text-muted)" }}
                            >
                              Show the gear icon next to the settings shortcut.
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] text-[color:var(--color-accent)] focus:ring-[color:var(--color-accent)]"
                            checked={systemIcons.settings}
                            onChange={(event) =>
                              setSystemIcons((prev) => ({
                                ...prev,
                                settings: event.target.checked,
                              }))
                            }
                          />
                        </label>
                      </div>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-slate-100">
                        Sidebar details
                      </h3>
                      <p className="mt-1 text-sm text-slate-400">
                        Choose which supporting labels appear under each script
                        name in the sidebar lists.
                      </p>
                      <div className="mt-3 space-y-3">
                        <label
                          className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm transition-all hover:shadow-sm"
                          style={{
                            background: "var(--color-surface-1)",
                            borderColor: "var(--color-panel-border)",
                          }}
                        >
                          <span className="flex flex-col gap-1">
                            <span
                              className="font-semibold"
                              style={{ color: "var(--color-app-text)" }}
                            >
                              Show endpoint labels
                            </span>
                            <span
                              className="text-xs"
                              style={{ color: "var(--color-text-muted)" }}
                            >
                              Display the /s/ path below each script name in the
                              sidebar.
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] text-[color:var(--color-accent)] focus:ring-[color:var(--color-accent)]"
                            checked={showSidebarEndpoints}
                            onChange={(event) =>
                              setShowSidebarEndpoints(event.target.checked)
                            }
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                )}
                {settingsTab === "collections" && currentUser?.isAdmin && (
                  <SettingsCategories
                    onAuthError={handleAuthError}
                    onCategoryChange={loadCategories}
                  />
                )}
                {settingsTab === "global-variables" && currentUser?.isAdmin && (
                  <SettingsGlobalVariables onAuthError={handleAuthError} />
                )}
                {settingsTab === "data" && currentUser?.isAdmin && (
                  <SettingsData onAuthError={handleAuthError} />
                )}
                {settingsTab === "users" && currentUser?.isAdmin && (
                  <SettingsUsers
                    currentUser={currentUser}
                    onAuthError={handleAuthError}
                  />
                )}
                {settingsTab === "runners" && currentUser?.isAdmin && (
                  <SettingsRunnerHosts onAuthError={handleAuthError} />
                )}
                {!["ui", "collections", "global-variables", "data", "users", "runners"].includes(
                  settingsTab,
                ) && (
                  <div className="flex h-full items-center justify-center rounded border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-400">
                    <div>
                      <p className="font-semibold text-slate-200">
                        {SETTINGS_TABS.find((tab) => tab.id === settingsTab)?.label}
                        {" "}
                        settings are coming soon.
                      </p>
                      <p className="mt-2 text-slate-400">
                        We're designing focused controls for this area.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : selected ? (
          <>
            <div className="border-b border-slate-800 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold text-slate-100">
                      {selected.name || "New Script"}
                    </h2>
                    {selected && (
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{
                          borderColor: selectedLanguageAccent?.border,
                          background: selectedLanguageAccent?.background,
                          color: selectedLanguageAccent?.text,
                        }}
                      >
                        <span className="flex items-center justify-center">
                          {renderScriptIcon(
                            selectedLanguageIcon,
                            "h-4 w-4 flex-shrink-0",
                          )}
                        </span>
                        <span>{selectedLanguageLabel}</span>
                      </span>
                    )}
                    {isSelectedRecycled && (
                      <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-200">
                        Recycled
                      </span>
                    )}
                  </div>
                  {selected.endpoint && (
                    <div className="mt-1 font-mono text-xs text-slate-500">/s/{selected.endpoint}</div>
                  )}
                  {(selected.createdByUsername || selected.ownerUsername) && (
                    <div className="mt-1 text-xs text-slate-400">
                      Created by{" "}
                      <span className="font-semibold text-slate-200">
                        {selected.createdByUsername || selected.ownerUsername}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!isSelectedRecycled && selected?.id && selected?.endpoint && (
                    <button
                      onClick={() => handleOpenRunModal(selected)}
                      disabled={isRunningScript}
                      className="button-run rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed"
                    >
                      {isRunningScript ? "Running..." : "Run Script"}
                    </button>
                  )}
                  {!isSelectedRecycled && selected?.id && canClearLogs && (
                    <button
                      onClick={() => handleClearLogs(selected)}
                      className="button-clear rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors"
                    >
                      Clear Logs
                    </button>
                  )}
                  {!isSelectedRecycled && selected?.endpoint && canDeleteScript && (
                    <button
                      onClick={() => handleRecycle(selected)}
                      className="button-danger rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors"
                    >
                      Delete
                    </button>
                  )}
                  {isSelectedRecycled && selected?.id && (
                    <>
                      <button
                        onClick={() => handleRestore(selected)}
                        className="rounded border border-emerald-400/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-200 transition-colors hover:bg-emerald-400/10"
                      >
                        Restore
                      </button>
                      <button
                        onClick={() => handlePermanentDelete(selected)}
                        className="button-danger rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors"
                      >
                        Delete Permanently
                      </button>
                    </>
                  )}
                </div>
              </div>
              {!isSelectedRecycled && (
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  {availableTabs.map((tab) => {
                    const label = (() => {
                      if (tab === "variables") {
                        const count = Number(selected?.variableCount) || 0;
                        return count > 0 ? `variables (${count})` : "variables";
                      }
                      if (tab === "packages") {
                        const count = Number(selected?.packageCount) || 0;
                        return count > 0 ? `packages (${count})` : "packages";
                      }
                      return tab;
                    })();
                    return (
                      <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`capitalize transition-colors ${
                          activeTab === tab
                            ? "text-sky-400 border-b-2 border-sky-400 pb-1"
                            : "text-gray-400 hover:text-gray-200"
                        }`}
                      >
                        <span className="capitalize">{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {isSelectedRecycled ? (
                <div className="max-w-md rounded border border-dashed border-slate-700 bg-slate-900/40 p-6 text-sm text-slate-300">
                  <p className="font-semibold text-amber-200">
                    This script is currently in the recycle bin.
                  </p>
                  <p className="mt-2 text-slate-400">
                    Restore it to continue editing or running it. Delete it permanently to remove all logs, settings, and the script code from Automn.
                  </p>
                </div>
              ) : (
                <>
                  {!isCreating && (
                    <div
                      role="tabpanel"
                      id="script-tab-analytics"
                      aria-hidden={activeTab !== "analytics"}
                      className={`h-full ${activeTab === "analytics" ? "block" : "hidden"}`}
                    >
                      <ScriptAnalytics
                        script={selected}
                        refreshKey={analyticsRefreshKey}
                        onRefresh={triggerAnalyticsRefresh}
                        onAuthError={handleAuthError}
                      />
                    </div>
                  )}
                  <div
                    role="tabpanel"
                    id="script-tab-editor"
                    aria-hidden={activeTab !== "editor"}
                    className={`h-full ${activeTab === "editor" ? "block" : "hidden"}`}
                  >
                    <ScriptEditor
                      script={selected}
                      onSave={handleSaved}
                      onCancel={() => {
                        setSelected(null);
                        setIsCreating(false);
                        setActiveTab("analytics");
                        navigateToEndpoint(null);
                      }}
                      onAuthError={handleAuthError}
                      categoryOptions={writableCategories}
                      categoriesLoaded={categoriesLoaded}
                      runnerHosts={runnerHosts}
                      runnersLoaded={runnersLoaded}
                      runnerLoadError={runnerLoadError}
                      currentUser={currentUser}
                      isActive={activeTab === "editor"}
                      variablesRefreshKey={variablesRefreshKey}
                    />
                  </div>
                  {supportsPackageManagement && (
                    <div
                      role="tabpanel"
                      id="script-tab-packages"
                      aria-hidden={activeTab !== "packages"}
                      className={`h-full ${activeTab === "packages" ? "block" : "hidden"}`}
                    >
                      <ScriptPackages
                        script={selected}
                        onAuthError={handleAuthError}
                        onPackagesChange={handlePackagesChanged}
                      />
                    </div>
                  )}
                  <div
                    role="tabpanel"
                    id="script-tab-variables"
                    aria-hidden={activeTab !== "variables"}
                    className={`h-full ${activeTab === "variables" ? "block" : "hidden"}`}
                  >
                    <ScriptVariables
                      script={selected}
                      onAuthError={handleAuthError}
                      onVariablesChange={handleVariablesChanged}
                    />
                  </div>
                  {!isCreating && (
                    <div
                      role="tabpanel"
                      id="script-tab-versions"
                      aria-hidden={activeTab !== "versions"}
                      className={`h-full ${activeTab === "versions" ? "block" : "hidden"}`}
                    >
                      <ScriptVersions
                        script={selected}
                        onAuthError={handleAuthError}
                      />
                    </div>
                  )}
                  {(selected?.permissions?.manage || isCreating) && (
                    <div
                      role="tabpanel"
                      id="script-tab-security"
                      aria-hidden={activeTab !== "security"}
                      className={`h-full ${activeTab === "security" ? "block" : "hidden"}`}
                    >
                      <ScriptPermissions
                        script={selected}
                        onAuthError={handleAuthError}
                        onSecurityChange={handleSecurityUpdated}
                        renderApiSection={({
                          requireAuth,
                          isSaving,
                          isLoading,
                          script,
                          canModify,
                        }) => (
                          <ScriptTokenManager
                            script={{ ...script, isDraft: selected?.isDraft }}
                            currentUser={currentUser}
                            onTokenChanged={handleTokenChanged}
                            onAuthError={handleAuthError}
                            disabled={
                              !requireAuth ||
                              isSaving ||
                              isLoading ||
                              !canModify ||
                              selected?.isDraft
                            }
                          />
                        )}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <div className="m-auto text-gray-600 text-lg">
            {routeEndpoint && hasLoadedScripts
              ? `Script "${routeEndpoint}" not found.`
              : "Select a script to begin"}
          </div>
        )}
      </main>
      {isNotificationCenterOpen && (
        <div
          className="fixed inset-0 z-50 flex"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notification-center-title"
        >
          <div
            className="flex-1 bg-slate-950/60"
            onClick={handleCloseNotificationCenter}
            role="presentation"
            aria-hidden="true"
          />
          <aside className="relative ml-auto flex h-full w-full max-w-xl flex-col border-l border-slate-800 bg-slate-900 shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
              <div>
                <h2
                  id="notification-center-title"
                  className="text-base font-semibold text-slate-100"
                >
                  Notifications
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  {showReadNotifications
                    ? "Showing all notifications"
                    : "Hiding read notifications"}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {totalNotifications} total • {unreadNotifications} unread
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseNotificationCenter}
                className="rounded border border-slate-700 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-300 transition hover:border-sky-500 hover:text-sky-300"
              >
                Close
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border border-slate-600 bg-slate-900 text-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                  checked={showReadNotifications}
                  onChange={handleToggleShowReadNotifications}
                />
                <span>Show read notifications</span>
              </label>
              <button
                type="button"
                onClick={() => handleMarkNotificationsRead(unreadNotificationIds)}
                disabled={unreadNotificationIds.length === 0}
                className={`rounded border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition ${
                  unreadNotificationIds.length === 0
                    ? "cursor-not-allowed border-slate-800 text-slate-600"
                    : "border-slate-700 text-slate-300 hover:border-sky-500 hover:text-sky-300"
                }`}
              >
                Mark all as read
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {notificationsLoading ? (
                <div className="text-sm text-slate-400">Loading notifications…</div>
              ) : notificationsError ? (
                <div className="text-sm text-red-300">{notificationsError}</div>
              ) : filteredNotifications.length ? (
                <ul className="space-y-3">
                  {filteredNotifications.map((notification) => {
                    const levelKey = (notification.level || "info").toLowerCase();
                    const levelClassName =
                      NOTIFICATION_LEVEL_CLASSNAMES[levelKey] ||
                      NOTIFICATION_LEVEL_CLASSNAMES.info;
                    const levelLabel = (notification.level || "info").toUpperCase();
                    const audienceLabel = resolveAudienceLabel(notification.audience);
                    const typeLabel =
                      NOTIFICATION_TYPE_LABELS[notification.type] || "Notification";
                    const isUnread = !notification.isRead;
                    const isPinned = isNotificationPinned(notification) && isUnread;
                    return (
                      <li
                        key={notification.id}
                        className={`notification-card${
                          isUnread ? " notification-card--unread" : ""
                        } rounded border p-4 text-sm transition`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span
                            className={`notification-level font-semibold uppercase ${levelClassName}`}
                          >
                            {levelLabel}
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-1">
                              {isPinned && (
                                <span className="notification-pill rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide">
                                  Pinned
                                </span>
                              )}
                              <span className="notification-pill rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide">
                                {typeLabel}
                              </span>
                            </div>
                            <span
                              className={`notification-status text-[10px] uppercase tracking-wide${
                                isUnread ? " notification-status--unread" : ""
                              }`}
                            >
                              {isUnread ? "Unread" : "Read"}
                            </span>
                          </div>
                        </div>
                        <div className="notification-timestamp mt-1 text-[11px]">
                          Created {formatNotificationTimestamp(notification.createdAt)}
                        </div>
                        <div className="notification-message mt-2 whitespace-pre-line text-sm leading-relaxed">
                          {notification.message || "—"}
                        </div>
                        {audienceLabel && (
                          <div className="notification-meta mt-2 text-[11px]">
                            For {audienceLabel}
                          </div>
                        )}
                        {notification.script && (
                          <div className="notification-meta mt-2 text-[11px]">
                            Script: {notification.script.name || notification.script.endpoint}
                          </div>
                        )}
                        {notification.readAt && (
                          <div className="notification-meta mt-2 text-[11px]">
                            Read {formatNotificationTimestamp(notification.readAt)}
                          </div>
                        )}
                        {!notification.isRead && (
                          <div className="mt-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleMarkNotificationsRead([notification.id])}
                              className="notification-action text-[11px] font-semibold uppercase tracking-wide transition-colors"
                            >
                              Mark as read
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : notifications.length ? (
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  {showReadNotifications
                    ? "No notifications to display."
                    : "No unread notifications."}
                </div>
              ) : (
                <div className="text-sm text-slate-500 dark:text-slate-400">No notifications yet.</div>
              )}
            </div>
          </aside>
        </div>
      )}
      <RunScriptModal
        script={runModalScript}
        isOpen={isRunModalOpen}
        isSubmitting={isRunningScript}
        onClose={handleCloseRunModal}
        onConfirm={(config) =>
          runModalScript ? handleRunScript(runModalScript, config) : undefined
        }
      />
    </div>
  );
}
