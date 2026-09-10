import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const INTERNAL_TABLE_SQL = `
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '_cf_%'
  AND name <> 'd1_migrations'
ORDER BY name;
`;

export function shellCommand(value = "npx wrangler") {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(["'])(.*)\1$/, "$2")) ?? ["npx", "wrangler"];
}

export function targetArgs(target, options = {}) {
  if (target === "local") return ["--local"];
  const args = ["--remote"];
  const environment = target === "staging" ? options.stagingEnv : options.productionEnv;
  if (environment) args.push("--env", environment);
  return args;
}

export function extractRows(value) {
  if (Array.isArray(value)) return value.flatMap(extractRows);
  if (!value || typeof value !== "object") return [];
  const rows = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "results" && Array.isArray(child)) rows.push(...child);
    rows.push(...extractRows(child));
  }
  return rows;
}

export function parseJsonRows(output) {
  try {
    return extractRows(JSON.parse(output));
  } catch {
    throw new Error("Wrangler returned invalid JSON while inspecting D1.");
  }
}

export function tableNamesFromJson(output) {
  return parseJsonRows(output)
    .map((row) => row?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
}

export function clearSql(tableNames) {
  const identifiers = tableNames.map((name) => `"${name.replaceAll('"', '""')}"`);
  return [
    "PRAGMA defer_foreign_keys = ON;",
    ...identifiers.map((name) => `DELETE FROM ${name};`),
    "PRAGMA defer_foreign_keys = OFF;",
    "",
  ].join("\n");
}

export function stripInternalRows(sql) {
  return sql
    .split("\n")
    .filter((line) => !/^\s*INSERT\s+INTO\s+["`]?((d1_migrations)|(sqlite_[^"`\s]*)|(_cf_[^"`\s]*))["`]?/i.test(line))
    .join("\n");
}

function run(wrangler, args, options = {}) {
  const result = spawnSync(wrangler[0], [...wrangler.slice(1), ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${wrangler.join(" ")} exited with status ${result.status ?? "unknown"}.`);
  return result.stdout ?? "";
}

function execute(wrangler, database, target, sqlFile, options) {
  run(wrangler, ["d1", "execute", database, ...targetArgs(target, options), "--file", sqlFile, "--yes", "--config", options.config], options);
}

function executeJson(wrangler, database, target, command, options) {
  return run(wrangler, ["d1", "execute", database, ...targetArgs(target, options), "--command", command, "--json", "--config", options.config], { ...options, capture: true });
}

function migrations(wrangler, database, target, options) {
  run(wrangler, ["d1", "migrations", "apply", database, ...targetArgs(target, options), "--config", options.config], options);
}

async function refreshD1(target, { database, productionDatabase, options }) {
  const directory = await mkdtemp(join(tmpdir(), "cf-genai-d1-refresh-"));
  const exportPath = join(directory, "production-data.sql");
  const importPath = join(directory, "application-data.sql");
  try {
    run(options.wranglerCommand, [
      "d1", "export", productionDatabase, "--remote",
      ...(options.productionEnv ? ["--env", options.productionEnv] : []),
      "--no-schema", "--output", exportPath, "--skip-confirmation", "--config", options.config,
    ], options);
    migrations(options.wranglerCommand, database, target, options);
    const tableOutput = executeJson(options.wranglerCommand, database, target, INTERNAL_TABLE_SQL, options);
    const tables = tableNamesFromJson(tableOutput);
    if (tables.length === 0) throw new Error(`No application tables found in ${target} D1 database.`);
    const exported = await readFile(exportPath, "utf8");
    await writeFile(importPath, `${clearSql(tables)}${stripInternalRows(exported)}`);
    execute(options.wranglerCommand, database, target, importPath, options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function refreshLocalD1(args) {
  return refreshD1("local", args);
}

export function refreshStagingD1(args) {
  return refreshD1("staging", args);
}

export function migrateD1({ target, database, options }) {
  migrations(options.wranglerCommand, database, target, options);
}

export function statusD1({ target, database, options }) {
  if (target !== "local") {
    run(options.wranglerCommand, ["d1", "info", database, ...(target === "staging" && options.stagingEnv ? ["--env", options.stagingEnv] : []), ...(target === "production" && options.productionEnv ? ["--env", options.productionEnv] : []), "--config", options.config], options);
    return;
  }
  const output = executeJson(options.wranglerCommand, database, target, "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY type, name;", options);
  console.log(output);
}

export function checkD1({ target, database, options }) {
  const output = executeJson(options.wranglerCommand, database, target, "PRAGMA foreign_key_check; PRAGMA integrity_check;", options);
  const rows = parseJsonRows(output);
  const failures = rows.filter((row) => !(Object.values(row ?? {}).length === 1 && Object.values(row)[0] === "ok"));
  if (failures.length > 0) throw new Error(`D1 integrity checks failed: ${JSON.stringify(failures)}`);
  console.log(`${target} D1 integrity checks passed.`);
}

export function checkConfig(options) {
  run(options.wranglerCommand, ["deploy", "--dry-run", "--config", options.config], options);
}
