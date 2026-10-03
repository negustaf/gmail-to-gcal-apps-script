# Gmail Plus-Address → Gemini → Calendar

Forward event emails to a Gmail **plus-address**, and this Google Apps Script turns them into Google Calendar events. It works with any email client that can send to that address.

Every 5 minutes the script searches Gmail for mail addressed to your plus-address, asks Gemini to extract event details, and creates an event on your **primary** calendar when confidence is high enough. A later reply on that same thread is read again. An event already created from the thread is skipped only while it is still on the calendar.

## How it works

1. From any email client, forward a confirmation or invite to `you+schedule@gmail.com` (same inbox as `you@gmail.com`). Anything you type above the forwarded message is sent to Gemini as instructions (title, which dates to keep, all-day, duration, location, who to invite). Dates still have to appear in the forwarded mail or in a later reply.
2. A time-driven Apps Script trigger runs `processForwardedEmails`. Styled mail is sent to Gemini as the full visible wording: the HTML text is used when it is longer than the plaintext preview, and the original forward stays in the transcript after later replies.
3. Gemini returns one or more events (`title`, `start`, `end`, `allDay`, `location`, `description`, `guests`, `confidence`), including explicit deadlines such as “reservations close October 31,” as all-day events when no clock time is stated. Emails you ask to invite are added as Calendar guests and sent invites.
4. On success the thread gets the `schedule-processed` label and (by default) the sender gets a short confirmation reply.
5. If a date, time, or choice among dates is missing, the sender gets a clarifying question. Each later reply on that thread is sent back to Gemini. There is no follow-up limit.
6. When the mail is not something to schedule, the thread gets `schedule-needs-review` and the sender gets a needs-review reply. The script does not invent times. Another reply on that thread is still read.

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
3. Or use [clasp](https://github.com/google/clasp): `clasp create --type standalone --title "Gmail Schedule"` then `clasp push`.

### 2. Set your plus-address

You do **not** need a second Google account for the tag itself. If your Gmail is `transactions.ngustafson@gmail.com`, use `transactions.ngustafson+schedule@gmail.com`.

1. In the Apps Script editor: **Project Settings → Script Properties → Add script property**.
2. Property: `SCHEDULE_PLUS_ADDRESS`
3. Value: your full plus-address, e.g. `transactions.ngustafson+schedule@gmail.com`

`Config.gs` reads this property and builds a search like:

```text
(to:"transactions.ngustafson+schedule@gmail.com" OR deliveredto:"transactions.ngustafson+schedule@gmail.com") newer_than:7d -label:schedule-processed -label:schedule-needs-review -label:schedule-awaiting-reply
```

### 3. Add a Gemini API key

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Script Property name: `GEMINI_API_KEY`
3. Value: the API key string

The default model id is `gemini-3.8-flash` in `Config.gs` (`CONFIG.GEMINI_MODEL`). If that model is still failing after `GEMINI_MAX_ATTEMPTS`, the script tries `gemini-3.5-flash-lite` and then `gemini-3.1-flash-lite` on the same API key. Change `GEMINI_FALLBACK_MODELS` to use a different free chain.

### 4. Authorize

1. In the editor, select `processForwardedEmails` (or `setupTrigger`) and click **Run**.
2. Approve Gmail, Calendar, and external request access when prompted.

### 5. Install the 5-minute trigger

1. Select `setupTrigger` in the function dropdown and **Run** it once.
2. Confirm under **Triggers** that `processForwardedEmails` runs every 5 minutes.

You can also create the trigger manually: **Triggers → Add trigger → processForwardedEmails → Time-driven → Minutes timer → Every 5 minutes**.

### 6. Forward an email

1. Open the email in your mail client.
2. Forward it and put your plus-address in the **To** field (for example `transactions.ngustafson+schedule@gmail.com`).
3. Do not rely on a contact card that strips the `+schedule` tag—type the full address.
4. Within about five minutes the script should create a calendar event, ask a clarifying question, or apply `schedule-needs-review`.

Optional Gmail polish: create a filter `to:(you+schedule@gmail.com)` that applies a label like `Schedule/Inbound` so the inbox stays tidy. The script keys off the plus-address search and its own processed/review labels, not that optional label.

## Multiple Gmail accounts

These Gmail accounts already have this script installed. Forward to that account’s plus-address so the event lands on its primary calendar.

| Gmail account | Forward to |
|---------------|------------|
| `transactions.ngustafson@gmail.com` | `transactions.ngustafson+schedule@gmail.com` |
| `noahedwingustafson@gmail.com` | `noahedwingustafson+schedule@gmail.com` |

Apps Script runs **as the Google account that authorized it**. It can only read that account’s Gmail and create events on **that** account’s primary Calendar.

| What you have | What to do |
|---------------|------------|
| One Gmail, one calendar | One Apps Script project; set `SCHEDULE_PLUS_ADDRESS` to `you+schedule@gmail.com` |
| Several separate Gmails (e.g. `you@gmail.com` and `transactions.ngustafson@gmail.com`) | **One Apps Script project per Gmail**, signed in / authorized as that account. Same code, different Script Properties. Forward to that account’s `+schedule` address so mail lands in *its* inbox and events land on *its* Calendar. |
| Several plus-tags on the **same** Gmail | Still one project; today the script watches a single `SCHEDULE_PLUS_ADDRESS`. Change the property or extend the search if you need more tags on one inbox. |

There is no supported way for a personal Gmail Apps Script to watch another person’s inbox or write to another person’s Calendar. Reuse the GitHub files in each project; you do not need different code—just a separate deployment per mailbox.

Example: forward to `transactions.ngustafson+schedule@gmail.com` → install this script under `transactions.ngustafson@gmail.com` → events appear on that account’s Google Calendar.

## Config knobs (`Config.gs`)

| Setting | Default | Meaning |
|---------|---------|---------|
| `SCHEDULE_PLUS_ADDRESS` (Script Property) | *(required)* | Who you forward to, e.g. `you+schedule@gmail.com` |
| `GEMINI_API_KEY` (Script Property) | *(required)* | Google AI Studio API key |
| `PROCESSED_LABEL` | `schedule-processed` | Applied after a successful Calendar create |
| `NEEDS_REVIEW_LABEL` | `schedule-needs-review` | Applied when confidence is low or datetime is missing and follow-ups are done |
| `AWAITING_REPLY_LABEL` | `schedule-awaiting-reply` | Applied while waiting for the sender to fill a missing detail |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Generative Language model tried first |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` | Free models tried after the primary model exhausts its attempts |
| `GEMINI_MAX_ATTEMPTS` | `4` | Tries for the primary model on a transient HTTP failure |
| `GEMINI_FALLBACK_ATTEMPTS` | `2` | Tries for each fallback model before the next one |
| `TIMEZONE` | script timezone | Context for relative phrases in the prompt |
| `CONFIDENCE_THRESHOLD` | `0.7` | Below this → needs review, no event |
| `SEARCH_NEWER_THAN` | `7d` | Gmail search window |
| `EMAIL_SELF_ON_SUCCESS` | `true` | Reply to the sender after a successful Calendar create |
| `EMAIL_SELF_ON_NEEDS_REVIEW` | `true` | Reply to the sender when a message needs review |
| `TRANSCRIPT_CHAR_LIMIT` | `200000` | Visible characters of each message sent to Gemini, after HTML is reduced to text |

## Idempotency and review behavior

- The script does not run again until a new message from the sender arrives. Its own confirmation or question is not treated as a follow-up.
- A thread labeled `schedule-processed` or `schedule-needs-review` used to be skipped forever, which stopped the conversation after one reply. Those threads are searched again, and a new reply is sent back to Gemini.
- An event already created from that thread, matching title and start, is not created again while it is still on the calendar. If you delete it, a later forward or reply on that thread creates it again.
- The script **never invents** start/end times. It asks the sender for a missing date, time, or which dates to keep.
- A temporary Gemini failure (HTTP 429 or 5xx, including “high demand”) is retried on the primary model, then on each free fallback model. If every model fails, the thread is tried again on the next trigger. It does not label the thread `schedule-needs-review` or email the sender.
- By default the sender gets a reply for **both** success and failure. Toggle with `EMAIL_SELF_ON_SUCCESS` / `EMAIL_SELF_ON_NEEDS_REVIEW` in `Config.gs`. The reply is sent from the Gmail account and threads onto the forward, so it lands in the inbox that sent it.

## Manual test

1. Set both Script Properties.
2. Run `setupTrigger` once (or run `processForwardedEmails` manually).
3. Forward a real invite from any mail client to your plus-address.
4. Check primary Calendar, the thread labels in Gmail, and the sender's inbox for the confirmation, clarifying question, or needs-review reply.
5. If a clarifying question arrives, reply on that thread with the missing date or time and wait for the next run.

## Privacy note

Email subject and body are sent to the Gemini API for extraction. Use only mail you are comfortable sending to Google’s Generative Language API, and keep your API key in Script Properties—never commit it to git.
