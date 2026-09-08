#!/usr/bin/env bash
#
# Instant rollback: switch nginx back to the other colour.
#
#   deploy/rollback.sh
#
# The previous release is still on disk with its own symlink, so this is a
# start + health check + nginx reload — typically a couple of seconds, with no
# rebuild and no download.
#
# It does NOT roll back the database. If the release you are leaving applied a
# destructive migration, the older code may not run against the new schema —
# which is why deploy.sh asks you to split destructive changes across two
# releases.

set -euo pipefail

APP_ROOT="/opt/wezo"
UPSTREAM_CONF="/etc/nginx/conf.d/wezo-upstream.conf"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

declare -A PORTS=([blue]=3001 [green]=3002)

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

CURRENT="$(cat "$APP_ROOT/active" 2>/dev/null || echo blue)"
TARGET=$([[ "$CURRENT" == "blue" ]] && echo green || echo blue)
TARGET_PORT="${PORTS[$TARGET]}"

[[ -L "$APP_ROOT/$TARGET" ]] || die "no previous release on $TARGET — nothing to roll back to"
TARGET_RELEASE="$(readlink -f "$APP_ROOT/$TARGET")"
[[ -d "$TARGET_RELEASE/.next" ]] || die "$TARGET points at $TARGET_RELEASE, which has no build"

log "Rolling back: $CURRENT -> $TARGET ($TARGET_RELEASE)"

log "Starting $TARGET"
sudo systemctl restart "wezo@${TARGET}.service"

log "Waiting for $TARGET to report ready"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
ready=0
while [[ $(date +%s) -lt $deadline ]]; do
  body="$(curl -fsS --max-time 5 "http://127.0.0.1:${TARGET_PORT}/api/health" 2>/dev/null || true)"
  if [[ -n "$body" ]] && echo "$body" | jq -e '.ready == true' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done

if [[ $ready -ne 1 ]]; then
  journalctl -u "wezo@${TARGET}.service" -n 40 --no-pager | sed 's/^/    /'
  sudo systemctl stop "wezo@${TARGET}.service" || true
  die "rollback target is unhealthy — staying on $CURRENT"
fi
ok "$TARGET is ready"

log "Switching nginx"
cat <<EOF | sudo tee "$UPSTREAM_CONF" >/dev/null
# Rolled back by deploy/rollback.sh at $(date -Is)
upstream wezo_app {
    server 127.0.0.1:${TARGET_PORT} max_fails=0;
    keepalive 32;
}
EOF
sudo nginx -t >/dev/null || die "nginx rejected the config"
sudo systemctl reload nginx
echo "$TARGET" > "$APP_ROOT/active"
ok "traffic now on $TARGET"

sleep 5
sudo systemctl stop "wezo@${CURRENT}.service" || true

printf '\n\033[1;32m==> Rolled back to %s\033[0m\n\n' "$TARGET"
