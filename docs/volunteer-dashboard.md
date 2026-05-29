# Ride Check-In — Volunteer Dashboard

A dashboard that lets OutCycling volunteers view who's registered for a bike ride and
manage day-of check-in, **without exposing the sensitive data** (emails, phones, billing
addresses, emergency contacts, payment info) that also lives in the registration spreadsheet.

## How it works

```
Squarespace ──sync──▶ Google Sheet (master, contains PII)
                          │  apps-script/roster-sync.gs
                          │  (timer + onEdit) copies ONLY an allowlist of safe
                          │  columns into Firebase — PII never enters the payload
                          ▼
              Firebase Realtime Database (dedicated OutCycling.org project)
                /eventRoster/{eventId}   safe roster   (sync writes, volunteers read)
                /checkins/{eventId}      check-in state (volunteers read + write, realtime)
                /meta/{eventId}/lastSync sync timestamp
                          ▲
                          │  Google sign-in restricted to @outcycling.org,
                          │  enforced by firebase/database.rules.json
                          │
              volunteer-dashboard.html (static page, like the other widgets)
```

- **Auth:** volunteers sign in with their existing `@outcycling.org` Google account — no new
  accounts. The page only *hints* at the domain; the actual enforcement is in the database rules.
- **Concurrency:** check-ins are written to `/checkins` and streamed back via realtime listeners,
  so multiple volunteers on different devices see each other's check-ins instantly. Each record
  stores who checked the rider in and when.
- **The master sheet is never modified** by the dashboard.

### What volunteers can see (allowlist)
Rider name, route option, jersey size, registration tier (line item), quantity, registration
date, and whether the waiver was acknowledged.

### What is never synced (everything else)
Email, phone, billing name/address, emergency contact name/phone, payment method/reference, all
financial columns, private notes, channel info. Cancelled/refunded orders are filtered out (using
those columns server-side without ever exporting them). The allowlist in `roster-sync.gs` is the
single source of truth — new sheet columns leak nothing until explicitly added there.

## Setup

### 1. Firebase project (one-time)
- Create a **new** Firebase project under the OutCycling.org Workspace (kept separate from the
  public weather/heatmap `ride-annotator` project).
- Enable **Realtime Database**.
- Enable **Authentication → Sign-in method → Google**.
- Under **Authentication → Settings → Authorized domains**, add the host where this page is served
  (e.g. the GitHub Pages domain).
- Publish the rules from `firebase/database.rules.json` (Realtime Database → Rules).

### 2. Wire up the page
- Copy the project's web config (Project settings → General → Your apps → SDK setup) into
  `FIREBASE_CONFIG` near the top of `volunteer-dashboard.html`, replacing the `REPLACE_…`
  placeholders. These are public client identifiers, safe to commit (security is in the rules).

### 3. Spreadsheet sync (one-time)
- Open the orders Google Sheet → **Extensions → Apps Script**, and paste in
  `apps-script/roster-sync.gs`.
- Create a service account in the Firebase project ("Firebase Realtime Database Admin" role),
  download its JSON key.
- In Apps Script → **Project Settings → Script Properties**, add:
  `SERVICE_ACCOUNT_JSON`, `DATABASE_URL`, `EVENT_ID` (default `default`), and optionally
  `SHEET_NAME`. **Never commit these.**
- Run `installTriggers()` once and authorize. The roster then syncs every 5 minutes and on edit.

## Multiple events
Run several rides off one project by giving each its own `EVENT_ID` in Script Properties and
opening the dashboard with `?event=<id>`.

## Verification checklist
1. Sign in with an `@outcycling.org` account → roster loads. Sign in with a personal Gmail →
   rejected, no data shown.
2. In the Firebase console, inspect `/eventRoster` and the page's network traffic — confirm no
   email/phone/address/payment fields are present.
3. Edit a jersey size in the sheet → within ~5 min (or immediately on save) the dashboard updates.
4. Open the dashboard on two devices, check the same rider in on one → the other updates live;
   `/checkins` shows `by` + `at`. Undo works.
5. Confirm the master sheet is unchanged after check-ins.
