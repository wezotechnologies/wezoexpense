#!/usr/bin/env bash
#
# Confirms that the release behind nginx is serving and reports ready.
# Runs ON the VM; used by deploy.sh after the switch and by CI as the gate that
# decides whether to keep a release or roll it back.
#
# Why this is not a one-line curl:
#
#   `curl http://127.0.0.1/api/health` worked during setup only because the app's
#   server block was the default one on port 80. Enabling TLS changes that.
#   Certbot leaves port 80 as a redirect-only block:
#
#       if ($host = expense.wezo.co) { return 301 https://$host$request_uri; }
#       listen 80;
#       server_name expense.wezo.co;
#       return 404;
#
#   so the loopback check answers 404 for an unrecognised Host and 301 for the
#   right one. Neither is `ready: true`. That is not hypothetical — it rolled
#   back a healthy release minutes after certbot ran, and would have rolled back
#   every release after it.
#
# So: ask for the public URL the app is actually configured with, and use
# --resolve to keep the request on loopback while still presenting the correct
# SNI and Host. That exercises the same server block a real visitor reaches,
# rather than a URL that merely used to work.
#
# The http fallbacks exist for the window before TLS is enabled, when
# NEXTAUTH_URL already names https but certbot has not run yet.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/wezo/shared/.env}"
APP_ROOT="${APP_ROOT:-/opt/wezo}"
APP_USER="${APP_USER:-wezo}"
TIMEOUT="${TIMEOUT:-10}"
# nginx reload does not cut over instantly: workers already handling connections
# finish on the old upstream, so a probe fired immediately after the switch can
# still be answered by the previous release. Retry rather than accept the first
# answer, or the check reports success for a release that is not serving yet.
SETTLE_SECONDS="${SETTLE_SECONDS:-20}"

die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# Which release should be answering: the one the deploy just made active.
# Passing it explicitly overrides that; an empty value skips the assertion,
# which is what a first run before any switch needs.
expected="${1-}"
if [[ -z "${expected+x}" || $# -eq 0 ]]; then
  colour="$(cat "$APP_ROOT/active" 2>/dev/null || true)"
  target="$(readlink -f "$APP_ROOT/$colour" 2>/dev/null || true)"
  expected="${target:+$(basename "$target")}"
fi

# Read as the service account: /opt/wezo/shared is 0700, so an unprivileged
# read here would fail in a way that looks like a missing variable.
public_url="$(
  sudo -u "$APP_USER" bash -c "set -a; . '$ENV_FILE'; set +a; printf '%s' \"\${NEXTAUTH_URL:-}\""
)" || die "could not read $ENV_FILE as $APP_USER"

[[ -n "$public_url" ]] || die "NEXTAUTH_URL is not set in $ENV_FILE"

host="${public_url#*://}"
host="${host%%/*}"
host="${host%%:*}"

# Ordered most- to least-representative of what a real visitor does.
attempt() {
  local label="$1"; shift
  local body version
  body="$("$@" 2>/dev/null)" || return 1
  printf '%s' "$body" | jq -e '.ready == true' >/dev/null 2>&1 || return 1

  if [[ -n "$expected" ]]; then
    version="$(printf '%s' "$body" | jq -r '.version // empty')"
    [[ "$version" == "$expected" ]] || return 1
  fi

  printf '%s' "$body" | jq -c '{status,ready,checks,version,latencyMs}'
  echo "  (verified via $label)"
  return 0
}

probe_all() {
  attempt "https://${host} on loopback" \
    curl -fsS --max-time "$TIMEOUT" \
      --resolve "${host}:443:127.0.0.1" "https://${host}/api/health" && return 0

  attempt "http on loopback with Host: ${host}" \
    curl -fsS --max-time "$TIMEOUT" -H "Host: ${host}" \
      "http://127.0.0.1/api/health" && return 0

  attempt "http://127.0.0.1 (no TLS configured yet)" \
    curl -fsS --max-time "$TIMEOUT" "http://127.0.0.1/api/health" && return 0

  return 1
}

[[ -n "$expected" ]] && echo "  expecting release ${expected}"
deadline=$(( $(date +%s) + SETTLE_SECONDS ))
while :; do
  probe_all && exit 0
  [[ $(date +%s) -lt $deadline ]] || break
  sleep 2
done

# Nothing answered. Say what the app itself thinks, so the log distinguishes
# "the release is broken" from "nginx is not routing to it".
printf '\n\033[1;31m!! nginx did not serve a ready %s for %s\033[0m\n' \
  "${expected:-release}" "$public_url" >&2
for port in 3001 3002; do
  body="$(curl -s --max-time 5 "http://127.0.0.1:${port}/api/health" || true)"
  version="$(printf '%s' "$body" | jq -r '.version // "-"' 2>/dev/null || echo -)"
  ready="$(printf '%s' "$body" | jq -r '.ready // "-"' 2>/dev/null || echo -)"
  printf '   app on :%-5s ready=%-5s version=%s\n' "$port" "$ready" "$version" >&2
done
printf '   nginx: %s, upstream %s\n' \
  "$(systemctl is-active nginx)" \
  "$(sudo grep -o '127.0.0.1:[0-9]*' /etc/nginx/conf.d/wezo-upstream.conf 2>/dev/null || echo '?')" >&2
exit 1
