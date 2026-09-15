import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSql, parseJsonRows, stripInternalRows, targetArgs } from "../src/d1.js";
import { main } from "../src/cli.js";
import { baseDependencyVersion, dataAccessLint, devCommand, isNpmAuthenticationFailure, normalizeReleaseVersion, releaseStatusDot, releaseStatusShouldContinue, releaseWaitMinutes, vendorPackageMigrations } from "../src/project.js";

test("dev command loads .env.dev through 1Password", () => {
  assert.deepEqual(devCommand({ hasScript: true, args: ["--", "--host", "127.0.0.1"] }), [
    "op", "run", "--env-file=.env.dev", "--", "npm", "run", "dev", "--host", "127.0.0.1",
  ]);
  assert.deepEqual(devCommand({ hasScript: false }), [
    "op", "run", "--env-file=.env.dev", "--", "npx", "wrangler", "dev",
  ]);
});

test("data access lint detects direct D1 calls in cf-genai source", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cf-genai-lint-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "@agilesyndrome/cf-genai-cookbook" }));
    await writeFile(join(cwd, "src", "recipe.js"), "export const rows = env.DB.prepare('SELECT 1');\n");
    assert.throws(() => dataAccessLint({ cwd }), /Direct D1 access is not allowed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("data access lint recognizes consumers by package metadata, not folder name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cookbook-lint-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "cookbook", dependencies: { "@agilesyndrome/cf-genai-base": "2.1.0" } }));
    await writeFile(join(cwd, "src", "recipe.js"), "export const rows = env.DB.prepare('SELECT 1');\n");
    assert.throws(() => dataAccessLint({ cwd }), /Direct D1 access is not allowed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("base package metadata does not lint its own framework internals", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "base-lint-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "@agilesyndrome/cf-genai-base" }));
    await writeFile(join(cwd, "src", "authorization.js"), "export const rows = env.DB.prepare('SELECT 1');\n");
    assert.deepEqual(dataAccessLint({ cwd }), { skipped: true, violations: [] });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("target args select local or named remote environments", () => {
  assert.deepEqual(targetArgs("local", { stagingEnv: "staging" }), ["--local"]);
  assert.deepEqual(targetArgs("staging", { stagingEnv: "staging" }), ["--remote", "--env", "staging"]);
  assert.deepEqual(targetArgs("production", { productionEnv: "" }), ["--remote"]);
});

test("clear SQL safely quotes discovered tables", () => {
  assert.match(clearSql(["recipes", "weird\"table"]), /DELETE FROM "weird""table";/);
});

test("internal rows are not imported", () => {
  const sql = ['INSERT INTO "recipes" VALUES (1);', 'INSERT INTO "d1_migrations" VALUES (1);', 'INSERT INTO "sqlite_sequence" VALUES (1);', 'INSERT INTO "_cf_KV" VALUES (1);'].join("\n");
  assert.equal(stripInternalRows(sql), 'INSERT INTO "recipes" VALUES (1);');
});

test("package migrations are vendored once with ordered site migration names", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cf-genai-upgrade-"));
  try {
    await mkdir(join(cwd, "migrations"));
    await mkdir(join(cwd, "node_modules", "@agilesyndrome", "cf-genai-base", "migrations"), { recursive: true });
    await writeFile(join(cwd, "migrations", "0001_existing.sql"), "SELECT 1;\n");
    await writeFile(join(cwd, "node_modules", "@agilesyndrome", "cf-genai-base", "migrations", "0003_auth_groups.sql"), "CREATE TABLE auth_groups(name TEXT);\n");
    const first = vendorPackageMigrations({ cwd, version: "4.1.1" });
    assert.deepEqual(first.added, ["0002_cf_genai_base_auth_groups.sql"]);
    const second = vendorPackageMigrations({ cwd, version: "4.1.1" });
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.skipped, ["0003_auth_groups.sql"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Wrangler JSON envelopes are flattened to rows", () => {
  assert.deepEqual(parseJsonRows(JSON.stringify([{ results: [{ name: "recipes" }] }])), [{ name: "recipes" }]);
});

test("production refresh is absent from the command grammar", async () => {
  await assert.rejects(() => main(["d1", "refresh", "production"]), /Unknown command/);
});

test("production migration requires an explicit confirmation", async () => {
  await assert.rejects(() => main(["d1", "migrate", "production"]), /requires --confirm-production/);
});

test("release status uses one shared five-minute default wait budget", () => {
  assert.equal(releaseWaitMinutes([]), 5);
  assert.equal(releaseWaitMinutes(["--wait", "3"]), 3);
  assert.equal(releaseWaitMinutes(["--wait=0"]), 0);
  assert.throws(() => releaseWaitMinutes(["--wait"]), /requires a number/);
  assert.throws(() => releaseWaitMinutes(["--wait", "-1"]), /non-negative/);
});

test("release status keeps waiting for npm after Actions passes", () => {
  const checks = { github_actions: { state: "passed" }, npm: { state: "not_published" } };
  assert.equal(releaseStatusShouldContinue(checks, 1_000, 2_000), true);
  assert.equal(releaseStatusShouldContinue({ github_actions: { state: "passed" }, npm: { state: "published" } }, 1_000, 2_000), false);
  assert.equal(releaseStatusShouldContinue({ github_actions: { state: "failed" }, npm: { state: "not_published" } }, 1_000, 2_000), false);
  assert.equal(releaseStatusShouldContinue({ github_actions: { state: "unavailable" }, npm: { state: "not_published" } }, 1_000, 2_000), true);
  assert.equal(releaseStatusShouldContinue({ github_actions: { state: "unavailable" }, npm: { state: "published" } }, 1_000, 2_000), false);
  assert.equal(releaseStatusShouldContinue(checks, 2_000, 2_000), false);
});

test("release status maps checks to traffic-light dots", () => {
  assert.equal(releaseStatusDot("clean"), "🟢");
  assert.equal(releaseStatusDot("running"), "🟡");
  assert.equal(releaseStatusDot("failed"), "🔴");
  assert.equal(releaseStatusDot("outdated"), "🟡");
  assert.equal(releaseStatusDot("ready"), "🟢");
});

test("release status reads the base version from package metadata", () => {
  assert.equal(baseDependencyVersion({ dependencies: { "@agilesyndrome/cf-genai-base": "^2.1.0" } }), "2.1.0");
  assert.equal(baseDependencyVersion({ devDependencies: { "@agilesyndrome/cf-genai-base": "2.2.0" } }), "2.2.0");
  assert.equal(baseDependencyVersion({ name: "@agilesyndrome/cf-genai-base", version: "3.0.0" }), "3.0.0");
  assert.equal(baseDependencyVersion({ dependencies: { "@agilesyndrome/other": "1.0.0" } }), null);
});

test("explicit release versions normalize major.minor and reject patch input", () => {
  assert.equal(normalizeReleaseVersion("4.1"), "4.1.0");
  assert.equal(normalizeReleaseVersion("004.001"), "4.1.0");
  assert.throws(() => normalizeReleaseVersion("4"), /major\.minor/);
  assert.throws(() => normalizeReleaseVersion("4.1.2"), /major\.minor/);
});

test("release requires explicit human confirmation before inspecting or changing git", async () => {
  await assert.rejects(() => main(["release"]), /requires explicit human confirmation/);
});

test("initial publish requires explicit human confirmation", async () => {
  await assert.rejects(() => main(["release", "--first"]), /Initial npm publishing is irreversible.*--confirm/)
});

test("adding npm trust requires explicit human confirmation", async () => {
  await assert.rejects(() => main(["release", "--add-trust"]), /Changing npm Trusted Publishing.*--confirm/)
});

test("npm authentication failures are recognized", () => {
  assert.equal(isNpmAuthenticationFailure("npm error code E401\nnpm error 401 Unauthorized"), true);
  assert.equal(isNpmAuthenticationFailure("npm error code E404\nnpm error 404 Not Found"), false);
});

test("publish command is removed", async () => {
  await assert.rejects(() => main(["publish:first"]), /Unknown command/);
});

test("release dry-run still protects dirty trees", async () => {
const marker = ".release-safety-test-" + process.pid + ".tmp";
  await writeFile(marker, "");
  try {
    await assert.rejects(() => main(["release", "--dry-run"]), /Working tree must be clean before a release/);
  } finally {
    await rm(marker, { force: true });
  }
});
