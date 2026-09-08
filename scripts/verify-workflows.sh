#!/bin/zsh
# Run against a running dev server: npm run dev, then ./scripts/verify-workflows.sh
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
export REPO
# Workflow verification: uploads, receipts, AI fallback, import, cron, locking.
set -u
B=http://localhost:3000
WORK="${TMPDIR:-/tmp}/wezo-verify"
mkdir -p "$WORK"
cd "$WORK"
PSQL=/opt/homebrew/opt/postgresql@14/bin/psql
CRON=$(grep '^CRON_SECRET=' "$REPO/.env" | cut -d'"' -f2)

pass=0; fail=0
ok()   { print -r -- "  ok   $1"; pass=$((pass+1)) }
bad()  { print -r -- "  FAIL $1"; fail=$((fail+1)) }
check(){ if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1 — got '$2', want '$3'"; fi }
has()  { if print -r -- "$2" | grep -q "$3"; then ok "$1"; else bad "$1 — got: $(print -r -- "$2" | head -c 200)"; fi }

# Sign in as <email> <password> <jarfile>. Named `signin`, not `login`, because
# `login` resolves to /usr/bin/login and silently swallows the call.
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

# Reuses the cookie jars from verify-permissions.sh; sign in if absent.
if [[ ! -f super.jar ]]; then
  signin owner@wezo.co "WezoBooks2026x" super.jar >/dev/null
fi

print -r -- "=============== 1. Upload: type sniffing & limits ==============="
# A real PNG (generated with sharp) and a fake one.
node -e "
const sharp=require(process.env.REPO+'/node_modules/sharp');
sharp({create:{width:600,height:400,channels:3,background:'#ffffff'}}).png().toFile('receipt.png').then(()=>console.log('made receipt.png'));
" >/dev/null 2>&1
print -r -- "This is definitely not an image" > fake.png
print -r -- "%PDF-1.4 minimal" > tiny.pdf

UP=$(curl -s -b super.jar -X POST "$B/api/upload" -F "file=@receipt.png;type=image/png")
has "real PNG accepted" "$UP" '"blobKey"'
BLOB=$(print -r -- "$UP" | node -pe "JSON.parse(require('fs').readFileSync(0)).blobKey")
MIME=$(print -r -- "$UP" | node -pe "JSON.parse(require('fs').readFileSync(0)).mime")
STORE=$(print -r -- "$UP" | node -pe "JSON.parse(require('fs').readFileSync(0)).storage")
print -r -- "       stored as $BLOB ($MIME) via $STORE"

FAKE=$(curl -s -b super.jar -X POST "$B/api/upload" -F "file=@fake.png;type=image/png")
has "renamed text file rejected by magic bytes" "$FAKE" "isn.t a JPG, PNG or WebP"

check "upload requires auth" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/upload" -F "file=@receipt.png")" "401"

print -r -- "\n=============== 2. AI extraction ==============="
# NOTE: when a vision key is configured this makes a real, billed API call
# (about $0.02 with Claude Opus 5). The spend counter is asserted below.
AI=$(curl -s -b super.jar -X POST "$B/api/ai/extract" -H "Content-Type: application/json" \
  -d "{\"blobKey\":\"$BLOB\",\"mime\":\"$MIME\"}")
check "extract always returns HTTP 200 (a failed read is not an error)" \
  "$(curl -s -b super.jar -o /dev/null -w '%{http_code}' -X POST "$B/api/ai/extract" -H 'Content-Type: application/json' -d "{\"blobKey\":\"$BLOB\",\"mime\":\"$MIME\"}")" "200"

AI_CONFIGURED=$(curl -s -b super.jar "$B/api/settings" | node -pe "String(JSON.parse(require('fs').readFileSync(0)).ai.configured)")
if [[ "$AI_CONFIGURED" == "true" ]]; then
  print -r -- "       (a key is configured — asserting a live read)"
  print -r -- "       the fixture is a BLANK image, so a low confidence here is"
  print -r -- "       the correct answer: it proves the manual-fallback band works"
  print -r -- "$AI" | node -e "
  const d=JSON.parse(require('fs').readFileSync(0));
  const ok = (l,c) => console.log(c ? '  ok   '+l : '  FAIL '+l);
  ok('extraction succeeded', d.ok === true);
  ok('a draft came back', !!d.draft);
  ok('confidence is a 0..1 number', typeof d.draft?.confidence === 'number' && d.draft.confidence >= 0 && d.draft.confidence <= 1);
  ok('band matches the confidence', ['high','verify','low'].includes(d.band));
  ok('spend was recorded against the cap', d.budget.spentUsd > 0);
  console.log('       band=' + d.band + ' confidence=' + d.draft?.confidence + ' spent=\$' + d.budget.spentUsd);
  "
  # The node block prints its own ok/FAIL lines; count them into the totals.
  extra_pass=$(print -r -- "$AI" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0));
  [d.ok===true, !!d.draft, typeof d.draft?.confidence==='number', ['high','verify','low'].includes(d.band), d.budget.spentUsd>0].filter(Boolean).length")
  pass=$((pass + extra_pass)); fail=$((fail + 5 - extra_pass))
else
  print -r -- "       (no key configured — asserting the manual fallback)"
  AI_OK=$(print -r -- "$AI" | node -pe "String(JSON.parse(require('fs').readFileSync(0)).ok)")
  check "extract returns ok=false" "$AI_OK" "false"
  has "explains the manual fallback" "$AI" "fill in the details"
fi

print -r -- "\n=============== 3. Receipt is served only to those allowed ==============="
TXN=$(curl -s -b super.jar -X POST "$B/api/transactions" -H "Content-Type: application/json" \
  -d "{\"type\":\"EXPENSE\",\"date\":\"2026-09-18\",\"amountInr\":\"1200.00\",\"receiptBlobKey\":\"$BLOB\",\"receiptMime\":\"$MIME\",\"notes\":\"With receipt\",\"saveAsApproved\":true}")
TXN_ID=$(print -r -- "$TXN" | node -pe "JSON.parse(require('fs').readFileSync(0)).id")
HAS_RECEIPT=$(print -r -- "$TXN" | node -pe "String(JSON.parse(require('fs').readFileSync(0)).hasReceipt)")
check "transaction records the receipt" "$HAS_RECEIPT" "true"

# Behaviour differs by storage mode, and both are correct:
#   Azure      -> 302 to a short-lived, read-only SAS URL
#   local disk  -> 200 with the bytes streamed through the authorised route
RH=$(curl -s -b super.jar -D - -o receipt-out.bin "$B/api/receipt/$TXN_ID")
RCODE=$(print -r -- "$RH" | head -1 | grep -oE '[0-9]{3}')
has "never cached" "$RH" "no-store"

if [[ "$STORE" == "azure" ]]; then
  check "owner gets a redirect to Azure" "$RCODE" "302"
  SASURL=$(curl -s -b super.jar "$B/api/receipt/$TXN_ID?mode=url" | node -pe "JSON.parse(require('fs').readFileSync(0)).url")
  print -r -- "$SASURL" | grep -q "blob.core.windows.net" && ok "the URL points at Azure Blob" || bad "not an Azure URL"
  print -r -- "$SASURL" | grep -q "sp=r" && ok "the SAS is read-only (sp=r)" || bad "SAS is not read-only"
  print -r -- "$SASURL" | grep -q "sig=" && ok "the SAS is signed" || bad "SAS has no signature"
  TTL=$(curl -s -b super.jar "$B/api/receipt/$TXN_ID?mode=url" | node -pe "JSON.parse(require('fs').readFileSync(0)).expiresInSeconds")
  if [[ "$TTL" -gt 0 && "$TTL" -le 3600 ]]; then ok "the SAS expires soon (${TTL}s)"; else bad "unexpected SAS TTL: $TTL"; fi
  # Following the signed URL must return the real bytes.
  curl -s -o via-sas.bin "$SASURL"
  if [[ "$(wc -c < via-sas.bin | tr -d ' ')" -gt 1000 ]]; then ok "the signed URL returns the image"; else bad "signed URL returned nothing"; fi
  # And the same object must be refused without a signature.
  UNSIGNED=$(print -r -- "$SASURL" | cut -d'?' -f1)
  UCODE=$(curl -s -o /dev/null -w '%{http_code}' "$UNSIGNED")
  if [[ "$UCODE" != "200" ]]; then ok "the blob is private without a signature (HTTP $UCODE)"; else bad "the blob is PUBLICLY READABLE"; fi
else
  check "owner can fetch the receipt" "$RCODE" "200"
  has "served with an image content-type" "$RH" "content-type: image/"
  print -r -- "       bytes returned: $(wc -c < receipt-out.bin)"
  check "download variant works" "$(curl -s -b super.jar -o /dev/null -w '%{http_code}' "$B/api/receipt/$TXN_ID?download=1")" "200"
fi
check "employee cannot fetch it" "$(curl -s -b emp.jar -o /dev/null -w '%{http_code}' "$B/api/receipt/$TXN_ID")" "404"
check "anonymous cannot fetch it" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/receipt/$TXN_ID")" "401"
check "bogus id -> 404" "$(curl -s -b super.jar -o /dev/null -w '%{http_code}' "$B/api/receipt/doesnotexist")" "404"

print -r -- "\n=============== 4. CSV import: preview then commit ==============="
cat > import.csv <<'CSV'
Transaction Date,Type,Amount (INR),Category,Payee,Narration,Currency,Original Amount,Routing
2026-08-03,expense,18500.00,Salaries,Priya Sharma,August salary,,,
2026-08-05,expense,2400.50,Utilities,BSES,Electricity,,,
2026-08-11,income,82000.00,Client Work,Northwind Ltd,Phase 1,USD,1000.00,DIRECT
2026-08-19,income,55000.00,Client Work,Gulf Retail LLC,Dubai collection,AED,2400.00,VIA DUBAI PARTNER
2026-08-22,expense,not-a-number,Travel,Uber,Bad row,,,
2026-13-99,expense,500.00,Travel,Ola,Impossible date,,,
CSV

PREV=$(curl -s -b super.jar -X POST "$B/api/import" -H "Content-Type: application/json" \
  --data-binary @<(node -e "
const fs=require('fs');
process.stdout.write(JSON.stringify({mode:'preview',csv:fs.readFileSync('import.csv','utf8')}));
"))
print -r -- "$PREV" | node -e "
const d=JSON.parse(require('fs').readFileSync(0)).preview;
console.log('       headers mapped:', Object.values(d.mapping).join(', '));
console.log('       valid:', d.validCount, '| errors:', d.errorCount);
console.log('       new vendors:', d.newVendors.join(', ') || '(none)');
console.log('       totals: income', d.totals.income, '/ expense', d.totals.expense);
const bad = d.rows.filter(r=>!r.ok).map(r=>'line '+r.line+': '+r.errors[0]);
bad.forEach(b=>console.log('       rejected ->', b));
"
V=$(print -r -- "$PREV" | node -pe "JSON.parse(require('fs').readFileSync(0)).preview.validCount")
E=$(print -r -- "$PREV" | node -pe "JSON.parse(require('fs').readFileSync(0)).preview.errorCount")
check "4 good rows validate" "$V" "4"
check "2 bad rows rejected" "$E" "2"
has "alternative headers auto-mapped" "$PREV" '"amountInr"'
has "spaced routing normalised" "$PREV" "VIA_DUBAI_PARTNER"

BEFORE=$($PSQL -d wezo_expenses -tAc "select count(*) from \"Transaction\"")
COMMIT=$(curl -s -b super.jar -X POST "$B/api/import" -H "Content-Type: application/json" \
  --data-binary @<(node -e "
const fs=require('fs');
process.stdout.write(JSON.stringify({mode:'commit',csv:fs.readFileSync('import.csv','utf8'),approve:true,createMissingVendors:true}));
"))
has "commit reports what it did" "$COMMIT" '"created"'
print -r -- "$COMMIT" | node -e "
const r=JSON.parse(require('fs').readFileSync(0)).result;
console.log('       created:',r.created,'| vendors added:',r.vendorsCreated,'| skipped:',r.skipped,'| status:',r.status);
"
AFTER=$($PSQL -d wezo_expenses -tAc "select count(*) from \"Transaction\"")
check "exactly 4 rows written" "$((AFTER-BEFORE))" "4"

print -r -- "\n=============== 5. Cron: bearer secret required ==============="
check "no secret -> 401"    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/cron/recurring")" "401"
check "wrong secret -> 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/cron/recurring" -H 'Authorization: Bearer wrong-value-entirely')" "401"
CR=$(curl -s -X POST "$B/api/cron/recurring" -H "Authorization: Bearer $CRON")
has "correct secret accepted" "$CR" '"report"'
print -r -- "$CR" | node -e "
const r=JSON.parse(require('fs').readFileSync(0)).report;
console.log('       rules considered:',r.rulesConsidered,'| created:',r.created,'| errors:',r.errors.length);
"

print -r -- "\n=============== 6. Recurring rule generates a transaction ==============="
RENT=$($PSQL -d wezo_expenses -tAc "select id from \"Category\" where name='Rent'")
RULE=$(curl -s -b super.jar -X POST "$B/api/recurring" -H "Content-Type: application/json" \
  -d "{\"name\":\"Test office rent\",\"type\":\"EXPENSE\",\"frequency\":\"MONTHLY\",\"nextRunDate\":\"2026-09-01\",\"autoApprove\":true,\"isActive\":true,\"template\":{\"amountInr\":\"31000.00\",\"categoryId\":\"$RENT\",\"routing\":\"DIRECT\",\"notes\":\"Generated by test\"}}")
has "rule created" "$RULE" '"id"'
CR2=$(curl -s -X POST "$B/api/cron/recurring" -H "Authorization: Bearer $CRON")
CREATED=$(print -r -- "$CR2" | node -pe "JSON.parse(require('fs').readFileSync(0)).report.created")
if [[ "$CREATED" -ge 1 ]]; then ok "cron generated $CREATED transaction(s) from the rule"; else bad "cron generated nothing"; fi
GEN=$($PSQL -d wezo_expenses -tAc "select count(*) from \"Transaction\" where notes='Generated by test'")
if [[ "$GEN" -ge 1 ]]; then ok "generated rows are in the ledger ($GEN)"; else bad "no generated rows found"; fi
NEXT=$($PSQL -d wezo_expenses -tAc "select to_char(\"nextRunDate\",'YYYY-MM-DD') from \"RecurringRule\" where name='Test office rent'")
print -r -- "       rule advanced to next run: $NEXT"

print -r -- "\n=============== 7. Monthly close seals the period ==============="
# Clear the queue first — closing refuses while submissions are pending.
for id in $($PSQL -d wezo_expenses -tAc "select id from \"Transaction\" where status='PENDING' and deleted_at is null" 2>/dev/null || $PSQL -d wezo_expenses -tAc "select id from \"Transaction\" where status='PENDING' and \"deletedAt\" is null"); do
  curl -s -b super.jar -o /dev/null -X POST "$B/api/transactions/$id/approve"
done

LOCK=$(curl -s -b super.jar -X POST "$B/api/periods/lock" -H "Content-Type: application/json" -d '{"month":"2026-08"}')
has "August closes" "$LOCK" '"locked":true'
check "closing twice -> 409" "$(curl -s -b super.jar -o /dev/null -w '%{http_code}' -X POST "$B/api/periods/lock" -H 'Content-Type: application/json' -d '{"month":"2026-08"}')" "409"

AUG_ID=$($PSQL -d wezo_expenses -tAc "select id from \"Transaction\" where date >= '2026-07-31 18:30:00' and date < '2026-08-31 18:30:00' limit 1")
NEW_IN_LOCKED=$(curl -s -b admin.jar -X POST "$B/api/transactions" -H "Content-Type: application/json" \
  -d '{"type":"EXPENSE","date":"2026-08-15","amountInr":"100.00"}')
has "admin cannot add into a closed month" "$NEW_IN_LOCKED" "has been closed"

SUPER_IN_LOCKED=$(curl -s -b super.jar -X POST "$B/api/transactions" -H "Content-Type: application/json" \
  -d '{"type":"EXPENSE","date":"2026-08-15","amountInr":"100.00","saveAsApproved":true}')
has "superadmin may still write into it" "$SUPER_IN_LOCKED" '"id"'

check "admin cannot reopen" "$(curl -s -b admin.jar -o /dev/null -w '%{http_code}' -X POST "$B/api/periods/unlock" -H 'Content-Type: application/json' -d '{"month":"2026-08"}')" "403"
UNLOCK=$(curl -s -b super.jar -X POST "$B/api/periods/unlock" -H "Content-Type: application/json" -d '{"month":"2026-08"}')
has "superadmin reopens" "$UNLOCK" '"locked":false'

print -r -- "\n=============== 7b. Superadmin resets someone's password ==============="
EMP_UID=$($PSQL -d wezo_expenses -tAc "select id from \"User\" where email='ravi@wezo.co'")
# Unique per run so re-running the suite is meaningful.
RESET_PW="Reset$(date +%s)a"
RESET=$(curl -s -b super.jar -X PATCH "$B/api/users" -H "Content-Type: application/json" \
  -d "{\"id\":\"$EMP_UID\",\"newPassword\":\"$RESET_PW\"}")
has "reset succeeds" "$RESET" '"id"'
RR=$(signin ravi@wezo.co "$RESET_PW" emp2.jar)
check "employee can sign in with the reset password" "$RR" "EMPLOYEE"
# The reset forces another change, so the app should send them to /welcome.
check "forced back to the password screen" "$(curl -s -b emp2.jar -o /dev/null -w '%{http_code}' "$B/dashboard")" "307"
check "weak reset rejected" "$(curl -s -b super.jar -o /dev/null -w '%{http_code}' -X PATCH "$B/api/users" -H 'Content-Type: application/json' -d "{\"id\":\"$EMP_UID\",\"newPassword\":\"weak\"}")" "422"
# Restore the shared fixture password so the RBAC suite stays runnable.
curl -s -b emp2.jar -o /dev/null -X PATCH "$B/api/me/password" -H "Content-Type: application/json" \
  -d "{\"currentPassword\":\"$RESET_PW\",\"newPassword\":\"RaviBooks2026a\"}"

print -r -- "\n=============== 8. Audit log captured everything ==============="
curl -s -b super.jar "$B/api/audit?perPage=200" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const counts={};
for(const e of d.entries) counts[e.action]=(counts[e.action]||0)+1;
const want=['CREATE_TXN','APPROVE_TXN','REJECT_TXN','ADD_USER','CHANGE_ROLE','DEACTIVATE_USER','RESET_PASSWORD','CHANGE_OWN_PASSWORD','LOCK_PERIOD','UNLOCK_PERIOD','IMPORT_TXN','RUN_RECURRING','CREATE_RECURRING'];
let miss=0;
for(const a of want){
  if(counts[a]) console.log('  ok   logged '+a+' x'+counts[a]);
  else { console.log('  FAIL never logged '+a); miss++; }
}
console.log('       total audit entries: '+d.total);
process.exit(0);
"

print -r -- "\n=============== 9. Reports reflect the imported data ==============="
curl -s -b super.jar "$B/api/reports/pnl?month=2026-08" | node -e "
const r=JSON.parse(require('fs').readFileSync(0)).report;
console.log('       August P&L:', r.summary.map(s=>s.label+'='+s.value).join('  '));
r.memos.forEach(m=>console.log('       memo:', m.slice(0,120)+'…'));
"
check "August P&L exports to PDF" "$(curl -s -b super.jar -o aug.pdf -w '%{http_code}' "$B/api/reports/pnl/export?month=2026-08&fmt=pdf")" "200"
print -r -- "       $(file -b aug.pdf)"
check "transactions CSV export" "$(curl -s -b super.jar -o txns.csv -w '%{http_code}' "$B/api/transactions/export")" "200"
print -r -- "       CSV rows: $(($(wc -l < txns.csv) - 1))"

print -r -- "\n=================================================="
print -r -- "  PASSED: $pass    FAILED: $fail"
print -r -- "=================================================="
[[ $fail -eq 0 ]]
