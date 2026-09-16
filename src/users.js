import { executeJson, parseJsonRows } from "./d1.js";

function sql(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
function query(database, target, command, options) { return parseJsonRows(executeJson(options.wranglerCommand, database, target, command, options)); }
function csv(value) { return String(value).split(",").map((item) => item.trim()).filter(Boolean); }

export function runUserCommand({ action, username, options }) {
  const target = options.target || "local";
  if (!["local", "staging", "production"].includes(target)) throw new Error("User target must be local, staging, or production.");
  if (action === "list") {
    const users = query(options.database, target, "SELECT id,email,display_name,provider,subject,is_admin,created_at,updated_at FROM auth_users ORDER BY email COLLATE NOCASE;", options);
    return console.log(JSON.stringify(users.map((user) => ({ ...user, tenants: query(options.database, target, "SELECT t.id,t.name FROM auth_tenants t JOIN auth_user_tenants ut ON ut.tenant_id=t.id WHERE ut.user_id=" + sql(user.id) + " ORDER BY t.name COLLATE NOCASE;", options) })), null, 2));
  }
  if (!username) throw new Error("A username, email, subject, or user id is required.");
  const where = `(id=${sql(username)} OR email=${sql(username)} OR subject=${sql(username)})`;
  const rows = query(options.database, target, `SELECT id,email,display_name,provider,subject,is_admin,created_at,updated_at FROM auth_users WHERE ${where} LIMIT 1;`, options);
  if (!rows[0]) throw new Error(`User not found: ${username}`);
  if (action === "get") {
    const user = rows[0];
    const scopes = query(options.database, target, `SELECT scope_name,granted_at FROM auth_user_scopes WHERE user_id=${sql(user.id)} ORDER BY scope_name;`, options);
    const groups = query(options.database, target, `SELECT group_name,granted_at FROM auth_user_groups WHERE user_id=${sql(user.id)} ORDER BY group_name;`, options);
    const tenants = query(options.database, target, `SELECT t.id,t.name,ut.joined_at FROM auth_tenants t JOIN auth_user_tenants ut ON ut.tenant_id=t.id WHERE ut.user_id=${sql(user.id)} ORDER BY t.name COLLATE NOCASE;`, options);
    return console.log(JSON.stringify({ ...user, scopes, groups, tenants }, null, 2));
  }
  if (action !== "update") throw new Error("Unknown user action.");
  const assignments = [];
  if (options.roles !== undefined) assignments.push(`is_admin=${csv(options.roles).includes("admin") ? 1 : 0}`);
  if (!assignments.length && options.scopes === undefined && options.groups === undefined && options.tenants === undefined) throw new Error("user:update requires --roles, --scopes, --groups, or --tenants.");
  if (assignments.length) query(options.database, target, `UPDATE auth_users SET ${assignments.join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=${sql(rows[0].id)};`, options);
  if (options.scopes !== undefined) { query(options.database, target, "DELETE FROM auth_user_scopes WHERE user_id=" + sql(rows[0].id) + ";", options); for (const scope of csv(options.scopes)) query(options.database, target, "INSERT OR IGNORE INTO auth_user_scopes (user_id,scope_name,granted_by) VALUES (" + sql(rows[0].id) + "," + sql(scope) + ",'human:cli');", options); }
  if (options.groups !== undefined) { query(options.database, target, "DELETE FROM auth_user_groups WHERE user_id=" + sql(rows[0].id) + ";", options); for (const group of csv(options.groups)) query(options.database, target, "INSERT OR IGNORE INTO auth_user_groups (user_id,group_name,granted_by) VALUES (" + sql(rows[0].id) + "," + sql(group) + ",'human:cli');", options); }
  if (options.tenants !== undefined) { const tenants = csv(options.tenants); if (tenants.length) { const available = query(options.database, target, "SELECT id FROM auth_tenants WHERE id IN (" + tenants.map(sql).join(",") + ");", options); const found = new Set(available.map((tenant) => tenant.id)); if (found.size !== tenants.length) throw new Error("One or more tenants do not exist."); } query(options.database, target, "DELETE FROM auth_user_tenants WHERE user_id=" + sql(rows[0].id) + ";", options); for (const tenant of tenants) query(options.database, target, "INSERT OR IGNORE INTO auth_user_tenants (user_id,tenant_id) VALUES (" + sql(rows[0].id) + "," + sql(tenant) + ");", options); }
  return runUserCommand({ action: "get", username: rows[0].id, options });
}
