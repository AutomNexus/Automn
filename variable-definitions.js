const SCRIPT_VARIABLE_ENV_PREFIX = "AUTOMN_VAR_";
const GLOBAL_VARIABLE_ENV_PREFIX = "AUTOMN_GLOBAL_VAR_";
const COLLECTION_VARIABLE_ENV_PREFIX = "AUTOMN_CAT_VAR_";
const CATEGORY_VARIABLE_ENV_PREFIX = COLLECTION_VARIABLE_ENV_PREFIX;
const JOB_VARIABLE_ENV_PREFIX = "AUTOMN_JOB_VAR_";

const JOB_VARIABLE_DEFINITIONS = [
  {
    key: "HTTP_METHOD",
    envName: `${JOB_VARIABLE_ENV_PREFIX}HTTP_METHOD`,
    label: "HTTP method",
    description: "HTTP method used to trigger this run (for example GET or POST).",
    resolveValue: ({ httpMethod }) =>
      typeof httpMethod === "string" && httpMethod.trim()
        ? httpMethod.trim().toUpperCase()
        : "",
  },
  {
    key: "SCRIPT_NAME",
    envName: `${JOB_VARIABLE_ENV_PREFIX}SCRIPT_NAME`,
    label: "Script name",
    description: "Name of the script that is executing.",
    resolveValue: ({ scriptName }) =>
      typeof scriptName === "string" ? scriptName : "",
  },
  {
    key: "SCRIPT_VERSION",
    envName: `${JOB_VARIABLE_ENV_PREFIX}SCRIPT_VERSION`,
    label: "Script version",
    description: "Current published version number of the script.",
    resolveValue: ({ scriptVersion }) =>
      Number.isFinite(scriptVersion) && scriptVersion > 0
        ? String(scriptVersion)
        : typeof scriptVersion === "string"
        ? scriptVersion
        : "",
  },
  {
    key: "TARGET_RUNNER",
    envName: `${JOB_VARIABLE_ENV_PREFIX}TARGET_RUNNER`,
    label: "Target runner",
    description: "Runner host handling the execution (host name when available).",
    resolveValue: ({ targetRunnerName, targetRunnerId }) => {
      if (typeof targetRunnerName === "string" && targetRunnerName.trim()) {
        return targetRunnerName.trim();
      }
      if (typeof targetRunnerId === "string" && targetRunnerId.trim()) {
        return targetRunnerId.trim();
      }
      return "";
    },
  },
];

function buildJobVariables(context = {}) {
  return JOB_VARIABLE_DEFINITIONS.map((definition) => {
    let value;
    try {
      value = definition.resolveValue(context);
    } catch (err) {
      value = "";
    }
    if (value === undefined || value === null) {
      value = "";
    }
    return {
      envName: definition.envName,
      value: String(value),
      scope: "job",
    };
  });
}

function serializeJobVariableDefinitions() {
  return JOB_VARIABLE_DEFINITIONS.map(({ envName, label, description }) => ({
    envName,
    label,
    description,
    scope: "job",
  }));
}

module.exports = {
  SCRIPT_VARIABLE_ENV_PREFIX,
  GLOBAL_VARIABLE_ENV_PREFIX,
  COLLECTION_VARIABLE_ENV_PREFIX,
  CATEGORY_VARIABLE_ENV_PREFIX,
  JOB_VARIABLE_ENV_PREFIX,
  JOB_VARIABLE_DEFINITIONS,
  buildJobVariables,
  serializeJobVariableDefinitions,
};
