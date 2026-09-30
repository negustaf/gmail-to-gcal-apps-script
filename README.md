# Hey Forward → Gmail Plus-Address → Gemini → Calendar

Forward event emails from [Hey](https://www.hey.com/) to a Gmail **plus-address**, and this Google Apps Script turns them into Google Calendar events.

Every 5 minutes the script searches Gmail for mail addressed to your plus-address, asks Gemini to extract event details, creates an event on your **primary** calendar when confidence is high enough, and labels the thread so it is never processed twice.

## How it works

1. In Hey, forward a confirmation or invite to `you+schedule@gmail.com` (same inbox as `you@gmail.com`).
2. A time-driven Apps Script trigger runs `processForwardedEmails`.
3. Gemini returns JSON: `title`, `start`, `end`, `allDay`, `location`, `description`, `confidence`.
4. On success the thread gets the `schedule-processed` label.
5. Low confidence or missing datetime → `schedule-needs-review` (no invented times); optionally emails you a short note.

## Files

| File | Role |
|------|------|
| `Config.gs` | Plus-address property, label names, Gemini model, timezone, confidence threshold |
| `Code.gs` | `processForwardedEmails()` entry, label helpers, `setupTrigger()` |
| `Gemini.gs` | Generative Language API call + extraction prompt |
| `Calendar.gs` | Create timed or all-day events on the primary calendar |
| `appsscript.json` | OAuth scopes (Gmail, Calendar, UrlFetch, triggers) |

## One-time setup

### 1. Create the Apps Script project

1. Open [script.google.com](https://script.google.com/) while signed into the **Gmail account that should receive forwards**.
2. **New project** → paste each `.gs` file (create matching script files) and replace `appsscript.json` via **Project Settings → Show "appsscript.json" manifest**.
3. Or use [clasp](https://github.com/google/clasp): `clasp create --type standalone --title "Hey Forward Schedule"` then `clasp push`.

### 2. Set your plus-address

You do **not** need a second Google account for the tag itself. If your Gmail is `transactions.ngustafson@gmail.com`, use `transactions.ngustafson+schedule@gmail.com`.

1. In the Apps Script editor: **Project Settings → Script Properties → Add script property**.
2. Property: `SCHEDULE_PLUS_ADDRESS`
3. Value: your full plus-address, e.g. `transactions.ngustafson+schedule@gmail.com`

`Config.gs` reads this property and builds a search like:

```text
to:transactions.ngustafson+schedule@gmail.com newer_than:7d -label:schedule-processed -label:schedule-needs-review
```

### 3. Add a Gemini API key

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Script Property name: `GEMINI_API_KEY`
3. Value: the API key string

The default model id is `gemini-3.8-flash` in `Config.gs` (`CONFIG.GEMINI_MODEL`). Change it there if you prefer another Generative Language model.

### 4. Authorize

1. In the editor, select `processForwardedEmails` (or `setupTrigger`) and click **Run**.
2. Approve Gmail, Calendar, and external request access when prompted.

### 5. Install the 5-minute trigger

1. Select `setupTrigger` in the function dropdown and **Run** it once.
2. Confirm under **Triggers** that `processForwardedEmails` runs every 5 minutes.

You can also create the trigger manually: **Triggers → Add trigger → processForwardedEmails → Time-driven → Minutes timer → Every 5 minutes**.

### 6. Forward from Hey

1. Open the email in Hey.
2. Forward it and put your plus-address in the **To** field (for example `transactions.ngustafson+schedule@gmail.com`).
3. Do not rely on a contact card that strips the `+schedule` tag—type the full address.
4. Within about five minutes the script should create a calendar event (or apply `schedule-needs-review`).

Optional Gmail polish: create a filter `to:(you+schedule@gmail.com)` that applies a label like `Schedule/Inbound` so the inbox stays tidy. The script keys off the plus-address search and its own processed/review labels, not that optional label.

## Multiple Gmail accounts

Apps Script runs **as the Google account that authorized it**. It can only read that account’s Gmail and create events on **that** account’s primary Calendar.

| What you have | What to do |
|---------------|------------|
| One Gmail, one calendar | One Apps Script project; set `SCHEDULE_PLUS_ADDRESS` to `you+schedule@gmail.com` |
| Several separate Gmails (e.g. `you@gmail.com` and `transactions.ngustafson@gmail.com`) | **One Apps Script project per Gmail**, signed in / authorized as that account. Same code, different Script Properties. Forward from Hey to that account’s `+schedule` address so mail lands in *its* inbox and events land on *its* Calendar. |
| Several plus-tags on the **same** Gmail | Still one project; today the script watches a single `SCHEDULE_PLUS_ADDRESS`. Change the property or extend the search if you need more tags on one inbox. |

There is no supported way for a personal Gmail Apps Script to watch another person’s inbox or write to another person’s Calendar. Reuse the GitHub files in each project; you do not need different code—just a separate deployment per mailbox.

Example: forward to `transactions.ngustafson+schedule@gmail.com` → install this script under `transactions.ngustafson@gmail.com` → events appear on that account’s Google Calendar.

## Config knobs (`Config.gs`)

| Setting | Default | Meaning |
|---------|---------|---------|
| `SCHEDULE_PLUS_ADDRESS` (Script Property) | *(required)* | Who you forward to, e.g. `you+schedule@gmail.com` |
| `GEMINI_API_KEY` (Script Property) | *(required)* | Google AI Studio API key |
| `PROCESSED_LABEL` | `schedule-processed` | Applied after a successful Calendar create |
| `NEEDS_REVIEW_LABEL` | `schedule-needs-review` | Applied when confidence is low or datetime is missing |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Generative Language model id |
| `TIMEZONE` | script timezone | Context for relative phrases in the prompt |
| `CONFIDENCE_THRESHOLD` | `0.7` | Below this → needs review, no event |
| `SEARCH_NEWER_THAN` | `7d` | Gmail search window |
| `EMAIL_SELF_ON_NEEDS_REVIEW` | `true` | Email yourself when a message needs review |

## Idempotency and review behavior

- Threads already labeled `schedule-processed` or `schedule-needs-review` are skipped.
- The search also excludes those labels, so reruns stay cheap.
- The script **never invents** start/end times. Missing datetime or low confidence → label only (and optional email), no Calendar write.

## Manual test

1. Set both Script Properties.
2. Run `setupTrigger` once (or run `processForwardedEmails` manually).
3. Forward a real invite from Hey to your plus-address.
4. Check primary Calendar and the thread labels in Gmail.

## Privacy note

Email subject and body are sent to the Gemini API for extraction. Use only mail you are comfortable sending to Google’s Generative Language API, and keep your API key in Script Properties—never commit it to git.
