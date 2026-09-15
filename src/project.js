import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { migrateD1, shellCommand } from "./d1.js";
import { compareVersions } from "./version.js";

const packagePath = "package.json";
const basePackageName = "@agilesyndrome/cf-genai-base";
const npmRegistry = "https://registry.npmjs.org";
const releaseStatusCommandTimeout = 10_000;
const DATA_ACCESS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const DATA_ACCESS_DIRECT = /\b(?:env|environment)\s*\.\s*DB\s*\.\s*prepare\s*\(|\bDB\s*\.\s*prepare\s*\(/;

function run(command, args, { inherit = true, failOnError = true, timeout, env } = {}) {
  const result = spawnSync(command, args, {
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...(timeout === undefined ? {} : { timeout }),
    ...(env === undefined ? {} : { env }),
  });
  if (result.error && failOnError) throw result.error;
  if (result.status !== 0 && failOnError) process.exitCode = result.status || 1;
  return result;
}

function packageJson() {
  if (!existsSync(packagePath)) throw new Error("package.json was not found in the current directory.");
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function packageMigrations(packageName, cwd = process.cwd()) {
  const directory = join(cwd, "node_modules", ...packageName.split("/"), "migrations");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort().map((name) => ({ name, path: join(directory, name), sql: readFileSync(join(directory, name), "utf8") }));
}

function migrationHash(sql) { return createHash("sha256").update(sql).digest("hex").slice(0, 12); }

export function vendorPackageMigrations({ packageName = basePackageName, version, cwd = process.cwd() } = {}) {
  const destination = join(cwd, "migrations");
  if (!existsSync(destination)) mkdirSync(destination, { recursive: true });
  const sources = packageMigrations(packageName, cwd);
  if (!sources.length) return { packageName, version, added: [], skipped: [] };
  const existing = readdirSync(destination).filter((name) => /^\d+_.+\.sql$/.test(name));
  const used = new Set(existing);
  const sourceText = existing.map((name) => readFileSync(join(destination, name), "utf8")).join("\n");
  let next = Math.max(0, ...existing.map((name) => Number(name.match(/^\d+/)?.[0] || 0))) + 1;
  const added = [];
  const skipped = [];
  for (const source of sources) {
    const marker = `cf-genai-source: ${packageName}/${source.name}`;
    if (sourceText.includes(marker)) { skipped.push(source.name); continue; }
    let target;
    do { target = `${String(next++).padStart(4, "0")}_${packageName.split("/").at(-1).replaceAll("-", "_")}_${source.name.replace(/^\d+_/, "")}`; } while (used.has(target));
    const content = `-- ${marker}@${version || "installed"} sha256:${migrationHash(source.sql)}\n${source.sql.trim()}\n`;
    writeFileSync(join(destination, target), content);
    used.add(target);
    added.push(target);
  }
  return { packageName, version, added, skipped };
}

function upgradePackage(args = []) {
  const target = args[0] === "base" ? basePackageName : args[0];
  if (target !== basePackageName) throw new Error("Only the base package can be upgraded with this command: cf-genai upgrade base <latest|VERSION>.");
  const requested = args[1] || "latest";
  if (args.length > 2) throw new Error("Upgrade accepts one package version: cf-genai upgrade base <latest|VERSION>.");
  const result = run("npm", ["install", `${basePackageName}@${requested}`], { failOnError: false });
  if (result.status !== 0) throw new Error("npm install failed; no package migrations were copied.");
  const installed = packageJson().dependencies?.[basePackageName] || packageJson().devDependencies?.[basePackageName] || requested;
  const migrationResult = vendorPackageMigrations({ packageName: basePackageName, version: installed });
  console.log(`Upgraded ${basePackageName} to ${installed}.`);
  console.log(`Package migrations added: ${migrationResult.added.length}; already vendored: ${migrationResult.skipped.length}.`);
  for (const name of migrationResult.added) console.log(`  + migrations/${name}`);
  return migrationResult;
}

function packageDependency(packageMetadata, name) {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .map((section) => packageMetadata[section]?.[name])
    .find((value) => value !== undefined) || null;
}

export function baseDependencyVersion(packageMetadata = {}) {
  if (packageMetadata.name === basePackageName) return packageMetadata.version || null;
  const spec = packageDependency(packageMetadata, basePackageName);
  if (!spec) return null;
  const match = String(spec).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

function isCfGenaiProject(cwd) {
  if (!existsSync(join(cwd, packagePath))) return false;
  const pkg = JSON.parse(readFileSync(join(cwd, packagePath), "utf8"));
  const name = pkg.name || "";
  if (name === "@agilesyndrome/cf-genai-base") return false;
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
  return name.startsWith("@agilesyndrome/cf-genai-") || name.startsWith("cf-genai-") || Boolean(dependencies["@agilesyndrome/cf-genai-base"]);
}

function sourceFiles(directory, files = []) {
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", ".wrangler", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, files);
    else if (DATA_ACCESS_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) files.push(path);
  }
  return files;
}

export function dataAccessLint({ cwd = process.cwd() } = {}) {
  if (!isCfGenaiProject(cwd)) return { skipped: true, violations: [] };
  const roots = ["src", "app", "apps", "functions", "workers", "server"].map((root) => join(cwd, root)).filter((root) => existsSync(root));
  const files = (roots.length ? roots : [cwd]).flatMap((root) => sourceFiles(root));
  const violations = files
    .filter((path) => !path.split(/[\\/]/).includes("tests"))
    .flatMap((path) => String(readFileSync(path, "utf8")).split(/\r?\n/).flatMap((line, index) => DATA_ACCESS_DIRECT.test(line) ? [{ path, line: index + 1, text: line.trim() }] : []));
  if (violations.length) {
    const details = violations.map((item) => `  ${item.path}:${item.line}: ${item.text}`).join("\n");
    throw new Error(`Direct D1 access is not allowed in cf-genai domain source. Use state.data scoped readers instead.\n${details}`);
  }
  return { skipped: false, violations };
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

function npmVersionState(name, requestedVersion) {
  const result = run("npm", ["view", `${name}@${requestedVersion}`, "version", "--json", "--registry", npmRegistry], { inherit: false, failOnError: false });
  if (result.status === 0) {
    let published = result.stdout.trim();
    try { published = JSON.parse(published); } catch { /* npm may return an unquoted version */ }
    return { exists: published === requestedVersion, version: published || null };
  }
  if (/E404|not found/i.test(`${result.stdout}\n${result.stderr}`)) return { exists: false, version: null };
  throw new Error(`Unable to verify whether ${name}@${requestedVersion} is published.`);
}

function npmPackageExists(name) {
  const result = run("npm", ["view", name, "name", "--json", "--registry", npmRegistry], { inherit: false, failOnError: false });
  if (result.status === 0) return Boolean(result.stdout.trim());
  if (/E404|not found/i.test(`${result.stdout}\n${result.stderr}`)) return false;
  throw new Error(`Unable to verify whether ${name} exists on npm.`);
}

export function normalizeReleaseVersion(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)$/);
  if (!match) throw new Error("--version must be a major.minor version such as 4.1; patch is assigned as .0.");
  return `${Number(match[1])}.${Number(match[2])}.0`;
}

function requestedReleaseVersion(args = []) {
  const index = args.findIndex((arg) => arg === "--version" || arg.startsWith("--version="));
  if (index < 0) return null;
  const raw = args[index].includes("=") ? args[index].split("=", 2)[1] : args[index + 1];
  if (raw === undefined || raw.startsWith("--")) throw new Error("--version requires a major.minor value.");
  return normalizeReleaseVersion(raw);
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

function remoteRepository() {
  const remote = output("git", ["remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error("origin does not point to a GitHub repository.");
  return `${match[1]}/${match[2]}`;
}

function addNpmTrust(name) {
  const workflow = ".github/workflows/publish.yml";
  if (!existsSync(workflow)) throw new Error(`Cannot configure npm trust: ${workflow} was not found.`);
  const npmVersionResult = run("npm", ["--version"], { inherit: false, failOnError: false });
  const npmVersionOutput = npmVersionResult.stdout?.trim() || "";
  if (npmVersionResult.status !== 0 || compareVersions(npmVersionOutput, "11.15.0") < 0) {
    throw new Error(`npm trust requires npm 11.15.0 or newer (found ${npmVersionOutput || "unknown"}).`);
  }
  const trust = run("npm", [
    "trust", "github", name,
    "--file", "publish.yml",
    "--repo", remoteRepository(),
    "--allow-publish",
    "--yes",
    "--registry", npmRegistry,
  ], { failOnError: false });
  if (trust.status !== 0) {
    throw new Error("Unable to configure npm Trusted Publishing. Confirm that the package exists, your npm account has 2FA enabled, and you have package write access.");
  }
  return trust;
}

export function releaseWaitMinutes(args = []) {
  const index = args.findIndex((arg) => arg === "--wait" || arg.startsWith("--wait="));
  if (index < 0) return 5;
  const raw = args[index].includes("=") ? args[index].split("=", 2)[1] : args[index + 1];
  if (raw === undefined || raw.startsWith("--")) throw new Error("--wait requires a number of minutes.");
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("--wait must be a non-negative number of minutes.");
  return minutes;
}

export function releaseStatusShouldContinue(checks, now, deadline) {
  if (now >= deadline) return false;
  if (checks.github_actions.state === "failed") return false;
  if (checks.github_actions.state === "unavailable") return !["published", "unavailable"].includes(checks.npm.state);
  return !(checks.github_actions.state === "passed" && checks.npm.state === "published");
}

export function releaseStatusDot(state, ready = false) {
  if (ready || ["clean", "yes", "present and correct", "passed", "published", "ready"].includes(state)) return "🟢";
  if (["dirty", "no", "missing or incorrect", "failed", "unavailable", "not ready"].includes(state)) return "🔴";
  return "🟡";
}

function releaseTagState(tag) {
  const local = run("git", ["rev-parse", `refs/tags/${tag}`], { inherit: false, failOnError: false });
  // Do not allow Git to wait for credentials in non-interactive images or CI.
  // A remote/network failure is a status result, not a reason to block the CLI.
  const remote = run("git", ["ls-remote", "origin", `refs/tags/${tag}`], {
    inherit: false,
    failOnError: false,
    timeout: releaseStatusCommandTimeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const localSha = local.status === 0 ? local.stdout.trim() : "";
  const remoteSha = remote.status === 0 ? remote.stdout.trim().split(/\s+/)[0] : "";
  return { present: Boolean(localSha && remoteSha), local_sha: localSha || null, remote_sha: remoteSha || null, matches: Boolean(localSha && remoteSha && localSha === remoteSha) };
}

function gitReleaseState() {
  const clean = run("git", ["status", "--porcelain"], { inherit: false, failOnError: false });
  const branch = run("git", ["branch", "--show-current"], { inherit: false, failOnError: false });
  const head = run("git", ["rev-parse", "HEAD"], { inherit: false, failOnError: false });
  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { inherit: false, failOnError: false });
  const upstreamHead = upstream.status === 0 ? run("git", ["rev-parse", upstream.stdout.trim()], { inherit: false, failOnError: false }) : null;
  const headSha = head.status === 0 ? head.stdout.trim() : "";
  const remoteSha = upstreamHead?.status === 0 ? upstreamHead.stdout.trim() : "";
  return { clean: clean.status === 0 && !clean.stdout.trim(), branch: branch.status === 0 ? branch.stdout.trim() : null, pushed: Boolean(headSha && remoteSha && headSha === remoteSha), head_sha: headSha || null, remote_sha: remoteSha || null };
}

function githubActionsState(repository, commit, timeout) {
  const result = run("gh", ["run", "list", "--repo", repository, "--workflow", "publish.yml", "--commit", commit, "--limit", "100", "--json", "status,conclusion,databaseId,displayTitle,workflowName,url,headSha"], { inherit: false, failOnError: false, timeout });
  if (result.status !== 0) return { state: "unavailable", runs: [], error: (result.stderr || result.stdout || "GitHub Actions could not be queried.").trim() };
  let runs;
  try { runs = JSON.parse(result.stdout || "[]"); } catch { return { state: "unavailable", runs: [], error: "GitHub Actions returned invalid JSON." }; }
  if (!runs.length) return { state: "pending", runs: [] };
  const failed = runs.filter((item) => item.status === "completed" && item.conclusion !== "success");
  const running = runs.filter((item) => item.status !== "completed");
  return { state: failed.length ? "failed" : running.length ? "running" : "passed", runs };
}

function npmReleaseState(name, currentVersion, timeout) {
  const result = run("npm", ["view", `${name}@${currentVersion}`, "version", "--json", "--registry", npmRegistry], { inherit: false, failOnError: false, timeout });
  if (result.status === 0) {
    let published = result.stdout.trim();
    try { published = JSON.parse(published); } catch { /* npm may return an unquoted version */ }
    return { state: published === currentVersion ? "published" : "not_published", version: published || null };
  }
  return { state: /E404|not found/i.test(`${result.stdout}\n${result.stderr}`) ? "not_published" : "unavailable", version: null, error: (result.stderr || result.stdout || "npm could not be queried.").trim() };
}

function baseReleaseState(packageMetadata, timeout) {
  const configured = baseDependencyVersion(packageMetadata);
  const spec = packageMetadata.name === basePackageName ? packageMetadata.version : packageDependency(packageMetadata, basePackageName);
  if (!spec) return { state: "not_declared", version: null, latest: null };
  if (!configured) return { state: "unavailable", version: null, latest: null, spec, error: `Could not determine a version from ${basePackageName}: ${spec}` };
  const result = run("npm", ["view", basePackageName, "version", "--json", "--registry", npmRegistry], { inherit: false, failOnError: false, timeout });
  if (result.status !== 0) return { state: "unavailable", version: configured, latest: null, spec, error: (result.stderr || result.stdout || "npm could not be queried.").trim() };
  let latest = result.stdout.trim();
  try { latest = JSON.parse(latest); } catch { /* npm may return an unquoted version */ }
  if (!latest) return { state: "unavailable", version: configured, latest: null, spec };
  const outdated = compareVersions(latest, configured) > 0;
  return { state: outdated ? "outdated" : "current", version: configured, latest, spec, ...(outdated ? { upgrade: "cf-genai upgrade base latest" } : {}) };
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
  if (command === "check") { dataAccessLint(); return run("npm", ["run", "check"]); }
  if (command === "lint") { if (args.length && args[0] !== "data-access") throw new Error("Unknown lint target. Use data-access."); return dataAccessLint(); }
  if (command === "ci:lint") { dataAccessLint(); return run("npm", ["run", "check"]); }
  if (command === "test") return run("npm", ["test"]);
  if (command === "build" || command === "ci") return run("npm", ["run", "build"]);
  if (command === "dev") {
    printDevDataStatus();
    applyDevMigrations();
    const scripts = packageJson().scripts || {};
    const [program, ...programArgs] = devCommand({ hasScript: Boolean(scripts.dev), args });
    return run(program, programArgs);
  }
  if (command === "upgrade") return upgradePackage(args);
  if (command === "release" && args.includes("--first")) return publishFirst(args);
  if (command === "release" && args.includes("--add-trust")) return addTrust(args);
  if (command === "release") return release(args);
  if (command === "release-status") return releaseStatus(args);
  return null;
}

function publishFirst(args) {
  if (args.some((arg) => arg === "--version" || arg.startsWith("--version="))) throw new Error("--version is only supported by the normal release command, not --first.");
  assertFlag(args, "--confirm", "Initial npm publishing is irreversible and requires explicit human confirmation.");
  assertClean();
  if (!args.includes("--bypass-lint")) runProjectCommand("ci:lint");
  assertMainIsSynchronized();
  const name = packageName();
  const currentVersion = version();
  ensureNpmLogin(name);
  if (npmVersion(name, currentVersion)) throw new Error(name + "@" + currentVersion + " is already published.");
  console.log("Publishing " + name + "@" + currentVersion + " to npm...");
  const published = run("npm", ["publish", "--access", "public", "--provenance=false"]);
  if (published.status !== 0) return published;
  console.log("Configuring npm Trusted Publishing for " + name + "...");
  return addNpmTrust(name);
}

function addTrust(args) {
  if (args.includes("--first")) throw new Error("Use either --first or --add-trust; --first already configures Trusted Publishing after the initial publish.");
  assertFlag(args, "--confirm", "Changing npm Trusted Publishing requires explicit human confirmation.");
  assertClean();
  const name = packageName();
  if (!npmPackageExists(name)) {
    throw new Error(`${name} must be published before Trusted Publishing can be configured. Run cf-genai release --first --confirm.`);
  }
  console.log("Configuring npm Trusted Publishing for " + name + "...");
  return addNpmTrust(name);
}

function release(args) {
  const dryRun = args.includes("--dry-run");
  const bypassLint = args.includes("--bypass-lint");
  const requestedVersion = requestedReleaseVersion(args);
  if (requestedVersion && args.includes("--type")) throw new Error("Use either --version or --type, not both.");
  if (!dryRun) assertFlag(args, "--confirm", "A release requires explicit human confirmation because it creates a commit, tag, and npm publish trigger.");
  assertClean();
  if (!bypassLint) runProjectCommand("ci:lint");
  assertMainIsSynchronized();
  const name = packageName();
  let currentVersion = version();
  if (requestedVersion) {
    if (compareVersions(requestedVersion, currentVersion) <= 0) throw new Error(`Requested version ${requestedVersion} must be greater than the current version ${currentVersion}.`);
    const published = npmVersionState(name, requestedVersion);
    if (published.exists || tagExists(`v${requestedVersion}`)) throw new Error(`${name}@${requestedVersion} already exists; release versions cannot be reused.`);
    if (dryRun) {
      console.log(`Dry run: ${name}@${currentVersion} would release as ${requestedVersion}. Main is synchronized and no changes were made.`);
      return;
    }
    const bumped = run("npm", ["version", requestedVersion, "--no-git-tag-version"]);
    if (bumped.status !== 0) return bumped;
    currentVersion = version();
  }
  const typeIndex = args.indexOf("--type");
  const type = typeIndex >= 0 ? args[typeIndex + 1] : "patch";
  if (!["patch", "minor", "major"].includes(type)) throw new Error("--type must be patch, minor, or major.");
  const currentPublished = requestedVersion ? false : npmVersionState(name, currentVersion).exists;
  const currentTagExists = requestedVersion ? false : tagExists(`v${currentVersion}`);
  if (!requestedVersion && currentTagExists && !currentPublished) {
    throw new Error(`${name}@${currentVersion} has a release tag but is not published. Repair the failed publish or run release-status before creating another release.`);
  }
  if (!requestedVersion && !currentPublished && !currentTagExists) {
    throw new Error(`${name} is not published yet. Run cf-genai release --first --confirm to bootstrap the npm package before creating a release tag.`);
  }
  const consumed = requestedVersion ? false : Boolean(currentPublished || currentTagExists);
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

async function releaseStatus(args = []) {
  const name = packageName();
  const currentVersion = version();
  const waitMinutes = releaseWaitMinutes(args);
  const json = args.includes("--json");
  const deadline = Date.now() + waitMinutes * 60_000;
  const tag = `v${currentVersion}`;
  const checks = { git: gitReleaseState(), tag: releaseTagState(tag), base: baseReleaseState(packageJson(), releaseStatusCommandTimeout), github_actions: { state: "pending", runs: [] }, npm: { state: "not_published", version: null } };
  const repository = remoteRepository();
  do {
    const remaining = Math.max(1, deadline - Date.now());
    checks.github_actions = githubActionsState(repository, checks.tag.remote_sha || checks.tag.local_sha || "", Math.min(10_000, remaining));
    checks.npm = npmReleaseState(name, currentVersion, Math.min(10_000, Math.max(1, deadline - Date.now())));
    if (!releaseStatusShouldContinue(checks, Date.now(), deadline)) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  const result = { package: name, version: currentVersion, tag, repository, wait_minutes: waitMinutes, checks, ok: checks.git.clean && checks.git.pushed && checks.tag.matches && checks.github_actions.state === "passed" && checks.npm.state === "published" };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${name}@${currentVersion}`);
    const clean = checks.git.clean ? "clean" : "dirty";
    const pushed = checks.git.pushed ? "yes" : "no";
    const tagState = checks.tag.matches ? "present and correct" : "missing or incorrect";
    const releaseState = result.ok ? "ready" : "not ready";
    console.log(`workspace: ${releaseStatusDot(clean)} ${clean}; pushed: ${releaseStatusDot(pushed)} ${pushed}`);
    console.log(`tag ${tag}: ${releaseStatusDot(tagState)} ${tagState}`);
    const actionsError = checks.github_actions.error ? ` — ${checks.github_actions.error.replace(/\s+/g, " ")}` : "";
    const failedPublish = checks.github_actions.runs?.find((run) => run.status === "completed" && run.conclusion !== "success");
    const failedPublishError = failedPublish ? ` — ${failedPublish.conclusion}${failedPublish.url ? ` (${failedPublish.url})` : ""}` : "";
    const npmError = checks.npm.error ? ` — ${checks.npm.error.replace(/\s+/g, " ")}` : "";
    const baseError = checks.base.error ? ` — ${checks.base.error.replace(/\s+/g, " ")}` : "";
    console.log(`GitHub Actions: ${releaseStatusDot(checks.github_actions.state)} ${checks.github_actions.state}${actionsError}${failedPublishError}`);
    console.log(`npm: ${releaseStatusDot(checks.npm.state)} ${checks.npm.state}${npmError}`);
    if (checks.base.state === "outdated") {
      console.log(`cf-genai-base: ${releaseStatusDot(checks.base.state)} outdated (${checks.base.version}; latest ${checks.base.latest})`);
      console.log(`  Upgrade: ${checks.base.upgrade}`);
    } else if (checks.base.state !== "not_declared") {
      console.log(`cf-genai-base: ${releaseStatusDot(checks.base.state)} ${checks.base.state}${baseError}`);
    }
    console.log(`release status: ${releaseStatusDot(releaseState)} ${releaseState}`);
  }
  return result;
}
