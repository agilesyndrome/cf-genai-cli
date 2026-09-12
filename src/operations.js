import { executeJson, parseJsonRows } from "./d1.js";

function query(sql, options) { return parseJsonRows(executeJson(options.wranglerCommand, options.database, normalizeTarget(options.target), sql, options)); }
function normalizeTarget(target) { return target === "prod" ? "production" : target || "local"; }
function output(value) { console.log(JSON.stringify(value, null, 2)); }

export function runOperationalCommand({ domain, action, identifier, value, options }) {
  const target = normalizeTarget(options.target);
  if (!["local", "staging", "production"].includes(target)) throw new Error("Environment must be local, staging, or prod/production.");
  if (domain === "healthcheck" && action === "list") return output(query("SELECT id,feature,component,display_name,state,metadata_json,created_at,updated_at FROM core_healthchecks ORDER BY feature,component;", { ...options, target }));
  if ((domain === "circuit-breaker" || domain === "circuit") && action === "list") return output(query("SELECT id,feature,name,display_name,state,healthcheck_mode,allow_self_healing,metadata_json,created_at,updated_at FROM core_circuit_breakers ORDER BY feature,name;", { ...options, target }));
  if ((domain === "circuit-breaker" || domain === "circuit") && action === "get") {
    if (!identifier) throw new Error("A circuit-breaker id is required.");
    return output(query("SELECT id,feature,name,display_name,state,healthcheck_mode,allow_self_healing,metadata_json,created_at,updated_at FROM core_circuit_breakers WHERE id=\"" + sql(identifier) + "\" LIMIT 1;", { ...options, target }));
  }
  if ((domain === "circuit-breaker" || domain === "circuit") && (action === "set" || action === "update")) {
    if (!identifier || !value) throw new Error("circuit-breaker:set requires an id and state (off, tripped, or on).");
    if (!["off", "tripped", "on"].includes(value)) throw new Error("Circuit-breaker state must be off, tripped, or on.");
    if (target === "production" && !options.confirmProduction) throw new Error("Production circuit-breaker changes require --confirm-production.");
    const rows = query("SELECT id,state FROM core_circuit_breakers WHERE id=\"" + sql(identifier) + "\" LIMIT 1;", { ...options, target });
    if (!rows[0]) throw new Error("Circuit breaker not found: " + identifier);
    query("UPDATE core_circuit_breakers SET state=\"" + value + "\",updated_at=CURRENT_TIMESTAMP WHERE id=\"" + sql(identifier) + "\";", { ...options, target });
    return output({ id: identifier, state: value, environment: target, changed_by: "human:cli" });
  }
  throw new Error("Unknown operational command.");
}
function sql(value) { return String(value).replaceAll("\"", "\"\""); }
