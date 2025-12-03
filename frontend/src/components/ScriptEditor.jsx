import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { apiRequest } from "../utils/api";

const NODE_SNIPPETS = [
  {
    label: "AutomnReturn (success)",
    value: "AutomnReturn({ success: true, data: null });\n",
  },
  {
    label: "AutomnLog (info)",
    value: "AutomnLog(\"Starting process\", \"info\");\n",
  },
  {
    label: "AutomnLog (warn)",
    value: "AutomnLog(\"User not found\", \"warn\");\n",
  },
  {
    label: "AutomnLog (error)",
    value: "AutomnLog(\"Critical failure\", \"error\");\n",
  },
  {
    label: "AutomnRunLog",
    value: "AutomnRunLog(\"Debug info\", { context: \"runner\" });\n",
  },
  {
    label: "AutomnNotify (Admins)",
    value: "AutomnNotify(\"Admins\", \"Deployment completed\", \"info\");\n",
  },
];

const PYTHON_SNIPPETS = [
  {
    label: "AutomnReturn (success)",
    value: "AutomnReturn({\"success\": True, \"data\": None})\n",
  },
  {
    label: "AutomnLog (info)",
    value: "AutomnLog(\"Starting process\", \"info\")\n",
  },
  {
    label: "AutomnLog (warn)",
    value: "AutomnLog(\"User not found\", \"warn\")\n",
  },
  {
    label: "AutomnLog (error)",
    value: "AutomnLog(\"Critical failure\", \"error\")\n",
  },
  {
    label: "AutomnRunLog",
    value: "AutomnRunLog(\"Debug info\", {\"context\": \"runner\"})\n",
  },
  {
    label: "AutomnNotify (Admins)",
    value: "AutomnNotify(\"Admins\", \"Deployment completed\", \"info\")\n",
  },
];

const POWERSHELL_SNIPPETS = [
  {
    label: "AutomnReturn (success)",
    value: "AutomnReturn(@{ success = $true; data = $null })\n",
  },
  {
    label: "AutomnLog (info)",
    value: "AutomnLog \"Starting process\" \"info\"\n",
  },
  {
    label: "AutomnLog (warn)",
    value: "AutomnLog \"User not found\" \"warn\"\n",
  },
  {
    label: "AutomnLog (error)",
    value: "AutomnLog \"Critical failure\" \"error\"\n",
  },
  {
    label: "AutomnRunLog",
    value: "AutomnRunLog \"Debug info\" @{ context = \"runner\" }\n",
  },
  {
    label: "AutomnNotify (Admins)",
    value: "AutomnNotify \"Admins\" \"Deployment completed\" \"info\"\n",
  },
];

const SHELL_SNIPPETS = [
  {
    label: "AutomnReturn (success)",
    value: "AutomnReturn '{\"success\":true,\"data\":null}'\n",
  },
  {
    label: "AutomnLog (info)",
    value: "AutomnLog \"Starting process\" \"info\"\n",
  },
  {
    label: "AutomnLog (warn)",
    value: "AutomnLog \"User not found\" \"warn\"\n",
  },
  {
    label: "AutomnLog (error)",
    value: "AutomnLog \"Critical failure\" \"error\"\n",
  },
  {
    label: "AutomnRunLog",
    value: "AutomnRunLog \"Debug info\"\n",
  },
  {
    label: "AutomnNotify (Admins)",
    value: "AutomnNotify \"Admins\" \"Deployment completed\" \"info\"\n",
  },
];

const SNIPPETS = {
  node: NODE_SNIPPETS,
  javascript: NODE_SNIPPETS,
  typescript: NODE_SNIPPETS,
  python: PYTHON_SNIPPETS,
  powershell: POWERSHELL_SNIPPETS,
  shell: SHELL_SNIPPETS,
};

const VARIABLE_WARNING_STORAGE_KEY = "automn.hideVariableSecurityWarning";

const createEmptyVariableGroups = () => ({
  script: [],
  category: [],
  global: [],
  job: [],
});

const getEditorLanguage = (value) => {
  switch (value) {
    case "node":
    case "javascript":
      return "javascript";
    case "typescript":
      return "typescript";
    case "python":
      return "python";
    case "powershell":
      return "powershell";
    case "shell":
      return "shell";
    default:
      return "javascript";
  }
};

const DEFAULT_COLLECTION_ID = "category-general";
const DEFAULT_CATEGORY_ID = DEFAULT_COLLECTION_ID;
const NO_RUNNER_VALUE = "__no_runner__";
const SUPPORTED_HTTP_METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"];
const DEFAULT_ACCEPTED_METHODS = ["POST", "GET"];

export default function ScriptEditor({
  script,
  onSave,
  onCancel,
  onAuthError,
  categoryOptions = [],
  categoriesLoaded = false,
  runnerHosts = [],
  runnersLoaded = false,
  runnerLoadError = "",
  currentUser = null,
  isActive = true,
  variablesRefreshKey = 0,
}) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [language, setLanguage] = useState("node");
  const [timeout, setTimeoutVal] = useState(0);
  const [code, setCode] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [runnerHostId, setRunnerHostId] = useState("");
  const [inheritCategoryRunner, setInheritCategoryRunner] = useState(true);
  const [acceptedMethods, setAcceptedMethods] = useState(() => [
    ...DEFAULT_ACCEPTED_METHODS,
  ]);
  const [errorMessage, setErrorMessage] = useState("");
  const [variables, setVariables] = useState(() => createEmptyVariableGroups());
  const [variablesLoading, setVariablesLoading] = useState(false);
  const [skipVariableSecurityWarning, setSkipVariableSecurityWarning] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(VARIABLE_WARNING_STORAGE_KEY) === "true";
    } catch (err) {
      console.error("Failed to read variable warning preference", err);
      return false;
    }
  });
  const [showVariableSecurityWarning, setShowVariableSecurityWarning] = useState(false);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);

  const toSortedMethods = useCallback((methods) => {
    const normalized = new Set();
    if (Array.isArray(methods)) {
      for (const value of methods) {
        if (typeof value !== "string") continue;
        const upper = value.trim().toUpperCase();
        if (!upper) continue;
        if (!SUPPORTED_HTTP_METHODS.includes(upper)) continue;
        normalized.add(upper);
      }
    }
    return SUPPORTED_HTTP_METHODS.filter((method) => normalized.has(method));
  }, []);

  const mergedCategories = useMemo(() => {
    const map = new Map();
    if (Array.isArray(categoryOptions)) {
      for (const category of categoryOptions) {
        if (category?.id) {
          map.set(category.id, category);
        }
      }
    }
    const scriptCollection = script?.collection || script?.category || null;
    const scriptCollectionId =
      script?.collectionId || script?.categoryId || scriptCollection?.id;
    if (scriptCollectionId && !map.has(scriptCollectionId)) {
      map.set(scriptCollectionId, {
        id: scriptCollectionId,
        name:
          (scriptCollection?.name || script?.categoryName || "General").trim() ||
          "General",
        description: scriptCollection?.description || "",
        defaultLanguage: scriptCollection?.defaultLanguage || null,
        defaultRunnerHostId:
          scriptCollection?.defaultRunnerHostId ||
          script?.categoryDefaultRunnerHostId ||
          null,
        defaultRunner:
          scriptCollection?.defaultRunner || script?.categoryDefaultRunner || null,
        isSystem: Boolean(scriptCollection?.isSystem),
      });
    }
    return Array.from(map.values());
  }, [
    categoryOptions,
    script?.collection,
    script?.collectionId,
    script?.category,
    script?.categoryId,
    script?.categoryName,
    script?.categoryDefaultRunnerHostId,
    script?.categoryDefaultRunner,
  ]);

  const selectedCategory = useMemo(() => {
    const targetId =
      categoryId ||
      script?.collectionId ||
      script?.collection?.id ||
      script?.categoryId ||
      script?.category?.id ||
      null;
    if (!targetId) return null;
    return mergedCategories.find((category) => category.id === targetId) || null;
  }, [
    mergedCategories,
    categoryId,
    script?.collectionId,
    script?.collection?.id,
    script?.categoryId,
    script?.category?.id,
  ]);

  const categoryDefaultRunnerHostId = useMemo(() => {
    if (selectedCategory?.defaultRunnerHostId) {
      return selectedCategory.defaultRunnerHostId;
    }
    return (
      script?.collectionDefaultRunnerHostId ||
      script?.categoryDefaultRunnerHostId ||
      null
    );
  }, [
    selectedCategory?.defaultRunnerHostId,
    script?.collectionDefaultRunnerHostId,
    script?.categoryDefaultRunnerHostId,
  ]);

  const categoryDefaultRunner = useMemo(() => {
    if (selectedCategory?.defaultRunner) {
      return selectedCategory.defaultRunner;
    }
    return script?.collectionDefaultRunner || script?.categoryDefaultRunner || null;
  }, [
    selectedCategory?.defaultRunner,
    script?.collectionDefaultRunner,
    script?.categoryDefaultRunner,
  ]);

  const normalizedRunnerHosts = useMemo(() => {
    const entries = new Map();
    if (Array.isArray(runnerHosts)) {
      for (const host of runnerHosts) {
        if (!host?.id) continue;
        const id = host.id;
        entries.set(id, {
          id,
          name: host.name || id,
          adminOnly: Boolean(host.adminOnly),
          status: host.status || "pending",
          statusMessage: host.statusMessage || null,
          disabledAt: host.disabledAt || null,
        });
      }
    }

    if (script?.runnerHostId && !entries.has(script.runnerHostId)) {
      const runner = script.runner || null;
      const id = script.runnerHostId;
      entries.set(id, {
        id,
        name: runner?.name || id,
        adminOnly: Boolean(runner?.adminOnly),
        status: runner?.status || "pending",
        statusMessage: runner?.statusMessage || null,
        disabledAt: runner?.disabledAt || null,
      });
    }

    if (categoryDefaultRunnerHostId && !entries.has(categoryDefaultRunnerHostId)) {
      const runner = categoryDefaultRunner || null;
      const id = categoryDefaultRunnerHostId;
      entries.set(id, {
        id,
        name: runner?.name || id,
        adminOnly: Boolean(runner?.adminOnly),
        status: runner?.status || "pending",
        statusMessage: runner?.statusMessage || null,
        disabledAt: runner?.disabledAt || null,
      });
    }

    const list = Array.from(entries.values());
    list.sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, {
        sensitivity: "base",
      }),
    );
    return list;
  }, [
    runnerHosts,
    script?.runnerHostId,
    script?.runner,
    categoryDefaultRunnerHostId,
    categoryDefaultRunner,
  ]);

  const selectedRunner = useMemo(() => {
    if (runnerHostId) {
      return (
        normalizedRunnerHosts.find((runner) => runner.id === runnerHostId) || null
      );
    }
    if (inheritCategoryRunner) {
      return categoryDefaultRunner || null;
    }
    return null;
  }, [
    normalizedRunnerHosts,
    runnerHostId,
    categoryDefaultRunner,
    inheritCategoryRunner,
  ]);

  const canSelectAdminOnly = Boolean(currentUser?.isAdmin);

  const runnerSelectValue = runnerHostId
    ? runnerHostId
    : inheritCategoryRunner
      ? ""
      : NO_RUNNER_VALUE;

  const hasAdminOnlyRunner = useMemo(
    () => normalizedRunnerHosts.some((runner) => runner.adminOnly),
    [normalizedRunnerHosts],
  );

  const categoryDefaultRunnerLabel = useMemo(() => {
    if (!categoryDefaultRunner) {
      return null;
    }
    const labelSource =
      categoryDefaultRunner.name ||
      categoryDefaultRunner.id ||
      categoryDefaultRunnerHostId ||
      "Runner";
    const suffix = categoryDefaultRunner.adminOnly ? " · Admin only" : "";
    return `Use collection default (${labelSource}${suffix})`;
  }, [categoryDefaultRunner, categoryDefaultRunnerHostId]);

  const isRunnerListLoading = !runnersLoaded && normalizedRunnerHosts.length === 0;

  const handleToggleAcceptedMethod = (method) => {
    const normalized =
      typeof method === "string" ? method.trim().toUpperCase() : "";
    if (!normalized || !SUPPORTED_HTTP_METHODS.includes(normalized)) {
      return;
    }
    setAcceptedMethods((prev) => {
      if (prev.includes(normalized)) {
        if (prev.length === 1) {
          return prev;
        }
        const next = prev.filter((value) => value !== normalized);
        return next.length
          ? SUPPORTED_HTTP_METHODS.filter((value) => next.includes(value))
          : prev;
      }
      const next = [...prev, normalized];
      return SUPPORTED_HTTP_METHODS.filter((value) => next.includes(value));
    });
    setErrorMessage("");
  };

  const handleCategoryChange = (event) => {
    const nextCategoryId = event.target.value;
    setCategoryId(nextCategoryId);
    if (!script?.id) {
      const matched = mergedCategories.find((category) => category.id === nextCategoryId);
      if (matched?.defaultLanguage) {
        setLanguage(matched.defaultLanguage);
      }
      setRunnerHostId("");
      setInheritCategoryRunner(true);
    } else if (!script?.runnerHostId) {
      setRunnerHostId("");
    }
  };

  // ✅ Whenever `script` changes, update the editor fields
  useEffect(() => {
    if (script) {
      setName(script.name || "");
      setEndpoint(script.endpoint || "");
      setLanguage(script.language || "node");
      setTimeoutVal(script.timeout || 0);
      setCode(script.code || "");
      if (script.id) {
        setCategoryId(
          script.collectionId ||
          script.collection?.id ||
          script.categoryId ||
          script.category?.id ||
          DEFAULT_CATEGORY_ID,
        );
      } else {
        setCategoryId(
          script.collectionId ||
          script.collection?.id ||
          script.categoryId ||
          script.category?.id ||
          "",
        );
      }
      setRunnerHostId(script.runnerHostId || "");
      setInheritCategoryRunner(
        script?.inheritCategoryRunner === undefined
          ? true
          : Boolean(script.inheritCategoryRunner),
      );
      const resolvedMethods = toSortedMethods(script.acceptedMethods);
      setAcceptedMethods(
        resolvedMethods.length > 0
          ? resolvedMethods
          : [...DEFAULT_ACCEPTED_METHODS],
      );
    } else {
      // clear form for "new script"
      setName("");
      setEndpoint("");
      setLanguage("node");
      setTimeoutVal(0);
      setCode("");
      setCategoryId("");
      setRunnerHostId("");
      setInheritCategoryRunner(true);
      setAcceptedMethods([...DEFAULT_ACCEPTED_METHODS]);
    }
    setErrorMessage("");
  }, [script, toSortedMethods]);

  useEffect(() => {
    if (script?.id) return;
    if (categoryId) return;
    if (!Array.isArray(categoryOptions) || categoryOptions.length === 0) {
      if (categoriesLoaded) {
        setCategoryId(DEFAULT_CATEGORY_ID);
      }
      return;
    }
    const firstCategory = categoryOptions[0];
    if (!firstCategory) return;
    setCategoryId(firstCategory.id || DEFAULT_CATEGORY_ID);
    if (firstCategory.defaultLanguage) {
      setLanguage(firstCategory.defaultLanguage);
    }
  }, [script?.id, categoryId, categoryOptions, categoriesLoaded]);

  useEffect(() => {
    let isCancelled = false;

    if (!script?.id) {
      setVariables(createEmptyVariableGroups());
      setVariablesLoading(false);
      return () => {
        isCancelled = true;
      };
    }

    setVariables(createEmptyVariableGroups());
    setVariablesLoading(true);

    const fetchVariables = async () => {
      try {
        const data = await apiRequest(
          `/api/scripts/${encodeURIComponent(script.id)}/variables`,
        );
        if (isCancelled) return;
        const scriptList = Array.isArray(data?.scriptVariables)
          ? data.scriptVariables
          : Array.isArray(data?.variables)
            ? data.variables
            : [];
        const categoryList = Array.isArray(data?.categoryVariables)
          ? data.categoryVariables
          : [];
        const globalList = Array.isArray(data?.globalVariables)
          ? data.globalVariables
          : [];
        const jobList = Array.isArray(data?.jobVariables) ? data.jobVariables : [];
        setVariables({
          script: scriptList,
          category: categoryList,
          global: globalList,
          job: jobList,
        });
      } catch (err) {
        if (isCancelled) return;
        if (onAuthError && (err.status === 401 || err.status === 403)) {
          onAuthError(err);
        } else {
          console.error("Failed to load script variables", err);
        }
      } finally {
        if (isCancelled) return;
        setVariablesLoading(false);
      }
    };

    fetchVariables();

    return () => {
      isCancelled = true;
    };
  }, [script?.id, onAuthError, variablesRefreshKey]);

  useEffect(() => {
    if (!editorRef.current) return;
    if (!isActive) return;
    // ensure monaco model updates selection when language changes
    editorRef.current.focus();
  }, [language, isActive]);

  const snippetOptions = useMemo(() => SNIPPETS[language] || [], [language]);
  const variableOptions = useMemo(() => {
    if (!variables) return [];
    const groups = [
      { scope: "Script", items: Array.isArray(variables.script) ? variables.script : [] },
      {
        scope: "Collection",
        items: Array.isArray(variables.category) ? variables.category : [],
      },
      { scope: "Global", items: Array.isArray(variables.global) ? variables.global : [] },
      { scope: "Job", items: Array.isArray(variables.job) ? variables.job : [] },
    ];
    const options = [];
    for (const { scope, items } of groups) {
      for (const variable of items) {
        if (!variable?.envName) continue;
        const baseLabel = variable.name
          ? `${variable.name} (${variable.envName})`
          : variable.label
            ? `${variable.label} (${variable.envName})`
            : variable.envName;
        const scopeLabel = `${scope} • ${baseLabel}`;
        options.push({
          id: variable.id || `${scope}-${variable.envName}`,
          envName: variable.envName,
          isSecure: Boolean(variable.isSecure),
          label: variable.isSecure ? `${scopeLabel} 🔐` : scopeLabel,
        });
      }
    }
    return options;
  }, [variables]);

  const getVariableSnippet = useCallback(
    (envName) => {
      if (!envName) return "";
      if (language === "python") {
        return `os.environ.get("${envName}")`;
      }
      if (language === "powershell") {
        return `$env:${envName}`;
      }
      return `process.env.${envName}`;
    },
    [language],
  );

  const handleVariableInsert = (event) => {
    const envName = event.target.value;
    if (!envName) return;
    const selectedOption = variableOptions.find((option) => option.envName === envName);
    const snippet = getVariableSnippet(envName);
    insertTextAtCursor(snippet);
    if (selectedOption?.isSecure && !skipVariableSecurityWarning) {
      setShowVariableSecurityWarning(true);
    }
    event.target.value = "";
  };

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  };

  const insertTextAtCursor = useCallback((text) => {
    if (!text) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const selection = editor.getSelection();
    const range =
      selection ||
      new monaco.Selection(
        model.getLineCount(),
        model.getLineMaxColumn(model.getLineCount()),
        model.getLineCount(),
        model.getLineMaxColumn(model.getLineCount()),
      );

    editor.executeEdits("insert-text", [
      {
        range,
        text,
        forceMoveMarkers: true,
      },
    ]);
    if (isActive) {
      editor.focus();
    }
  }, [isActive]);

  const handleSnippetInsert = (e) => {
    const snippetValue = e.target.value;
    if (!snippetValue) return;
    insertTextAtCursor(snippetValue);
    e.target.value = "";
  };

  const handleVariableWarningPreferenceChange = (event) => {
    const nextValue = event.target.checked;
    setSkipVariableSecurityWarning(nextValue);
    if (typeof window !== "undefined") {
      try {
        if (nextValue) {
          window.localStorage.setItem(VARIABLE_WARNING_STORAGE_KEY, "true");
        } else {
          window.localStorage.removeItem(VARIABLE_WARNING_STORAGE_KEY);
        }
      } catch (err) {
        console.error("Failed to persist variable warning preference", err);
      }
    }
    if (nextValue) {
      setShowVariableSecurityWarning(false);
    }
  };

  const handleDismissVariableWarning = () => {
    setShowVariableSecurityWarning(false);
  };

  async function handleSave() {
    const trimmedName = name.trim();
    const trimmedEndpoint = endpoint.trim();
    const resolvedCategoryId = (categoryId || "").trim();

    if (trimmedName !== name) {
      setName(trimmedName);
    }
    if (trimmedEndpoint !== endpoint) {
      setEndpoint(trimmedEndpoint);
    }

    if (!trimmedName) {
      setErrorMessage("Please enter a script name.");
      return;
    }

    if (!trimmedEndpoint) {
      setErrorMessage("Please enter an endpoint.");
      return;
    }

    if (!resolvedCategoryId) {
      setErrorMessage("Please select a collection.");
      return;
    }

    setErrorMessage("");

    const normalizedAccepted = SUPPORTED_HTTP_METHODS.filter((method) =>
      acceptedMethods.includes(method),
    );
    if (normalizedAccepted.length === 0) {
      setErrorMessage("Select at least one HTTP method.");
      return;
    }
    const defaultRunMethodForScript =
      typeof script?.runMethod === "string" && script.runMethod.trim()
        ? script.runMethod.trim().toUpperCase()
        : "POST";
    if (
      SUPPORTED_HTTP_METHODS.includes(defaultRunMethodForScript) &&
      !normalizedAccepted.includes(defaultRunMethodForScript)
    ) {
      normalizedAccepted.push(defaultRunMethodForScript);
    }
    const finalAcceptedMethods = SUPPORTED_HTTP_METHODS.filter((method) =>
      normalizedAccepted.includes(method),
    );
    setAcceptedMethods(finalAcceptedMethods);

    const payload = {
      id: script?.id, // <--- send id if editing
      name: trimmedName,
      endpoint: trimmedEndpoint,
      language,
      timeout: Number(timeout),
      code,
      categoryId: resolvedCategoryId,
      collectionId: resolvedCategoryId,
      inheritCategoryPermissions:
        script?.inheritCategoryPermissions === undefined
          ? true
          : Boolean(script.inheritCategoryPermissions),
      inheritCollectionPermissions:
        script?.inheritCollectionPermissions === undefined
          ? true
          : Boolean(script.inheritCollectionPermissions),
      runnerHostId: runnerHostId ? runnerHostId : null,
      inheritCategoryRunner,
      inheritCollectionRunner: inheritCategoryRunner,
      acceptedMethods: finalAcceptedMethods,
    };

    try {
      const responseBody = await apiRequest("/api/scripts", {
        method: "POST",
        body: payload,
      });
      onSave?.(responseBody);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
        return;
      }
      const message = err?.data?.error || err.message || "Failed to save script.";
      setErrorMessage(message);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <h2 className="text-xl font-semibold text-sky-400">
        {script ? "Edit Script" : "Create Script"}
      </h2>

      {errorMessage && (
        <div className="rounded border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {errorMessage}
        </div>
      )}

      <div className="grid shrink-0 gap-3 text-sm md:grid-cols-2">
        <div>
          <label className="block text-gray-400">Name</label>
          <input
            className="w-full bg-slate-800 border border-slate-600 rounded p-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-gray-400">Endpoint</label>
          <input
            className="w-full bg-slate-800 border border-slate-600 rounded p-2"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-gray-400">Collection</label>
          {mergedCategories.length > 0 ? (
            <select
              className="w-full bg-slate-800 border border-slate-600 rounded p-2"
              value={categoryId}
              onChange={handleCategoryChange}
            >
              {mergedCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name || "Unnamed"}
                </option>
              ))}
            </select>
          ) : categoriesLoaded ? (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              No collections are available for you to use. Please contact an administrator.
            </div>
          ) : (
            <div className="rounded border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-300">
              Loading collections…
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-gray-400" htmlFor="script-runner">
              Runner
            </label>
            {(runnerHostId || !inheritCategoryRunner) && (
              <button
                type="button"
                onClick={() => {
                  setRunnerHostId("");
                  setInheritCategoryRunner(true);
                  setErrorMessage("");
                }}
                className="text-xs text-slate-300 underline decoration-dotted underline-offset-4 hover:text-slate-100"
              >
                Use collection default
              </button>
            )}
          </div>
          {runnerLoadError && (
            <div className="mt-1 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {runnerLoadError}
            </div>
          )}
          {isRunnerListLoading ? (
            <div className="rounded border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-300">
              Loading runners…
            </div>
          ) : (
            <select
              id="script-runner"
              className="w-full bg-slate-800 border border-slate-600 rounded p-2"
              value={runnerSelectValue}
              onChange={(event) => {
                const value = event.target.value;
                if (value === NO_RUNNER_VALUE) {
                  setRunnerHostId("");
                  setInheritCategoryRunner(false);
                } else if (value === "") {
                  setRunnerHostId("");
                  setInheritCategoryRunner(true);
                } else {
                  setRunnerHostId(value);
                  setInheritCategoryRunner(false);
                }
                setErrorMessage("");
              }}
            >
              <option value="">
                {categoryDefaultRunnerLabel || "Inherit collection default"}
              </option>
              <option value={NO_RUNNER_VALUE}>No assigned runner (disable script)</option>
              {normalizedRunnerHosts.map((runner) => (
                <option
                  key={runner.id}
                  value={runner.id}
                  disabled={
                    Boolean(runner.disabledAt) ||
                    (runner.adminOnly && !canSelectAdminOnly)
                  }
                >
                  {runner.name}
                  {runner.adminOnly ? " (Admin only)" : ""}
                  {runner.disabledAt ? " (Disabled)" : ""}
                </option>
              ))}
            </select>
          )}
          <p className="mt-1 text-xs text-slate-400">
            {runnerHostId
              ? selectedRunner
                ? `This script will always run on ${selectedRunner.name ||
                selectedRunner.id ||
                runnerHostId
                }.`
                : "This script will use the selected runner."
              : !inheritCategoryRunner
                ? "This script is disabled and will respond with 'No runners configured' until a runner is assigned."
                : categoryDefaultRunner
                  ? `This script will inherit the collection default runner (${categoryDefaultRunner.name || categoryDefaultRunnerHostId || "Runner"}).`
                  : normalizedRunnerHosts.length > 0
                    ? "Assign a runner, inherit the collection default, or choose 'No assigned runner' to keep this script idle."
                    : "No runners are currently available. Configure a runner or disable inheritance before saving."}
          </p>
          {!canSelectAdminOnly && hasAdminOnlyRunner && (
            <p className="mt-1 text-xs text-amber-200">
              Admin-only runners are managed by administrators and cannot be assigned directly.
            </p>
          )}
        </div>

        <div>
          <label className="block text-gray-400">Language</label>
          <select
            className="w-full bg-slate-800 border border-slate-600 rounded p-2"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="node">Node JS</option>
            <option value="python">Python</option>
            <option value="powershell">PowerShell</option>
            <option value="shell">Shell</option>
          </select>
        </div>

        <div>
          <label className="block text-gray-400">Timeout (s)</label>
          <input
            type="number"
            className="w-full bg-slate-800 border border-slate-600 rounded p-2"
            value={timeout}
            onChange={(e) => setTimeoutVal(e.target.value)}
          />
        </div>

        <div className="md:col-span-2">
          <label className="block text-gray-400">Allowed HTTP methods</label>
          <div className="mt-2 flex flex-wrap gap-3">
            {SUPPORTED_HTTP_METHODS.map((method) => {
              const isChecked = acceptedMethods.includes(method);
              const disableUncheck = isChecked && acceptedMethods.length === 1;
              return (
                <label
                  key={method}
                  className="flex items-center gap-2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-sky-400"
                    checked={isChecked}
                    onChange={() => handleToggleAcceptedMethod(method)}
                    disabled={disableUncheck}
                  />
                  <span>{method}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Requests using other methods receive a 405 Method Not Allowed response.
          </p>
        </div>
      </div>

      <div className="flex min-h-[400px] flex-1 flex-col overflow-hidden rounded border border-slate-700">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-300">
          <span>Code</span>
          <div className="flex items-center gap-2">
            {variableOptions.length > 0 && (
              <select
                onChange={handleVariableInsert}
                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200"
                defaultValue=""
                disabled={variablesLoading}
              >
                <option value="" disabled>
                  {variablesLoading ? "Loading variables…" : "Insert variable…"}
                </option>
                {variableOptions.map((option) => (
                  <option key={option.id || option.envName} value={option.envName}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            {snippetOptions.length > 0 && (
              <select
                onChange={handleSnippetInsert}
                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200"
                defaultValue=""
              >
                <option value="" disabled>
                  Insert snippet…
                </option>
                {snippetOptions.map((option) => (
                  <option key={option.label} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        {showVariableSecurityWarning && (
          <div className="border-b border-amber-500/40 bg-amber-900/30 px-3 py-3 text-xs text-amber-100">
            <div className="flex items-start justify-between gap-3">
              <p className="flex-1">
                <span className="font-semibold">Sensitive data warning:</span> This secured
                variable may contain encrypted secrets. Handle it carefully to avoid exposing the
                value in logs or other outputs.
              </p>
              <button
                type="button"
                onClick={handleDismissVariableWarning}
                className="shrink-0 rounded border border-amber-400/60 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-amber-100 hover:bg-amber-500/10"
              >
                Dismiss
              </button>
            </div>
            <label className="mt-3 flex items-center gap-2 text-amber-200/90">
              <input
                type="checkbox"
                checked={skipVariableSecurityWarning}
                onChange={handleVariableWarningPreferenceChange}
                className="h-4 w-4 rounded border border-amber-300 bg-slate-900"
              />
              <span>Do not show this message again</span>
            </label>
          </div>
        )}
        <div className="flex-1 min-h-0">
          <Editor
            height="100%"
            language={getEditorLanguage(language)}
            theme="vs-dark"
            value={code}
            onChange={(v) => setCode(v || "")}
            onMount={handleEditorMount}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              automaticLayout: true,
            }}
          />
        </div>
      </div>

      <div className="flex shrink-0 justify-end gap-3 pt-2">
        <button
          onClick={onCancel}
          className="bg-slate-700 hover:bg-slate-600 text-gray-300 px-3 py-1 rounded"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="bg-sky-400 hover:bg-sky-300 text-black font-semibold px-3 py-1 rounded"
        >
          Save
        </button>
      </div>
    </div>
  );
}
