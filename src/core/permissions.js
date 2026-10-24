// What people may do in a company. ℹ️ Each member has one role. The five built-in roles are presets
// of the permissions below; an owner can also make custom roles (any set of checkboxes), and put
// people in departments (Accounting, Engineering, Field…), which decide whose timesheets a
// department approver sees.

export const PERMISSIONS = Object.freeze({
  view_books: 'See the books: transactions, accounts, banking and reports',
  post: 'Record, change and void transactions; banking',
  invoices: 'Create invoices and customers; record customer payments',
  bills: 'Enter bills and vendors; record bill payments',
  accounts: 'Change the chart of accounts; import books',
  close: 'Close accounting periods',
  payroll: 'Payroll: employees, paychecks, pay stubs, payroll taxes',
  audit: 'Run audit-trail checks',
  admin: 'Company settings, members, roles and departments',
  time_own: 'Enter their own time on timesheets',
  time_approve: "Approve timesheets of people in their department",
  time_all: "See and approve everyone's timesheets",
});
export const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS));

export const PRESET_ROLES = Object.freeze({
  owner: { label: 'Owner', permissions: PERMISSION_KEYS },
  accountant: { label: 'Accountant', permissions: PERMISSION_KEYS.filter((p) => p !== 'admin') },
  bookkeeper: { label: 'Bookkeeper', permissions: ['view_books', 'post', 'invoices', 'bills', 'time_own'] },
  viewer: { label: 'Viewer (read only)', permissions: ['view_books'] },
  staff: { label: 'Staff (invoices and own time)', permissions: ['invoices', 'time_own'] },
});
export const PRESET_KEYS = Object.freeze(Object.keys(PRESET_ROLES));

/** Clean a list of permission names from a request; throws with a readable message on unknown ones. */
export function cleanPermissions(list) {
  if (!Array.isArray(list)) throw new TypeError('permissions must be a list');
  const bad = list.filter((p) => !PERMISSION_KEYS.includes(p));
  if (bad.length) throw new TypeError(`unknown permission(s): ${bad.join(', ')}`);
  return PERMISSION_KEYS.filter((p) => list.includes(p)); // de-duplicated, in catalog order
}
