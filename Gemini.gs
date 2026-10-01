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
    'Follow them for the title, which dates to keep or drop, all-day versus a timed event, duration, and location.',
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
    '{ "events": [ { "title", "start", "end", "allDay", "location", "description", "confidence" } ], "followUp": { "needed": false, "question": null } }',
    '- title (string): short event title taken from the thread',
    '- start (string|null): ISO 8601 datetime, or YYYY-MM-DD for all-day',
    '- end (string|null): ISO 8601 datetime, or YYYY-MM-DD for all-day; null if unknown',
    '- allDay (boolean): true when no clock time is stated',
    '- location (string|null)',
    '- description (string|null): short note, not the full email',
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
    confidence:
      typeof data.confidence === 'number' && !isNaN(data.confidence)
        ? data.confidence
        : 0
  };
}
