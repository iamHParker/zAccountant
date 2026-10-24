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
   only view/restore existing backups. The alternative is a nightly `pg_dump` job to outside storage.

**Done 2026-10-24:** steps 1–7 at `zaccountant-production.up.railway.app` (Hobby plan). Step 8 waits on Homer's
choice (Pro, or our own backup job); he chose to decide later, reminder set for Nov 16.

9. **Developer dashboard.** App service → Variables: `DEVELOPER_EMAILS=<Homer's sign-in email>`. The app redeploys
   and a **Developer** button appears next to ? Help.

Later: custom domain (e.g. app.zaccountant.com, then set `ALLOWED_HOSTS` to include it), `METRICS_TOKEN` for
Grafana, an uptime monitor on `/healthz`.
