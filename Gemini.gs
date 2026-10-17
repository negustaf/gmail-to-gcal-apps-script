/**
 * Calls the Gemini Generative Language API to extract events and an optional clarifying question from a thread.
 */
function extractEventFromEmail(transcript, sentAt) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(
    CONFIG.GEMINI_API_KEY_PROPERTY
  );
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error(
      'Set Script Property GEMINI_API_KEY to your Google AI Studio key. See README.md.'
    );
  }

  var prompt = buildExtractionPrompt_(transcript, sentAt);
  var payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      thinkingConfig: {
        thinkingLevel: 'LOW'
      }
    }
  };

  var models = geminiModelsToTry_();
  var lastError = null;
  for (var i = 0; i < models.length; i++) {
    var model = models[i];
    var attempts =
      i === 0
        ? CONFIG.GEMINI_MAX_ATTEMPTS || 4
        : CONFIG.GEMINI_FALLBACK_ATTEMPTS || 2;
    try {
      var parsed = fetchGeminiJson_(
        geminiGenerateUrl_(apiKey, model),
        payload,
        attempts,
        model
      );
      var text = extractGeminiText_(parsed);
      if (i > 0) {
        Logger.log('Extracted events with fallback model ' + model + '.');
      }
      return parseExtraction_(text);
    } catch (err) {
      lastError = err;
      if (!err || err.retryable !== true || i === models.length - 1) {
        throw err;
      }
      Logger.log(
        model +
          ' failed after ' +
          attempts +
          ' tries; falling back to ' +
          models[i + 1] +
          '.'
      );
    }
  }
  throw lastError;
}

/**
 * Returns the primary Gemini model followed by any distinct free fallback models.
 */
function geminiModelsToTry_() {
  var models = [];
  if (CONFIG.GEMINI_MODEL) {
    models.push(String(CONFIG.GEMINI_MODEL).trim());
  }
  var fallbacks = CONFIG.GEMINI_FALLBACK_MODELS || [];
  for (var i = 0; i < fallbacks.length; i++) {
    var id = fallbacks[i] ? String(fallbacks[i]).trim() : '';
    if (id && models.indexOf(id) === -1) {
      models.push(id);
    }
  }
  if (!models.length) {
    throw new Error('Set CONFIG.GEMINI_MODEL to a Generative Language model id.');
  }
  return models;
}

/**
 * Builds the generateContent URL for one model using the AI Studio API key.
 */
function geminiGenerateUrl_(apiKey, model) {
  return (
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    model +
    ':generateContent?key=' +
    encodeURIComponent(String(apiKey).trim())
  );
}

/**
 * Posts to Gemini and retries overload or server errors with exponential backoff before giving up.
 */
function fetchGeminiJson_(url, payload, attempts, model) {
  var maxAttempts = attempts || CONFIG.GEMINI_MAX_ATTEMPTS || 4;
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var lastError = null;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var status = response.getResponseCode();
      var raw = response.getContentText();
      if (status >= 200 && status < 300) {
        return JSON.parse(raw);
      }
      lastError = geminiHttpError_(status, raw, model);
      if (!lastError.retryable || attempt === maxAttempts) {
        throw lastError;
      }
      Logger.log(
        (model || 'Gemini') +
          ' HTTP ' +
          status +
          ' on attempt ' +
          attempt +
          ' of ' +
          maxAttempts +
          '; retrying.'
      );
    } catch (err) {
      if (err && err.retryable === false) {
        throw err;
      }
      lastError = err;
      if (!lastError.retryable) {
        lastError.retryable = true;
      }
      if (attempt === maxAttempts) {
        throw lastError;
      }
      Logger.log(
        (model || 'Gemini') +
          ' request failed on attempt ' +
          attempt +
          ' of ' +
          maxAttempts +
          ': ' +
          lastError
      );
    }
    Utilities.sleep((CONFIG.GEMINI_RETRY_BASE_MS || 1000) * Math.pow(2, attempt - 1));
  }
  throw lastError;
}

/**
 * Builds an Error for a Gemini HTTP failure and marks overload and server errors as retryable.
 */
function geminiHttpError_(status, raw, model) {
  var label = model ? ' (' + model + ')' : '';
  var err = new Error('Gemini API error HTTP ' + status + label + ': ' + raw);
  err.retryable = status === 408 || status === 429 || status >= 500;
  return err;
}

/**
 * Builds the extraction prompt so Gemini returns events plus a question when the sender must fill a gap.
 */
function buildExtractionPrompt_(transcript, sentAt) {
  var sentLabel = sentAt
    ? Utilities.formatDate(sentAt, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss")
    : 'unknown';
  return [
    'You extract calendar events from an email thread that someone sent to a scheduling address.',
    'Messages labeled Sender are the person scheduling. Messages labeled Scheduler are questions you already asked.',
    'Use later Sender replies to fill gaps from earlier messages. Ignore forwarding wrappers,',
    'headers like "---------- Forwarded message ----------", "Begin forwarded message", and quoted reply markers.',
    'When a Sender message contains "Sender instructions:" and "Source email:", those instructions are directions from the person scheduling.',
    'Follow them for the title, which dates to keep or drop, all-day versus a timed event, duration, location, who to invite, reminders, free versus busy, links, and files to attach.',
    'When the sender asks to invite someone or writes an email address in Sender instructions, put that address in guests so they receive a Calendar invite.',
    'Do not put invite emails in description. Do not invent guests from the source email unless the sender asks to invite them.',
    'Fill location from the source email when it names a place. For a flight or airfare, location is the departure airport the traveler must drive to, written as the full airport name Google Maps would list, with airport codes expanded. Do not use the arrival airport or a later layover unless sender instructions name a different place. If instructions name a location, use that instead.',
    'Set url to the one http or https link that belongs to the event, such as a reservation, ticket, or event page, or the link given in sender instructions. Skip unsubscribe, tracking, and mailto links. A maps link is a location, not url.',
    'Set showAs to free only when sender instructions say to show the event as free or available. Otherwise null.',
    'Set reminders only when sender instructions ask for an alert. Each reminder is minutes before the start. Use method email when they ask to be emailed, otherwise popup. Leave reminders null when they do not ask.',
    'Set attachEmailFiles true only when sender instructions say to attach a file from the email. Put any filenames they name in attachmentNames.',
    'When the sender names which date to keep, return only that date and drop the others.',
    'Take a date or clock time only from the source email or from a later Sender reply that states it. If neither states a time, do not invent one.',
    'The source email is the full visible wording, not the inbox preview. Use dates anywhere in it, including near the end.',
    'A Sender reply with no "Source email:" section is itself an instruction. If "Sender instructions:" is absent, that message has no extra directions.',
    'Extract every item the reader would put on a calendar: appointments, reservations, meetings,',
    'and explicit dates named in the message, such as "reservations close October 31",',
    '"sales open November 1", or "orders ship from December 1".',
    'Return one event per distinct date. Do not merge separate dates into one event.',
    'Do not invent clock times. If the email gives a date but no time, set allDay to true and start to YYYY-MM-DD.',
    'If a month and day have no year, use the year from the latest sender message; if that month and day already passed, use the next year.',
    'Do not create events for vague timing ("almost here", "soon", "two years ago") or for a copyright year in a footer.',
    'If a title, date, time, or a choice among several dates is missing, leave that event incomplete and ask the sender.',
    'Set followUp.needed to true only when a reply could supply the missing fact. The question must name the missing fact',
    'and quote any candidate dates already in the thread. Set followUp.needed to false when the events are complete,',
    'or when the thread has nothing to put on a calendar.',
    '',
    'Return ONLY a JSON object of this shape:',
    '{ "events": [ { "title", "start", "end", "allDay", "location", "description", "guests", "url", "showAs", "reminders", "attachEmailFiles", "attachmentNames", "isFlight", "confidence" } ], "followUp": { "needed": false, "question": null } }',
    '- title (string): short event title taken from the thread',
    '- start (string|null): ISO 8601 datetime, or YYYY-MM-DD for all-day',
    '- end (string|null): ISO 8601 datetime, or YYYY-MM-DD for all-day; null if unknown',
    '- allDay (boolean): true when no clock time is stated',
    '- location (string|null): place name or airport name, with no invite emails',
    '- description (string|null): short note, not the full email, and not invite addresses or the url',
    '- guests (string[]|null): email addresses the sender asked to invite; empty or null when none',
    '- url (string|null): one http or https link for the event, or null',
    '- showAs (string|null): "free" only when sender instructions say free or available; otherwise null',
    '- reminders (array|null): { "minutes": number, "method": "popup" or "email" } only when sender instructions ask for alerts',
    '- attachEmailFiles (boolean): true only when sender instructions say to attach a file from the email',
    '- attachmentNames (string[]|null): filenames named in sender instructions',
    '- isFlight (boolean): true when the event is airfare or a flight',
    '- confidence (number): 0 to 1 how sure you are the title and date are stated in the thread',
    '- followUp.needed (boolean)',
    '- followUp.question (string|null): one short question the sender can answer by replying to the email',
    '',
    'Timezone: ' + CONFIG.TIMEZONE,
    'Latest sender message at: ' + sentLabel,
    '',
    'Thread:',
    transcript || '(empty)'
  ].join('\n');
}

/**
 * Pulls the last non-thought text part from a Gemini generateContent response body.
 */
function extractGeminiText_(apiResponse) {
  var candidates = apiResponse && apiResponse.candidates;
  if (!candidates || !candidates.length) {
    throw new Error('Gemini returned no candidates: ' + JSON.stringify(apiResponse));
  }
  var parts = candidates[0].content && candidates[0].content.parts;
  if (!parts || !parts.length) {
    throw new Error('Gemini returned empty content: ' + JSON.stringify(apiResponse));
  }
  var text = '';
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].thought || !parts[i].text) {
      continue;
    }
    text = parts[i].text;
  }
  if (!text) {
    throw new Error('Gemini returned empty content: ' + JSON.stringify(apiResponse));
  }
  return text;
}

/**
 * Parses Gemini text into normalized events and an optional clarifying question for the sender.
 */
function parseExtraction_(text) {
  var cleaned = String(text || '').trim();
  if (cleaned.indexOf('```') === 0) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  var data = JSON.parse(cleaned);
  var rawEvents = [];
  if (data && Array.isArray(data.events)) {
    rawEvents = data.events;
  } else if (Array.isArray(data)) {
    rawEvents = data;
  } else if (data && (data.title || data.start)) {
    rawEvents = [data];
  }
  var events = [];
  for (var i = 0; i < rawEvents.length; i++) {
    events.push(normalizeEvent_(rawEvents[i] || {}));
  }
  var followUp = data && data.followUp ? data.followUp : {};
  var question = followUp.question != null ? String(followUp.question).trim() : '';
  return {
    events: events,
    followUp: {
      needed: !!followUp.needed,
      question: question || null
    }
  };
}

/**
 * Normalizes one Gemini event object so missing fields cannot crash calendar creation.
 */
function normalizeEvent_(data) {
  return {
    title: data.title ? String(data.title).trim() : null,
    start: data.start != null ? String(data.start).trim() : null,
    end: data.end != null ? String(data.end).trim() : null,
    allDay: !!data.allDay,
    location: data.location != null && String(data.location).trim() ? String(data.location).trim() : null,
    description:
      data.description != null && String(data.description).trim()
        ? String(data.description).trim()
        : null,
    guests: normalizeGuests_(data.guests),
    url: usableEventUrl_(data.url),
    showAs: data.showAs === 'free' || data.showAs === 'busy' ? data.showAs : null,
    reminders: normalizeReminders_(data.reminders),
    attachEmailFiles: !!data.attachEmailFiles,
    attachmentNames: normalizeAttachmentNames_(data.attachmentNames),
    isFlight: !!data.isFlight,
    confidence:
      typeof data.confidence === 'number' && !isNaN(data.confidence)
        ? data.confidence
        : 0
  };
}

/** Collects unique email addresses from a guests array or comma-separated string. */
function normalizeGuests_(guests) {
  var raw = [];
  if (Array.isArray(guests)) {
    raw = guests;
  } else if (guests != null && String(guests).trim()) {
    raw = String(guests).split(/[,;\s]+/);
  }
  var emails = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var email = String(raw[i] || '')
      .trim()
      .toLowerCase()
      .replace(/^<|>$/g, '')
      .replace(/[.,;:)]+$/g, '');
    if (!email || seen[email] || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      continue;
    }
    seen[email] = true;
    emails.push(email);
  }
  return emails;
}

// Copies prompt-only guest, reminder, free/busy, link, and attachment choices onto each extracted event.
function applyInstructionOverrides_(events, transcript) {
  var instructions = senderInstructionText_(transcript);
  var promptedGuests = guestsFromInstructions_(instructions);
  var promptedReminders = remindersFromInstructions_(instructions);
  var promptedShowAs = showAsFromInstructions_(instructions);
  var promptedUrl = firstInstructionUrl_(instructions);
  var wantsAttachments = instructionsRequestAttachments_(instructions);
  var promptedNames = attachmentNamesFromInstructions_(instructions);
  var driveUrls = driveUrlsFromInstructions_(instructions);
  for (var i = 0; i < events.length; i++) {
    var eventData = events[i];
    if (
      eventData.location &&
      instructions &&
      instructions.toLowerCase().indexOf(String(eventData.location).toLowerCase()) !== -1
    ) {
      eventData.locationFromPrompt = true;
    }
    eventData.guests = mergeGuestLists_(eventData.guests, promptedGuests);
    eventData.description = descriptionWithoutGuestEmails_(eventData.description, eventData.guests);
    if (promptedReminders.length) {
      eventData.reminders = promptedReminders;
    } else if (!instructionRequestsReminders_(instructions)) {
      eventData.reminders = [];
    }
    eventData.showAs = promptedShowAs;
    if (promptedUrl) {
      eventData.url = promptedUrl;
    }
    var mapsUrl = firstMapsUrl_(instructions);
    if (!eventData.location && mapsUrl) {
      eventData.location = mapsUrl;
    }
    if (eventData.url && isMapsUrl_(eventData.url)) {
      if (!eventData.location) {
        eventData.location = eventData.url;
      }
      eventData.url = null;
    }
    eventData.attachEmailFiles = wantsAttachments;
    eventData.attachmentNames = mergeNameLists_(promptedNames, eventData.attachmentNames);
    eventData.driveUrls = driveUrls;
  }
}

// Returns sender directions, using the note above a forward and treating a bare reply as instructions.
function senderInstructionText_(transcript) {
  var text = String(transcript || '');
  var chunks = [];
  var pattern = /--- Sender \|[^\n]*\n([\s\S]*?)(?=\n--- |\s*$)/g;
  var match;
  while ((match = pattern.exec(text))) {
    var body = match[1] || '';
    var labeled = body.match(/Sender instructions:\s*([\s\S]*?)(?:\nSource email:|$)/i);
    if (labeled) {
      if (labeled[1].trim()) {
        chunks.push(labeled[1].trim());
      }
    } else if (body.indexOf('Source email:') === -1 && body.trim()) {
      chunks.push(body.trim());
    }
  }
  return chunks.join('\n');
}

// Collects email addresses written in sender instructions, excluding this mailbox and no-reply addresses.
function guestsFromInstructions_(instructions) {
  if (
    !instructions ||
    !/\b(invite|inviting|guest|guests|attendee|attendees|share with)\b|\badd\b[^\n]{0,80}@/i.test(
      instructions
    )
  ) {
    var onlyEmails = String(instructions || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    var emailsOnly =
      onlyEmails.length > 0 &&
      onlyEmails.every(function (part) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part.replace(/[,;]+$/, ''));
      });
    if (!emailsOnly) {
      return [];
    }
  }
  return excludeOwnAddresses_(normalizeGuests_(instructions));
}

// Drops the schedule address and the script owner so they are not invited to their own event.
function excludeOwnAddresses_(emails) {
  var skip = {};
  try {
    skip[String(getSchedulePlusAddress() || '').toLowerCase()] = true;
  } catch (err) {
    Logger.log(err);
  }
  var owner = '';
  try {
    owner = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail() || '';
  } catch (err) {
    Logger.log(err);
  }
  if (owner) {
    skip[owner.toLowerCase()] = true;
  }
  var kept = [];
  for (var i = 0; i < emails.length; i++) {
    var email = emails[i];
    if (skip[email] || /^(no-?reply|donotreply|do-not-reply)@/i.test(email)) {
      continue;
    }
    kept.push(email);
  }
  return kept;
}

// Returns unique guest emails from the model and from sender instructions.
function mergeGuestLists_(primary, extra) {
  return normalizeGuests_((primary || []).concat(extra || []));
}

// Removes invited addresses from the note so they are stored only as guests.
function descriptionWithoutGuestEmails_(description, guests) {
  if (!description) {
    return null;
  }
  var text = String(description);
  var list = guests || [];
  for (var i = 0; i < list.length; i++) {
    text = text.replace(new RegExp(escapeRegExp_(list[i]), 'ig'), '');
  }
  text = text.replace(/\b(invite|invited|invitation|guests?|attendees?|shared with)\s*:\s*/gi, '');
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  text = text.replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, '').trim();
  return text || null;
}

// Escapes text so it can be used inside a regular expression.
function escapeRegExp_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns true when sender instructions ask for an alert before the event.
function instructionRequestsReminders_(instructions) {
  return /\b(remind|reminder|reminders|alert|alerts|notification|notifications)\b/i.test(
    instructions || ''
  );
}

// Parses reminder lead times written in sender instructions, capped at five alerts.
function remindersFromInstructions_(instructions) {
  var text = String(instructions || '');
  if (!instructionRequestsReminders_(text)) {
    return [];
  }
  var methods = [];
  if (/\bemail\b/i.test(text)) {
    methods.push('email');
  }
  if (/\b(popup|notification|alert)\b/i.test(text) || !methods.length) {
    methods.push('popup');
  }
  var minutes = [];
  var pattern = /(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)/gi;
  var match;
  while ((match = pattern.exec(text))) {
    minutes.push(reminderMinutes_(match[1], match[2]));
  }
  if (/\bhalf an hour\b/i.test(text)) {
    minutes.push(30);
  }
  if (/\b(a|an|one) hour\b/i.test(text)) {
    minutes.push(60);
  }
  if (/\b(a|an|one|the) day\b/i.test(text)) {
    minutes.push(1440);
  }
  if (/\b(a|an|one) week\b/i.test(text)) {
    minutes.push(10080);
  }
  var reminders = [];
  var seen = {};
  for (var i = 0; i < minutes.length && reminders.length < 5; i++) {
    for (var m = 0; m < methods.length && reminders.length < 5; m++) {
      var key = methods[m] + ':' + minutes[i];
      if (seen[key] || minutes[i] == null) {
        continue;
      }
      seen[key] = true;
      reminders.push({ minutes: minutes[i], method: methods[m] });
    }
  }
  return reminders;
}

// Converts a counted unit from sender instructions into minutes before the event.
function reminderMinutes_(amount, unit) {
  var count = Number(amount);
  if (!count || count < 0) {
    return null;
  }
  var name = String(unit || '').toLowerCase();
  var multiplier = 1;
  if (name.indexOf('hour') === 0 || name.indexOf('hr') === 0) {
    multiplier = 60;
  } else if (name.indexOf('day') === 0) {
    multiplier = 1440;
  } else if (name.indexOf('week') === 0) {
    multiplier = 10080;
  }
  var minutes = count * multiplier;
  if (minutes > 40320) {
    return 40320;
  }
  return minutes;
}

// Normalizes reminder objects from Gemini and drops anything outside Calendar's allowed range.
function normalizeReminders_(reminders) {
  if (!Array.isArray(reminders)) {
    return [];
  }
  var cleaned = [];
  var seen = {};
  for (var i = 0; i < reminders.length && cleaned.length < 5; i++) {
    var item = reminders[i] || {};
    var minutes = reminderMinutes_(item.minutes, 'minute');
    var method = String(item.method || 'popup').toLowerCase() === 'email' ? 'email' : 'popup';
    if (minutes == null) {
      continue;
    }
    var key = method + ':' + minutes;
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    cleaned.push({ minutes: minutes, method: method });
  }
  return cleaned;
}

// Returns free or busy only when sender instructions explicitly set how the event should display.
function showAsFromInstructions_(instructions) {
  var text = String(instructions || '');
  if (
    /\b(show|mark|set|make)(?:\s+(?:me|it|this|the event))?\s+as\s+(free|available)\b/i.test(text) ||
    /\b(show|mark|set|make)\s+(?:it|this|the event)\s+(free|available)\b/i.test(text) ||
    /\b(not busy|instead of busy)\b/i.test(text)
  ) {
    return 'free';
  }
  if (/\b(show( me)? as|mark( me)? as|set( me)? as)\s+busy\b/i.test(text)) {
    return 'busy';
  }
  return null;
}

// Returns the first usable link in sender instructions, skipping map links that belong in location.
function firstInstructionUrl_(instructions) {
  var urls = urlsInText_(instructions);
  for (var i = 0; i < urls.length; i++) {
    if (!isMapsUrl_(urls[i]) && !isDriveFileUrl_(urls[i])) {
      return urls[i];
    }
  }
  return null;
}

// Returns Drive and Docs links from sender instructions so they can be added as event attachments.
function driveUrlsFromInstructions_(instructions) {
  var urls = urlsInText_(instructions);
  var drive = [];
  var seen = {};
  for (var i = 0; i < urls.length; i++) {
    if (!isDriveFileUrl_(urls[i]) || seen[urls[i]]) {
      continue;
    }
    seen[urls[i]] = true;
    drive.push(urls[i]);
  }
  return drive;
}

// Pulls http and https links out of text and drops tracking or unsubscribe targets.
function urlsInText_(text) {
  var found = [];
  var seen = {};
  var pattern = /https?:\/\/[^\s<>"']+/gi;
  var match;
  while ((match = pattern.exec(String(text || '')))) {
    var url = usableEventUrl_(match[0]);
    if (!url || seen[url]) {
      continue;
    }
    seen[url] = true;
    found.push(url);
  }
  return found;
}

// Keeps one http or https link and rejects unsubscribe, mailto, and tracking addresses.
function usableEventUrl_(value) {
  var url = String(value || '').trim().replace(/[)\].,;>]+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }
  if (/unsubscribe|email-preferences|opt-?out|viewinbrowser|list-manage|trk\.|click\./i.test(url)) {
    return null;
  }
  return url;
}

// Returns the first Google Maps link in sender instructions.
function firstMapsUrl_(instructions) {
  var urls = urlsInText_(instructions);
  for (var i = 0; i < urls.length; i++) {
    if (isMapsUrl_(urls[i])) {
      return urls[i];
    }
  }
  return null;
}

// Returns true when a link points at Google Maps rather than an event page.
function isMapsUrl_(url) {
  return /google\.[^/\s]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\./i.test(url || '');
}

// Returns true when a link points at a Google Drive or Docs file that Calendar can attach.
function isDriveFileUrl_(url) {
  return /drive\.google\.com\/(?:file\/|open\?id=)|docs\.google\.com\//i.test(url || '');
}

// Returns true when sender instructions ask to attach a file from the email.
function instructionsRequestAttachments_(instructions) {
  return /\b(attach|attachment|attachments|include the (?:pdf|file|files|document|boarding pass))\b/i.test(
    instructions || ''
  );
}

// Collects filenames mentioned in sender instructions.
function attachmentNamesFromInstructions_(instructions) {
  var names = [];
  var pattern = /([\w.\- ]+\.(?:pdf|png|jpe?g|gif|ics|docx?|xlsx?|txt|csv|zip))\b/gi;
  var match;
  while ((match = pattern.exec(String(instructions || '')))) {
    names.push(match[1].trim());
  }
  return names;
}

// Normalizes a list of attachment filenames from Gemini.
function normalizeAttachmentNames_(names) {
  if (!Array.isArray(names)) {
    if (names == null || !String(names).trim()) {
      return [];
    }
    names = [names];
  }
  var cleaned = [];
  var seen = {};
  for (var i = 0; i < names.length; i++) {
    var name = String(names[i] || '').trim();
    var key = name.toLowerCase();
    if (!name || seen[key]) {
      continue;
    }
    seen[key] = true;
    cleaned.push(name);
  }
  return cleaned;
}

// Merges filename lists without duplicates.
function mergeNameLists_(primary, extra) {
  return normalizeAttachmentNames_((primary || []).concat(extra || []));
}
