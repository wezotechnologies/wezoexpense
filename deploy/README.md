# Deploying to the Azure VM

Zero-downtime blue/green deploys on a single Ubuntu VM, driven by GitHub
Actions. No container registry, no orchestrator — which suits an internal tool
with a handful of users and keeps the running cost to one small VM.

**Why not Azure Static Web Apps:** this app is not static. 47 of its 50 routes
are server-rendered on demand, it has 26 server-side API routes, a Node-runtime
proxy (`proxy.ts`), a Prisma connection pool, and native dependencies (`sharp`,
`pdfkit`). It needs a Node process, so it needs a VM, App Service or Container
Apps.

---

## How zero downtime works

Two copies of the app run as systemd services on different loopback ports:

```
        nginx :80/:443
              |
     upstream wezo_app          <- one line, rewritten per deploy
        /            \
  wezo@blue        wezo@green
   :3001             :3002
```

A deploy never touches the colour that is serving:

1. The new release is unpacked into `/opt/wezo/releases/<timestamp>-<sha>/`.
2. Migrations are applied (`prisma migrate deploy` — never resets, never prompts).
3. The **idle** colour is pointed at the new release and started.
4. It is polled on `/api/health` until `ready: true`. That requires a live
   database connection, so a release that boots but cannot reach Postgres never
   receives traffic.
5. Only then is nginx's upstream rewritten and **reloaded** (not restarted), so
   requests already in flight on the old colour finish normally.
6. The old colour is drained for 5s, then stopped. It stays on disk as the
   instant rollback target.

If the health check fails, the new colour is stopped and nginx is never touched
— the deploy aborts with the previous version still serving. CI also attempts
an automatic rollback if any later step fails.

### Migration compatibility — the one thing to watch

Step 2 runs *before* the switch, so for a few seconds the **old code runs
against the new schema**. Additive changes are safe: a new table, a new nullable
column, a new index. A destructive change is not — dropping or renaming a column
the old code still selects will error during that window.

Deploy destructive changes as two releases:

| Release | Migration | Code |
|---|---|---|
| 1 | add the new column, backfill it | write to both, read the old |
| 2 | drop the old column | read the new |

> **New to this?** [`WALKTHROUGH.md`](WALKTHROUGH.md) is the same setup written
> as numbered steps with a check after each one, including the SiteGround DNS
> record and the Azure firewall screens. Start there; this file is the reference.

---

## One-time VM setup

SSH in, then:

```bash
git clone https://github.com/wezotechnologies/wezoexpense.git /tmp/wezo-src
sudo bash /tmp/wezo-src/deploy/provision.sh
```

That installs Node 20, nginx, ufw, a dedicated unprivileged `wezo` service
account, the `/opt/wezo` release layout, both systemd services, and a
least-privilege sudoers rule so the deploy user can restart *only* these
services and reload nginx — not act as root generally.

### 1. Write the secrets

```bash
sudo -u wezo nano /opt/wezo/shared/.env
```

```bash
DATABASE_URL="postgresql://wezoexpcalc:<URL-ENCODED-PASSWORD>@wezoexpcalc.postgres.database.azure.com:5432/wezo_expenses?sslmode=verify-full"

AUTH_SECRET="<openssl rand -base64 32>"
NEXTAUTH_SECRET="<same value>"
NEXTAUTH_URL="https://expense.wezo.co"     # the public URL, with scheme

OPENAI_API_KEY="sk-proj-..."                 # either or both providers
ANTHROPIC_API_KEY="sk-ant-..."
OPENAI_MODEL="gpt-4.1-mini"

AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=wezoexpensecalc;AccountKey=...;EndpointSuffix=core.windows.net"
AZURE_BLOB_CONTAINER="wezo-receipts"

SUPERADMIN_EMAIL="owner@wezo.co"
SUPERADMIN_PASSWORD="<temporary; forced to change on first sign-in>"

CRON_SECRET="<openssl rand -hex 32>"
```

`NEXTAUTH_URL` must match the public URL exactly. Auth.js builds its callback
URLs from it, so an `http://` value behind TLS breaks sign-in redirects.

### 2. Let the VM reach Postgres

In the Azure Portal, add this VM's public IP to the Postgres server's firewall
rules — and while you are there, **remove any home/office IP** left over from
setup. Then confirm:

```bash
sudo -u wezo bash -c 'set -a; . /opt/wezo/shared/.env; set +a; psql "$DATABASE_URL" -c "select current_database()"'
```

### 3. GitHub repository secrets

Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the VM's public IP or DNS name |
| `DEPLOY_USER` | the SSH user (e.g. `azurewezoexpensecalc`) |
| `DEPLOY_SSH_KEY` | a **private** key whose public half is in that user's `~/.ssh/authorized_keys` |
| `DEPLOY_HOST_KEY` | output of `ssh-keyscan -H <host>` — pins the host key |

Generate a deploy-only key rather than reusing a personal one:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/wezo_deploy -N "" -C "github-actions-deploy"
ssh-copy-id -i ~/.ssh/wezo_deploy.pub <user>@<host>
cat ~/.ssh/wezo_deploy          # -> DEPLOY_SSH_KEY
ssh-keyscan -H <host>           # -> DEPLOY_HOST_KEY
```

`DEPLOY_HOST_KEY` is optional but recommended: without it the workflow accepts
the host key on trust on every run, which a redirected DNS record could abuse.

Optionally set the repository **variable** `PUBLIC_URL` so the GitHub
deployment links to the live site.

### 4. Seed the database (first deploy only)

```bash
cd /opt/wezo/blue      # whichever colour is live
sudo -u wezo npx prisma migrate deploy
sudo -u wezo npm run db:seed
```

### 5. DNS and TLS

Point an A record at the VM, then:

```bash
sudo sed -i 's/server_name _;/server_name expense.wezo.co;/' /etc/nginx/sites-available/wezo.conf
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d expense.wezo.co
```

certbot adds the TLS server block and the HTTP redirect, and installs a renewal
timer. Afterwards set `NEXTAUTH_URL` to the `https://` URL and restart:

```bash
sudo systemctl restart "wezo@$(cat /opt/wezo/active)"
```

### 6. Schedule the recurring job

```bash
sudo -u wezo crontab -e
```

```cron
# Generate due recurring transactions, 01:15 IST daily.
45 19 * * * . /opt/wezo/shared/.env; curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1/api/cron/recurring >/dev/null
```

(19:45 UTC is 01:15 IST. Missed periods are caught up on the next run, so a
skipped night is not a problem.)

---

## Day-to-day

```bash
# What is live, and which build?
cat /opt/wezo/active
curl -s http://127.0.0.1/api/health | jq

# Logs
journalctl -u "wezo@$(cat /opt/wezo/active)" -f

# Deploy: just push to main. To re-run by hand:
sudo bash /opt/wezo/../wezo-src/deploy/deploy.sh /opt/wezo/releases/<release>

# Roll back to the previous release, in a couple of seconds
sudo bash deploy/rollback.sh
```

`/api/health` is restricted to loopback and the Azure probe address in nginx, so
it is not exposed publicly. It reports only whether each dependency answers —
no counts, names or configuration values.

---

## What CI does

`.github/workflows/deploy.yml`, on push to `main`:

**verify** (also runs on pull requests, which never deploy)
- `npm ci`, typecheck, lint
- `npm run verify:logic` — 62 assertions covering IST/UTC boundaries, Decimal
  money, the VAT rules and defensive AI parsing. No server or database needed.
- `npm run build`, then re-install with `--omit=dev`, regenerate the Prisma
  client, and package `release.tar.gz`

The two HTTP suites (`verify:permissions`, `verify:workflows`) are deliberately
**not** run in CI: they mutate data and would bill a real AI call. Run those
against a development database by hand.

**deploy** (main only, one at a time)
- uploads the tarball, runs `deploy/deploy.sh` for the blue/green switch
- confirms `/api/health` reports ready through nginx
- on any failure, attempts `deploy/rollback.sh`

The VM never builds. It receives a tarball that already contains `.next`,
`node_modules` and the generated Prisma client, so a deploy is an unpack plus a
service start — and a build break can never take the site down.
