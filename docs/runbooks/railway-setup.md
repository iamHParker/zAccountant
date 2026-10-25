# Railway setup (first time)

Homer does these steps in the Railway website; Claude sends them one at a time in the project thread.
ℹ️ A Railway **project** is the job folder; inside it are two **services**: the database and the app.

1. **Empty project.** railway.com → New → Empty Project. Rename it zAccountant.
2. **Database.** In the project: + Create (or Add) → Database → PostgreSQL. Leave its name as **Postgres**
   (the variables below refer to it by that name).
3. **App from GitHub.** + Create → GitHub Repo → `iamHParker/zAccountant`. Railway reads `railway.toml` and builds
   with the `Dockerfile`. The first build may fail until step 4 is done; that's expected.
4. **Variables** on the app service (Variables tab → Raw Editor), with the three secrets Claude generates:
   ```
   MIGRATION_DATABASE_URL=${{Postgres.DATABASE_URL}}
   DATABASE_URL=postgresql://zacc_app:<APP DB PASSWORD>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   AUDIT_HMAC_KEY=<secret 1>
   FIELD_ENCRYPTION_KEY=<secret 2, base64 of 32 bytes>
   ```
   - `MIGRATION_DATABASE_URL` is the owner login: it builds the tables at start-up.
   - `DATABASE_URL` is the app's restricted login. The server creates it at start-up from this user name and
     password (`ensureRuntimeRole` in `src/db/grant.js`) and gives it only the rights in `grantRuntimeRole`.
   - **Keep a copy of `AUDIT_HMAC_KEY` and `FIELD_ENCRYPTION_KEY` somewhere safe outside Railway** (a password
     manager). Without the encryption key, stored Social Security numbers can't be read; without the audit key,
     the audit trail can't be verified.
   - Not needed: `ALLOWED_HOSTS` (the app reads `RAILWAY_PUBLIC_DOMAIN`), `TRUST_PROXY` (on by default on Railway),
     `NODE_ENV` (set in the Dockerfile), `PORT` (Railway sets it).
5. **Public address.** App service → Settings → Networking → Generate Domain (gives `something.up.railway.app`).
6. **Deploy and check.** Deployments tab shows "Active"; open `https://<domain>/healthz` → `{"ok":true}`;
   the deploy log shows `runtime database role ready` and `zAccountant running`.
7. **First sign-in.** Open the domain, create the owner account, set up two-step sign-in, save the recovery codes.
8. **Backups.** Postgres service → Backups: turn on scheduled backups (daily). Run the restore drill
   (`docs/runbooks/operations.md`) once before the alpha. **Needs Railway Pro**: on Hobby the Backups tab can
   only view/restore existing backups. The alternative, now built, is the nightly off-site backup to outside
   storage (`docs/runbooks/operations.md` section 4: create the bucket, set the `BACKUP_*` variables).

**Done 2026-10-24:** steps 1–7 at `zaccountant-production.up.railway.app` (Hobby plan). Step 8 waits on Homer's
choice (Pro, or our own backup job); he chose to decide later, reminder set for Nov 16.

9. **Developer dashboard.** App service → Variables: `DEVELOPER_EMAILS=<Homer's sign-in email>`. The app redeploys
   and **Admin** and **Developer** buttons appear next to ? Help. (`ADMIN_EMAILS` gives someone the Admin dashboard only.)
10. **Updates reach the site on their own.** Every PR merged into `main` should start a new deploy (Settings →
    Source: repo `iamHParker/zAccountant`, branch **main**, automatic deploys on). Check it took: the build at the
    top of the app (next to Settings) reads `0.1.0+<first 7 characters of the newest main commit>`. Database
    updates (new migrations) run by themselves at start-up.
    If the build number is old (2026-10-25: the site was still on #34 after #35–#43 merged):
    - Deployments shows a red **Failed** deploy → open it, copy the end of **Build Logs** or **Deploy Logs** to Claude.
    - No new deploys at all → Settings → Source: reconnect the repo or pick branch `main`; then press **Deploy** on
      the newest commit. Railway keeps the last good version running until a new one starts cleanly.

Later: custom domain (e.g. app.zaccountant.com, then set `ALLOWED_HOSTS` to include it), `METRICS_TOKEN` for
Grafana, an uptime monitor on `/healthz`.
