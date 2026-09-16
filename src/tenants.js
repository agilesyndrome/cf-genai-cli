import { executeJson, parseJsonRows } from "./d1.js";

function sql(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
function query(database, target, command, options) { return parseJsonRows(executeJson(options.wranglerCommand, database, target, command, options)); }
function output(value) { console.log(JSON.stringify(value, null, 2)); }

export function runTenantCommand({ action, identifier, name, options }) {
  const target = options.target === "prod" ? "production" : options.target || "local";
  if (!["local", "staging", "production"].includes(target)) throw new Error("Tenant target must be local, staging, or production.");
  if (action === "list") return output(query(options.database, target, "SELECT t.id,t.name,t.created_at,t.updated_at,COUNT(ut.user_id) AS user_count FROM auth_tenants t LEFT JOIN auth_user_tenants ut ON ut.tenant_id=t.id GROUP BY t.id ORDER BY t.name COLLATE NOCASE;", options));
  if (!identifier) throw new Error("A tenant id is required.");
  if (action === "get") return output(query(options.database, target, "SELECT id,name,created_at,updated_at FROM auth_tenants WHERE id=" + sql(identifier) + " LIMIT 1;", options));
  if (action === "create") { if (!name) throw new Error("tenant:create requires --name."); query(options.database, target, "INSERT INTO auth_tenants (id,name) VALUES (" + sql(identifier) + "," + sql(name) + ");", options); return output({ id: identifier, name, environment: target, changed_by: "human:cli" }); }
  if (["update", "rename"].includes(action)) { if (!name) throw new Error("tenant:update requires --name."); query(options.database, target, "UPDATE auth_tenants SET name=" + sql(name) + ",updated_at=CURRENT_TIMESTAMP WHERE id=" + sql(identifier) + ";", options); return output({ id: identifier, name, environment: target, changed_by: "human:cli" }); }
  throw new Error("Unknown tenant action.");
}
