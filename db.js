const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const { hashPassword, verifyPassword } = require("./security");
const { DEFAULT_ADMIN_PASSWORD } = require("./constants");

const DEFAULT_CATEGORY_ID = "category-general";

const DB_FILE = path.join(__dirname, "data", "automn.db");

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

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

const db = new sqlite3.Database(DB_FILE);

function backfillScriptVersions(database) {
  database.serialize(() => {
    database.all(
      `SELECT s.id, s.code, s.owner_id, s.created_at, s.last_version_user_id,
              MAX(sv.version) AS max_version
         FROM scripts s
         LEFT JOIN script_versions sv ON sv.script_id = s.id
        GROUP BY s.id`,
      (err, rows) => {
        if (err) {
          console.error("Failed to scan scripts for version backfill", err);
          return;
        }

        if (!Array.isArray(rows) || !rows.length) {
          return;
        }

        const processRow = (index) => {
          if (index >= rows.length) {
            return;
          }

          const row = rows[index];
          if (!row?.id) {
            processRow(index + 1);
            return;
          }

          const scriptId = row.id;
          const scriptCode = row.code || "";
          const scriptCreatedAt = row.created_at || new Date().toISOString();
          const maxVersion = Number(row.max_version) || 0;
          const fallbackAuthorId =
            row.last_version_user_id || row.owner_id || null;

          if (maxVersion <= 0) {
            database.run(
              `INSERT INTO script_versions (id, script_id, version, code, updated_by_user_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                uuidv4(),
                scriptId,
                1,
                scriptCode,
                fallbackAuthorId,
                scriptCreatedAt,
              ],
              (insertErr) => {
                if (
                  insertErr &&
                  (!insertErr.message ||
                    !insertErr.message.includes("UNIQUE"))
                ) {
                  console.error(
                    "Failed to seed initial script version",
                    insertErr,
                  );
                }

                if (!row.last_version_user_id && fallbackAuthorId) {
                  database.run(
                    `UPDATE scripts SET last_version_user_id=? WHERE id=?`,
                    [fallbackAuthorId, scriptId],
                    () => processRow(index + 1),
                  );
                  return;
                }

                processRow(index + 1);
              },
            );
            return;
          }

          database.get(
            `SELECT code, updated_by_user_id FROM script_versions WHERE script_id=? AND version=?`,
            [scriptId, maxVersion],
            (getErr, versionRow) => {
              if (getErr) {
                console.error("Failed to inspect script version", getErr);
                processRow(index + 1);
                return;
              }

              const versionCode = versionRow?.code || "";
              const effectiveAuthor =
                row.last_version_user_id ||
                versionRow?.updated_by_user_id ||
                row.owner_id ||
                null;

              if (versionCode !== scriptCode) {
                const nextVersion = maxVersion + 1;
                const createdAt = new Date().toISOString();

                database.run(
                  `INSERT INTO script_versions (id, script_id, version, code, updated_by_user_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                  [
                    uuidv4(),
                    scriptId,
                    nextVersion,
                    scriptCode,
                    effectiveAuthor,
                    createdAt,
                  ],
                  (insertErr) => {
                    if (
                      insertErr &&
                      (!insertErr.message ||
                        !insertErr.message.includes("UNIQUE"))
                    ) {
                      console.error(
                        "Failed to append current script version",
                        insertErr,
                      );
                    }

                    if (effectiveAuthor) {
                      database.run(
                        `UPDATE scripts SET last_version_user_id=? WHERE id=?`,
                        [effectiveAuthor, scriptId],
                        () => processRow(index + 1),
                      );
                      return;
                    }

                    processRow(index + 1);
                  },
                );
                return;
              }

              if (
                effectiveAuthor &&
                row.last_version_user_id !== effectiveAuthor
              ) {
                database.run(
                  `UPDATE scripts SET last_version_user_id=? WHERE id=?`,
                  [effectiveAuthor, scriptId],
                  () => processRow(index + 1),
                );
                return;
              }

              processRow(index + 1);
            },
          );
        };

        processRow(0);
      },
    );
  });
}

function normalizeCategoryKey(name) {
  if (!name) return "";
  return String(name).trim().toLowerCase();
}

function ensureDefaultCategory(database, callback = () => {}) {
  database.get(
    "SELECT id, name FROM categories WHERE id=?",
    [DEFAULT_CATEGORY_ID],
    (err, row) => {
      if (err) {
        console.error("Failed to ensure default category", err);
        callback(err);
        return;
      }

      if (row) {
        database.run(
          `UPDATE categories
              SET name=?,
                  is_system=1,
                  updated_at=CURRENT_TIMESTAMP
            WHERE id=?`,
          ["General", DEFAULT_CATEGORY_ID],
          (updateErr) => {
            if (updateErr) {
              console.error("Failed to refresh default category", updateErr);
              callback(updateErr);
              return;
            }
            callback(null, DEFAULT_CATEGORY_ID);
          },
        );
        return;
      }

      database.run(
        `INSERT INTO categories (id, name, description, default_language, is_system)
         VALUES (?, ?, '', NULL, 1)`,
        [DEFAULT_CATEGORY_ID, "General"],
        (insertErr) => {
          if (insertErr) {
            if (
              insertErr.message &&
              insertErr.message.toUpperCase().includes("UNIQUE")
            ) {
              callback(null, DEFAULT_CATEGORY_ID);
              return;
            }
            console.error("Failed to create default category", insertErr);
            callback(insertErr);
            return;
          }
          callback(null, DEFAULT_CATEGORY_ID);
        },
      );
    },
  );
}

function backfillScriptCategories(database, defaultCategoryId = DEFAULT_CATEGORY_ID) {
  database.all(
    `SELECT id, name FROM categories`,
    (categoryErr, categoryRows) => {
      if (categoryErr) {
        console.error("Failed to load categories for backfill", categoryErr);
        return;
      }

      const knownCategories = new Map();
      if (Array.isArray(categoryRows)) {
        for (const row of categoryRows) {
          const normalized = normalizeCategoryKey(row?.name);
          if (normalized) {
            knownCategories.set(normalized, { id: row.id, name: row.name });
          }
        }
      }

      database.all(
        `SELECT id, project_name, category_id FROM scripts`,
        (scriptErr, scriptRows) => {
          if (scriptErr) {
            console.error(
              "Failed to inspect scripts for category backfill",
              scriptErr,
            );
            return;
          }

          if (!Array.isArray(scriptRows) || scriptRows.length === 0) {
            return;
          }

          const requiredCategories = [];
          const requiredSet = new Set();

          for (const script of scriptRows) {
            const trimmed = (script?.project_name || "").trim();
            if (!trimmed) continue;
            const normalized = normalizeCategoryKey(trimmed);
            if (!normalized || knownCategories.has(normalized)) {
              continue;
            }
            if (requiredSet.has(normalized)) continue;
            requiredSet.add(normalized);
            requiredCategories.push({ normalized, name: trimmed });
          }

          const createNextCategory = (index) => {
            if (index >= requiredCategories.length) {
              assignScripts();
              return;
            }

            const entry = requiredCategories[index];
            const categoryId = uuidv4();
            database.run(
              `INSERT INTO categories (id, name, description, default_language, is_system)
               VALUES (?, ?, '', NULL, 0)`,
              [categoryId, entry.name],
              (insertErr) => {
                if (insertErr) {
                  if (
                    insertErr.message &&
                    insertErr.message.toUpperCase().includes("UNIQUE")
                  ) {
                    database.get(
                      `SELECT id, name FROM categories WHERE LOWER(name)=LOWER(?)`,
                      [entry.name],
                      (lookupErr, existing) => {
                        if (!lookupErr && existing) {
                          knownCategories.set(entry.normalized, {
                            id: existing.id,
                            name: existing.name,
                          });
                        }
                        createNextCategory(index + 1);
                      },
                    );
                    return;
                  }
                  console.error(
                    "Failed to create category during backfill",
                    insertErr,
                  );
                } else {
                  knownCategories.set(entry.normalized, {
                    id: categoryId,
                    name: entry.name,
                  });
                }
                createNextCategory(index + 1);
              },
            );
          };

          const assignScripts = () => {
            const scriptsNeedingUpdate = scriptRows.filter(
              (script) => !script.category_id,
            );
            if (!scriptsNeedingUpdate.length) {
              return;
            }

            const updateNext = (index) => {
              if (index >= scriptsNeedingUpdate.length) {
                return;
              }

              const script = scriptsNeedingUpdate[index];
              const trimmed = (script?.project_name || "").trim();
              let categoryId = defaultCategoryId;
              if (trimmed) {
                const normalized = normalizeCategoryKey(trimmed);
                const category = knownCategories.get(normalized);
                if (category?.id) {
                  categoryId = category.id;
                }
              }

              database.run(
                `UPDATE scripts SET category_id=? WHERE id=?`,
                [categoryId, script.id],
                () => updateNext(index + 1),
              );
            };

            updateNext(0);
          };

          createNextCategory(0);
        },
      );
    },
  );
}

function initializeSchema(database) {
  database.serialize(() => {
    database.run(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT,
        default_language TEXT,
        default_runner_host_id TEXT,
        is_system INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    database.all("PRAGMA table_info(categories)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect categories table", err);
        return;
      }

      const columnNames = columns.map((col) => col.name);
      if (!columnNames.includes("default_runner_host_id")) {
        database.run(
          "ALTER TABLE categories ADD COLUMN default_runner_host_id TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error(
                "Failed to add default_runner_host_id column",
                alterErr,
              );
            }
          },
        );
      }
    });

    database.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name ON categories(name)`,
    );

    database.run(`
      CREATE TABLE IF NOT EXISTS category_permissions (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        can_read INTEGER DEFAULT 0,
        can_write INTEGER DEFAULT 0,
        can_delete INTEGER DEFAULT 0,
        can_run INTEGER DEFAULT 0,
        can_clear_logs INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category_id, user_id),
        FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS scripts (
        id TEXT PRIMARY KEY,
        name TEXT,
        endpoint TEXT UNIQUE,
        language TEXT,
        code TEXT,
        timeout INTEGER DEFAULT 0,
        project_name TEXT,
        owner_id TEXT,
        last_version_user_id TEXT,
        runner_host_id TEXT,
        inherit_category_runner INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        is_draft INTEGER DEFAULT 0,
        is_recycled INTEGER DEFAULT 0,
        recycled_at TEXT,
        run_method TEXT DEFAULT 'POST',
        allowed_methods TEXT DEFAULT '["POST","GET"]',
        run_headers TEXT,
        run_body TEXT,
        run_token TEXT,
        require_authentication INTEGER DEFAULT 1,
        expose_automn_response INTEGER DEFAULT 0,
        expose_run_id INTEGER DEFAULT 1,
        FOREIGN KEY(owner_id) REFERENCES users(id),
        FOREIGN KEY(last_version_user_id) REFERENCES users(id)
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS script_packages (
        script_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        message TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (script_id, name),
        FOREIGN KEY(script_id) REFERENCES scripts(id) ON DELETE CASCADE
      )
    `);

    database.run(
      `CREATE INDEX IF NOT EXISTS idx_script_packages_script ON script_packages(script_id)`
    );

    database.all("PRAGMA table_info(scripts)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect scripts table", err);
        return;
      }

      const hasProject = columns.some((col) => col.name === "project_name");
      if (!hasProject) {
        database.run("ALTER TABLE scripts ADD COLUMN project_name TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add project_name column", alterErr);
          }
        });
      }

      const hasIsRecycled = columns.some((col) => col.name === "is_recycled");
      if (!hasIsRecycled) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN is_recycled INTEGER DEFAULT 0",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add is_recycled column", alterErr);
            }
          },
        );
      }

      const hasIsDraft = columns.some((col) => col.name === "is_draft");
      if (!hasIsDraft) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN is_draft INTEGER DEFAULT 0",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add is_draft column", alterErr);
            }
          },
        );
      }

      const hasRecycledAt = columns.some((col) => col.name === "recycled_at");
      if (!hasRecycledAt) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN recycled_at TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add recycled_at column", alterErr);
            }
          },
        );
      }

      const hasRunMethod = columns.some((col) => col.name === "run_method");
      if (!hasRunMethod) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN run_method TEXT DEFAULT 'POST'",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add run_method column", alterErr);
            }
          },
        );
      }

      const hasAllowedMethods = columns.some((col) => col.name === "allowed_methods");
      if (!hasAllowedMethods) {
        database.run(
          `ALTER TABLE scripts ADD COLUMN allowed_methods TEXT DEFAULT '["POST","GET"]'`,
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add allowed_methods column", alterErr);
            } else {
              database.run(
                `UPDATE scripts SET allowed_methods='["POST","GET"]' WHERE allowed_methods IS NULL OR TRIM(allowed_methods)=''`,
                (updateErr) => {
                  if (updateErr) {
                    console.error(
                      "Failed to backfill allowed_methods column",
                      updateErr,
                    );
                  }
                },
              );
            }
          },
        );
      }

      const hasRunHeaders = columns.some((col) => col.name === "run_headers");
      if (!hasRunHeaders) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN run_headers TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add run_headers column", alterErr);
            }
          },
        );
      }

      const hasRunBody = columns.some((col) => col.name === "run_body");
      if (!hasRunBody) {
        database.run("ALTER TABLE scripts ADD COLUMN run_body TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add run_body column", alterErr);
          }
        });
      }

      const hasRunToken = columns.some((col) => col.name === "run_token");
      if (!hasRunToken) {
        database.run("ALTER TABLE scripts ADD COLUMN run_token TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add run_token column", alterErr);
          }
        });
      }

      const hasExposeAutomnResponse = columns.some(
        (col) => col.name === "expose_automn_response",
      );
      if (!hasExposeAutomnResponse) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN expose_automn_response INTEGER DEFAULT 0",
          (alterErr) => {
            if (alterErr) {
              console.error(
                "Failed to add expose_automn_response column",
                alterErr,
              );
            }
          },
        );
      }

      const hasExposeRunId = columns.some((col) => col.name === "expose_run_id");
      if (!hasExposeRunId) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN expose_run_id INTEGER DEFAULT 1",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add expose_run_id column", alterErr);
            }
          },
        );
      }

      const hasRunnerHostId = columns.some((col) => col.name === "runner_host_id");
      if (!hasRunnerHostId) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN runner_host_id TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add runner_host_id column", alterErr);
            }
          },
        );
      }

      const hasInheritCategoryRunner = columns.some(
        (col) => col.name === "inherit_category_runner",
      );
      if (!hasInheritCategoryRunner) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN inherit_category_runner INTEGER DEFAULT 1",
          (alterErr) => {
            if (alterErr) {
              console.error(
                "Failed to add inherit_category_runner column",
                alterErr,
              );
            }
          },
        );
      }

      const hasRequireAuth = columns.some(
        (col) => col.name === "require_authentication",
      );
      if (!hasRequireAuth) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN require_authentication INTEGER DEFAULT 1",
          (alterErr) => {
            if (alterErr) {
              console.error(
                "Failed to add require_authentication column",
                alterErr,
              );
            }
          },
        );
      }

      const hasOwnerId = columns.some((col) => col.name === "owner_id");
      if (!hasOwnerId) {
        database.run("ALTER TABLE scripts ADD COLUMN owner_id TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add owner_id column", alterErr);
          }
        });
      }

      const hasLastVersionUserId = columns.some(
        (col) => col.name === "last_version_user_id",
      );
      if (!hasLastVersionUserId) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN last_version_user_id TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error(
                "Failed to add last_version_user_id column",
                alterErr,
              );
            }
          },
        );
      }

      const hasCategoryId = columns.some((col) => col.name === "category_id");
      if (!hasCategoryId) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN category_id TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add category_id column", alterErr);
            }
          },
        );
      }

      const hasInheritCategory = columns.some(
        (col) => col.name === "inherit_category_permissions",
      );
      if (!hasInheritCategory) {
        database.run(
          "ALTER TABLE scripts ADD COLUMN inherit_category_permissions INTEGER DEFAULT 1",
          (alterErr) => {
            if (alterErr) {
              console.error(
                "Failed to add inherit_category_permissions column",
                alterErr,
              );
            }
          },
        );
      }

      ensureDefaultCategory(database, (err, defaultCategoryId) => {
        if (err) {
          return;
        }
        backfillScriptCategories(database, defaultCategoryId || DEFAULT_CATEGORY_ID);
      });
    });

    database.run(`
      CREATE TABLE IF NOT EXISTS script_permissions (
        id TEXT PRIMARY KEY,
        script_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        can_read INTEGER DEFAULT 0,
        can_write INTEGER DEFAULT 0,
        can_delete INTEGER DEFAULT 0,
        can_run INTEGER DEFAULT 0,
        can_clear_logs INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(script_id, user_id),
        FOREIGN KEY(script_id) REFERENCES scripts(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    database.all("PRAGMA table_info(script_permissions)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect script_permissions table", err);
        return;
      }

      const hasClearLogs = columns.some((col) => col.name === "can_clear_logs");
      if (!hasClearLogs) {
        database.run(
          "ALTER TABLE script_permissions ADD COLUMN can_clear_logs INTEGER DEFAULT 0",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add can_clear_logs column", alterErr);
            }
          },
        );
      }
    });

    database.run(`
      CREATE TABLE IF NOT EXISTS script_variables (
        id TEXT PRIMARY KEY,
        script_id TEXT NOT NULL,
        name TEXT NOT NULL,
        env_name TEXT NOT NULL,
        value TEXT,
        is_secure INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(script_id, name),
        FOREIGN KEY(script_id) REFERENCES scripts(id) ON DELETE CASCADE
      )
    `);

    database.all("PRAGMA table_info(script_variables)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect script_variables table", err);
        return;
      }

      const columnNames = columns.map((col) => col.name);
      if (!columnNames.includes("env_name")) {
        database.run(
          "ALTER TABLE script_variables ADD COLUMN env_name TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add env_name column", alterErr);
            }
          },
        );
      }

      if (!columnNames.includes("updated_at")) {
        database.run(
          "ALTER TABLE script_variables ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add updated_at column", alterErr);
            }
          },
        );
      }

      database.run(
        "UPDATE script_variables SET env_name = 'AUTOMN_VAR_' || name WHERE env_name IS NULL OR env_name = ''",
        () => {},
      );
    });

    database.run(`
      CREATE TABLE IF NOT EXISTS global_variables (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        env_name TEXT NOT NULL,
        value TEXT,
        is_secure INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name)
      )
    `);

    database.all("PRAGMA table_info(global_variables)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect global_variables table", err);
        return;
      }

      const columnNames = columns.map((col) => col.name);
      if (!columnNames.includes("env_name")) {
        database.run(
          "ALTER TABLE global_variables ADD COLUMN env_name TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add env_name column to global_variables", alterErr);
            }
          },
        );
      }

      if (!columnNames.includes("updated_at")) {
        database.run(
          "ALTER TABLE global_variables ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add updated_at column to global_variables", alterErr);
            }
          },
        );
      }

      database.run(
        "UPDATE global_variables SET env_name = 'AUTOMN_GLOBAL_VAR_' || name WHERE env_name IS NULL OR env_name = ''",
        () => {},
      );
    });

    database.run(`
      CREATE TABLE IF NOT EXISTS category_variables (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        name TEXT NOT NULL,
        env_name TEXT NOT NULL,
        value TEXT,
        is_secure INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category_id, name),
        FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
      )
    `);

    database.all("PRAGMA table_info(category_variables)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect category_variables table", err);
        return;
      }

      const columnNames = columns.map((col) => col.name);
      if (!columnNames.includes("env_name")) {
        database.run(
          "ALTER TABLE category_variables ADD COLUMN env_name TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add env_name column to category_variables", alterErr);
            }
          },
        );
      }

      if (!columnNames.includes("updated_at")) {
        database.run(
          "ALTER TABLE category_variables ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add updated_at column to category_variables", alterErr);
            }
          },
        );
      }

      database.run(
        "UPDATE category_variables SET env_name = 'AUTOMN_CAT_VAR_' || name WHERE env_name IS NULL OR env_name = ''",
        () => {},
      );
    });

    database.run(`
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        script_id TEXT,
        start_time TEXT,
        duration_ms INTEGER,
        stdout TEXT,
        stderr TEXT,
        exit_code INTEGER,
        automn_logs_json TEXT,
        automn_notifications_json TEXT,
        FOREIGN KEY(script_id) REFERENCES scripts(id),
        FOREIGN KEY(run_id) REFERENCES runs(id)
      )
    `);

    database.all("PRAGMA table_info(logs)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect logs table", err);
        return;
      }

      const columnNames = columns.map((col) => col.name);
      if (!columnNames.includes("run_id")) {
        database.run("ALTER TABLE logs ADD COLUMN run_id TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add run_id column", alterErr);
          }
        });
      }

      if (!columnNames.includes("automn_logs_json")) {
        database.run("ALTER TABLE logs ADD COLUMN automn_logs_json TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add automn_logs_json column", alterErr);
          }
        });
      }

      if (!columnNames.includes("automn_notifications_json")) {
        database.run(
          "ALTER TABLE logs ADD COLUMN automn_notifications_json TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error(
                "Failed to add automn_notifications_json column",
                alterErr,
              );
            }
          },
        );
      }

      if (!columnNames.includes("input_json")) {
        database.run("ALTER TABLE logs ADD COLUMN input_json TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add input_json column", alterErr);
          }
        });
      }
    });

    database.run(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        script_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        created_by_user_id TEXT,
        metadata TEXT,
        FOREIGN KEY(script_id) REFERENCES scripts(id) ON DELETE SET NULL,
        FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS notification_recipients (
        notification_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        read_at TEXT,
        PRIMARY KEY (notification_id, user_id),
        FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    database.run(
      `CREATE INDEX IF NOT EXISTS idx_notification_recipients_user ON notification_recipients(user_id, read_at)`,
    );
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)`,
    );

    database.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      script_id TEXT,
      start_time TEXT,
      end_time TEXT,
      duration_ms INTEGER,
      status TEXT,
      return_json TEXT,
      code_version INTEGER,
      triggered_by TEXT,
      triggered_by_user_id TEXT,
      http_method TEXT,
      FOREIGN KEY(script_id) REFERENCES scripts(id)
    )
  `);

    database.all("PRAGMA table_info(runs)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect runs table", err);
        return;
      }

      const columnNames = columns.map((col) => col.name);
      if (!columnNames.includes("code_version")) {
        database.run("ALTER TABLE runs ADD COLUMN code_version INTEGER", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add code_version column", alterErr);
          }
        });
      }

      if (!columnNames.includes("triggered_by")) {
        database.run("ALTER TABLE runs ADD COLUMN triggered_by TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add triggered_by column", alterErr);
          }
        });
      }

      if (!columnNames.includes("triggered_by_user_id")) {
        database.run(
          "ALTER TABLE runs ADD COLUMN triggered_by_user_id TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add triggered_by_user_id column", alterErr);
            }
          },
        );
      }

      if (!columnNames.includes("http_method")) {
        database.run("ALTER TABLE runs ADD COLUMN http_method TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add http_method column", alterErr);
          }
        });
      }
    });

    database.run(`
    CREATE TABLE IF NOT EXISTS runner_hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      secret_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      status_message TEXT,
      endpoint TEXT,
      last_seen_at TEXT,
      max_concurrency INTEGER,
      timeout_ms INTEGER,
      runner_version TEXT,
      runner_os TEXT,
      runner_platform TEXT,
      runner_arch TEXT,
      runner_uptime INTEGER,
      runner_runtimes TEXT,
      minimum_host_version TEXT,
      admin_only INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      disabled_at TEXT
    )
  `);

    database.all("PRAGMA table_info(runner_hosts)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect runner_hosts table", err);
        return;
      }

      const columnNames = new Set(columns.map((col) => col.name));

      const ensureColumn = (name, definition) => {
        if (columnNames.has(name)) return;
        database.run(`ALTER TABLE runner_hosts ADD COLUMN ${name} ${definition}`, (alterErr) => {
          if (alterErr) {
            console.error(`Failed to add column ${name} to runner_hosts`, alterErr);
          }
        });
      };

      ensureColumn("status", "TEXT NOT NULL DEFAULT 'pending'");
      ensureColumn("status_message", "TEXT");
      ensureColumn("endpoint", "TEXT");
      ensureColumn("last_seen_at", "TEXT");
      ensureColumn("max_concurrency", "INTEGER");
      ensureColumn("timeout_ms", "INTEGER");
      ensureColumn("runner_version", "TEXT");
      ensureColumn("runner_os", "TEXT");
      ensureColumn("runner_platform", "TEXT");
      ensureColumn("runner_arch", "TEXT");
      ensureColumn("runner_uptime", "INTEGER");
      ensureColumn("runner_runtimes", "TEXT");
      ensureColumn("minimum_host_version", "TEXT");
      ensureColumn("admin_only", "INTEGER DEFAULT 0");
      ensureColumn("created_at", "TEXT DEFAULT CURRENT_TIMESTAMP");
      ensureColumn("updated_at", "TEXT DEFAULT CURRENT_TIMESTAMP");
      ensureColumn("disabled_at", "TEXT");
    });

    database.run(`
      CREATE TABLE IF NOT EXISTS script_versions (
        id TEXT PRIMARY KEY,
        script_id TEXT,
        version INTEGER,
        code TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_by_user_id TEXT,
        FOREIGN KEY(script_id) REFERENCES scripts(id),
        FOREIGN KEY(updated_by_user_id) REFERENCES users(id)
      )
    `);

    database.all("PRAGMA table_info(script_versions)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect script_versions table", err);
        return;
      }

      const hasUpdatedBy = columns.some((col) => col.name === "updated_by_user_id");
      if (!hasUpdatedBy) {
        database.run(
          "ALTER TABLE script_versions ADD COLUMN updated_by_user_id TEXT",
          (alterErr) => {
            if (alterErr) {
              console.error("Failed to add updated_by_user_id column", alterErr);
            }
          },
        );
      }
    });

    database.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password_hash TEXT,
        must_change_password INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        is_admin INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_login TEXT,
        deleted_at TEXT
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        token TEXT UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT,
        last_seen TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    database.all("PRAGMA table_info(users)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect users table", err);
        return;
      }

      const columnNames = columns.map((col) => col.name);
      if (!columnNames.includes("deleted_at")) {
        database.run("ALTER TABLE users ADD COLUMN deleted_at TEXT", (alterErr) => {
          if (alterErr) {
            console.error("Failed to add deleted_at column", alterErr);
          }
        });
      }
    });

    backfillScriptVersions(database);
  });
}

function parseRunnerRuntimes(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const normalized = {};
    for (const [key, rawValue] of Object.entries(parsed)) {
      if (!key) continue;
      if (rawValue === null || rawValue === undefined) {
        normalized[key] = null;
        continue;
      }
      const stringValue = typeof rawValue === "string" ? rawValue.trim() : String(rawValue);
      normalized[key] = stringValue || null;
    }
    return normalized;
  } catch (err) {
    return {};
  }
}

function serializeRunnerRuntimes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const normalized = {};
  for (const [key, rawValue] of Object.entries(value)) {
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
  try {
    return JSON.stringify(normalized);
  } catch (err) {
    return null;
  }
}

function mapRunnerHostRow(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const mapped = {
    id: row.id || null,
    name: row.name || null,
    status: row.status || "pending",
    statusMessage: row.status_message || null,
    endpoint: row.endpoint || null,
    lastSeenAt: row.last_seen_at || null,
    maxConcurrency:
      row.max_concurrency === null || row.max_concurrency === undefined
        ? null
        : Number(row.max_concurrency),
    timeoutMs:
      row.timeout_ms === null || row.timeout_ms === undefined
        ? null
        : Number(row.timeout_ms),
    runnerVersion: row.runner_version || null,
    runnerOs: row.runner_os || null,
    runnerPlatform: row.runner_platform || null,
    runnerArch: row.runner_arch || null,
    runnerUptime:
      row.runner_uptime === null || row.runner_uptime === undefined
        ? null
        : Number(row.runner_uptime),
    runnerRuntimes: parseRunnerRuntimes(row.runner_runtimes),
    minimumHostVersion: row.minimum_host_version || null,
    adminOnly: normalizeDbBoolean(row.admin_only),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    disabledAt: row.disabled_at || null,
  };

  if (includeSecret) {
    mapped.secretHash = row.secret_hash || null;
  }

  return mapped;
}

function getRunnerHostById(database, id, { includeSecret = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!id) {
      resolve(null);
      return;
    }

    database.get(
      `SELECT id, name, secret_hash, status, status_message, endpoint, last_seen_at, max_concurrency, timeout_ms, runner_version, runner_os, runner_platform, runner_arch, runner_uptime, runner_runtimes, minimum_host_version, admin_only, created_at, updated_at, disabled_at
         FROM runner_hosts
        WHERE id=?`,
      [id],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(mapRunnerHostRow(row, { includeSecret }));
      },
    );
  });
}

function listRunnerHosts(database) {
  return new Promise((resolve, reject) => {
    database.all(
      `SELECT id, name, status, status_message, endpoint, last_seen_at, max_concurrency, timeout_ms, runner_version, runner_os, runner_platform, runner_arch, runner_uptime, runner_runtimes, minimum_host_version, admin_only, created_at, updated_at, disabled_at
         FROM runner_hosts
        ORDER BY name COLLATE NOCASE ASC`,
      [],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows.map((row) => mapRunnerHostRow(row) || null).filter(Boolean));
      },
    );
  });
}

function createRunnerHostRecord(
  database,
  { id, name, secretHash, status = "pending", adminOnly = false },
) {
  const trimmedId = typeof id === "string" ? id.trim() : id;
  const hostId = trimmedId || uuidv4();
  const rawId = typeof hostId === "string" ? hostId : String(hostId);
  const finalId = rawId.trim();
  if (!finalId) {
    return Promise.reject(new Error("Runner host id is required"));
  }
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) {
    return Promise.reject(new Error("Runner host name is required"));
  }
  if (!secretHash) {
    return Promise.reject(new Error("Runner host secret hash is required"));
  }

  return new Promise((resolve, reject) => {
    database.run(
      `INSERT INTO runner_hosts (id, name, secret_hash, status, admin_only)
       VALUES (?, ?, ?, ?, ?)`,
      [finalId, trimmedName, secretHash, status, adminOnly ? 1 : 0],
      (err) => {
        if (err) {
          reject(err);
          return;
        }

        getRunnerHostById(database, finalId, { includeSecret: true })
          .then(resolve)
          .catch(reject);
      },
    );
  });
}

function updateRunnerHostStatus(database, id, updates = {}) {
  if (!id) {
    return Promise.reject(new Error("Runner host id is required"));
  }

  const fields = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(updates, "status")) {
    fields.push("status=?");
    values.push(updates.status || "pending");
  }

  if (Object.prototype.hasOwnProperty.call(updates, "statusMessage")) {
    fields.push("status_message=?");
    values.push(updates.statusMessage || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "endpoint")) {
    fields.push("endpoint=?");
    values.push(updates.endpoint || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "lastSeenAt")) {
    fields.push("last_seen_at=?");
    values.push(updates.lastSeenAt || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "maxConcurrency")) {
    const numericConcurrency = Number.parseInt(updates.maxConcurrency, 10);
    fields.push("max_concurrency=?");
    values.push(Number.isFinite(numericConcurrency) ? numericConcurrency : null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "timeoutMs")) {
    const numericTimeout = Number.parseInt(updates.timeoutMs, 10);
    fields.push("timeout_ms=?");
    values.push(Number.isFinite(numericTimeout) ? numericTimeout : null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "runnerVersion")) {
    fields.push("runner_version=?");
    values.push(updates.runnerVersion || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "runnerOs")) {
    fields.push("runner_os=?");
    values.push(updates.runnerOs || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "runnerPlatform")) {
    fields.push("runner_platform=?");
    values.push(updates.runnerPlatform || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "runnerArch")) {
    fields.push("runner_arch=?");
    values.push(updates.runnerArch || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "runnerUptime")) {
    const numericUptime = Number.parseInt(updates.runnerUptime, 10);
    fields.push("runner_uptime=?");
    values.push(Number.isFinite(numericUptime) && numericUptime >= 0 ? numericUptime : null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "runnerRuntimes")) {
    fields.push("runner_runtimes=?");
    values.push(serializeRunnerRuntimes(updates.runnerRuntimes));
  }

  if (Object.prototype.hasOwnProperty.call(updates, "minimumHostVersion")) {
    fields.push("minimum_host_version=?");
    values.push(updates.minimumHostVersion || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "adminOnly")) {
    fields.push("admin_only=?");
    values.push(normalizeDbBoolean(updates.adminOnly) ? 1 : 0);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "name")) {
    const trimmedName = typeof updates.name === "string" ? updates.name.trim() : "";
    if (!trimmedName) {
      return Promise.reject(new Error("Runner host name is required"));
    }
    fields.push("name=?");
    values.push(trimmedName);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "secretHash")) {
    const hashed = updates.secretHash;
    if (!hashed) {
      return Promise.reject(new Error("Runner host secret hash is required"));
    }
    fields.push("secret_hash=?");
    values.push(hashed);
  }

  if (updates.clearDisabledAt) {
    fields.push("disabled_at=NULL");
  }

  if (!fields.length) {
    return getRunnerHostById(database, id, { includeSecret: true });
  }

  fields.push("updated_at=CURRENT_TIMESTAMP");

  return new Promise((resolve, reject) => {
    database.run(
      `UPDATE runner_hosts SET ${fields.join(", ")} WHERE id=?`,
      [...values, id],
      (err) => {
        if (err) {
          reject(err);
          return;
        }

        getRunnerHostById(database, id, { includeSecret: true })
          .then(resolve)
          .catch(reject);
      },
    );
  });
}

function disableRunnerHost(database, id, { statusMessage } = {}) {
  if (!id) {
    return Promise.reject(new Error("Runner host id is required"));
  }

  return new Promise((resolve, reject) => {
    database.run(
      `UPDATE runner_hosts
          SET status='disabled',
              status_message=?,
              disabled_at=CURRENT_TIMESTAMP,
              updated_at=CURRENT_TIMESTAMP
        WHERE id=?`,
      [statusMessage || null, id],
      (err) => {
        if (err) {
          reject(err);
          return;
        }

        getRunnerHostById(database, id, { includeSecret: true })
          .then(resolve)
          .catch(reject);
      },
    );
  });
}

function deleteRunnerHost(database, id) {
  if (!id) {
    return Promise.reject(new Error("Runner host id is required"));
  }

  return new Promise((resolve, reject) => {
    database.run(
      `DELETE FROM runner_hosts WHERE id=?`,
      [id],
      function handleResult(err) {
        if (err) {
          reject(err);
          return;
        }

        resolve(this?.changes > 0);
      },
    );
  });
}

function hasHealthyRunnerHost(database, staleThresholdMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    database.get(
      `SELECT last_seen_at FROM runner_hosts
        WHERE status='healthy' AND disabled_at IS NULL
        ORDER BY last_seen_at DESC
        LIMIT 1`,
      [],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (!row || !row.last_seen_at) {
          resolve(false);
          return;
        }

        const lastSeen = Date.parse(row.last_seen_at);
        if (!Number.isFinite(lastSeen)) {
          resolve(false);
          return;
        }

        resolve(Date.now() - lastSeen <= staleThresholdMs);
      },
    );
  });
}

function ensureAdminAccount(database = db) {
  const computeDefaultHash = () => {
    try {
      return hashPassword(DEFAULT_ADMIN_PASSWORD);
    } catch (hashErr) {
      console.error("Failed to hash default admin password", hashErr);
      return null;
    }
  };

  return new Promise((resolve, reject) => {
    database.get(
      "SELECT id, password_hash, deleted_at, is_active, is_admin, must_change_password FROM users WHERE username=?",
      ["admin"],
      (err, row) => {
        if (err) {
          console.error("Failed to verify admin account", err);
          reject(err);
          return;
        }

        if (!row) {
          const passwordHash = computeDefaultHash();
          if (!passwordHash) {
            resolve();
            return;
          }

          database.run(
            `INSERT INTO users (id, username, password_hash, must_change_password, is_active, is_admin)
             VALUES (?, ?, ?, 1, 1, 1)`,
            [uuidv4(), "admin", passwordHash],
            (insertErr) => {
              if (insertErr) {
                console.error("Failed to create default admin account", insertErr);
                reject(insertErr);
                return;
              }
              resolve();
            },
          );
          return;
        }

        if (row.deleted_at) {
          const passwordHash = row.password_hash || computeDefaultHash();
          if (!passwordHash) {
            resolve();
            return;
          }

          database.run(
            `UPDATE users
               SET deleted_at=NULL,
                   is_active=1,
                   is_admin=1,
                   must_change_password=1,
                   password_hash=?
             WHERE id=?`,
            [passwordHash, row.id],
            (updateErr) => {
              if (updateErr) {
                console.error("Failed to restore default admin account", updateErr);
                reject(updateErr);
                return;
              }
              resolve();
            },
          );
          return;
        }

        const updates = [];
        const params = [];

        let mustChangePassword = normalizeDbBoolean(row.must_change_password);

        if (!row.password_hash) {
          const passwordHash = computeDefaultHash();
          if (!passwordHash) {
            resolve();
            return;
          }
          updates.push("password_hash=?");
          params.push(passwordHash);
          mustChangePassword = true;
        } else if (verifyPassword(DEFAULT_ADMIN_PASSWORD, row.password_hash)) {
          mustChangePassword = true;
        }

        if (!row.is_active) {
          updates.push("is_active=1");
        }

        if (!row.is_admin) {
          updates.push("is_admin=1");
        }

        if (mustChangePassword !== normalizeDbBoolean(row.must_change_password)) {
          updates.push("must_change_password=?");
          params.push(mustChangePassword ? 1 : 0);
        }

        if (updates.length > 0) {
          params.push(row.id);
          database.run(
            `UPDATE users SET ${updates.join(", ")} WHERE id=?`,
            params,
            (updateErr) => {
              if (updateErr) {
                console.error("Failed to update default admin account", updateErr);
                reject(updateErr);
                return;
              }
              resolve();
            },
          );
          return;
        }

        resolve();
      },
    );
  });
}

const schemaReady = new Promise((resolve, reject) => {
  initializeSchema(db);
  db.serialize(() => {
    db.get("SELECT 1", (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
})
  .then(() => ensureAdminAccount(db))
  .catch((err) => {
    console.error("Database initialization failed", err);
    throw err;
  });

module.exports = db;
module.exports.schemaReady = schemaReady;
module.exports.ensureAdminAccount = () => ensureAdminAccount(db);
module.exports.DB_PATH = DB_FILE;
module.exports.createRunnerHost = (options) => createRunnerHostRecord(db, options);
module.exports.getRunnerHostById = (id, options) => getRunnerHostById(db, id, options);
module.exports.listRunnerHosts = () => listRunnerHosts(db);
module.exports.updateRunnerHostStatus = (id, updates) =>
  updateRunnerHostStatus(db, id, updates);
module.exports.disableRunnerHost = (id, options) => disableRunnerHost(db, id, options);
module.exports.deleteRunnerHost = (id) => deleteRunnerHost(db, id);
module.exports.hasHealthyRunnerHost = (staleThresholdMs) =>
  hasHealthyRunnerHost(db, staleThresholdMs);
