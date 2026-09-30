/**
 * Calls the Gemini Generative Language API to extract calendar event JSON from an email.
 */
function extractEventFromEmail(subject, body) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(
    CONFIG.GEMINI_API_KEY_PROPERTY
  );
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error(
      'Set Script Property GEMINI_API_KEY to your Google AI Studio key. See README.md.'
    );
  }

  var url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    CONFIG.GEMINI_MODEL +
    ':generateContent?key=' +
    encodeURIComponent(String(apiKey).trim());

  var prompt = buildExtractionPrompt_(subject, body);
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

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var status = response.getResponseCode();
  var raw = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Gemini API error HTTP ' + status + ': ' + raw);
  }

  var parsed = JSON.parse(raw);
  var text = extractGeminiText_(parsed);
  return parseEventJson_(text);
}

/**
 * Builds the extraction prompt, instructing Gemini to ignore forward wrappers and return event JSON.
 */
function buildExtractionPrompt_(subject, body) {
  return [
    'You extract calendar events from emails that were forwarded (often from Hey or another client).',
    'Ignore forwarding wrappers, headers like "---------- Forwarded message ----------",',
    '"Begin forwarded message", From/To/Date/Subject preamble lines, and quoted reply markers.',
    'Focus on the original invitation, confirmation, or scheduling content.',
    'Do not invent times, dates, locations, or titles. If a field is unknown, use null.',
    'If no clear event datetime exists, set start and end to null and lower confidence.',
    '',
    'Return ONLY a JSON object with these fields:',
    '- title (string): short event title',
    '- start (string|null): ISO 8601 datetime, or YYYY-MM-DD for all-day',
    '- end (string|null): ISO 8601 datetime, or YYYY-MM-DD for all-day (exclusive end preferred for all-day)',
    '- allDay (boolean): true if this is an all-day event',
    '- location (string|null)',
    '- description (string|null): useful notes, links, or agenda; not the full raw forward',
    '- confidence (number): 0 to 1 how sure you are this is a real event with correct timing',
    '',
    'Timezone context for relative phrases: ' + CONFIG.TIMEZONE,
    '',
    'Email subject:',
    subject || '(none)',
    '',
    'Email body:',
    body || '(empty)'
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
 * Parses Gemini text into a normalized event object, stripping optional markdown fences.
 */
function parseEventJson_(text) {
  var cleaned = String(text || '').trim();
  if (cleaned.indexOf('```') === 0) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  var data = JSON.parse(cleaned);
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
