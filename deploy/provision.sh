#!/usr/bin/env bash
#
# One-time VM provisioning for the Wezo Expense Tracker.
# Ubuntu 22.04/24.04 on Azure. Run once, as a sudo-capable user:
#
#   curl -fsSL https://raw.githubusercontent.com/wezotechnologies/wezoexpense/main/deploy/provision.sh | sudo bash
#
# or, from a clone:  sudo bash deploy/provision.sh
#
# Idempotent — safe to re-run.
#
# What it sets up:
#   * Node.js 22 LTS (the Azure SDK, openai and unpdf all declare >= 22)
#   * a dedicated unprivileged `wezo` service account that owns the app
#   * /opt/wezo blue/green release layout
#   * two systemd services (blue on 3001, green on 3002)
#   * nginx as the TLS-terminating reverse proxy, with an upstream file the
#     deploy script rewrites to switch colours
#   * ufw allowing only SSH + HTTP/HTTPS
#
# It deliberately does NOT write secrets. After running, create
# /opt/wezo/shared/.env (see the runbook in deploy/README.md).

set -euo pipefail

APP_USER="wezo"
APP_ROOT="/opt/wezo"
NODE_MAJOR="22"
BLUE_PORT="3001"
GREEN_PORT="3002"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/provision.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
log "Updating package lists"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

log "Installing base packages"
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg git nginx ufw rsync jq \
  postgresql-client

# ---------------------------------------------------------------------------
log "Installing Node.js ${NODE_MAJOR}.x"
# 22, not 20: @azure/*, openai and unpdf declare engines.node >= 22. They load on
# 20, but relying on that is a latent runtime risk in code paths not yet hit.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
node -v
npm -v

# ---------------------------------------------------------------------------
log "Creating the ${APP_USER} service account"
# No login shell and no password: this account exists only to run the process.
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${APP_USER}" \
          --shell /usr/sbin/nologin "$APP_USER"
fi

log "Creating the release layout under ${APP_ROOT}"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 \
  "$APP_ROOT" "$APP_ROOT/releases" "$APP_ROOT/shared"
# Secrets live here. 0700 so only the service account can read them.
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$APP_ROOT/shared"

# Per-colour port files, read by the systemd template unit.
printf 'PORT=%s\n' "$BLUE_PORT"  > "$APP_ROOT/shared/blue.env"
printf 'PORT=%s\n' "$GREEN_PORT" > "$APP_ROOT/shared/green.env"
chown "$APP_USER:$APP_USER" "$APP_ROOT/shared/blue.env" "$APP_ROOT/shared/green.env"
chmod 0644 "$APP_ROOT/shared/blue.env" "$APP_ROOT/shared/green.env"

if [[ ! -f "$APP_ROOT/shared/.env" ]]; then
  install -o "$APP_USER" -g "$APP_USER" -m 0600 /dev/null "$APP_ROOT/shared/.env"
  warn "Created an EMPTY ${APP_ROOT}/shared/.env — fill it in before deploying."
  warn "See deploy/README.md for the required variables."
fi

# Start on blue by default.
if [[ ! -f "$APP_ROOT/active" ]]; then
  echo blue > "$APP_ROOT/active"
  chown "$APP_USER:$APP_USER" "$APP_ROOT/active"
fi
# 0664, not the umask's 0644: deploy.sh rewrites this on every switch, and the
# deploy user is in the wezo group. At 0644 that write needs root, and it
# happens after nginx has switched — the worst possible place to hit EACCES.
chmod 0664 "$APP_ROOT/active"

# ---------------------------------------------------------------------------
log "Installing the systemd template unit"
cp "$(dirname "$0")/wezo@.service" /etc/systemd/system/wezo@.service 2>/dev/null \
  || curl -fsSL https://raw.githubusercontent.com/wezotechnologies/wezoexpense/main/deploy/wezo@.service \
       -o /etc/systemd/system/wezo@.service
systemctl daemon-reload
systemctl enable wezo@blue.service wezo@green.service >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
log "Configuring nginx"
# The upstream lives in its own file so the deploy script can swap colours by
# rewriting one line and reloading, with no edit to the site config.
if [[ ! -f /etc/nginx/conf.d/wezo-upstream.conf ]]; then
  cat > /etc/nginx/conf.d/wezo-upstream.conf <<EOF
# Rewritten by deploy/deploy.sh — do not edit by hand.
upstream wezo_app {
    server 127.0.0.1:${BLUE_PORT} max_fails=0;
    keepalive 32;
}
EOF
fi

cp "$(dirname "$0")/nginx/wezo.conf" /etc/nginx/sites-available/wezo.conf 2>/dev/null \
  || curl -fsSL https://raw.githubusercontent.com/wezotechnologies/wezoexpense/main/deploy/nginx/wezo.conf \
       -o /etc/nginx/sites-available/wezo.conf
ln -sf /etc/nginx/sites-available/wezo.conf /etc/nginx/sites-enabled/wezo.conf
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable --now nginx
systemctl reload nginx

# ---------------------------------------------------------------------------
log "Firewall"
# Azure's Network Security Group is the outer gate; ufw is defence in depth.
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/    /'

# ---------------------------------------------------------------------------
log "Allowing the deploy user to manage just this app"
# The CI deploy user needs to restart the services and reload nginx, and
# nothing else. Full sudo is not required.
DEPLOY_USER="${SUDO_USER:-$(logname 2>/dev/null || echo azureuser)}"
cat > /etc/sudoers.d/wezo-deploy <<EOF
# Least-privilege deploy rights for ${DEPLOY_USER}.
#
# On an Azure image the default admin already holds NOPASSWD:ALL from
# cloud-init, so this rule grants nothing extra there. It exists so a deploy
# user WITHOUT blanket sudo still works — which means it has to cover
# everything deploy.sh actually calls through sudo, or the script fails
# mid-switch on a locked-down host.

# Act as the unprivileged service account: read the secrets file the way the app
# does, and apply migrations as its owner. Broad, but strictly less privileged
# than root — ${APP_USER} is a nologin account that owns only its own release tree.
${DEPLOY_USER} ALL=(${APP_USER}) NOPASSWD: ALL

${DEPLOY_USER} ALL=(root) NOPASSWD: /bin/systemctl start wezo@blue.service, \\
  /bin/systemctl start wezo@green.service, \\
  /bin/systemctl stop wezo@blue.service, \\
  /bin/systemctl stop wezo@green.service, \\
  /bin/systemctl restart wezo@blue.service, \\
  /bin/systemctl restart wezo@green.service, \\
  /bin/systemctl is-active wezo@blue.service, \\
  /bin/systemctl is-active wezo@green.service, \\
  /usr/sbin/nginx -t, \\
  /bin/systemctl reload nginx, \\
  /usr/bin/tee /etc/nginx/conf.d/wezo-upstream.conf, \\
  /usr/bin/tee /opt/wezo/shared/blue.env, \\
  /usr/bin/tee /opt/wezo/shared/green.env, \\
  /usr/bin/tee /opt/wezo/active, \\
  /bin/chown wezo\\:wezo /opt/wezo/shared/blue.env, \\
  /bin/chown wezo\\:wezo /opt/wezo/shared/green.env, \\
  /usr/bin/journalctl -u wezo@blue.service *, \\
  /usr/bin/journalctl -u wezo@green.service *
EOF
chmod 0440 /etc/sudoers.d/wezo-deploy
visudo -c -f /etc/sudoers.d/wezo-deploy

# The deploy user must be able to write releases.
usermod -aG "$APP_USER" "$DEPLOY_USER" 2>/dev/null || true
chmod 0775 "$APP_ROOT" "$APP_ROOT/releases"
chgrp "$APP_USER" "$APP_ROOT" "$APP_ROOT/releases"

# ---------------------------------------------------------------------------
log "Provisioning complete"
cat <<EOF

Next steps (numbered walkthrough in deploy/WALKTHROUGH.md, reference in
deploy/README.md):

  1. Write the secrets, if you have not already. This script creates
     ${APP_ROOT}/shared/.env empty on a first run, and a deploy refuses to
     run until it has content. Copy the file in rather
     than pasting into an editor — a paste that is not saved leaves it
     empty, and that only surfaces later in the deploy log:
       # from your machine
       scp <keyfile> prod.env ${DEPLOY_USER}@<this VM>:/tmp/wezo.env
       # then here
       sudo install -o ${APP_USER} -g ${APP_USER} -m 600 /tmp/wezo.env \\
         ${APP_ROOT}/shared/.env && rm /tmp/wezo.env
     Must include DATABASE_URL, AUTH_SECRET, NEXTAUTH_URL,
     AZURE_STORAGE_CONNECTION_STRING, an AI key, CRON_SECRET.
     Any password inside DATABASE_URL must be URL-encoded: an unencoded
     '@' or ':' silently produces a different host.

  2. Allow this VM through the Postgres firewall (Azure Portal), then prove
     the connection string itself works — this is what the deploy's health
     gate needs:
       sudo -u ${APP_USER} bash -c 'set -a; . ${APP_ROOT}/shared/.env; set +a; psql "\$DATABASE_URL" -c "select current_database()"'

  3. Add these GitHub repository secrets so CI can deploy:
       DEPLOY_HOST=$(curl -fsS -H Metadata:true --noproxy '*' \
         'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text' 2>/dev/null || echo '<this VM public IP>')
       DEPLOY_USER=${DEPLOY_USER}
       DEPLOY_SSH_KEY=<private key whose public half is in ~${DEPLOY_USER}/.ssh/authorized_keys>

  4. Point DNS at this VM, then enable TLS:
       sudo apt-get install -y certbot python3-certbot-nginx
       sudo certbot --nginx -d expense.wezo.co

  5. Push to main. The workflow builds, gates on tests, and deploys.

EOF
