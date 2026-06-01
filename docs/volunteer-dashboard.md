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
                /acl/superAdmins/{email}  super-admin allowlist (console-managed)
                /acl/volunteers/{email}   volunteer allowlist  (super-admins manage in-app)
                /eventRoster/{eventId}   safe roster      (sync writes, volunteers read)
                /checkins/{eventId}      check-in state    (volunteers read + write, realtime)
                /jerseys/{eventId}       jersey-pickup     (volunteers read + write, realtime)
                /meta/{eventId}/lastSync sync timestamp
                /restricted/
                  emergencyContacts/…    emergency name+phone (sync writes; volunteers + super-admins read)
                  auditLog/…             activity log (append by anyone with access; super-admins read)
                          ▲
                          │  Any verified Google account may sign in; ROLE is decided by
                          │  the /acl lists, enforced by firebase/database.rules.json
                          │
              volunteer-dashboard.html (static page, like the other widgets)
```

- **Auth & roles:** anyone can sign in with *any* verified Google account, but access is
  **allowlist-driven**, not by email domain. A user's role is read from two global lists:
  - **Super-admin** (`/acl/superAdmins`): everything a volunteer can do **plus** read the
    Activity Log **plus** add/remove volunteers from the app.
  - **Volunteer** (`/acl/volunteers`): the dashboard, check-in/out, jersey pickup, and viewing
    emergency contacts — but **not** the Activity Log.
  - **Anyone in neither list:** no access — they see a "not authorized yet" screen.

  Enforcement is in the database rules; the page UI only mirrors it. Emails are keyed lowercased
  with `.` replaced by `,` (RTDB keys can't contain `.`) — e.g. `Jo.Lee@gmail.com` →
  `jo,lee@gmail,com`. Gmail dot/alias normalization is **not** applied, so add the exact address.
- **Concurrency:** check-ins and jersey pickups are written to `/checkins` and `/jerseys` and
  streamed back via realtime listeners, so multiple volunteers on different devices see each
  other's updates instantly. Each record stores who did it and when.
- **Two independent annotations:** *Check-In* (rider has arrived) and *Jersey Picked Up* are
  tracked separately, so a jersey table and a check-in table can run as different stations.
- **Live breakdown stats:** the dashboard shows overall totals, a compact per-route strip of
  checked-in / signed-up counts (styled like the summary, wraps on mobile), and a per-jersey-size
  table of signed-up / checked-in / picked-up counts.
- **The master sheet is never modified** by the dashboard.

### What volunteers can see (allowlist)
Rider name, route option, jersey size, registration tier (line item), quantity, registration
date, and whether the waiver was acknowledged.

### What is never synced (everything else)
Email, phone, billing name/address, payment method/reference, all financial columns, private
notes, channel info. Cancelled/refunded orders are filtered out (using those columns server-side
without ever exporting them). The allowlist in `roster-sync.gs` is the single source of truth —
new sheet columns leak nothing until explicitly added there.

### Restricted data — emergency contacts & activity log
Emergency contact name/phone **is** synced, but ONLY to `/restricted/emergencyContacts`, which is
never world-readable. Read access requires a role (volunteer **or** super-admin) — accounts in
neither allowlist can't retrieve it even by forcing the call.

- In the rider detail sheet, anyone with access gets a **🚑 Show emergency contact** disclosure.
  Each reveal writes an `emergency_view` audit entry.
- The **Activity Log** (rider additions, check-ins, jersey pickups, the undo of each, every
  emergency-contact reveal, and volunteer add/remove — who · what · when) is readable by
  **super-admins only**.
- Audit entries are **append-only**: anyone with access can write their own action (so their
  check-ins and emergency-views get logged) but **cannot read the log back** — only super-admins can.

**Managing who has access (super-admins):** open the dashboard's **Manage Volunteers** card (visible
to super-admins) and add or remove volunteer emails. Changes take effect on the volunteer's next
sign-in/refresh; each add/remove is itself audited. The **super-admin** list is console-managed only
(the rules make `/acl/superAdmins` read-only from the app) — see "Seeding the first super-admin".

**Data handling:** after the event, delete `/restricted/emergencyContacts/{eventId}` (and optionally
the audit log) from the Firebase console.

### Seeding the first super-admin (console)
The app cannot bootstrap its own first super-admin by design. In the Firebase console → Realtime
Database, create:

```
/acl/superAdmins/<email-lowercased-dots-as-commas>: true
```

e.g. key `ivan@outcycling,org` with value `true` (a boolean). That account can then sign in, see the
**Manage Volunteers** card, and add everyone else. To add more super-admins, repeat in the console.

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
  - `SERVICE_ACCOUNT_JSON` = the entire downloaded service-account JSON
  - `DATABASE_URL` = `https://widgets-2e848-default-rtdb.firebaseio.com`
  - `EVENT_ID` = `default`
  - `SHEET_NAME` = the orders tab name (optional; defaults to the first sheet)

  **Never commit these.**
- Run `installTriggers()` once and authorize. The roster then syncs every 5 minutes and on edit.

## Multiple events
Run several rides off one project by giving each its own `EVENT_ID` in Script Properties and
opening the dashboard with `?event=<id>`.

## Verification checklist
1. Seed a super-admin in the console (see "Seeding the first super-admin"). Sign in as that account
   → roster loads, Activity Log + Manage Volunteers cards show. Sign in with an account in **no**
   allowlist → "not authorized yet" screen, no data shown. Add that account via Manage Volunteers,
   refresh → roster loads, but **no** Activity Log card (volunteer, not super-admin).
2. In the Firebase console, inspect `/eventRoster` and the page's network traffic — confirm no
   email/phone/address/payment fields are present.
3. Edit a jersey size in the sheet → within ~5 min (or immediately on save) the dashboard updates.
4. Open the dashboard on two devices, check the same rider in on one → the other updates live;
   `/checkins` shows `by` + `at`. Undo works. Repeat for the 👕 jersey toggle (`/jerseys`).
5. Confirm the breakdown tables (by route, by jersey size) tally correctly as you toggle.
6. Confirm the master sheet is unchanged after check-ins / jersey pickups.

> **Note:** the jersey feature added a `/jerseys` node to `firebase/database.rules.json`. If you
> published the rules before this change, **re-publish them** (Realtime Database → Rules) or
> jersey writes will be denied.

## Enabling restricted emergency contacts + activity log
1. **Seed at least one super-admin** in the console (see "Seeding the first super-admin"), then have
   them add volunteers via the **Manage Volunteers** card. Volunteers can view emergency contacts;
   only super-admins read the Activity Log.
2. **Add the emergency columns to the sync.** `roster-sync.gs` already reads
   `Product Form: Emergency Contact Name` and `Product Form: Emergency Contact Phone` into
   `/restricted/emergencyContacts` (never `/eventRoster`). No Script Property changes are needed; the
   existing admin service-account token can write `/restricted` (Admin bypasses rules). Re-run
   `installTriggers()` only if you haven't already.
3. **Verify the gate:** sign in as a volunteer → the 🚑 disclosure appears in a rider's detail sheet,
   but **no** Activity Log card. Sign in as a super-admin → both appear. Sign in as an account in no
   list → "not authorized yet" screen, and a forced read of `/restricted/...` is denied in the
   console network tab.
4. **Verify auditing:** anyone with access reveals a contact → an `emergency_view` row appears in the
   super-admin's Activity Log. A volunteer's check-in/jersey toggle appears as a row (the volunteer
   can't read the log). A super-admin add/remove shows `volunteer_added`/`volunteer_removed`. Add a
   sheet row → after sync, a `rider_added` row (actor `sync`) appears.
5. **After the event:** delete `/restricted/emergencyContacts/{eventId}` from the console.
