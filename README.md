# Wezo Expense &amp; Income Tracker

Internal PWA for tracking Wezo Technologies' income and expenses: AI receipt
reading, an approval workflow, role-based access, and financial reports that
export to PDF and CSV.

INR is the single source of truth for the books. Foreign-currency amounts are
recorded for reference against the rupees that actually reached the bank.

---

## Quick start

```bash
cp .env.example .env        # then fill in the values below
npm install                 # runs prisma generate via postinstall
npm run db:migrate          # create the schema
npm run db:seed             # Superadmin + default categories + settings
npm run dev                 # http://localhost:3000
```

Sign in with `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`. You are required to
replace that password before anything else becomes reachable.

---

## Environment

Every value is **server-only**. Nothing here is prefixed `NEXT_PUBLIC_`, and no
secret reaches the browser or the installed app.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `AUTH_SECRET` | yes | `openssl rand -base64 32`. `NEXTAUTH_SECRET` also accepted |
| `NEXTAUTH_URL` | yes | The app's public URL |
| `OPENAI_API_KEY` | no | OpenAI vision key. Without any key, receipt reading is skipped and the manual form is used |
| `ANTHROPIC_API_KEY` | no | Anthropic vision key. Both providers may be set at once — see below |
| `OPENAI_MODEL` | no | Default model; Settings overrides it |
| `AZURE_STORAGE_CONNECTION_STRING` | no | Without it, receipts go to a gitignored local folder (development only) |
| `AZURE_BLOB_CONTAINER` | no | Defaults to `wezo-receipts` |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | seed only | Creates the first account |
| `CRON_SECRET` | for recurring | A value **you invent** — see the note below |

The optional integrations are genuinely optional: the app runs and every feature
except AI extraction works without them, and the Settings screen shows which are
wired up.

### Which AI provider?

The spec named OpenAI `gpt-4o-mini`. **Both OpenAI and Anthropic are supported,
and both can be configured at once** — the model selected in Settings decides
which vendor is called, so switching is a dropdown rather than a redeploy.

Keys are matched to vendors by their own prefix (`sk-ant-…` is Anthropic), never
by which variable they sit in. Swapping the two env vars by mistake still routes
each key to the right API instead of leaking it to the other vendor.

### Choosing a model — measured, not theoretical

Per-token price is a poor guide for images, because image tokenisation varies
enormously between models. Measured on the same 620x880 Indian GST receipt:

| Model | Image input tokens | Cost / receipt | Receipts per $20 | Fields correct |
|---|---|---|---|---|
| **gpt-4.1-mini** (default) | 933 | ~₹0.07 | ~25,000 | 7 / 7 |
| claude-haiku-4-5 | — | ~₹0.23 | ~7,700 | 7 / 7 |
| gpt-4o-mini | 25,527 | ~₹0.35 | ~5,000 | 7 / 7 |
| claude-opus-5 | — | ~₹1.40 | ~1,250 | 7 / 7 |

`gpt-4o-mini` — the spec's original choice — turns out to be **~5x dearer per
receipt than `gpt-4.1-mini`** despite a lower headline token price, because it
spends 27x more tokens on the same picture. The default is therefore
`gpt-4.1-mini`: cheapest measured, and identical accuracy on the test document.
All four models scored 7/7 on type, date, vendor, currency, total, tax and
payment method, so this is a cost choice, not an accuracy one.

> One provider quirk handled in code: **Claude Haiku 4.5 rejects the `effort`
> parameter** (`400 This model does not support the effort parameter`). Effort is
> therefore a per-model capability in `lib/ai.ts`, not an unconditional field —
> without that, selecting Haiku silently fell back to manual entry every time.

---

## Deployment checklist

1. **Postgres** — already done for the Azure server (see *Production* below).
   For a new environment: set `DATABASE_URL`, then `npm run db:deploy` (applies
   migrations without prompting) and `npm run db:seed`. Never `db:reset` against
   a live database — it drops everything.
2. **Azure Blob** — already done (`wezo-receipts`). For a new environment:
   create a container and set the connection string. Leave the container
   **private**; the app never makes blobs public and serves each
   receipt through a short-lived SAS minted per request.
3. **OpenAI** — set the API key. The monthly spend cap (default $10) is enforced
   in-app and adjustable in Settings.
4. **Scheduler** — `CRON_SECRET` is not issued by any service; it is a shared
   password you make up so that only your scheduler can trigger the job.
   Generate one and put the same value in both places:
   ```bash
   openssl rand -hex 32
   ```
   Then call the job daily:
   ```
   POST https://<host>/api/cron/recurring
   Authorization: Bearer <CRON_SECRET>
   ```
   On Vercel, a `vercel.json` cron entry works; anything that can send a bearer
   token is fine. Missed periods are caught up on the next run, and an Admin can
   always press **Run due now** on the Recurring screen instead.
5. **Logo** — done: `public/logo.svg` is the official asset, and
   `components/logo.tsx` inlines it so the wordmark can follow the theme (the
   supplied asset draws it in #242331, which would be invisible on the dark UI).
   The PWA icons in `public/icons/` are generated from the same official tile
   (lime ground, black chevrons), with a 22% safe-zone inset on the maskable
   variants so a circular launcher crop keeps the whole mark.
6. **Users** — sign in as Superadmin and add colleagues under **Users**. Each
   gets a temporary password they must replace on first sign-in.
7. **History** — optionally bulk-import past transactions under **Import CSV**.

---

## Deploying

The app needs a Node process — it is **not** a static site (47 of its 50 routes
are server-rendered on demand, plus 26 API routes, a Node-runtime proxy, a
Prisma pool and native dependencies). Azure Static Web Apps cannot host it.

Zero-downtime blue/green deploys to an Ubuntu VM, driven by GitHub Actions, are
set up in [`deploy/`](deploy/README.md):

```
nginx  ->  upstream wezo_app  ->  wezo@blue :3001  |  wezo@green :3002
```

CI builds and gates on the logic suite, ships a tarball, starts the **idle**
colour, polls `/api/health` until the database answers, then *reloads* nginx
onto it. The live colour is untouched until that gate passes, and stays on disk
as an instant rollback target.

[`deploy/README.md`](deploy/README.md) covers the one-time VM setup, the GitHub
secrets CI needs, TLS, the cron entry for recurring transactions, and the rule
for destructive migrations.

---

## Production (Azure) — current state

The Azure resources are provisioned and the schema is live.

| Piece | State |
|---|---|
| Database | `wezo_expenses` on `wezoexpcalc.postgres.database.azure.com` (PostgreSQL 18.6). Schema applied, seeded: 1 Superadmin, 14 categories, 1 settings row, 0 transactions. Created as a **dedicated** database rather than using the server's default `postgres`. |
| Receipt storage | Azure Blob container `wezo-receipts` on account `wezoexpensecalc`. **Private** — the account has public access disabled, so an unsigned request is refused with `PublicAccessNotPermitted`. |
| AI | **Both** providers configured (OpenAI + Anthropic). Active model `gpt-4.1-mini`. Verified end-to-end on a real receipt and a real PDF invoice, and by switching models to confirm the vendor follows the selection. |

Connection string shape for the app — **the password is deliberately not in this
repository**; take it from the Azure Portal or your secret store and URL-encode
it (`@` becomes `%40`, `#` becomes `%23`):

```
DATABASE_URL="postgresql://wezoexpcalc:<URL-ENCODED-PASSWORD>@wezoexpcalc.postgres.database.azure.com:5432/wezo_expenses?sslmode=require"
```

A quick way to encode it without pasting it into a shell history:

```bash
node -p 'encodeURIComponent(process.env.PW)'   # with PW exported beforehand
```

**Transport security is verified, not assumed.** `sslmode=require` is passed to
node-postgres, which treats it as `verify-full` — stricter than libpq's `require`,
because it also validates the server certificate. The live session reports
`ssl=true, TLSv1.3, TLS_AES_256_GCM_SHA384`, and a deliberately unencrypted
connection is refused by the server (`no pg_hba.conf entry ... no encryption`).

**Two things to tighten before real use:**

1. **Firewall.** The server currently accepts connections from a home IP
   (whatever was added when it was created). Restrict the Azure Postgres
   firewall to the app host's outbound IP, or put both on a VNet — right now
   anyone with the password can reach it from that address range.
2. **Rotate the secrets below.**

### Secret rotation checklist

Every one of these was shared over chat during development, so treat them as
compromised and rotate before go-live. The app reads all of them from the
environment, so rotating is a config change — **no code edits**:

| Secret | Where to rotate | Then update |
|---|---|---|
| Anthropic API key | console.anthropic.com -> API keys -> revoke & create | `ANTHROPIC_API_KEY` |
| OpenAI API key | platform.openai.com -> API keys -> revoke & create | `OPENAI_API_KEY` |
| Azure storage account key | Azure Portal -> storage account -> Access keys -> Rotate key | `AZURE_STORAGE_CONNECTION_STRING` |
| Postgres password | Azure Portal -> Postgres server -> Reset password | `DATABASE_URL` (URL-encode it) |
| Superadmin password | Already forced: the seeded account must change it on first sign-in | nothing |
| `AUTH_SECRET` | `openssl rand -base64 32` (invalidates all sessions) | `AUTH_SECRET` |
| `CRON_SECRET` | `openssl rand -hex 32` | app env **and** the scheduler's header |

Rotating the storage account key does **not** break existing receipts — blob
keys are stored on the transaction, and SAS URLs are minted fresh per request
with whatever key is current.

---

## How the money model works

This is the part worth reading before touching the code.

**INR is the booked figure.** `Transaction.amountInr` is what reports sum, and
the only figure in the P&L. `originalCurrency` / `originalAmount` are
informational, and `fxRate` is *derived* from the two by the server — never
accepted from the client.

> A client pays **USD 200** and the bank credits **INR 20,000**:
> `originalAmount = 200`, `originalCurrency = USD`, `amountInr = 20000`,
> `fxRate = 100.0`. Reports show ₹20,000.

**VAT via the Dubai partner is never Wezo income.** When income is routed
`VIA_DUBAI_PARTNER`, the partner collects the gross, handles the VAT, and remits
the net. Only that net INR figure is booked. The gross and VAT are stored as
reference fields and surface as a separate memo line on reports, explicitly
excluded from revenue:

> *"VAT handled via Dubai partner: AED 100.00 across 1 payment. Excluded from
> revenue and P&L — the partner collects and remits this VAT, and Wezo India
> books only the net amount received."*

**All arithmetic uses `Prisma.Decimal`.** Never floats — `0.1 + 0.2` must be
`0.3`, and a rupee must not drift. Decimals are stringified at the
server/client boundary and formatted with Indian digit grouping
(₹12,34,567.50).

**Dates are stored UTC, reasoned about in IST.** A transaction dated 3 Sep 2026
is stored as IST midnight in UTC (`2026-09-02T18:30:00Z`). Month buckets follow
the Indian calendar month, not the UTC one — see `lib/dates.ts`, which is
exact because India has no DST.

---

## Roles

Strict hierarchy: **Superadmin > Admin > Employee**.

| | Superadmin | Admin | Employee |
|---|:--:|:--:|:--:|
| Submit, use AI, edit own pending | ✅ | ✅ | ✅ |
| View all transactions | ✅ | ✅ | own only |
| Approve / reject | ✅ | ✅ | ❌ |
| Reports &amp; exports | ✅ | ✅ | own summary |
| Categories, vendors, budgets, recurring | ✅ | ✅ | ❌ |
| Close a month | ✅ | ✅ | ❌ |
| Reopen a month | ✅ | ❌ | ❌ |
| Manage users &amp; roles | ✅ | ❌ | ❌ |
| App settings | ✅ | ❌ | ❌ |
| Audit log | ✅ | read-only | ❌ |

Authorisation is enforced **server-side on every route and every query**. Hiding
a nav link is a convenience, never the control:

- `lib/rbac.ts` re-reads the user from the database on every protected request,
  so the JWT is only an identity claim. A role change or deactivation takes
  effect on the very next request rather than when the token happens to refresh.
- `transactionScope()` narrows the Prisma `where` clause, so an Employee cannot
  read another person's rows even by crafting the request by hand.
- Probing an id you may not see returns the same 404 as a missing record, so the
  API cannot be used to discover other people's transactions.
- No one can approve their own submission.

---

## AI receipt reading

`POST /api/ai/extract` reads a stored receipt and returns a **draft**. Every
field it suggests is an ordinary editable control — nothing is locked because
AI filled it, and manual entry works fully with no image at all.

- **Either provider** works (see *Which AI provider?* above). Claude uses
  structured outputs via `messages.parse()`; OpenAI uses strict `json_schema`.
  Both are schema-constrained so neither can reply with prose.
- **Images** are EXIF-rotated (phone photos are often sideways), downscaled to
  1600px on the longest edge and re-encoded as JPEG to keep tokens down.
- **PDFs** take the text-extraction path rather than being rasterised. Invoices
  and salary slips almost always have a real text layer, which reads more
  accurately than OCR and avoids a native canvas dependency. A scanned,
  image-only PDF has no text; that is detected and routed to the manual form
  with an explanation.
- The reply is schema-constrained, and parsed defensively anyway.

Verified live on real documents:

| Input | What the model got right |
|---|---|
| Indian GST receipt (JPEG) | Read `14/09/2026` as 14 September, not 9 April (DD/MM convention); summed CGST + SGST into one tax figure; took the TOTAL, not the subtotal; confidence 0.92 -> pre-filled with no warning |
| USD invoice (PDF, text layer) | Read USD 240 and returned `amountInr: null` — correctly refusing to invent an exchange rate, leaving the user to enter what actually reached the bank |
| Blank image | Confidence 0.01 -> routed to the manual form with a banner |

Confidence drives the UI (spec 8.3): `>= 0.75` pre-fills normally, `0.5–0.75`
flags the shaky fields with "AI wasn't sure — please check this", and below
`0.5` (or on any failure) you get the manual form with a banner.

Every failure path — no API key, spent budget, unreadable scan, network error,
malformed reply — lands on the same usable manual form. The monthly spend cap is
checked *before* each call and the running total is incremented from the token
usage the API actually reports.

---

## Reports

Seven reports, each exportable to PDF and CSV: **P&L**, **expenses by
category**, **expenses by vendor**, **income summary**, **cash flow**, **budget
vs actual**, and **submissions by user**.

All of them reduce to one `Report` shape (`lib/reports.ts`), so a single CSV
writer and a single PDF writer serve every report — what you see on screen and
what you export cannot disagree. Adding a report means adding a builder, not
another exporter.

Financial reports are **cash-basis over approved transactions**: a pending
submission is not yet money that moved. The basis is printed on every export so
a reader never has to guess.

Two details worth knowing:

- PDF standard fonts have no rupee glyph, so money is rendered with Indian digit
  grouping and every money column is labelled `(INR)`. That also keeps exports
  free of embedded fonts.
- CSV cells beginning with `=` `+` `-` `@` are prefixed with an apostrophe.
  Vendor names and notes are user-supplied and end up in spreadsheets, where
  such a cell would otherwise be executed as a formula.

---

## Offline &amp; PWA

Installable, dark-theme, standalone, with maskable icons and iOS home-screen
support. The service worker (`public/sw.js`) caches the app shell and static
assets, is network-first for API data, and falls back to `/offline` so the app
always opens.

Recording a transaction while offline queues it — with its receipt image — in
IndexedDB, and it is sent when connectivity returns. Draining lives in the page
rather than the worker, so the two-step upload-then-create flow exists in one
place; the worker's background-sync handler just nudges an open tab.

Session material and receipts are **never** cached, and signing out purges the
worker's caches so no financial data is left on a shared device.

---

## Verification

Two runnable suites exercise the behaviour that matters. Start the dev server,
then:

```bash
npm run verify:logic         # 62 assertions — pure logic, no server needed

npm run dev                  # in one terminal, then:
npm run verify               # all three suites, 149 assertions
npm run verify:permissions   # 42 assertions: RBAC, scoping, approval workflow
npm run verify:workflows     # 45 assertions: uploads, receipts, AI, import, cron, close
```

> Two cautions: they sign in as the Superadmin and rotate its password to a
> known value on first run, and — when a vision key is configured — the workflow
> suite makes one real, billed AI call (about $0.02). Run them against
> development data, never a live database.

`verify:logic` needs nothing running and covers the areas where a quiet mistake
would corrupt the books: IST/UTC date boundaries (including that an instant
which is 1 Oct in India buckets to October, not September), Decimal money
parsing, the cross-field VAT rules, and defensive parsing of AI output.

The two HTTP suites are idempotent and self-contained — they create their own
fixtures and can be re-run. Between them they cover:

- Every role boundary in the table above, including that a demoted user loses
  access on their next request and a deactivated user's existing cookie stops
  working immediately.
- An Employee seeing only their own rows, and being unable to reach another
  person's transaction or receipt by id.
- Submission → approval / rejection-with-reason → notification.
- Magic-byte type sniffing (a text file renamed `.png` is rejected).
- A live AI read when a key is configured: a draft comes back, the confidence
  band is coherent, and the spend lands on the monthly counter.
- Receipts served only to those allowed and never cached — and, on Azure, that
  the SAS is signed, read-only, short-lived, and that the blob is **refused
  without a signature**.
- CSV import: header mapping, per-row validation, preview then commit.
- The cron endpoint's bearer-secret auth, and recurring generation.
- Month close: admins cannot write into a closed month, only a Superadmin can
  reopen one.
- The audit log capturing every action.

Also:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # production build
```

---

## Layout

```
app/
  (app)/            authenticated screens, share the shell + nav
  api/              route handlers — all Zod-validated and role-checked
  login/  welcome/  offline/
components/         UI; charts/ holds the validated chart palette
lib/
  rbac.ts           roles, capabilities, query scoping     <- security core
  transactions.ts   the only place a Transaction is written
  money.ts          Decimal maths; dates.ts  IST/UTC handling
  ai.ts             OpenAI extraction + fallbacks
  reports.ts        the seven reports; csv.ts / pdf.ts export them
  storage.ts        Azure Blob + SAS, local-disk fallback
prisma/             schema + seed
scripts/            the verification suites
```

`lib/*` modules that touch secrets or the database import `server-only`, so the
build fails if a Client Component ever pulls one in.

---

## Notes on choices

- **Service worker is hand-written** rather than generated by `next-pwa`. The
  spec allows an "App Router equivalent"; a ~150-line worker gives exact control
  over what is and isn't cached — which matters when the payload is financial
  data — and avoids a webpack plugin in a Turbopack-by-default project.
- **Rate limiting is in-process** (`lib/ratelimit.ts`). For a handful of users on
  one instance that is the right size, and it keeps the "no background infra
  beyond one cron route" constraint. On a multi-instance deployment the ceiling
  becomes limit × instances; the module is a single seam if a shared store is
  ever wanted.
- **Email is a hook, not a provider.** `deliverEmail` in `lib/notifications.ts`
  is the one place to implement it; in-app notifications work today.
- **Chart colours are validated, not chosen by eye.** Series colours live in
  `app/globals.css` and were checked for colourblind separation and contrast
  against both themes. Money-in/money-out sits in the tolerable-but-not-great
  band for red/green confusion, so those charts always carry a legend, direct
  value labels and a gap between bars — never hue alone. Amounts in tables
  additionally carry a direction arrow.
- **Prisma 7** needs a driver adapter and generates its client to
  `generated/prisma` (gitignored). `prisma.config.ts` holds the datasource URL;
  the schema no longer does.
