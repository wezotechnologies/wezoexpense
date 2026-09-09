# Step-by-step: from a bare VM to expense.wezo.co

Written for someone who is not a DevOps engineer. Follow the parts in order —
each one is short, and each ends with a check so you know it worked before
moving on.

Every command block is labelled with **where** to run it:

- 🖥️ **On the VM** — in the SSH session where the prompt looks like
  `azurewezoexpensecalc@wezoexpensecalc:~$`
- 💻 **On your Mac** — a normal Terminal window
- 🌐 **In a browser** — SiteGround, Azure Portal, or GitHub

If something fails, stop and read the error rather than continuing. Part 10 has
a troubleshooting table for the common ones.

---

## Part 1 — Find the VM's public IP  🖥️ On the VM

Everything else needs this number.

```bash
curl -s -H Metadata:true --noproxy '*' \
  'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text'
echo
```

That asks Azure itself, from inside the VM. You'll get something like
`20.198.45.112`.

**Write it down.** Below it is written as `VM_IP` — substitute your real number
everywhere you see it.

> If that returns nothing, get it from the Azure Portal instead: **Virtual
> machines → wezoexpensecalc → Overview → Public IP address**.

---

## Part 2 — Point expense.wezo.co at the VM  🌐 SiteGround

Your DNS is hosted at SiteGround (`ns1.siteground.net`). Do this **now**, before
the TLS step, because DNS changes take a few minutes to spread and the
certificate step needs it working.

1. Log in to SiteGround → **Websites** → your `wezo.co` site → **Site Tools**
2. Left menu: **Domain** → **DNS Zone Editor**
3. Make sure the domain selected at the top is `wezo.co`
4. Find the **A** tab / section and click **Create New Record**
5. Fill it in exactly like this:

| Field | Value |
|---|---|
| Name / Host | `expense` |
| Type | `A` |
| IP address / Points to | your `VM_IP` |
| TTL | `300` (or leave the default) |

6. **Create / Save**

You enter just `expense`, not `expense.wezo.co` — SiteGround appends the domain
automatically. If you type the full name you'll end up with
`expense.wezo.co.wezo.co`.

### Check it worked  💻 On your Mac

```bash
dig +short A expense.wezo.co
```

You want it to print your `VM_IP`. Nothing at first is normal — wait 2–5 minutes
and try again. Once it answers, carry on.

> This creates a **new subdomain** and does not touch `wezo.co` itself, which
> stays on `20.247.40.76`. Your main website is unaffected.

---

## Part 3 — Set up the VM  🖥️ On the VM

One script does the whole machine: Node 20, nginx, the firewall, a locked-down
service account, and the two app slots that make zero-downtime deploys work.

```bash
sudo apt update
git clone https://github.com/wezotechnologies/wezoexpense.git /tmp/wezo-src
sudo bash /tmp/wezo-src/deploy/provision.sh
```

It takes 2–4 minutes and prints a `==>` line per stage. It is safe to run again
if it stops halfway.

### Check it worked

```bash
node -v                          # v20.x or newer
systemctl is-active nginx        # active
ls /opt/wezo                     # active  releases  shared
```

At the end it prints a summary with your VM's IP and the deploy user name —
that's the same information you'll need in Part 6.

---

## Part 4 — Let the VM reach the database  🌐 Azure Portal

The database currently refuses connections from the VM, and it still allows my
home IP from when we set it up. Fix both together.

1. Azure Portal → search **wezoexpcalc** → open the **Azure Database for
   PostgreSQL flexible server**
2. Left menu: **Settings → Networking**
3. Under **Firewall rules**:
   - **+ Add a firewall rule** → Name `wezo-vm`, Start IP and End IP both = your
     `VM_IP`
   - **Delete** the rule containing `49.43.115.125` (that's my machine — it
     should not keep access)
4. Click **Save** at the top and wait for the green confirmation

### Check it worked  🖥️ On the VM

```bash
read -rsp 'Postgres password: ' PGPASSWORD; export PGPASSWORD; echo
psql "host=wezoexpcalc.postgres.database.azure.com port=5432 dbname=wezo_expenses user=wezoexpcalc sslmode=require" \
  -c 'select current_database();'
unset PGPASSWORD
```

(Typing it at the prompt rather than putting it in the command keeps the
password out of your shell history and off the screen.)

You want `wezo_expenses`. If it hangs or says "no pg_hba.conf entry", the
firewall rule hasn't taken effect — give it a minute and retry.

---

## Part 5 — Write the secrets  💻 + 🖥️

The app reads its configuration from one file that only the service account can
read. `provision.sh` created that file **empty**, and the deploy refuses to run
until it has content — so this part is not optional.

I generated the contents for you at `~/Desktop/wezo-vm-env.txt` on your Mac.
The database password is left as `__DB_PASSWORD__` and filled in on the VM in
step 5c, so the real password never sits in a file on your laptop.

> Copy the file rather than pasting it into an editor. A paste into `nano` that
> looks fine but isn't saved leaves the file empty, and the failure only shows
> up minutes later in the deploy log.

### 5a. Copy it up  💻 On your Mac

```bash
scp -i ~/.ssh/wezo_deploy ~/Desktop/wezo-vm-env.txt \
  azurewezoexpensecalc@VM_IP:/tmp/wezo.env
```

### 5b. Put it in place  🖥️ On the VM

```bash
sudo install -o wezo -g wezo -m 600 /tmp/wezo.env /opt/wezo/shared/.env
rm /tmp/wezo.env
```

`install` sets the owner and the permissions as it copies, so there is never a
moment where the file is readable by other accounts on the box. `600` means
only the `wezo` account can read it.

### 5c. Fill in the database password  🖥️ On the VM

The password is URL-encoded first, because a connection string treats `@` and
`:` as separators — an unencoded password containing either one silently
produces a wrong host.

```bash
read -rsp 'Postgres password: ' PW; echo
ENC=$(printf '%s' "$PW" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')
sudo sed -i "s|__DB_PASSWORD__|$ENC|" /opt/wezo/shared/.env
unset PW ENC
```

Reading the password at a prompt keeps it out of your shell history, and out of
the terminal scrollback.

### Check it worked  🖥️ On the VM

```bash
sudo -u wezo test -s /opt/wezo/shared/.env && echo "file has content"
sudo stat -c '%U %a %n' /opt/wezo/shared/.env    # want: wezo 600
grep -c __DB_PASSWORD__ /opt/wezo/shared/.env    # want: 0
```

Then prove the connection string actually works — this is the same thing the
deploy does, so a failure here saves you a round trip through CI:

```bash
sudo -u wezo bash -c 'set -a; . /opt/wezo/shared/.env; set +a; psql "$DATABASE_URL" -c "select current_database()"'
```

You want `wezo_expenses`. If it hangs, this VM's IP is not in the Postgres
firewall yet — go back to Part 4.

Finally, delete the copy on your Mac, since it contains live keys:

```bash
# 💻 On your Mac
rm ~/Desktop/wezo-vm-env.txt
```

---

## Part 6 — Give GitHub permission to deploy  🖥️ + 💻 + 🌐

GitHub Actions needs to log in to the VM. It uses a dedicated key that can only
do that one job — not your personal SSH key.

### 6a. Put the public key on the VM  🖥️ On the VM

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKqsoNBsCahIvSZcfg+uWEPZYNBvsNQku52LYslCzVa6 github-actions-deploy@wezoexpense' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 6b. Check the key works  💻 On your Mac

Replace `VM_IP` with your number:

```bash
ssh -i ~/.ssh/wezo_deploy azurewezoexpensecalc@VM_IP 'echo connected; whoami'
```

You want `connected` and `azurewezoexpensecalc`. If it asks for a password, the
key isn't installed correctly — redo 6a.

### 6c. Collect the four values  💻 On your Mac

```bash
# 1. DEPLOY_HOST
echo "VM_IP"

# 2. DEPLOY_USER
echo "azurewezoexpensecalc"

# 3. DEPLOY_SSH_KEY  — copies straight to your clipboard, nothing on screen
pbcopy < ~/.ssh/wezo_deploy && echo "private key copied to clipboard"

# 4. DEPLOY_HOST_KEY
ssh-keyscan -H VM_IP 2>/dev/null
```

### 6d. Add them to GitHub  🌐 In a browser

Go to
`https://github.com/wezotechnologies/wezoexpense/settings/secrets/actions`
→ **New repository secret**, once for each:

| Name | Value |
|---|---|
| `DEPLOY_HOST` | your `VM_IP` |
| `DEPLOY_USER` | `azurewezoexpensecalc` |
| `DEPLOY_SSH_KEY` | paste from the clipboard (step 3 above) |
| `DEPLOY_HOST_KEY` | the full output of `ssh-keyscan` |

The private key must be pasted **whole**, including the
`-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END ...-----` lines.

---

## Part 7 — First deploy  🌐 In a browser

Everything is ready. Trigger the pipeline:

`https://github.com/wezotechnologies/wezoexpense/actions`
→ **CI / Deploy** → **Run workflow** → branch `main` → **Run workflow**

It takes 3–5 minutes: it checks the code, builds it, ships it to the VM, starts
the app, waits for it to report healthy, then points nginx at it.

### Check it worked  🖥️ On the VM

```bash
cat /opt/wezo/active                              # blue or green
curl -s http://127.0.0.1/api/health | jq
```

You want `"ready": true` and a `"version"` matching the release. Then, in a
browser, `http://expense.wezo.co` should show the sign-in page.

If the workflow fails, open the failed step in the Actions log — the deploy
script prints the app's last 40 log lines when a health check fails, which is
almost always enough to see why.

---

## Part 8 — Turn on HTTPS  🖥️ On the VM

Only do this once `http://expense.wezo.co` loads, because the certificate
authority verifies the domain by fetching a file over HTTP.

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d expense.wezo.co
```

It asks for:
- an email (for expiry warnings) — use a real one
- agreement to the terms — `Y`
- whether to redirect HTTP to HTTPS — **choose redirect (option 2)**

Certificates last 90 days; certbot installs a timer that renews automatically.
Confirm it:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

### Then restart the app so sign-in uses the https URL

`NEXTAUTH_URL` is already `https://expense.wezo.co` in your `.env`, so just:

```bash
sudo systemctl restart "wezo@$(cat /opt/wezo/active)"
```

Visit `https://expense.wezo.co` and sign in as `owner@wezo.co`. You'll be
required to change the password immediately — that's intended.

---

## Part 9 — Schedule the recurring transactions  🖥️ On the VM

Rent, salaries and subscriptions are generated by a nightly job.

```bash
sudo -u wezo crontab -e
```

Choose nano if asked, then add this one line at the bottom:

```cron
45 19 * * * set -a; . /opt/wezo/shared/.env; set +a; curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1/api/cron/recurring >/dev/null
```

Save with **Ctrl+O, Enter, Ctrl+X**.

19:45 UTC is 01:15 IST. Missing a night is harmless — the next run catches up
any periods it missed. You can also trigger it any time from the **Recurring**
screen with **Run due now**.

### Check it worked

```bash
sudo -u wezo crontab -l
```

---

## Part 10 — From now on

**To deploy:** push to `main`. That's it. CI builds, tests, and switches with no
downtime. If a build breaks, the deploy never happens and the live site keeps
serving.

**Useful commands** 🖥️ On the VM:

```bash
# what's live and healthy?
cat /opt/wezo/active
curl -s http://127.0.0.1/api/health | jq

# watch the app's logs
journalctl -u "wezo@$(cat /opt/wezo/active)" -f

# undo the last deploy, in seconds
sudo bash /tmp/wezo-src/deploy/rollback.sh
```

### If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `dig` returns nothing for the domain | DNS hasn't propagated | Wait 5 minutes; check the record Name is `expense`, not the full domain |
| 502 Bad Gateway | the app isn't running | `journalctl -u "wezo@$(cat /opt/wezo/active)" -n 50` |
| Health check says `"database": false` | Postgres firewall or a wrong `DATABASE_URL` | Re-run the Part 4 check; remember `@` in the password must be `%40` |
| certbot: "Timeout during connect" | the domain doesn't reach the VM on port 80 | Confirm `dig` resolves, and that Azure's Network Security Group allows inbound 80 and 443 |
| Deploy fails at "Configure SSH" | a secret is wrong | Re-check `DEPLOY_SSH_KEY` was pasted whole, including both header lines |
| Sign-in loops or redirects wrongly | `NEXTAUTH_URL` doesn't match the address you're visiting | It must be exactly `https://expense.wezo.co` |

### One rule to remember

If you ever change the database schema, the migration runs **before** traffic
switches — so the old code briefly sees the new schema. Adding things is safe.
**Removing** a column or table needs two separate deploys: first stop using it,
then delete it. Doing both at once causes a few seconds of errors.

---

## Azure Network Security Group

The provisioning script configures the firewall *inside* the VM. Azure has a
second one in front of it. Check it allows inbound 80 and 443:

🌐 Azure Portal → **Virtual machines → wezoexpensecalc → Networking**. You
should see inbound rules allowing **80 (HTTP)** and **443 (HTTPS)** as well as
**22 (SSH)**. If HTTP/HTTPS are missing, add them with **Add inbound port
rule** — Destination port ranges `80,443`, Protocol TCP, Action Allow.

Nothing else needs to be open. Ports 3001 and 3002 are bound to the VM's own
loopback interface and are not reachable from outside, by design.
