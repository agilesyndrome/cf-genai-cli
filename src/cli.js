import { backupD1, checkConfig, checkD1, migrateD1, refreshLocalD1, refreshStagingD1, restoreD1, statusD1 } from "./d1.js";
import { runUserCommand } from "./users.js";
import { runOperationalCommand } from "./operations.js";
import { runProjectCommand } from "./project.js";
import { runVersionCommand } from "./version.js";
import { siteStatus } from "./status.js";

const usage = `Usage:
  cf-genai check|test|build|ci
  cf-genai dev [options]
  cf-genai release [--confirm] [--dry-run] [--type patch|minor|major]
    cf-genai status [--env local|staging|production] [--json]
  cf-genai version
  cf-genai d1 refresh|backup|restore|migrate|status|check local|staging|production [options]
  cf-genai admin status|features|users|scopes|groups|healthchecks|circuit-breakers [options]
  cf-genai config check [options]
  cf-genai user list|get|update [username] [options]

Options:
  --database NAME             D1 binding or database name (default: DB)
  --production-database NAME  Production D1 binding or database name
  --production-env NAME       Wrangler production environment (default: none)
  --staging-env NAME          Wrangler staging environment (default: staging)
  --config PATH               Wrangler config path (default: wrangler.jsonc)
  --env VALUE                 Environment alias: local, staging, or prod
  --output PATH               Backup output file
  --file PATH                 Restore input file
  --wrangler COMMAND          Wrangler command (default: npx wrangler)
  --yes                       Confirm a remote staging refresh
  --confirm-production        Explicitly permit production migration or breaker changes
  --confirm                    Confirm a destructive or release operation
  --first                      Release the current version as the initial publish
  --confirm-release             Compatibility alias for --confirm
  --confirm-publish             Compatibility alias for --confirm --first
  --dry-run                    Show release checks without changing Git or npm
  --json                      Return machine-readable output
  --help                      Show this help
`;

function splitCommand(value = "npx wrangler") {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(["'])(.*)\1$/, "$2")) ?? ["npx", "wrangler"];
}

function parseOptions(args, env = process.env) {
  const options = {
    config: env.CF_GENAI_WRANGLER_CONFIG || "wrangler.jsonc",
    database: env.CF_GENAI_DATABASE || "DB",
    productionEnv: env.CF_GENAI_PRODUCTION_ENV || "",
    stagingEnv: env.CF_GENAI_STAGING_ENV || "staging",
    wranglerCommand: splitCommand(env.CF_GENAI_WRANGLER || "npx wrangler"),
    yes: false,
    confirmProduction: false,
    target: env.CF_GENAI_TARGET || "local",
    roles: undefined,
    scopes: undefined,
    groups: undefined,
    json: false,
  };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { ...options, help: true, positional };
    if (arg === "--yes") options.yes = true;
    else if (arg === "--json") options.json = true
    else if (arg === "--confirm-production") options.confirmProduction = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const names = {
        database: "database", "production-database": "productionDatabase",
        "production-env": "productionEnv", "staging-env": "stagingEnv",
        config: "config", wrangler: "wrangler", target: "target", env: "target", roles: "roles", scopes: "scopes", groups: "groups", output: "output", file: "file",
      };
      const optionName = names[key];
      if (!optionName) throw new Error(`Unknown option: ${arg}`);
      const value = inline ?? args[++index];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      if (optionName === "wrangler") options.wranglerCommand = splitCommand(value);
      else options[optionName] = value;
    } else positional.push(arg);
  }
  return { ...options, positional, productionDatabase: options.productionDatabase || options.database };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args[0]?.includes(":")) { const [domain, action] = args[0].split(":", 2); if (["user", "healthcheck", "healthchecks", "circuit-breaker", "circuit-breakers", "circuit"].includes(domain)) args = [domain, action, ...args.slice(1)]; }
  if (args[0] === "version") return runVersionCommand();
  const projectCommand = args[0];
  if (["check", "test", "build", "ci", "dev", "release", "publish:first"].includes(projectCommand)) {
    const result = runProjectCommand(projectCommand, args.slice(1));
    if (result === null) throw new Error(`Unknown command.\n\n${usage}`);
    return result;
  }
  const options = parseOptions(args, env);
  if (options.positional[0] === "status") return siteStatus(options);
  if (options.help || options.positional.length === 0) {
    console.log(usage);
    return;
  }
  let [domain, action, target] = options.positional;
  if (domain === "admin") { const adminAction = { user: "users", healthcheck: "healthchecks", "circuit-breaker": "circuit-breakers", circuit: "circuit-breakers" }[action] || action; if (["local", "staging", "prod", "production"].includes(target)) options.target = target === "prod" ? "production" : target; if (["healthchecks", "circuit-breakers"].includes(adminAction)) return runOperationalCommand({ domain: adminAction, action: options.positional[2] || "list", identifier: options.positional[3], value: options.positional[4], options }); return runOperationalCommand({ domain: "admin", action: adminAction, identifier: options.positional[3], value: options.positional[4], options }); }
  if (domain === "backup" || domain === "restore") { target = action || options.target; action = domain; return runD1FileCommand(action, target, options); }
  if (domain === "user") return runUserCommand({ action, username: target, options });
  if (["healthcheck", "healthchecks", "circuit-breaker", "circuit-breakers", "circuit"].includes(domain)) return runOperationalCommand({ domain, action, identifier: target, value: options.positional[3], options });
  if (domain === "config" && action === "check") return checkConfig(options);
  if (domain !== "d1" || !["refresh", "backup", "restore", "migrate", "status", "check"].includes(action)) throw new Error(`Unknown command.\n\n${usage}`);
  target = target === "prod" ? "production" : target;
  if (!["local", "staging", "production"].includes(target)) throw new Error("Target must be local, staging, or production.");
  if (action === "backup" || action === "restore") return runD1FileCommand(action, target, options);
  if (action === "refresh") {
    if (target === "staging" && !options.yes) throw new Error("Staging refresh replaces remote data; rerun with --yes.");
    if (target === "local") return refreshLocalD1({ database: options.database, productionDatabase: options.productionDatabase, options });
    if (target === "staging") return refreshStagingD1({ database: options.database, productionDatabase: options.productionDatabase, options });
    throw new Error(`Unknown command.\n\n${usage}`);
  }
  if (action === "migrate" && target === "production" && !options.confirmProduction) throw new Error("Production migration requires --confirm-production.");
  if (action === "migrate") return migrateD1({ target, database: options.database, options });
  if (action === "status") return statusD1({ target, database: options.database, options });
  return checkD1({ target, database: options.database, options });
}

function runD1FileCommand(action, target, options) {
  if (action === "backup") return backupD1({ target, database: options.database, options });
  return restoreD1({ target, database: options.database, options });
}

export { parseOptions, usage };
