import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { migrateD1, shellCommand } from "./d1.js";

const packagePath = "package.json";
const npmRegistry = "https://registry.npmjs.org";

function run(command, args, { inherit = true, failOnError = true } = {}) {
  const result = spawnSync(command, args, {
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && failOnError) process.exitCode = result.status || 1;
  return result;
}

function packageJson() {
  if (!existsSync(packagePath)) throw new Error("package.json was not found in the current directory.");
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function packageName() {
  return packageJson().name || "package";
}

function version() {
  return packageJson().version;
}

function assertClean() {
  const result = run("git", ["status", "--porcelain"], { inherit: false });
  if (result.status !== 0) throw new Error("Unable to inspect git status.");
  if (result.stdout.trim()) throw new Error("Working tree must be clean before a release.");
}

function output(command, args) {
  const result = run(command, args, { inherit: false, failOnError: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed.`);
  return result.stdout.trim();
}

function assertMainIsSynchronized() {
  const branch = output("git", ["branch", "--show-current"]);
  if (branch !== "main") throw new Error(`Releases must run from main (currently on ${branch || "detached HEAD"}).`);
  const fetched = run("git", ["fetch", "origin", "main", "--tags"]);
  if (fetched.status !== 0) throw new Error("Unable to fetch origin/main; release stopped before changing anything.");
  const local = output("git", ["rev-parse", "main"]);
  const remote = output("git", ["rev-parse", "origin/main"]);
  if (local !== remote) throw new Error("Local main does not match origin/main; push or reconcile it before releasing.");
}

function assertFlag(args, flag, message) {
  if (!args.includes(flag)) throw new Error(`${message} Re-run with ${flag}.`);
}

function npmVersion(name, currentVersion) {
  const result = run("npm", ["view", `${name}@${currentVersion}`, "version"], { inherit: false, failOnError: false });
  return result.status === 0 ? result.stdout.trim() : "";
}

function packageScope(name) {
  return name.startsWith("@") ? name.split("/", 1)[0] : "";
}

export function isNpmAuthenticationFailure(output = "") {
  return /\b(?:E401|ENEEDAUTH)\b|401\s+Unauthorized|auth(?:entication|entication token)?[^\n]*(?:required|invalid|expired)|not logged in|must be logged in/i.test(output);
}

function ensureNpmLogin(name) {
  console.log("Checking npm authentication for " + name + "...");
  const whoami = run("npm", ["whoami", "--registry", npmRegistry], { inherit: false, failOnError: false });
  if (whoami.status === 0 && whoami.stdout.trim()) {
    console.log("npm authentication OK (" + whoami.stdout.trim() + ").");
    return;
  }

  const failure = whoami.stdout + "\n" + whoami.stderr;
  if (!isNpmAuthenticationFailure(failure)) {
    throw new Error("Unable to verify npm authentication. Check " + npmRegistry + " and try again.");
  }

  const scope = packageScope(name);
  console.log("npm authentication is missing or invalid; starting npm login...");
  const loginArgs = ["login", "--registry", npmRegistry];
  if (scope) loginArgs.push("--scope", scope);
  const login = run("npm", loginArgs, { failOnError: false });
  if (login.status !== 0) throw new Error("npm login failed or was cancelled. Re-run the release after logging in.");

  const verified = run("npm", ["whoami", "--registry", npmRegistry], { inherit: false, failOnError: false });
  if (verified.status !== 0 || !verified.stdout.trim()) {
    throw new Error("npm login completed, but npm authentication could not be verified. Run npm whoami and try again.");
  }
  console.log("npm authentication OK (" + verified.stdout.trim() + ").");
}

function tagExists(tag) {
  const local = run("git", ["tag", "--list", tag], { inherit: false, failOnError: false });
  if (local.status === 0 && local.stdout.trim()) return true;
  const remote = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { inherit: false, failOnError: false });
  return remote.status === 0 && Boolean(remote.stdout.trim());
}

export function devCommand({ hasScript, args = [] }) {
  const forwarded = args[0] === "--" ? args.slice(1) : args;
  const command = hasScript ? ["npm", "run", "dev", ...forwarded] : ["npx", "wrangler", "dev", ...forwarded];
  return ["op", "run", "--env-file=.env.dev", "--", ...command];
}

export function lastProdRefresh({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.CF_GENAI_LAST_PROD_REFRESH) return env.CF_GENAI_LAST_PROD_REFRESH;
  try {
    return readFileSync(join(cwd, ".cf-genai-last-prod-refresh"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function printDevDataStatus(options = {}) {
  const refreshed = lastProdRefresh(options);
  console.log("Last production data refresh: " + (refreshed || "unknown"));
  console.log("To refresh data from prod run: cf-genai d1 refresh local");
}

function applyDevMigrations(env = process.env) {
  if (!existsSync("migrations")) return;
  console.log("Applying local D1 migrations...");
  migrateD1({
    target: "local",
    database: env.CF_GENAI_DATABASE || "DB",
    options: {
      config: env.CF_GENAI_WRANGLER_CONFIG || "wrangler.jsonc",
      wranglerCommand: ["op", "run", "--env-file=.env.dev", "--", ...shellCommand(env.CF_GENAI_WRANGLER || "npx wrangler")],
      env,
    },
  });
}

export function runProjectCommand(command, args = []) {
  if (command === "check") return run("npm", ["run", "check"]);
  if (command === "test") return run("npm", ["test"]);
  if (command === "build" || command === "ci") return run("npm", ["run", "build"]);
  if (command === "dev") {
    printDevDataStatus();
    applyDevMigrations();
    const scripts = packageJson().scripts || {};
    const [program, ...programArgs] = devCommand({ hasScript: Boolean(scripts.dev), args });
    return run(program, programArgs);
  }
  if (command === "release" && args.includes("--first")) return publishFirst(args);
  if (command === "release") return release(args);
  if (command === "status") return releaseStatus();
  return null;
}

function publishFirst(args) {
  assertFlag(args, "--confirm", "Initial npm publishing is irreversible and requires explicit human confirmation.");
  assertClean();
  assertMainIsSynchronized();
  const name = packageName();
  const currentVersion = version();
  ensureNpmLogin(name);
  if (npmVersion(name, currentVersion)) throw new Error(name + "@" + currentVersion + " is already published.");
  console.log("Publishing " + name + "@" + currentVersion + " to npm...");
  return run("npm", ["publish", "--access", "public", "--provenance=false"]);
}

function release(args) {
  const dryRun = args.includes("--dry-run");
  if (!dryRun) assertFlag(args, "--confirm", "A release requires explicit human confirmation because it creates a commit, tag, and npm publish trigger.");
  assertClean();
  assertMainIsSynchronized();
  const name = packageName();
  let currentVersion = version();
  const typeIndex = args.indexOf("--type");
  const type = typeIndex >= 0 ? args[typeIndex + 1] : "patch";
  if (!["patch", "minor", "major"].includes(type)) throw new Error("--type must be patch, minor, or major.");
  const consumed = Boolean(npmVersion(name, currentVersion) || tagExists(`v${currentVersion}`));
  if (dryRun) {
    console.log(`Dry run: ${name}@${currentVersion}${consumed ? ` would bump ${type}` : " is ready to release"}. Main is synchronized and no changes were made.`);
    return;
  }
  if (consumed) {
    const bumped = run("npm", ["version", type, "--no-git-tag-version"]);
    if (bumped.status !== 0) return bumped;
    currentVersion = version();
  }
  const staged = run("git", ["add", "package.json", "package-lock.json"]);
  if (staged.status !== 0) return staged;
  const stagedChanges = spawnSync("git", ["diff", "--cached", "--quiet"], { stdio: "ignore" });
  if (stagedChanges.status !== 0) {
    const committed = run("git", ["commit", "-m", `Release ${name} v${currentVersion}`]);
    if (committed.status !== 0) return committed;
  }
  const pushedMain = run("git", ["push", "origin", "main"]);
  if (pushedMain.status !== 0) return pushedMain;
  const localHead = output("git", ["rev-parse", "HEAD"]);
  const remoteHead = output("git", ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0];
  if (localHead !== remoteHead) throw new Error("origin/main could not be verified at the release commit; tag was not created.");
  const tagged = run("git", ["tag", `v${currentVersion}`]);
  if (tagged.status !== 0) return tagged;
  return run("git", ["push", "origin", `refs/tags/v${currentVersion}`]);
}

function releaseStatus() {
  const name = packageName();
  const currentVersion = version();
  const published = npmVersion(name, currentVersion);
  console.log(`${name}@${currentVersion}: ${published === currentVersion ? "published" : "not published"}`);
  console.log(`tag v${currentVersion}: ${tagExists(`v${currentVersion}`) ? "exists" : "missing"}`);
}
