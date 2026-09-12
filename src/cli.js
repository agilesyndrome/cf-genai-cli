import { checkConfig, checkD1, migrateD1, refreshLocalD1, refreshStagingD1, statusD1 } from "./d1.js";
import { runUserCommand } from "./users.js";
import { runOperationalCommand } from "./operations.js";
import { runProjectCommand } from "./project.js";
import { runVersionCommand } from "./version.js";

const usage = `Usage:
  cf-genai check|test|build|ci
  cf-genai dev [options]
  cf-genai release [--confirm-release] [--dry-run] [--type patch|minor|major]
  cf-genai publish:first --confirm-publish
  cf-genai status
  cf-genai version
  cf-genai d1 refresh local|staging [options]
  cf-genai d1 migrate local|staging|production [options]
  cf-genai d1 status local|staging|production [options]
  cf-genai d1 check local|staging|production [options]
  cf-genai config check [options]
  cf-genai user list|get|update [username] [options]
  cf-genai healthcheck:list|get [id] [--env local|staging|prod]
  cf-genai circuit-breaker:list|get|set [id] [state] [--env local|staging|prod]

Options:
  --database NAME             D1 binding or database name (default: DB)
  --production-database NAME  Production D1 binding or database name
  --production-env NAME       Wrangler production environment (default: none)
  --staging-env NAME          Wrangler staging environment (default: staging)
  --config PATH               Wrangler config path (default: wrangler.jsonc)
  --env VALUE                 D1 environment alias: local, staging, or prod
  --wrangler COMMAND          Wrangler command (default: npx wrangler)
  --yes                       Confirm a remote staging refresh
  --confirm-production        Explicitly permit production migration or breaker changes
  --confirm-release            Confirm commit/tag/publish release operations
  --confirm-publish            Confirm initial direct npm publishing
  --dry-run                    Show release checks without changing Git or npm
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
  };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { ...options, help: true, positional };
    if (arg === "--yes") options.yes = true;
    else if (arg === "--confirm-production") options.confirmProduction = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const names = {
        database: "database", "production-database": "productionDatabase",
        "production-env": "productionEnv", "staging-env": "stagingEnv",
        config: "config", wrangler: "wrangler", target: "target", env: "target", roles: "roles", scopes: "scopes", groups: "groups",
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
  if (args[0]?.includes(":")) { const [domain, action] = args[0].split(":", 2); if (["user", "healthcheck", "circuit-breaker", "circuit"].includes(domain)) args = [domain, action, ...args.slice(1)]; }
  if (args[0] === "version") return runVersionCommand();
  const projectCommand = args[0];
  if (["check", "test", "build", "ci", "dev", "release", "publish:first", "status"].includes(projectCommand)) {
    const result = runProjectCommand(projectCommand, args.slice(1));
    if (result === null) throw new Error(`Unknown command.\n\n${usage}`);
    return result;
  }
  const options = parseOptions(args, env);
  if (options.help || options.positional.length === 0) {
    console.log(usage);
    return;
  }
  const [domain, action, target] = options.positional;
  if (domain === "user") return runUserCommand({ action, username: target, options });
  if (["healthcheck", "circuit-breaker", "circuit"].includes(domain)) return runOperationalCommand({ domain, action, identifier: target, value: options.positional[3], options });
  if (domain === "config" && action === "check") return checkConfig(options);
  if (domain !== "d1" || !["refresh", "migrate", "status", "check"].includes(action)) throw new Error(`Unknown command.\n\n${usage}`);
  if (!["local", "staging", "production"].includes(target)) throw new Error("Target must be local, staging, or production.");
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

export { parseOptions, usage };
