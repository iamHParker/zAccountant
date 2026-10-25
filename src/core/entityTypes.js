// How a business is organized, and the federal income tax return its books feed. ℹ️ A single-member LLC
// is "disregarded" by the IRS unless it elects otherwise, so it files like a sole proprietor (Schedule C);
// one that elected S-corp status should choose S corporation here.
export const ENTITY_TYPES = Object.freeze({
  individual: { label: 'Individual (personal books)', taxForm: 'Form 1040 (personal)' },
  sole_proprietor: { label: 'Sole proprietor', taxForm: 'Schedule C (Form 1040)' },
  single_member_llc: { label: 'Single-member LLC', taxForm: 'Schedule C (Form 1040)' },
  partnership: { label: 'Partnership or multi-member LLC', taxForm: 'Form 1065' },
  s_corp: { label: 'S corporation (or LLC taxed as one)', taxForm: 'Form 1120-S' },
  c_corp: { label: 'C corporation', taxForm: 'Form 1120' },
});
export const ENTITY_KEYS = Object.freeze(Object.keys(ENTITY_TYPES));
