#!/usr/bin/env bash
#
# Blue/green release switch. Runs ON the VM, invoked by CI over SSH:
#
#   deploy/deploy.sh /opt/wezo/releases/2026-09-08T10-00-00
#
# How it achieves zero downtime:
#
#   1. The live colour keeps serving throughout.
#   2. Migrations are applied first (see the note on compatibility below).
#   3. The IDLE colour is pointed at the new release and started.
#   4. It is polled on /api/health until `ready` is true — which requires a
#      working database connection, so a release that boots but cannot reach
#      Postgres never receives traffic.
#   5. Only then does nginx switch, via a config reload (not a restart), so
#      in-flight requests on the old colour finish normally.
#   6. The old colour is left running briefly, then stopped.
#
#   If the health check fails, the new colour is stopped and nginx is never
#   touched — the deploy aborts with the live version still serving.
#
# NOTE ON MIGRATIONS: step 2 runs before the switch, so for a few seconds the
# OLD code runs against the NEW schema. Additive migrations (new nullable
# column, new table, new index) are safe. A destructive one (drop/rename a
# column still read by the old code) will error during that window — deploy
# those as two releases: add and backfill first, remove later.

set -euo pipefail

RELEASE_DIR="${1:-}"
# Resolved so sibling scripts (healthcheck.sh) are found wherever this copy of
# the deploy directory was dropped, rather than at a hardcoded path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="/opt/wezo"
APP_USER="wezo"
UPSTREAM_CONF="/etc/nginx/conf.d/wezo-upstream.conf"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

declare -A PORTS=([blue]=3001 [green]=3002)

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$RELEASE_DIR" ]] || die "usage: deploy.sh <release-dir>"
[[ -d "$RELEASE_DIR" ]] || die "no such release: $RELEASE_DIR"
[[ -d "$RELEASE_DIR/.next" ]] || die "release has no .next build: $RELEASE_DIR"
# provision.sh creates this file empty on purpose, so refuse rather than start a
# release that would boot without a database or an auth secret. Checked before
# anything is linked or migrated: the live colour is untouched either way.
#
# Both checks run AS THE SERVICE ACCOUNT, not as the deploy user. /opt/wezo/shared
# is 0700 wezo, so an unprivileged `[[ -s ... ]]` here returns false for a
# perfectly good file — reporting "missing or empty" for a secrets file that is
# present and complete, which is unfalsifiable from the deploy log. Asking the
# account that actually has to read it at runtime is both correct and a stronger
# check: it fails if the file is empty *or* if the app could not read it.
if ! sudo -u "$APP_USER" test -s "$APP_ROOT/shared/.env"; then
  die "$APP_USER cannot read a non-empty $APP_ROOT/shared/.env — fill it in (deploy/WALKTHROUGH.md, Part 5). Nothing was changed."
fi
if sudo -u "$APP_USER" grep -q '__DB_PASSWORD__' "$APP_ROOT/shared/.env"; then
  die "$APP_ROOT/shared/.env still has the __DB_PASSWORD__ placeholder (WALKTHROUGH Part 5c). Nothing was changed."
fi

# ---------------------------------------------------------------------------
# Work out which colour is live and which is therefore idle.
LIVE="$(cat "$APP_ROOT/active" 2>/dev/null || echo blue)"
[[ "$LIVE" == "blue" || "$LIVE" == "green" ]] || LIVE=blue
IDLE=$([[ "$LIVE" == "blue" ]] && echo green || echo blue)
IDLE_PORT="${PORTS[$IDLE]}"

log "Live colour: $LIVE — deploying onto $IDLE (port $IDLE_PORT)"

# ---------------------------------------------------------------------------
# Keep a copy somewhere stable. The scripts arrive in /tmp, which does not
# survive a reboot, and the health check is the first thing anyone reaches for
# when the site looks wrong.
sudo install -m 755 "$SCRIPT_DIR/healthcheck.sh" "$APP_ROOT/healthcheck.sh" 2>/dev/null || true

log "Linking the release and its shared secrets"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/$IDLE"
# The app reads .env from its working directory as well as from systemd, so a
# symlink keeps `npm run db:deploy` and any manual tsx script working too.
ln -sfn "$APP_ROOT/shared/.env" "$RELEASE_DIR/.env"
# Cosmetic — the symlinks work regardless of who owns them, so never block on it.
sudo -n chown -h "$APP_USER:$APP_USER" "$APP_ROOT/$IDLE" "$RELEASE_DIR/.env" 2>/dev/null || true
ok "$APP_ROOT/$IDLE -> $RELEASE_DIR"

# ---------------------------------------------------------------------------
log "Applying database migrations"
# `migrate deploy` only applies pending migrations; it never resets or prompts.
if sudo -u "$APP_USER" --preserve-env=PATH \
     env -C "$RELEASE_DIR" npx prisma migrate deploy 2>&1 | sed 's/^/    /'; then
  ok "schema up to date"
else
  die "migrations failed — nothing was switched, $LIVE is still serving"
fi

# ---------------------------------------------------------------------------
# Stamp the release id into the colour's env file so the running process — and
# therefore /api/health — can report exactly which build is serving.
log "Recording the release id for $IDLE"
RELEASE_ID="$(basename "$RELEASE_DIR")"
{
  printf 'PORT=%s\n' "$IDLE_PORT"
  printf 'WEZO_RELEASE=%s\n' "$RELEASE_ID"
} | sudo tee "$APP_ROOT/shared/${IDLE}.env" >/dev/null
sudo chown "$APP_USER:$APP_USER" "$APP_ROOT/shared/${IDLE}.env"
ok "WEZO_RELEASE=$RELEASE_ID"

log "Starting $IDLE"
sudo systemctl restart "wezo@${IDLE}.service"

log "Waiting for $IDLE to report ready (timeout ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
ready=0
while [[ $(date +%s) -lt $deadline ]]; do
  body="$(curl -fsS --max-time 5 "http://127.0.0.1:${IDLE_PORT}/api/health" 2>/dev/null || true)"
  if [[ -n "$body" ]] && echo "$body" | jq -e '.ready == true' >/dev/null 2>&1; then
    ready=1
    echo "$body" | jq -c '{status,ready,checks,latencyMs}' | sed 's/^/    /'
    break
  fi
  sleep 2
done

if [[ $ready -ne 1 ]]; then
  printf '\n\033[1;31m  health check failed — last 40 log lines from %s:\033[0m\n' "$IDLE"
  sudo journalctl -u "wezo@${IDLE}.service" -n 40 --no-pager | sed 's/^/    /'
  sudo systemctl stop "wezo@${IDLE}.service" || true
  die "aborting: $LIVE is untouched and still serving traffic"
fi
ok "$IDLE is ready"

# ---------------------------------------------------------------------------
log "Switching nginx to $IDLE"
cat <<EOF | sudo tee "$UPSTREAM_CONF" >/dev/null
# Rewritten by deploy/deploy.sh at $(date -Is) — do not edit by hand.
upstream wezo_app {
    server 127.0.0.1:${IDLE_PORT} max_fails=0;
    keepalive 32;
}
EOF

if ! sudo nginx -t 2>&1 | sed 's/^/    /'; then
  # Put the old upstream back before failing, so we don't leave nginx broken.
  cat <<EOF | sudo tee "$UPSTREAM_CONF" >/dev/null
upstream wezo_app {
    server 127.0.0.1:${PORTS[$LIVE]} max_fails=0;
    keepalive 32;
}
EOF
  sudo systemctl reload nginx || true
  sudo systemctl stop "wezo@${IDLE}.service" || true
  die "nginx rejected the new config — rolled back to $LIVE"
fi

# reload, not restart: existing connections are served to completion.
sudo systemctl reload nginx
# Written through sudo: `active` is 0644 wezo:wezo, so a plain redirect from the
# deploy user fails with EACCES — and it fails *here*, after nginx has already
# switched, which would report a red deploy and fire a rollback over a release
# that is serving perfectly well.
printf '%s\n' "$IDLE" | sudo tee "$APP_ROOT/active" >/dev/null
ok "traffic now on $IDLE"

# ---------------------------------------------------------------------------
log "Verifying through nginx"
# Delegated to healthcheck.sh rather than curling a fixed URL: once TLS is on,
# port 80 is a redirect-only block and loopback http can no longer answer. This
# stays a warning — the release has already passed its own health gate on its
# port, and CI runs the same script as the authoritative check.
if "$SCRIPT_DIR/healthcheck.sh" "$RELEASE_ID" 2>&1 | sed 's/^/    /'; then
  ok "nginx is serving the new release"
else
  printf '\033[1;33m  [warn]\033[0m nginx health probe did not confirm; %s is running on :%s\n' "$IDLE" "$IDLE_PORT"
fi

# ---------------------------------------------------------------------------
# Leave the old colour up for a few seconds so any request that nginx had
# already routed there can finish, then stop it to free memory.
log "Draining and stopping $LIVE"
sleep 5
sudo systemctl stop "wezo@${LIVE}.service" || true
ok "$LIVE stopped (it stays as the instant rollback target)"

# ---------------------------------------------------------------------------
log "Pruning old releases (keeping $KEEP_RELEASES)"
# Never delete a release that either colour symlink points at.
keep_blue="$(readlink -f "$APP_ROOT/blue" 2>/dev/null || true)"
keep_green="$(readlink -f "$APP_ROOT/green" 2>/dev/null || true)"
mapfile -t all < <(ls -1dt "$APP_ROOT"/releases/*/ 2>/dev/null || true)
removed=0
for i in "${!all[@]}"; do
  dir="$(readlink -f "${all[$i]}")"
  [[ "$dir" == "$keep_blue" || "$dir" == "$keep_green" ]] && continue
  if (( i >= KEEP_RELEASES )); then
    rm -rf "$dir" && removed=$((removed+1))
  fi
done
ok "removed $removed old release(s)"

printf '\n\033[1;32m==> Deployed successfully. Live: %s (port %s)\033[0m\n' "$IDLE" "$IDLE_PORT"
printf '    release:  %s\n' "$RELEASE_DIR"
printf '    rollback: deploy/rollback.sh\n\n'
