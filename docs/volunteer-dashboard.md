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
                /checkins/{eventId}      check-in state + assigned number (volunteers read + write, realtime)
                /checkouts/{eventId}     check-out state   (volunteers read + write, realtime)
                /jerseys/{eventId}       jersey-pickup     (volunteers read + write, realtime)
                /reststops/{eventId}     per-rest-stop check-ins (volunteers read + write, realtime)
                /jerseyInventory/{eventId} jersey stock    (volunteers read; super-admins write)
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
- **Concurrency:** check-ins, check-outs, and jersey pickups are written to `/checkins`,
  `/checkouts`, and `/jerseys` and streamed back via realtime listeners, so multiple volunteers on
  different devices see each other's updates instantly. Each record stores who did it and when.
- **Three independent annotations:** *Check-In* (rider has arrived), *Check-Out* (rider has left),
  and *Jersey Picked Up* are tracked separately, so each can run as a different station. Each row in
  the roster table and the rider detail sheet has a toggle for all three; in the detail sheet the
  **🏁 Check Out** button sits on top of the others.
- **Check-in numbers:** checking a rider in opens a small dialog that assigns them a number
  (defaulting to the lowest unused one). The dialog warns and blocks if the number is **already
  given out** to someone else, so numbers can't be duplicated. The number is stored on the
  `/checkins` record (`number`), shown in the roster's **#** column and the detail sheet, and is
  **searchable** — the filter bar has a dedicated **Check-in #** box that filters the table to
  riders whose number contains the typed digits (the name box also still jumps to an exact-number
  match). The number can be changed
  later from the detail sheet. (The Squarespace order number is no longer shown on the dashboard.)
  **Un-checking-in** a rider releases their number (it becomes available again), so it first asks
  for confirmation, warning that the number will be freed.
- **Rest-stop check-ins:** five rest stops along the route are tracked as independent check-ins
  per rider, stored under `/reststops/{eventId}/{orderNumber}/{stopId}` (stop ids `1`–`5`). The
  stops are **Rest Stop 1** — Hoelscher Field, Harrington Park NJ; **2** — Tallman State Park;
  **3** — Rockland Lake State Park; **4** — Eugene Levy Memorial Park, New City NY; and **5** —
  Hoelscher Field, Harrington Park NJ (same location as stop 1 but a deliberately separate
  check-in). There are two ways to check a rider in at a rest stop:
  1. **Open the rider** and tap a rest stop in the detail sheet's *Rest Stops* list (each toggles
     on/off independently, exactly like check-in / check-out / jersey pickup). The roster table also
     has a per-stop column for each rest stop (named in the header).
  2. **Check in by number** — a card at the top of the page where the rest-stop volunteer picks
     their stop once (remembered per device) and just types the rider's **check-in number**; on
     submit it validates the number and shows a confirmation of **who** was checked in (or an error
     if the number isn't assigned). A *Rest stop check-ins by route* table shows, per route, how
     many riders have checked in at each of that route's stops out of how many are possible (the
     riders on that route who checked in at the start of the ride); stops a route doesn't use show
     `–`. It derives from live data, so it
     follows route edits — a re-routed rider is counted under their new route, and a check-in left
     at a stop the new route doesn't use simply stops being counted.

  **Adaptive by route:** the rest stops available to a rider depend on their route's mileage —
  the **40** route stops only at 1 & 2, the **65** route only at 1–3, and any other route uses all
  five (configurable via `ROUTE_REST_STOPS`). Unavailable stops show a muted `–` in the table, are
  omitted from the detail sheet, and are rejected (with an explanatory message) in the by-number card.
- **Reset data (super-admins):** a collapsible *Reset Data* card at the bottom of the page lets
  super-admins bulk-clear day-of state for the event — check-in numbers, check-in status, check-out
  status, jersey pickup status, rest-stop check-ins, and override edits — each opt-in via its own checkbox (with a live
  count of affected records). It requires typing `RESET` to confirm, plus a final confirmation
  dialog, and is **super-admin only** (and audited). Each reset writes per-record nulls to the same
  nodes volunteers already write, so no extra rules are required.
- **Live breakdown stats:** the dashboard shows overall totals, a compact per-route strip of
  checked-in / signed-up counts (styled like the summary, wraps on mobile), and a per-jersey-size
  table of signed-up / checked-in / picked-up counts.
- **Jersey inventory (super-admins):** a collapsible *Jersey Inventory* form lets super-admins
  record how many jerseys exist per size. Stock counts live in `/jerseyInventory/{eventId}/sizes`
  and are readable by all volunteers. When inventory data is present, a toggle pill appears in the
  *By&nbsp;Jersey&nbsp;Size* card (visible to every volunteer, defaults **on**) that switches each
  column between a plain count and **count / stock**. The toggle is per-user local state — it resets
  to on each session. A cell turns **red** when count exceeds stock and **yellow** when they match.
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
- The **Activity Log** (rider additions, check-ins with assigned number, check-outs, jersey
  pickups, the undo of each, number re-assignments, every emergency-contact reveal, and volunteer
  add/remove — who · what · when) is readable by **super-admins only**.
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
4. Open the dashboard on two devices, check the same rider in on one → the assign-number dialog
   appears; confirm a number and the other device updates live; `/checkins` shows `by`, `at`, and
   `number`. Try assigning the same number to another rider → the dialog warns and blocks it. Undo
   works. Repeat for the 🏁 check-out toggle (`/checkouts`) and the 👕 jersey toggle (`/jerseys`).
   Search by a rider's number → only that rider shows.
5. Open a checked-in rider's detail sheet → tap a rest stop in the *Rest Stops* list; `/reststops`
   shows `{checkedIn, by, at}` under that stop id and the status chip updates. At the top, pick a
   rest stop, type that rider's number, and submit → it confirms who was checked in; an unknown
   number shows an error. The *Rest stop check-ins* strip tallies live.
6. Confirm the breakdown tables (by route, by jersey size) tally correctly as you toggle.
7. Confirm the master sheet is unchanged after check-ins / jersey pickups.

> **Note:** the jersey feature added a `/jerseys` node to `firebase/database.rules.json`, the
> jersey-inventory feature added a `/jerseyInventory` node, the check-out feature added a
> `/checkouts` node (plus an optional `number` field on `/checkins`), and the rest-stop feature
> added a `/reststops` node. If you published the rules before any of these changes,
> **re-publish them** (Realtime Database → Rules) or those writes will be denied.

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
