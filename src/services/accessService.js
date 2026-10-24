// Custom roles and departments (who may do what, and which group someone belongs to).
import { withTransaction } from '../db/pool.js';
import { LedgerError } from '../core/ledger.js';
import { PERMISSIONS, PRESET_ROLES, cleanPermissions } from '../core/permissions.js';
import { appendAudit } from './audit.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanName = (name, max, what) => {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > max) throw new LedgerError(`${what} name is required (up to ${max} characters)`);
  return n;
};
const lockCompany = (c, companyId) => c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);

/** The permission catalog, the built-in roles, and this company's custom roles (with member counts). */
export async function listRoles(db, companyId) {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.permissions, (SELECT count(*)::int FROM memberships m WHERE m.custom_role_id = r.id) AS members
       FROM company_roles r WHERE r.company_id = $1 ORDER BY lower(r.name)`, [companyId]);
  return {
    permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
    presets: Object.entries(PRESET_ROLES).map(([key, r]) => ({ key, label: r.label, permissions: r.permissions })),
    custom: rows,
  };
}

function cleanRole({ name, permissions }) {
  const n = cleanName(name, 40, 'Role');
  if (Object.values(PRESET_ROLES).some((p) => p.label.toLowerCase() === n.toLowerCase()) || Object.hasOwn(PRESET_ROLES, n.toLowerCase())) {
    throw new LedgerError(`"${n}" is a built-in role; pick another name`);
  }
  let perms;
  try { perms = cleanPermissions(permissions); } catch (e) { throw new LedgerError(`Role is not valid: ${e.message}`); }
  if (!perms.length) throw new LedgerError('Role is not valid: tick at least one permission');
  return { name: n, permissions: perms };
}

export async function createRole(pool, companyId, input, { actor = null } = {}) {
  const v = cleanRole(input);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [dup] } = await c.query('SELECT 1 FROM company_roles WHERE company_id = $1 AND lower(trim(name)) = lower($2)', [companyId, v.name]);
    if (dup) throw new LedgerError(`There is already a role named "${v.name}"`);
    const { rows: [r] } = await c.query('INSERT INTO company_roles (company_id, name, permissions, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, permissions',
      [companyId, v.name, v.permissions, actor]);
    await appendAudit(c, companyId, { action: 'create', entity: 'role', entityId: r.id, actor, payload: v });
    return { ...r, members: 0 };
  });
}

export async function updateRole(pool, companyId, roleId, input, { actor = null } = {}) {
  if (typeof roleId !== 'string' || !UUIDISH.test(roleId)) throw new LedgerError('Role not found');
  const v = cleanRole(input);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [dup] } = await c.query('SELECT 1 FROM company_roles WHERE company_id = $1 AND lower(trim(name)) = lower($2) AND id <> $3', [companyId, v.name, roleId]);
    if (dup) throw new LedgerError(`There is already a role named "${v.name}"`);
    const { rows: [r] } = await c.query('UPDATE company_roles SET name = $3, permissions = $4 WHERE company_id = $1 AND id = $2 RETURNING id, name, permissions',
      [companyId, roleId, v.name, v.permissions]);
    if (!r) throw new LedgerError('Role not found');
    await appendAudit(c, companyId, { action: 'update', entity: 'role', entityId: r.id, actor, payload: v });
    return r;
  });
}

export async function deleteRole(pool, companyId, roleId, { actor = null } = {}) {
  if (typeof roleId !== 'string' || !UUIDISH.test(roleId)) throw new LedgerError('Role not found');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [used] } = await c.query('SELECT count(*)::int AS n FROM memberships WHERE company_id = $1 AND custom_role_id = $2', [companyId, roleId]);
    if (used.n) throw new LedgerError(`${used.n} member(s) still have this role; give them another role first`);
    const { rowCount } = await c.query('DELETE FROM company_roles WHERE company_id = $1 AND id = $2', [companyId, roleId]);
    if (!rowCount) throw new LedgerError('Role not found');
    await appendAudit(c, companyId, { action: 'delete', entity: 'role', entityId: roleId, actor, payload: {} });
    return { ok: true };
  });
}

export async function listDepartments(db, companyId) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, (SELECT count(*)::int FROM memberships m WHERE m.department_id = d.id) AS members
       FROM departments d WHERE d.company_id = $1 ORDER BY lower(d.name)`, [companyId]);
  return rows;
}

export async function createDepartment(pool, companyId, { name }, { actor = null } = {}) {
  const n = cleanName(name, 60, 'Department');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [dup] } = await c.query('SELECT 1 FROM departments WHERE company_id = $1 AND lower(trim(name)) = lower($2)', [companyId, n]);
    if (dup) throw new LedgerError(`There is already a department named "${n}"`);
    const { rows: [d] } = await c.query('INSERT INTO departments (company_id, name) VALUES ($1,$2) RETURNING id, name', [companyId, n]);
    await appendAudit(c, companyId, { action: 'create', entity: 'department', entityId: d.id, actor, payload: { name: n } });
    return { ...d, members: 0 };
  });
}

export async function deleteDepartment(pool, companyId, departmentId, { actor = null } = {}) {
  if (typeof departmentId !== 'string' || !UUIDISH.test(departmentId)) throw new LedgerError('Department not found');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [used] } = await c.query('SELECT count(*)::int AS n FROM memberships WHERE company_id = $1 AND department_id = $2', [companyId, departmentId]);
    if (used.n) throw new LedgerError(`${used.n} member(s) are still in this department; move them first`);
    const { rowCount } = await c.query('DELETE FROM departments WHERE company_id = $1 AND id = $2', [companyId, departmentId]);
    if (!rowCount) throw new LedgerError('Department not found');
    await appendAudit(c, companyId, { action: 'delete', entity: 'department', entityId: departmentId, actor, payload: {} });
    return { ok: true };
  });
}
