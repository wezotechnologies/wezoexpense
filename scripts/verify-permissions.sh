#!/bin/zsh
# Run against a running dev server: npm run dev, then ./scripts/verify-permissions.sh
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
export REPO
# End-to-end RBAC + workflow verification against the running dev server.
set -u
B=http://localhost:3000
WORK="${TMPDIR:-/tmp}/wezo-verify"
mkdir -p "$WORK"
cd "$WORK"

pass=0; fail=0
ok()   { print -r -- "  ok   $1"; pass=$((pass+1)) }
bad()  { print -r -- "  FAIL $1"; fail=$((fail+1)) }
check(){ if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1 — got '$2', want '$3'"; fi }

# Sign in as <email> <password> <jarfile>; leaves a cookie jar behind.
signin() {
  local email=$1 pw=$2 jar=$3
  rm -f "$jar"
  local t
  t=$(curl -s -c "$jar" "$B/api/auth/csrf" | node -pe "JSON.parse(require('fs').readFileSync(0)).csrfToken")
  curl -s -b "$jar" -c "$jar" -o /dev/null -X POST "$B/api/auth/callback/credentials" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "csrfToken=$t" --data-urlencode "email=$email" --data-urlencode "password=$pw"
  curl -s -b "$jar" "$B/api/auth/session" | node -pe "const d=JSON.parse(require('fs').readFileSync(0)); d&&d.user? d.user.role : 'NONE'"
}

code() { curl -s -b "$1" -o /dev/null -w "%{http_code}" "${@:2}" }
json() { curl -s -b "$1" "${@:2}" }

print -r -- "=============== 1. Superadmin session ==============="
# The seed sets SUPERADMIN_PASSWORD and forces a change on first sign-in, so
# try that first and rotate to a known value the rest of the suite can reuse.
SEED_PW=$(grep '^SUPERADMIN_PASSWORD=' "$REPO/.env" | cut -d'"' -f2)
SUPER_PW="WezoBooks2026x"
SUPER_ROLE=$(signin owner@wezo.co "$SUPER_PW" super.jar)
if [[ "$SUPER_ROLE" != "SUPERADMIN" && -n "$SEED_PW" ]]; then
  SUPER_ROLE=$(signin owner@wezo.co "$SEED_PW" super.jar)
  if [[ "$SUPER_ROLE" == "SUPERADMIN" ]]; then
    curl -s -b super.jar -o /dev/null -X PATCH "$B/api/me/password" \
      -H "Content-Type: application/json" \
      -d "{\"currentPassword\":\"$SEED_PW\",\"newPassword\":\"$SUPER_PW\"}"
    SUPER_ROLE=$(signin owner@wezo.co "$SUPER_PW" super.jar)
  fi
fi
check "superadmin signs in" "$SUPER_ROLE" "SUPERADMIN"

print -r -- "\n=============== 2. Superadmin creates Admin + Employee ==============="
for spec in "Asha Admin:asha@wezo.co:ADMIN" "Ravi Employee:ravi@wezo.co:EMPLOYEE"; do
  name="${spec%%:*}"; rest="${spec#*:}"; email="${rest%%:*}"; role="${rest##*:}"
  body=$(json super.jar -X POST "$B/api/users" -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"email\":\"$email\",\"role\":\"$role\",\"password\":\"TempPass2026a\"}")
  if print -r -- "$body" | grep -q '"id"'; then ok "created $role $email"
  elif print -r -- "$body" | grep -q "already exists"; then ok "$role $email already exists"
  else bad "create $role: $body"; fi
done

print -r -- "\n=============== 3. Employee cannot manage users ==============="
# Idempotent: on a first run the temp password works and is then rotated; on a
# re-run the rotated one is already in place.
EMP_ROLE=$(signin ravi@wezo.co 'TempPass2026a' emp.jar)
if [[ "$EMP_ROLE" == "EMPLOYEE" ]]; then
  curl -s -b emp.jar -o /dev/null -X PATCH "$B/api/me/password" -H "Content-Type: application/json" \
    -d '{"currentPassword":"TempPass2026a","newPassword":"RaviBooks2026a"}'
fi
EMP_ROLE=$(signin ravi@wezo.co 'RaviBooks2026a' emp.jar)
check "employee signs in (post password change)" "$EMP_ROLE" "EMPLOYEE"

check "POST /api/users forbidden"        "$(code emp.jar -X POST "$B/api/users" -H 'Content-Type: application/json' -d '{"name":"x","email":"x@y.co","role":"ADMIN","password":"Password123"}')" "403"
check "GET /api/settings forbidden"      "$(code emp.jar "$B/api/settings")" "403"
check "GET /api/audit forbidden"         "$(code emp.jar "$B/api/audit")" "403"
check "GET /api/budgets forbidden"       "$(code emp.jar "$B/api/budgets")" "403"
check "GET /api/recurring forbidden"     "$(code emp.jar "$B/api/recurring")" "403"
check "POST /api/periods/lock forbidden" "$(code emp.jar -X POST "$B/api/periods/lock" -H 'Content-Type: application/json' -d '{"month":"2026-09"}')" "403"
check "POST /api/import forbidden"       "$(code emp.jar -X POST "$B/api/import" -H 'Content-Type: application/json' -d '{"mode":"preview","csv":"type,date,amountInr"}')" "403"
check "P&L report forbidden"             "$(code emp.jar "$B/api/reports/pnl")" "403"
check "own submission summary allowed"   "$(code emp.jar "$B/api/reports/user-submissions")" "200"

print -r -- "\n=============== 4. Employee submits (must be PENDING) ==============="
CAT=$(/opt/homebrew/opt/postgresql@14/bin/psql -d wezo_expenses -tAc "select id from \"Category\" where name='Travel'")
EMP_TXN=$(json emp.jar -X POST "$B/api/transactions" -H "Content-Type: application/json" \
  -d "{\"type\":\"EXPENSE\",\"date\":\"2026-09-15\",\"amountInr\":\"2450.00\",\"categoryId\":\"$CAT\",\"notes\":\"Client visit cab\",\"saveAsApproved\":true}")
EMP_TXN_ID=$(print -r -- "$EMP_TXN" | node -pe "JSON.parse(require('fs').readFileSync(0)).id")
EMP_TXN_STATUS=$(print -r -- "$EMP_TXN" | node -pe "JSON.parse(require('fs').readFileSync(0)).status")
check "employee submission is PENDING despite saveAsApproved" "$EMP_TXN_STATUS" "PENDING"

check "employee cannot self-approve" "$(code emp.jar -X POST "$B/api/transactions/$EMP_TXN_ID/approve")" "403"

print -r -- "\n=============== 5. Employee sees ONLY their own rows ==============="
# Guarantee there is at least one row the employee did NOT create, so the
# scoping assertions are meaningful no matter what order suites run in.
SUPER_TXN_ID=$(json super.jar -X POST "$B/api/transactions" -H "Content-Type: application/json" \
  -d "{\"type\":\"INCOME\",\"date\":\"2026-09-14\",\"amountInr\":\"5000.00\",\"notes\":\"Owner-only control row\",\"saveAsApproved\":true}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).id")
EMP_LIST=$(json emp.jar "$B/api/transactions?perPage=100")
EMP_TOTAL=$(print -r -- "$EMP_LIST" | node -pe "JSON.parse(require('fs').readFileSync(0)).total")
EMP_OTHERS=$(print -r -- "$EMP_LIST" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const mine=d.rows.filter(r=>r.createdByName==='Ravi Employee').length;
console.log(d.rows.length-mine);
")
check "employee list contains only own rows" "$EMP_OTHERS" "0"
print -r -- "       (employee sees $EMP_TOTAL row(s) total)"

SUPER_TOTAL=$(json super.jar "$B/api/transactions?perPage=100" | node -pe "JSON.parse(require('fs').readFileSync(0)).total")
print -r -- "       (superadmin sees $SUPER_TOTAL row(s) total)"
if [[ "$SUPER_TOTAL" -gt "$EMP_TOTAL" ]]; then ok "superadmin sees strictly more than employee"; else bad "scoping not narrowing: super=$SUPER_TOTAL emp=$EMP_TOTAL"; fi

# Direct-object access: probe a transaction the employee did not create.
OTHER_ID=$SUPER_TXN_ID
if [[ -z "$OTHER_ID" ]]; then bad "could not create a control row to probe"; fi
check "employee GET of another's txn -> 404" "$(code emp.jar "$B/api/transactions/$OTHER_ID")" "404"
check "employee PATCH of another's txn -> 40x" "$(code emp.jar -X PATCH "$B/api/transactions/$OTHER_ID" -H 'Content-Type: application/json' -d '{"type":"EXPENSE","date":"2026-09-01","amountInr":"1.00"}')" "404"
check "employee DELETE of another's txn -> 403" "$(code emp.jar -X DELETE "$B/api/transactions/$OTHER_ID")" "403"
check "employee receipt of another's txn -> 404" "$(code emp.jar "$B/api/receipt/$OTHER_ID")" "404"

print -r -- "\n=============== 6. Admin approves the employee's submission ==============="
ADMIN_ROLE=$(signin asha@wezo.co 'TempPass2026a' admin.jar)
if [[ "$ADMIN_ROLE" == "ADMIN" ]]; then
  curl -s -b admin.jar -o /dev/null -X PATCH "$B/api/me/password" -H "Content-Type: application/json" \
    -d '{"currentPassword":"TempPass2026a","newPassword":"AshaBooks2026a"}'
fi
ADMIN_ROLE=$(signin asha@wezo.co 'AshaBooks2026a' admin.jar)
check "admin signs in (post password change)" "$ADMIN_ROLE" "ADMIN"

check "admin cannot manage users"  "$(code admin.jar -X POST "$B/api/users" -H 'Content-Type: application/json' -d '{"name":"x","email":"z@y.co","role":"ADMIN","password":"Password123"}')" "403"
check "admin cannot edit settings" "$(code admin.jar -X PATCH "$B/api/settings" -H 'Content-Type: application/json' -d '{"vatEnabled":false}')" "403"
check "admin can read settings"    "$(code admin.jar "$B/api/settings")" "200"
check "admin can run P&L"          "$(code admin.jar "$B/api/reports/pnl")" "200"
check "admin cannot unlock period" "$(code admin.jar -X POST "$B/api/periods/unlock" -H 'Content-Type: application/json' -d '{"month":"2026-09"}')" "403"

APPROVED=$(json admin.jar -X POST "$B/api/transactions/$EMP_TXN_ID/approve")
APPROVED_STATUS=$(print -r -- "$APPROVED" | node -pe "JSON.parse(require('fs').readFileSync(0)).status")
check "admin approves employee submission" "$APPROVED_STATUS" "APPROVED"

check "re-approving is a conflict" "$(code admin.jar -X POST "$B/api/transactions/$EMP_TXN_ID/approve")" "409"

print -r -- "\n=============== 7. Rejection requires a reason ==============="
EMP_TXN2_ID=$(json emp.jar -X POST "$B/api/transactions" -H "Content-Type: application/json" \
  -d "{\"type\":\"EXPENSE\",\"date\":\"2026-09-16\",\"amountInr\":\"999.00\",\"categoryId\":\"$CAT\",\"notes\":\"Duplicate claim\"}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).id")
check "reject without reason -> 422" "$(code admin.jar -X POST "$B/api/transactions/$EMP_TXN2_ID/reject" -H 'Content-Type: application/json' -d '{}')" "422"
check "reject with short reason -> 422" "$(code admin.jar -X POST "$B/api/transactions/$EMP_TXN2_ID/reject" -H 'Content-Type: application/json' -d '{"reason":"no"}')" "422"
REJ=$(json admin.jar -X POST "$B/api/transactions/$EMP_TXN2_ID/reject" -H 'Content-Type: application/json' -d '{"reason":"Already claimed on 12 Sept."}')
check "reject with reason succeeds" "$(print -r -- "$REJ" | node -pe "JSON.parse(require('fs').readFileSync(0)).status")" "REJECTED"

print -r -- "\n=============== 8. Employee notified of both outcomes ==============="
NOTIFS=$(json emp.jar "$B/api/notifications")
print -r -- "$NOTIFS" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const kinds=d.notifications.map(n=>n.kind);
const need=['SUBMISSION_APPROVED','SUBMISSION_REJECTED'];
for(const k of need){
  if(kinds.includes(k)) console.log('  ok   employee received '+k);
  else console.log('  FAIL missing '+k+' (got: '+kinds.join(',')+')');
}
console.log('       unread count: '+d.unread);
"

print -r -- "\n=============== 9. Approvers notified of new submissions ==============="
json admin.jar "$B/api/notifications" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const pend=d.notifications.filter(n=>n.kind==='SUBMISSION_PENDING');
console.log(pend.length>0 ? '  ok   admin received '+pend.length+' SUBMISSION_PENDING notification(s)' : '  FAIL admin got no pending notifications');
"

print -r -- "\n=============== 10. Deactivated users lose access immediately ==============="
EMP_ID=$(/opt/homebrew/opt/postgresql@14/bin/psql -d wezo_expenses -tAc "select id from \"User\" where email='ravi@wezo.co'")
curl -s -b super.jar -o /dev/null -X PATCH "$B/api/users" -H "Content-Type: application/json" -d "{\"id\":\"$EMP_ID\",\"isActive\":false}"
check "deactivated employee's existing cookie is rejected" "$(code emp.jar "$B/api/transactions")" "401"
curl -s -b super.jar -o /dev/null -X PATCH "$B/api/users" -H "Content-Type: application/json" -d "{\"id\":\"$EMP_ID\",\"isActive\":true}"
check "reactivated employee works again" "$(code emp.jar "$B/api/transactions")" "200"

print -r -- "\n=============== 11. Role change takes effect on the next request ==============="
curl -s -b super.jar -o /dev/null -X PATCH "$B/api/users" -H "Content-Type: application/json" -d "{\"id\":\"$EMP_ID\",\"role\":\"ADMIN\"}"
check "promoted employee can now run P&L (same old cookie)" "$(code emp.jar "$B/api/reports/pnl")" "200"
curl -s -b super.jar -o /dev/null -X PATCH "$B/api/users" -H "Content-Type: application/json" -d "{\"id\":\"$EMP_ID\",\"role\":\"EMPLOYEE\"}"
check "demoted again -> P&L forbidden (same old cookie)" "$(code emp.jar "$B/api/reports/pnl")" "403"

print -r -- "\n=============== 12. Superadmin self-protection ==============="
SUPER_ID=$(/opt/homebrew/opt/postgresql@14/bin/psql -d wezo_expenses -tAc "select id from \"User\" where email='owner@wezo.co'")
R=$(json super.jar -X PATCH "$B/api/users" -H "Content-Type: application/json" -d "{\"id\":\"$SUPER_ID\",\"role\":\"EMPLOYEE\"}")
print -r -- "$R" | grep -q "own role" && ok "cannot change own role" || bad "own-role guard: $R"
R=$(json super.jar -X PATCH "$B/api/users" -H "Content-Type: application/json" -d "{\"id\":\"$SUPER_ID\",\"isActive\":false}")
print -r -- "$R" | grep -q "own account" && ok "cannot deactivate self" || bad "self-deactivate guard: $R"

print -r -- "\n=============== 13. Anonymous access is refused ==============="
check "anonymous /api/transactions" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/transactions")" "401"
check "anonymous /api/users"        "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/users")" "401"
check "anonymous /api/reports/pnl"  "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/reports/pnl")" "401"
check "anonymous cron without secret" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/cron/recurring")" "401"

print -r -- "\n=================================================="
print -r -- "  PASSED: $pass    FAILED: $fail"
print -r -- "=================================================="
[[ $fail -eq 0 ]]
