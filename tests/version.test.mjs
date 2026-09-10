import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, formatVersionOutput } from "../src/version.js";

test("version comparison handles releases and prereleases", () => {
  assert.equal(compareVersions("1.2.4", "1.2.3") > 0, true);
  assert.equal(compareVersions("1.2.3", "1.2.3-beta.1") > 0, true);
  assert.equal(compareVersions("1.2.3-beta.2", "1.2.3-beta.10") < 0, true);
});

test("version output includes upgrade instructions only when npm is newer", () => {
  const upgrade = formatVersionOutput({ local: "0.1.3", latest: "0.1.4" });
  assert.match(upgrade, /local: 0\.1\.3/);
  assert.match(upgrade, /latest: 0\.1\.4/);
  assert.match(upgrade, /npm i -g @agilesyndrome\/cf-genai-cli/);

  const current = formatVersionOutput({ local: "0.1.4", latest: "0.1.4" });
  assert.doesNotMatch(current, /Upgrade available/);
});
