# Rajasthan Exam Notification Monitor (RPSC & RSSB)

Autonomous, resilient real-time monitoring, classification, and multi-channel notification pipeline for official announcements from Rajasthan examination authorities:
- **RPSC** (Rajasthan Public Service Commission)
- **RSSB** (Rajasthan Staff Selection Board)

Dispatches instant alerts to **Telegram Channels** and **Firebase Cloud Messaging (FCM HTTP v1)** for mobile apps.

---

## 🏛 Features

- **Government Portal Scraper:** Custom HTTP scraper with legacy SSL cipher support (`SSL_OP_LEGACY_SERVER_CONNECT`) designed specifically for Rajasthan government web servers.
- **Durable Outbox Architecture:** Uses PostgreSQL `claim_outbox_jobs` with `SKIP LOCKED` and advisory locks to ensure zero duplicate notifications and guaranteed delivery.
- **Silent Baseline Onboarding:** The very first scan records all active notices without sending spam. Only newly released or amended notices trigger alerts.
- **Change Audit History:** Detects when a previously published notice is updated (e.g., date amendments, revised syllabus) and archives a diff in `exam_notice_history`.
- **Intelligent Classification Engine:** Automatically tags notices by Exam (RAS, SI, CET Graduate, CET 10+2, REET, LDC, Patwar, Constable, etc.) and Notice Type (Recruitment Advertisement, Admit Card, Answer Key, Result, Exam Date, Corrigendum).
- **Gemini AI Enrichment:** Optional Google Gemini integration that generates structured Hindi/English summaries, vacancy counts, and key deadline highlights.

---

## 📂 Architecture

```
[RPSC / RSSB Portals]
        │ (Scrape HTML with legacy SSL)
        ▼
[IngestionCoordinator] ───► [ClassificationEngine]
        │                               │
        │                       (Optional AI)
        ▼                               ▼
[Supabase: exam_notices] ◄─── [GeminiEnrichmentService]
        │
        ▼ (Enqueue Outbox Jobs)
[Supabase: notice_outbox]
        │
        ├───► [TelegramDispatcher] ───► Telegram Channels (@pyqboxannouncements)
        └───► [FcmDispatcher]      ───► Mobile App Devices (FCM Topic / Token)
```

---

## ⚙️ Configuration & GitHub Secrets

To run this pipeline automatically via GitHub Actions, add these repository secrets in **Settings > Secrets and variables > Actions**:

| Secret | Required | Description |
| :--- | :---: | :--- |
| `SUPABASE_URL` | **Yes** | Your Supabase project URL (`https://xyz.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase Service Role key (needed to bypass RLS for table updates & advisory locks) |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram Bot API token from `@BotFather` |
| `FCM_SERVICE_ACCOUNT` | Optional | Raw stringified JSON or path of your Firebase Admin Service Account |
| `GEMINI_API_KEY` | Optional | Google Gemini API key for structured notice enrichment |

---

## 🚀 Execution Modes

### 1. Automated GitHub Actions (Serverless)
The included workflow [`.github/workflows/exam_monitor.yml`](.github/workflows/exam_monitor.yml) runs automatically during Rajasthan government office hours:
- **Peak Hours:** Every 15 minutes from **9:00 AM to 7:30 PM IST**, Monday through Saturday.
- **Evening Standby:** Every 30 minutes from **7:30 PM to 10:30 PM IST**, Monday through Saturday.
- **Sunday:** Every 2 hours during the day.
- **Manual Trigger:** Click **Run workflow** anytime in the Actions tab.

### 2. Local CLI Commands
```bash
# Install dependencies
npm install

# Run ingestion poll for RPSC and RSSB
npm run poll

# Dispatch pending Telegram and FCM outbox jobs
npm run outbox

# Reset source baseline (for re-onboarding)
npm run reset-baseline -- --source rpsc
```

### 3. Continuous Daemon Worker (Real-Time Sub-2-Minute Alerts)
For 24/7 sub-2-minute notification latency (e.g. deployed on a VPS or Render/Railway background worker):
```bash
npm run worker
```
The built-in scheduler dynamically adjusts polling frequency based on Indian Standard Time:
- **Peak Office Hours (9 AM – 7:30 PM IST):** Polls every **2 minutes**.
- **Evening Standby (8 PM – 11 PM IST):** Polls every **5 minutes**.
- **Night Quiet Hours (11 PM – 9 AM IST):** Polls every **15 minutes**.
- **Outbox Worker:** Dispatches notifications every **4 seconds**.

---

## 🗄 Database Setup

The required database tables, indexes, and RPC functions are provided in:
[`supabase/migrations/0019_exam_notifications.sql`](supabase/migrations/0019_exam_notifications.sql)

Apply this migration to your Supabase project using the Supabase CLI:
```bash
supabase db push
```
Or paste the SQL directly into the Supabase SQL Editor.
