# Free deployment, and connecting real Meta and TikTok

This guide answers two questions: **how do I try the real Meta and TikTok connections from my own computer**, and **how do I put the
site online without paying**. Read the honest part first.

## The honest part

- **"Free" has conditions.** Every free tier below asks for an account (some for a payment card to prove you are a person), has
  limits, and can change. The facts here were checked on 2026-10-22 from the providers' own pages and press reports, and several
  of them **conflict** (noted where they do). Check the live pages before you rely on a number.
- **Nothing in this guide has been run on a real server or against real Meta or TikTok.** The scripts were syntax-checked and their
  logic unit-tested on a laptop. Treat the first run as a rehearsal on something you can throw away.
- **A free site is a pilot, not production.** No uptime promise, no support, backups only if you set them up. Keep the sign-up
  allow-list on, and do not put real customers' data on it before you have read
  [privacy-and-deletion.md](../privacy-and-deletion.md) and
  [release/pilot-checklist.md](../release/pilot-checklist.md).
- **TikTok Shop is not available in Bangladesh.** A TikTok connection needs a shop in a market where TikTok Shop operates.

## Which route do I want?

| I want to...                                   | Use                                                                        | Cost                          |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| Try real Meta or TikTok while I work on my Mac | **Part 1**: a free tunnel to the API on `localhost:4000`                   | free, only while my Mac is on |
| Have the whole site online all the time        | **Part 2**: a free always-on VM, the project's Docker deployment, free DNS | free, with the limits listed  |
| Both                                           | Part 1 first (to learn the dashboards), then Part 2                        |                               |

---

## Part 1: real Meta / TikTok from your computer (a free tunnel)

Meta and TikTok call your API: they send sign-in returns and webhooks to it. They cannot reach `localhost`, so the API needs a public
HTTPS address. **Only the API needs one.** The web app can stay on `http://localhost:3000`.

1. **Install a tunnel tool (nothing is installed for you).**
   - **ngrok** (recommended): a free account gives you **one stable dev domain** like `your-name.ngrok-free.app`, which is what Meta and
     TikTok need (they remember the address you register).
     ```bash
     brew install ngrok/ngrok/ngrok
     ngrok config add-authtoken <token from dashboard.ngrok.com>
     ```
     Then copy your free dev domain from dashboard.ngrok.com > Domains. The free plan reportedly caps data at **1 GB a month**
     (ngrok's pages disagree on the exact limits: check them); webhooks and sign-ins are tiny, so this is enough for testing.
   - **Cloudflare quick tunnel** (no account): `brew install cloudflared`. Its address **changes every run**, so it is only useful for
     looking around, not for registering with Meta or TikTok. A _stable_ Cloudflare tunnel needs a domain you own.
2. **Start the tunnel.**
   ```bash
   pnpm tunnel --domain your-name.ngrok-free.app      # or set NGROK_DOMAIN in .env and run: pnpm tunnel
   ```
   It opens the tunnel to the API (port 4000) and prints the **exact addresses to register** with Meta and TikTok and the lines to put
   in `.env`. `pnpm tunnel --print https://your-name.ngrok-free.app` prints them without starting anything.
3. **Fill in `.env`.** The bottom of your local `.env` has a commented block for this. Uncomment it and fill in:
   - `API_PUBLIC_URL=https://your-name.ngrok-free.app`
   - Meta: `META_MODE=live`, `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (an invented string of 16+ characters),
     `META_GRAPH_VERSION` (a version Meta currently supports, for example `v23.0`: check)
   - TikTok: `TIKTOK_MODE=live`, `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`

   You get the Meta and TikTok values from their dashboards. **Never paste them into a chat or commit them.** `.env` is git-ignored.

4. **Restart the API and the worker** (both read these settings). Live mode refuses to start if something is missing and says what.
5. **Register the printed addresses and connect.** The dashboard steps are in the **Activation checklist** of
   [meta.md](../meta.md#activation-checklist) and [tiktok-shop.md](../tiktok-shop.md#activation-checklist). Then, in the app,
   Integrations > connect.
6. **Expect fixes.** These connections have never run against the real services. Follow the "staging verification" steps in those
   checklists and note anything that differs.

When `META_MODE=live`, the mock tools disappear (the mock endpoints answer 404 in live mode) and the "Mock integration" banner goes
away. To go back to mock, comment the live lines out and restart.

---

## Part 2: the whole site online, free, always on

### What the free tiers offer (checked 2026-10-22)

| Option                                  | Fits OrderLoop?               | Why                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Oracle Cloud "Always Free" VM**       | **Yes: the only real option** | A real always-on virtual machine, so the project's Docker deployment (API, worker, web, PostgreSQL, Redis, proxy) runs as designed. **Caveats below.**                                                                    |
| Your own computer or a spare machine    | Yes, for a demo               | Run the same Docker deployment at home and expose it with a tunnel. Free, but it is only online while the machine is on.                                                                                                  |
| Render free tier                        | No                            | Free web services sleep when idle, and (as far as I know: verify) free databases expire and background workers are not free. OrderLoop needs a worker and a database that stays.                                          |
| Vercel / Netlify free                   | No (web only)                 | They host the web app but not the API, worker, PostgreSQL or Redis. Vercel's free plan is for non-commercial use.                                                                                                         |
| Fly.io, Railway                         | Not free any more (verify)    | Both have moved to paid or trial-credit plans for new accounts as far as I know. Check their current pricing.                                                                                                             |
| Free hosted PostgreSQL (Neon, Supabase) | Not recommended               | OrderLoop needs custom database roles, row-level security and security-definer functions, and a worker. This has not been tried on them, and free Redis tiers meter commands in a way the job queue's polling can use up. |

**Oracle caveats (read before you start):**

- **The allowance reportedly shrank.** Oracle's own "Always Free resources" page described 4 OCPU and 24 GB for the Ampere A1 shape,
  while InfoQ and another blog reported a cut to 2 OCPU and 12 GB from 15 June 2026. The sources conflict and I could not confirm it
  against Oracle's live page: look at the live page and at what your console lets you create. Two OCPU and 12 GB is plenty for a pilot.
- **Idle instances can be reclaimed.** Oracle's terms (quoted by a user) treat an instance as idle if, over seven days, CPU, network and
  memory use all stay under roughly 15% (other sources say 10 to 20%). A quiet pilot can look idle. Oracle usually warns by email.
  There is no SLA and no compensation if it is stopped.
- **"Out of host capacity"** errors when creating an Ampere instance are common in popular regions. Retrying later or in another
  availability domain is the usual fix. Pick your home region carefully: it cannot be changed.
- **A card is required to sign up** (verification; free-tier resources are not charged, but check what the console says before creating
  anything marked paid).
- **Back up off the VM.** If Oracle stops the instance you lose it. Use `ops/backup.sh` with an off-site target and keep the backup key
  elsewhere ([backup-and-restore.md](backup-and-restore.md)).

### Steps

You do the first four by hand (they need your accounts); the script does the rest.

1. **Create the VM.** In the Oracle console create an **Ubuntu 24.04** instance, shape Ampere A1 (arm64) or the largest always-free shape
   it offers; add your SSH public key; note the **public IP**. Prefer a **reserved** public IP so it never changes.
2. **Open ports 80 and 443 in Oracle's firewall** (not only on the VM): VCN > Security List > add ingress rules for TCP 80 and 443
   from `0.0.0.0/0`. Port 22 is already open for SSH.
3. **Get a free domain name.** The deployment serves the web app at `app.<domain>` and the API at `api.<domain>`, with a real HTTPS
   certificate from Let's Encrypt. You need a name whose subdomains point at the VM:
   - **DuckDNS** (free, with a login): create `my-shop.duckdns.org` pointing at the VM's IP; subdomains of it (`app.my-shop...`,
     `api.my-shop...`) resolve to the same IP, so use `DOMAIN=my-shop.duckdns.org`.
   - **sslip.io** (free, no signup): the name encodes the IP: for IP `1.2.3.4` use `DOMAIN=1-2-3-4.sslip.io`. If the IP changes, the name
     changes.
   - **Your own domain** (a few dollars a year) is the most robust: add one `A` record for `app` and one for `api` pointing at the IP.
4. **Mail.** Sign-up and password-reset emails need an SMTP server. Free options include Brevo's free plan (about 300 emails a day: check)
   or a Gmail account with an app password. Have the host, port, user and password ready.
5. **On the VM**, as the default user, clone the repository and run step 1:
   ```bash
   git clone <your repository URL> orderloop && cd orderloop
   ./deploy/vm-bootstrap.sh --domain my-shop.duckdns.org --email you@example.com --owner you@example.com
   ```
   It installs Docker, adds swap on a small VM, opens ports 80 and 443 on the VM, checks that both names point at the VM, and creates
   `deploy/.env` with every secret generated (printed nowhere). `--owner` is the **only** email allowed to sign up.
6. **Edit `deploy/.env`**: `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`. Then:
   ```bash
   ./deploy/vm-bootstrap.sh --start
   ```
   It builds the images (several minutes on a small VM), starts everything, and waits for `https://api.<domain>/health/ready`.
7. **Open `https://app.<domain>` and sign up** with the owner email. Invite your team from Team & staff.
8. **Keep these two things OFF the VM**: `deploy/backup-age-identity.txt` (decrypts backups) and `COURIER_CREDENTIALS_KEY` (decrypts stored
   courier and Meta tokens). Copy them somewhere safe, then remove the identity file from the VM.
9. **The mobile apps** talk to `https://api.<domain>`: build them with `EXPO_PUBLIC_API_URL=https://api.<domain>` (release builds refuse
   plain http). See [docs/mobile.md](../mobile.md).

### Turning on real Meta and TikTok on the VM

The VM's address is already public and HTTPS, so **no tunnel is needed**. In `deploy/.env` set the live values (the file lists them), then
`sudo docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d`:

- Meta: `META_MODE=live`, `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (already generated: copy it into the Meta dashboard),
  `META_GRAPH_VERSION`.
- TikTok: `TIKTOK_MODE=live`, `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`.

Register the addresses with `pnpm tunnel --print https://api.<domain>` (run it anywhere: it only prints). Then follow the checklists in
[meta.md](../meta.md#activation-checklist) and [tiktok-shop.md](../tiktok-shop.md#activation-checklist).

### Keeping it safe

- Leave `REGISTRATION_MODE=allowlist` on. The script sets it with only your owner email.
- Never open PostgreSQL (5432) or Redis (6379) to the internet. The compose file does not publish them; do not change that.
- Update regularly: `git pull`, rebuild, `up -d`. Watch `docker compose logs`.
- Set up a backup schedule and an off-site copy before real data goes in. Test a restore.
- Read [deployment.md](deployment.md) section 12 (smoke test) and [incident-response.md](incident-response.md).

## What was and was not tested

| Item                                             | Status                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm tunnel` address logic (the URLs it prints) | Unit-tested.                                                                                                           |
| `pnpm tunnel` starting ngrok or cloudflared      | **Not run**: neither tool is installed on the machine it was written on. Written from their documented command lines.  |
| `deploy/vm-bootstrap.sh`                         | Syntax-checked; the `.env` editing function tested against the real template. **Never run on a VM.**                   |
| The Docker deployment it starts                  | Run locally on a laptop (see [deployment.md](deployment.md) section 14). Not on Oracle, Linux arm64, or a real domain. |
| Oracle, DuckDNS, sslip.io, Brevo, ngrok details  | From public pages and reports checked on 2026-10-22; they change and some conflict. Verify.                            |
| Real Meta and TikTok through any of this         | **Never run.** See the two checklists.                                                                                 |
