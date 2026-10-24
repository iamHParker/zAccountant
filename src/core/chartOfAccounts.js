// Default chart of accounts for a small US business.
// `key` marks accounts the system posts to automatically (payroll, AR/AP, etc.).
// cashFlow tells the Statement of Cash Flows (indirect method) where changes belong.

export const DEFAULT_CHART = Object.freeze([
  // Assets 1000-1999
  { code: '1000', name: 'Checking', type: 'asset', subtype: 'bank', cashFlow: 'cash', key: 'cash' },
  { code: '1010', name: 'Savings', type: 'asset', subtype: 'bank', cashFlow: 'cash' },
  { code: '1050', name: 'Petty Cash', type: 'asset', subtype: 'cash', cashFlow: 'cash' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', subtype: 'receivable', cashFlow: 'operating', key: 'accounts_receivable' },
  { code: '1200', name: 'Inventory', type: 'asset', subtype: 'current', cashFlow: 'operating' },
  { code: '1300', name: 'Prepaid Expenses', type: 'asset', subtype: 'current', cashFlow: 'operating' },
  { code: '1500', name: 'Equipment', type: 'asset', subtype: 'fixed', cashFlow: 'investing' },
  { code: '1510', name: 'Vehicles', type: 'asset', subtype: 'fixed', cashFlow: 'investing' },
  { code: '1590', name: 'Accumulated Depreciation', type: 'asset', subtype: 'contra', cashFlow: 'operating' },

  // Liabilities 2000-2999
  { code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'payable', cashFlow: 'operating', key: 'accounts_payable' },
  { code: '2100', name: 'Credit Card', type: 'liability', subtype: 'credit_card', cashFlow: 'operating' },
  { code: '2200', name: 'Sales Tax Payable', type: 'liability', subtype: 'current', cashFlow: 'operating' },
  { code: '2300', name: 'Net Pay Payable', type: 'liability', subtype: 'payroll', cashFlow: 'operating', key: 'net_pay_payable' },
  { code: '2310', name: 'Federal Income Tax Withheld', type: 'liability', subtype: 'payroll', cashFlow: 'operating', key: 'fit_payable' },
  { code: '2320', name: 'Social Security & Medicare Payable', type: 'liability', subtype: 'payroll', cashFlow: 'operating', key: 'fica_payable' },
  { code: '2330', name: 'State Income Tax Withheld', type: 'liability', subtype: 'payroll', cashFlow: 'operating', key: 'state_wh_payable' },
  { code: '2340', name: 'State Disability / Leave Insurance Payable', type: 'liability', subtype: 'payroll', cashFlow: 'operating', key: 'state_ins_payable' },
  { code: '2350', name: 'Federal Unemployment (FUTA) Payable', type: 'liability', subtype: 'payroll', cashFlow: 'operating', key: 'futa_payable' },
  { code: '2360', name: 'State Unemployment Payable', type: 'liability', subtype: 'payroll', cashFlow: 'operating', key: 'suta_payable' },
  { code: '2370', name: 'Retirement Plan Contributions Payable', type: 'liability', subtype: 'payroll', cashFlow: 'operating', key: 'deductions_payable' },
  { code: '2700', name: 'Loans Payable', type: 'liability', subtype: 'long_term', cashFlow: 'financing' },

  // Equity 3000-3999
  { code: '3000', name: "Owner's Capital", type: 'equity', subtype: 'capital', cashFlow: 'financing' },
  { code: '3100', name: "Owner's Draws", type: 'equity', subtype: 'draws', cashFlow: 'financing' },
  { code: '3900', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings', cashFlow: 'operating', key: 'retained_earnings' },

  // Revenue 4000-4999
  { code: '4000', name: 'Sales', type: 'revenue', subtype: 'operating' },
  { code: '4100', name: 'Service Revenue', type: 'revenue', subtype: 'operating' },
  { code: '4900', name: 'Interest Income', type: 'revenue', subtype: 'other' },

  // Expenses 5000-6999
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', subtype: 'cogs' },
  { code: '6000', name: 'Advertising', type: 'expense', subtype: 'operating' },
  { code: '6050', name: 'Bank Fees', type: 'expense', subtype: 'operating' },
  { code: '6100', name: 'Depreciation', type: 'expense', subtype: 'operating' },
  { code: '6150', name: 'Insurance', type: 'expense', subtype: 'operating' },
  { code: '6200', name: 'Office Supplies', type: 'expense', subtype: 'operating' },
  { code: '6250', name: 'Professional Fees', type: 'expense', subtype: 'operating' },
  { code: '6300', name: 'Rent', type: 'expense', subtype: 'operating' },
  { code: '6350', name: 'Utilities', type: 'expense', subtype: 'operating' },
  { code: '6400', name: 'Wages & Salaries', type: 'expense', subtype: 'payroll', key: 'wages_expense' },
  { code: '6410', name: 'Payroll Taxes', type: 'expense', subtype: 'payroll', key: 'payroll_tax_expense' },
  { code: '6500', name: 'Travel & Meals', type: 'expense', subtype: 'operating' },
  { code: '6600', name: 'Vehicle Expense', type: 'expense', subtype: 'operating' },
  { code: '6900', name: 'Interest Expense', type: 'expense', subtype: 'other' },
]);
