import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packagePath = "package.json";

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

function tagExists(tag) {
  const local = run("git", ["tag", "--list", tag], { inherit: false, failOnError: false });
  if (local.status === 0 && local.stdout.trim()) return true;
  const remote = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { inherit: false, failOnError: false });
  return remote.status === 0 && Boolean(remote.stdout.trim());
}

export function runProjectCommand(command, args = []) {
  if (command === "check") return run("npm", ["run", "check"]);
  if (command === "test") return run("npm", ["test"]);
  if (command === "build" || command === "ci") return run("npm", ["run", "build"]);
  if (command === "dev") {
    const scripts = packageJson().scripts || {};
    const forwarded = args[0] === "--" ? args.slice(1) : args;
    if (scripts.dev) return run("npm", ["run", "dev", ...forwarded]);
    return run("npx", ["wrangler", "dev", ...forwarded]);
  }
  if (command === "publish:first") {
    assertFlag(args, "--confirm-publish", "Initial npm publishing is irreversible and requires explicit human confirmation.");
    const name = packageName();
    const currentVersion = version();
    if (npmVersion(name, currentVersion)) throw new Error(`${name}@${currentVersion} is already published.`);
    return run("npm", ["publish", "--access", "public", "--provenance"]);
  }
  if (command === "release") return release(args);
  if (command === "status") return releaseStatus();
  return null;
}

function release(args) {
  assertFlag(args, "--confirm-release", "A release requires explicit human confirmation because it creates a commit, tag, and npm publish trigger.");
  assertClean();
  assertMainIsSynchronized();
  const name = packageName();
  let currentVersion = version();
  if (npmVersion(name, currentVersion) || tagExists(`v${currentVersion}`)) {
    const typeIndex = args.indexOf("--type");
    const type = typeIndex >= 0 ? args[typeIndex + 1] : "patch";
    if (!["patch", "minor", "major"].includes(type)) throw new Error("--type must be patch, minor, or major.");
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
