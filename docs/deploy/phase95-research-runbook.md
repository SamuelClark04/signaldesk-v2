# Phase 95 research system: runbook

Plan: `docs/superpowers/plans/2026-10-07-shadow-research-system.md`. Every step here that creates a cloud resource, deploys to the VM or
installs a scheduled task is YOURS to run, after its own approval. The research code only uses what you set up.

## 1. Bucket (plan 9.1 / 9.4; Task 0.3; cloud-resource creation needs your approval)

Everything below runs in **Google Cloud Shell** (the `>_` button in the Cloud console), which has `gcloud` installed and signed in to
your account. Replace `PROJECT` with a new project id of your choice, e.g. `signaldesk-research-1234` (globally unique).

**Why a separate project:** a billing problem or an optional billing cut-off there can never stop the trading VM, which lives in your
existing project.

```bash
# 1. A separate project, linked to your billing account (list accounts: gcloud billing accounts list)
gcloud projects create PROJECT --name="SignalDesk research"
gcloud billing projects link PROJECT --billing-account=BILLING_ACCOUNT_ID
gcloud services enable storage.googleapis.com --project=PROJECT

# 2. A private bucket in us-central1 (the Always Free region, next to the VM)
gcloud storage buckets create gs://PROJECT-data --project=PROJECT --location=us-central1 --default-storage-class=STANDARD \
  --uniform-bucket-level-access --public-access-prevention

# 3. Delete every object after 21 days (bounds storage and cost)
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":21}}]}' > lifecycle.json
gcloud storage buckets update gs://PROJECT-data --lifecycle-file=lifecycle.json

# 4. Two service accounts, each limited to this bucket: the VM may only CREATE objects, the PC may only READ them
gcloud iam service-accounts create sd-vm-writer --project=PROJECT --display-name="SignalDesk VM writer"
gcloud iam service-accounts create sd-pc-reader --project=PROJECT --display-name="SignalDesk PC reader"
gcloud storage buckets add-iam-policy-binding gs://PROJECT-data \
  --member=serviceAccount:sd-vm-writer@PROJECT.iam.gserviceaccount.com --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding gs://PROJECT-data \
  --member=serviceAccount:sd-pc-reader@PROJECT.iam.gserviceaccount.com --role=roles/storage.objectViewer

# 5. One key each (JSON). Keep them private; never paste them anywhere.
gcloud iam service-accounts keys create vm-writer.json --iam-account=sd-vm-writer@PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts keys create pc-reader.json --iam-account=sd-pc-reader@PROJECT.iam.gserviceaccount.com
```

**Moving the keys:**
- **VM:** download `vm-writer.json` from Cloud Shell (More, then Download), upload it in SSH-in-browser (UPLOAD FILE), then:
  ```bash
  mv ~/vm-writer.json ~/signaldesk-v2/.research-gcs.json && chmod 600 ~/signaldesk-v2/.research-gcs.json
  ```
- **PC:** download `pc-reader.json` and save it as `C:\SignalDesk-V2\.research-gcs.json`.
- **Clean up:** delete both files from Cloud Shell (`rm vm-writer.json pc-reader.json`).
- **Never committed:** `.research-gcs.json` is git-ignored.

**Check the rights** (prints the result, never the key):

```bash
# on the VM
cd ~/signaldesk-v2 && node scripts/research/gcs-check.js --role writer --bucket PROJECT-data   # "writer: can create, cannot read -> OK"
```
```bash
node scripts/research/gcs-check.js --role reader --bucket PROJECT-data
```

The second one runs on the PC and should print "reader: cannot create, can read -> OK". The writer check leaves one small object under
`check/`; the lifecycle rule deletes it.

## 2. Cost controls (plan 9.4): a budget alert is NOT a spending cap

- **Budget alert:** Billing, then Budgets & alerts, then Create budget.
  - Scope: project `PROJECT` only.
  - Amount: $1.
  - Alerts at 50%, 90% and 100%.

  It only sends email; it does not stop anything.
- **Limits that actually hold:**
  - the 21-day lifecycle rule (above);
  - the exporter's daily caps (150 MB, 300 objects) and the puller's per-run caps (1 GB, 2,000 objects), in code;
  - the separate project.
- **Optional true cap:** Google documents an automation that DISABLES billing for a project when a budget is reached (budget, then
  Pub/Sub, then a function that removes the billing account). Search the Cloud docs for "Disable billing usage with notifications".
  It is safe only because the bucket is in its own project (it would never touch the VM). It is off unless you set it up.
- **Free tier:** confirm in the console that us-central1 standard storage is within the Always Free tier for your account
  (5 GB-months, 5,000 Class A and 50,000 Class B operations a month). Expected use: about 0.3 GB, about 1,500 uploads and about 0.3 GB
  downloaded a month (to be replaced by measurements, plan section 11).

## 3. Research collector (Task 8.4 draft; DEPLOYING it needs your separate approval)

- **Process:** a separate pm2 app, low priority, which never touches the trading server's files:
  ```bash
  cd ~/signaldesk-v2 && pm2 start "nice -n 10 node server/research/collector/main.js" --name signaldesk-research \
    --max-memory-restart 200M --kill-timeout 6000 && pm2 save
  ```
  `--kill-timeout 6000` gives its shutdown (up to 4.5 s: it waits for a write in flight, then flushes) time to finish.
- **Its own files** in the events folder: `research-YYYY-MM-DD.jsonl`, `research-news-cursor.json`. Its STATUS lines read "research
  collector process". `vm-audit.sh` copies them; `inspect.js` reads both files and judges each process on its own counters.
- **The one switch: `RESEARCH_COLLECTOR=on` in `.env`.**
  - With it, the trading server stops ITS news poll and earnings snapshot at its next restart, and the collector runs them.
  - Without it, the collector records only its heartbeat (and later the option grid), so the two never poll twice.
  - Order: add the line, start the collector, then restart the trading server.
- **Keys:** the collector reads ONLY these from `.env`: the Alpaca data keys, `ALPACA_DATA_BASE_URL`, the Finnhub key and URL,
  `EVENTS_DIR`, `EVENTS_RECORDER`, `LEDGER_STATE_PATH`, `RESEARCH_*`. It never reads the broker keys or the credentials vault. If the
  Alpaca keys live only in the vault, add the PAPER data keys to `.env` for it. Check: its first `POLL_STATUS` line is `ok: true`.
- **Requests:** every Alpaca request goes through its limiter (`RESEARCH_COLLECTOR_PER_MIN`, default 40, clamped 1-150; 2-min stand-back
  on HTTP 429). The account limit (200 / min) is shared with the trading server.
- **Rollback:**
  1. `pm2 delete signaldesk-research && pm2 save`;
  2. remove `RESEARCH_COLLECTOR=on`;
  3. restart the trading server (its own poll resumes).
