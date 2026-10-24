# Section 18 — Monetization & Go-to-Market (new)

> Status: **Draft for owner review.** Prices and competitor figures are planning assumptions; competitor
> prices change often and must be re-checked before publishing. All dollar figures USD.

## 18.1 Positioning in one sentence

**zAccountant is the small-business accounting and payroll system that is checked by real professionals:
state-specific compliance for TX, CO, CA and DC, books that cannot silently go out of balance, and a public
Professional Review Board badge — at a lower price than QuickBooks.**

Three proof points used everywhere: (1) *Reviewed* — every tax table and payroll engine is certified by the
Professional Review Board before release; (2) *Secure* — zero-knowledge encryption of sensitive fields, MFA mandatory,
tamper-evident audit trail; (3) *Local* — state payroll rules built and maintained per state, not bolted on.

---

## 18.2 Pricing Model

### Subscription tiers (per company, monthly)

| | **Starter** | **Professional** | **Enterprise** |
|---|---|---|---|
| Monthly price | **$19** | **$49** | **$149** |
| Annual price (2 months free) | $190/yr | $490/yr | $1,490/yr |
| Users | 1 + accountant | 5 + accountant | unlimited |
| Bank connections (Plaid) | 2 | 10 | unlimited (fair use) |
| Double-entry ledger, invoices, bills | ✅ | ✅ | ✅ |
| Balance Sheet / Income Statement / Cash Flow | ✅ | ✅ | ✅ |
| QuickBooks / Excel import | ✅ | ✅ | ✅ + assisted migration |
| Class/location tracking, budgets | — | ✅ | ✅ |
| Approval workflows, custom roles | — | — | ✅ |
| Audit trail export, IP allow-list, SSO | — | — | ✅ |
| Support | email | email + chat | phone + named success manager |

### Add-on modules

| Add-on | Price | Notes |
|---|---|---|
| **Payroll** | $39/mo base + $6 per paid employee/mo | gross-to-net, direct deposit, federal + TX/CO/CA/DC |
| **Tax Compliance & E-Filing** | $25/mo (included free with Payroll in Year 1) | 941/940/W-2, state withholding & UI returns |
| **Professional Review** | $99/quarter | a credentialed board reviewer reviews the company's books quarterly and issues a review letter |
| Extra bank connections | $3/connection/mo | covers Plaid cost + margin |

**Rationale.** Starter undercuts QuickBooks Online Simple Start roughly by half, which matters for the freelancer
segment. Payroll is priced per employee because our cost (tax filings, support) scales with headcount. Plaid costs are
the main variable cost, so connections are capped by tier.

**State pricing.** Same price in all four markets. CA/DC payroll costs us more to support, but differential pricing
confuses buyers; recover cost through the per-employee fee instead.

**Freemium / beta (Jan 1 – Mar 31).** Public beta: all tiers free for 90 days, no card required; payroll in
"calculate-only" mode until each state engine is board-certified. Beta users get **40% off for life** of their first
year when they convert (founding-customer pricing). After GA: 30-day free trial, card required at day 30.

**Annual incentive.** 2 months free (≈17% discount). Accountant-managed clients billed through the firm get 30% wholesale.

---

## 18.3 Go-to-Market Strategy

### Launch timeline

| Milestone | Date | Scope |
|---|---|---|
| Private alpha | Dec 1 | 5–10 friendly businesses + 2 CPA firms; ledger, reports, import |
| **Public beta** | **Jan 1** | self-service signup, Starter/Professional features, payroll calculate-only |
| Payroll GA (TX) | Feb 1 | first certified state engine (simplest: no state income tax) |
| Payroll GA (CO, DC) | Mar 1 | after board certification |
| Payroll GA (CA) | Apr 1 | most complex (SDI, PIT Method B, ETT) |
| General availability + paid plans | Apr 1 | billing on, Enterprise tier, E-filing |

### Segments and channels

| Segment | Channel | Motion |
|---|---|---|
| Freelancers & sole proprietors | SEO, content, app marketplaces | self-service, Starter |
| Small businesses 1–25 employees | accountant referral, Google Ads on "QuickBooks alternative", local chambers of commerce | self-service + chat, Professional + Payroll |
| CPA firms & bookkeepers | direct outreach, state CPA society events (TXCPA, COCPA, CalCPA, GWSCPA) | partner program, multi-client console |
| Firms 25–100 employees | partner-led | Enterprise, assisted migration |

### Messaging vs. QuickBooks

- "Your books, checked by professionals." (Review Board badge)
- "Half the price, none of the surprise price hikes." (price lock for founding customers)
- "Payroll that knows California." (state depth)
- "We can't see your SSNs — and neither can attackers." (zero-knowledge encryption)
- Switching: "Import your QuickBooks file in 10 minutes, with a dry run that shows every number before anything is saved."

### Sales playbook

**Accountants/bookkeepers (direct):** 1) identify firms with 20–200 small-business clients in target states;
2) 20-minute demo focused on multi-client console + import dry-run; 3) free partner account, migrate 3 pilot clients;
4) firm certification (18.6); 5) quarterly business review. Success metric: clients per partner.

**Freelancers (self-service):** landing page → signup → guided 5-step onboarding (business type picks chart of
accounts automatically) → connect bank → first reconciled month. In-app nudges, no sales calls.

**Customer success plan:** day 1 welcome, day 3 "connect bank" nudge, day 7 first-reconciliation check-in,
day 30 "your first month-end close" guide, quarterly health score review for Professional+.

---

## 18.4 Customer Acquisition

- **Landing page & demo:** zaccountant.com with a live sandbox company (no signup) and a 2-minute video.
- **Free trial / freemium:** see 18.2. No permanent free tier (support cost of free accounting users is high).
- **Lead generation:** "QuickBooks price increase calculator", free state payroll tax calculators (TX/CO/CA/DC — strong
  SEO and they reuse our payroll engine), downloadable month-end close checklist.
- **Associations:** exhibit/sponsor at state CPA societies and Small Business Development Centers (SBDCs).
- **Referral program:** customer gives 1 month free, gets 1 month free per paying referral (cap 12/yr).
- **Affiliates (accountants, consultants):** 20% recurring commission for 12 months, or wholesale billing at 30% off.

## 18.5 Retention & Expansion

- **Churn reduction:** health score (logins, reconciled months, bank sync health); at-risk accounts get outreach;
  annual plans; easy data export (trust reduces churn).
- **Upsell / cross-sell:** first employee hired → Payroll; 3+ users → Professional; audit/export or SSO need → Enterprise;
  quarterly Professional Review offered at year-end.
- **Metrics:** monthly logo churn < 3% (SMB benchmark), net revenue retention > 100%, NPS ≥ 40, onboarding completion ≥ 60%.
- **Onboarding program:** in-app checklist, weekly live webinar, help center articles linked from each screen.
- **Accountant training & certification:** "zAccountant Certified Advisor" — 4 hour self-paced course + exam; listed in directory.

## 18.6 Marketing & Positioning

| Competitor | Their strength | Our angle |
|---|---|---|
| QuickBooks Online | market leader, ecosystem | price, professional review, security, state depth |
| Xero | clean UX, bank feeds | US state payroll depth, review board |
| FreshBooks | invoicing simplicity | real double-entry + payroll in one place |

**Content calendar (monthly cadence):** 4 blog posts (1 per state rotation: "Colorado FAMLI explained", etc.),
1 webinar (with a board member), 1 case study after beta, 1 tax-deadline email per month.
**PR & press kit:** founder story (engineer builds accountant-reviewed software), board member bios, screenshots, logo.
**Social:** LinkedIn (accountants), YouTube (tutorials), Reddit/Small-business forums (helpful answers, not ads).

## 18.7 Revenue Projections (planning model)

Assumptions: blended ARPU $42/mo Year 1 → $58 Year 3 (payroll attach grows from 20% to 40%); monthly churn 3%;
gross margin 80% (Plaid, hosting, payments, support).

| | Year 1 (2027) | Year 2 | Year 3 |
|---|---|---|---|
| Paying companies at year end | 1,500 | 5,000 | 12,000 |
| Of which via accountant partners | 35% | 45% | 50% |
| ARR at year end | ~$0.76 M | ~$3.0 M | ~$8.4 M |
| Recognized revenue | ~$0.35 M | ~$1.8 M | ~$5.7 M |

**CAC / LTV targets**

| Segment | CAC target | LTV (ARPU × margin ÷ churn) | LTV:CAC |
|---|---|---|---|
| Self-service freelancer | $150 | $25 × 0.8 ÷ 0.04 = $500 | 3.3 |
| Small business w/ payroll | $400 | $95 × 0.8 ÷ 0.025 = $3,040 | 7.6 |
| Via accountant partner | $120 | $42 × 0.8 ÷ 0.02 = $1,680 | 14 |

**Break-even:** with a lean team (founder + 2 engineers + 1 support/CS + part-time board reviewers ≈ $55k/mo fully
loaded + $10k/mo marketing), break-even ≈ $65k/mo ÷ ($52 × 0.8) ≈ **1,560 paying companies** — reached around month 14–16.

**Funding:** bootstrapped path needs ~$600–800k runway to break-even (or a pre-seed round of $1–1.5 M to accelerate
partner sales). Decision belongs to the owner.

## 18.8 Competitive Analysis

**Feature parity matrix (MVP)**

| Feature | zAccountant | QBO | Xero | FreshBooks |
|---|---|---|---|---|
| Double-entry GL, BS/IS/CF | ✅ | ✅ | ✅ | ✅ |
| Bank feeds | ✅ (Plaid) | ✅ | ✅ | ✅ |
| Payroll built-in (TX/CO/CA/DC) | ✅ | add-on | via Gusto | add-on |
| Professional review of tax logic | ✅ public badge | — | — | — |
| Tamper-evident audit trail | ✅ hash chain | audit log | history | limited |
| Zero-knowledge sensitive fields | ✅ | — | — | — |
| Import dry-run with rollback | ✅ | — | — | — |
| Inventory, projects | Phase 2 | ✅ | ✅ | projects |

**Pricing comparison (verify before publishing):** QBO Simple Start ≈ $35–38/mo, Essentials ≈ $65–75, Plus ≈ $99–115;
Xero ≈ $20–80; FreshBooks ≈ $19–60. zAccountant: $19 / $49 / $149.

**Win/loss template** (`docs/sales/win-loss.md`): deal, segment, competitor, decision driver (price / features /
trust / switching cost), quote, action item.

## 18.9 Partner & Channel Strategy

- **CPA firm integration:** multi-client console, accountant user role free on every plan, bulk month-end close view.
- **Tax professional partnerships:** board members' firms as launch partners; EA/CPA directory for customers who need
  filing help beyond the product.
- **Accountant certification:** see 18.5.
- **Reseller program:** Phase 3 (not at launch).
- **Technology partners:** Plaid (bank feeds), a payments processor for direct deposit/ACH (e.g. via a licensed money
  transmitter partner — we do not hold customer funds ourselves at MVP), IRS e-file (MeF transmitter via partner at MVP),
  state agencies (TWC, CDLE, EDD, DC DOES/OTR).

## 18.10 Customer Support & Success

| Tier | Channels | First response SLA (business hours, CT) |
|---|---|---|
| Starter | email, help center | 1 business day |
| Professional | email + chat | 4 hours |
| Enterprise | phone + chat + named CSM | 1 hour; Sev-1 issues 30 min, 24×7 |
| Payroll issues (all tiers) | priority queue | 2 hours on paydays |

**Knowledge base:** Getting started · Banking · Reports · Payroll by state · Taxes & filings · Import · Security · Troubleshooting.
**Community forum:** Phase 2 (once > 2,000 users). **Video library:** 2–3 minute task videos per screen.

## 18.11 Expansion Plan (beyond TX/CO/CA/DC)

- **Next states (in order):** FL and WA (no state income tax — fast, 2 weeks each), then NY, IL, GA, NC (3–4 weeks each).
- **Per-state process:** research → tax table config → engine → golden tests → board certification → dark launch → GA.
- **Hiring:** one contracted state-specialist (CPA or tax attorney) per new income-tax state, ~10 h/month retainer,
  joins the Review Board for that state.
- **Regulatory roadmap:** state withholding registration, UI agency e-file enrollment, local taxes (e.g. NYC, OH cities)
  scheduled after state-level coverage.
- **Localization:** English at launch; Spanish UI and help content in Year 2 (TX/CA demand).
