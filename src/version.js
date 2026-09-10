import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const PACKAGE_NAME = "@agilesyndrome/cf-genai-cli";

export function localVersion() {
  const packageUrl = new URL("../package.json", import.meta.url);
  return JSON.parse(readFileSync(packageUrl, "utf8")).version;
}

export function latestVersion(packageName = PACKAGE_NAME) {
  const result = spawnSync("npm", ["view", packageName, "version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
}

function parsedVersion(value) {
  const match = String(value).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareVersions(left, right) {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  return String(a.prerelease).localeCompare(String(b.prerelease), undefined, { numeric: true });
}

export function formatVersionOutput({ local, latest, packageName = PACKAGE_NAME }) {
  const lines = [`${packageName} local: ${local}`, `${packageName} latest: ${latest ?? "unavailable"}`];
  if (latest && compareVersions(latest, local) > 0) {
    lines.push("Upgrade available:", `  npm i -g ${packageName}`);
  }
  return lines.join("\n");
}

export function runVersionCommand() {
  const local = localVersion();
  const latest = latestVersion();
  console.log(formatVersionOutput({ local, latest }));
}
