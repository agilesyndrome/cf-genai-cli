import test from "node:test";
import assert from "node:assert/strict";
import { clearSql, parseJsonRows, stripInternalRows, targetArgs } from "../src/d1.js";
import { main } from "../src/cli.js";

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

test("Wrangler JSON envelopes are flattened to rows", () => {
  assert.deepEqual(parseJsonRows(JSON.stringify([{ results: [{ name: "recipes" }] }])), [{ name: "recipes" }]);
});

test("production refresh is absent from the command grammar", async () => {
  await assert.rejects(() => main(["d1", "refresh", "production"]), /Unknown command/);
});

test("production migration requires an explicit confirmation", async () => {
  await assert.rejects(() => main(["d1", "migrate", "production"]), /requires --confirm-production/);
});
