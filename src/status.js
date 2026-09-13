import { readFileSync } from "node:fs";
import { executeJson, parseJsonRows } from "./d1.js";

function readConfig(path) {
  try {
    const text = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}])/g, "$1");
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Unable to read Wrangler config " + path + ": " + error.message);
  }
}

function siteDetails(options) {
  const config = readConfig(options.config);
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const route = routes.find((item) => item?.custom_domain && item.pattern) || routes.find((item) => item?.pattern);
  const url = process.env.CF_GENAI_PRODUCTION_URL || config.vars?.PUBLIC_ORIGIN || (route?.pattern ? (String(route.pattern).startsWith("http") ? route.pattern : "https://" + route.pattern) : null);
  return { name: config.name || "Unnamed site", url, config: options.config };
}

function query(options, target, sql) {
  return parseJsonRows(executeJson(options.wranglerCommand, options.database, target, sql, { ...options, target }));
}

export function siteStatus(options) {
  const target = options.target === "local" ? "production" : (options.target === "prod" ? "production" : options.target);
  const checks = query(options, target, "SELECT id,display_name,feature,component,state FROM core_healthchecks ORDER BY feature,component;");
  const breakers = query(options, target, "SELECT id,display_name,feature,name,state FROM core_circuit_breakers ORDER BY feature,name;");
  const overview = {
    site: siteDetails(options),
    environment: target,
    database: options.database,
    healthchecks: { total: checks.length, green: checks.filter((item) => item.state === "green").length, yellow: checks.filter((item) => item.state === "yellow").length, red: checks.filter((item) => item.state === "red").length, attention: checks.filter((item) => item.state !== "green") },
    circuit_breakers: { total: breakers.length, green: breakers.filter((item) => item.state === "on").length, off: breakers.filter((item) => item.state === "off").length, tripped: breakers.filter((item) => item.state === "tripped").length, attention: breakers.filter((item) => item.state !== "on") }
  };
  if (options.json) { console.log(JSON.stringify(overview, null, 2)); return overview; }
  console.log("Site: " + overview.site.name);
  console.log("URL: " + (overview.site.url || "unknown"));
  console.log("Environment: " + overview.environment);
  console.log("Health checks: " + overview.healthchecks.green + " green, " + overview.healthchecks.yellow + " yellow, " + overview.healthchecks.red + " red");
  console.log("Circuit breakers: " + overview.circuit_breakers.green + " green, " + overview.circuit_breakers.off + " off, " + overview.circuit_breakers.tripped + " tripped");
  const attention = [...overview.healthchecks.attention.map((item) => ({ type: "health check", item })), ...overview.circuit_breakers.attention.map((item) => ({ type: "circuit breaker", item }))];
  if (attention.length) { console.log("Attention:"); for (const entry of attention) console.log("- " + entry.type + ": " + (entry.item.display_name || entry.item.id) + " (" + entry.item.state + ")"); } else console.log("All systems green.");
  return overview;
}

