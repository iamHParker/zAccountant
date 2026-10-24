# 6. The browser side (Vue 3, no build step)

The screens are plain files the server sends as they are. There is no compiler, bundler or `node_modules` in the
browser. What is in `public/` is exactly what runs.

| File | What it holds |
|---|---|
| `welcome.html`, `welcome.css`, `welcome.js`, `img/` | the public front page at `/` (services, prices from `GET /api/public/plans`, security, sign-in buttons into `/app`). Plain HTML, no Vue. ⚠️ The Security section's "Coming" list (encryption on the user's side, Swiss servers) is Homer's plan, not fact yet: move an item to "Today" only when it is built |
| `index.html` | the app at `/app`: all the screens' markup: one `<section v-if="tab === '…'">` per tab, plus dialogs |
| `app.js` | the Vue app: `data()` (the state), `computed` (values worked out from the state), `watch.tab` (loads a tab's data), `methods` (button actions) |
| `styles.css` | every style, including print rules |
| `help.js` | the in-app Help guides (searchable; the ? button opens the guide for the current tab) |
| `feedback.js` | the Beta feedback recorder and pictures |
| `templates/` | CSV templates people download for imports |

## How Vue works here, in engineering terms

The page is a drawing whose dimensions are linked to a table of values. `data()` is the table. The markup
references values with `{{ value }}`, `v-model` (a two-way link to an input box), `v-if` (show this only when
something is true) and `v-for` (repeat this for each item in a list). Change a value in a method and every place
that shows it redraws by itself. You never write "find this element and change its text".

## Patterns to follow

- **Calling the server:** `api(method, url, body)` returns the parsed JSON or throws an `Error` whose message is a
  sentence for the person. Wrap user actions in `this.run(() => api(...), 'Saved.')`. It shows the success toast, or
  the error in a red toast, and returns `undefined` on failure, so `if (!r) return;` is all you need.
- **Saves that post money** send an `Idempotency-Key` header (`newKey()` when the form opens). Pressing Save twice,
  or again after a dropped connection, records it once.
- **Permissions:** `can('invoices')` hides what a role can't use. `has('payroll')` hides what the plan doesn't
  include. These only hide; the server refuses anyway.
- **Money in the browser:** amounts arrive as integer cents. Show them with `money(cents)`. Typed amounts are sent
  as text (`"531.25"`), and the server parses them.
- **Dates:** ISO `'YYYY-MM-DD'` everywhere. `usDate()` shows MM/DD/YYYY on printed documents.

## Security rules the browser must follow

The page's Content-Security-Policy allows only scripts and styles from this site, and pictures from this site or
`data:` URLs. In practice:
- **No inline `style="…"` attributes and no inline scripts.** Add a class to `styles.css`.
- Pictures chosen by the person are read as `data:` URLs (`FileReader`), never `blob:` URLs, which are blocked.
- Third-party scripts are served from `node_modules` through a `/vendor/…` route in `src/app.js`, never from a CDN.

## Printing and PDFs

`printPage` prints only the card holding the button (or the section's `.print-me` card). Print rules in
`styles.css` hide navigation, buttons, hints and anything with class `no-print`. People choose "Save as PDF" in
the browser's print window.

## Checking a screen change

Run the app locally and drive it with Playwright (installed in the cloud environment). Sign up, turn on two-step
with `totpCode()` from `src/security/totp.js`, create a company, then click through and take screenshots. See
chapter 8.
