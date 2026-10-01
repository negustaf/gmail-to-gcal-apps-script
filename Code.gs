/**
 * Main entry: poll Gmail for plus-address forwards, extract events via Gemini, create Calendar events.
 * Install a time-driven trigger with setupTrigger() (run once from the editor).
 */
function processForwardedEmails() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Skipped run because another processForwardedEmails is still running.');
    return;
  }
  try {
    var plusAddress = getSchedulePlusAddress();
    var threads = collectThreads_([buildGmailSearchQuery(), buildAwaitingReplyQuery()]);
    var processedLabel = getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
    var needsReviewLabel = getOrCreateLabel_(CONFIG.NEEDS_REVIEW_LABEL);
    var awaitingLabel = getOrCreateLabel_(CONFIG.AWAITING_REPLY_LABEL);

    var state = loadThreadState_();
    for (var i = 0; i < threads.length; i++) {
      var thread = threads[i];
      var messages = thread.getMessages();
      if (!messages.length) {
        continue;
      }
      var message = latestInboundMessage_(messages);
      if (!message) {
        continue;
      }
      var threadId = thread.getId();
      var threadState = state[threadId] || { events: [] };
      var last = messages[messages.length - 1];
      var retryingOutage =
        messageIsFromScript_(last) &&
        (threadState.geminiRetry || scriptMessageIsGeminiOutage_(last));
      if (messageIsFromScript_(last) && !retryingOutage) {
        continue;
      }
      if (!retryingOutage && threadState.lastMessageId === message.getId()) {
        continue;
      }
      var known =
        threadHasLabel_(thread, CONFIG.AWAITING_REPLY_LABEL) ||
        threadHasLabel_(thread, CONFIG.PROCESSED_LABEL) ||
        threadHasLabel_(thread, CONFIG.NEEDS_REVIEW_LABEL);
      if (!known && !messageTargetsPlusAddress_(message, plusAddress)) {
        continue;
      }
      try {
        processOneMessage_(
          messages,
          thread,
          processedLabel,
          needsReviewLabel,
          awaitingLabel,
          state,
          threadId
        );
        state[threadId] = state[threadId] || threadState;
        state[threadId].lastMessageId = message.getId();
        state[threadId].geminiRetry = false;
        state[threadId].updated = new Date().getTime();
        saveThreadState_(state);
      } catch (err) {
        var detail = err && err.message ? String(err.message) : String(err);
        Logger.log('Failed processing message ' + message.getId() + ': ' + detail);
        if (isRetryableGeminiFailure_(err)) {
          deferGeminiRetry_(thread, needsReviewLabel, state, threadId);
          continue;
        }
        thread.addLabel(needsReviewLabel);
        thread.removeLabel(awaitingLabel);
        if (CONFIG.EMAIL_SELF_ON_NEEDS_REVIEW) {
          notifyNeedsReview_(message, detail, null);
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Processes a thread: create ready events, or ask the sender a clarifying question and wait for a reply.
 */
function processOneMessage_(
  messages,
  thread,
  processedLabel,
  needsReviewLabel,
  awaitingLabel,
  state,
  threadId
) {
  var message = latestInboundMessage_(messages);
  seedCreatedEventsFromThread_(state, threadId, messages);
  var extraction = extractEventFromEmail(
    buildConversationTranscript_(messages),
    message.getDate()
  );
  var extracted = extraction.events || [];
  var created = [];
  var duplicates = [];
  var skipped = [];
  var blocked = [];

  for (var i = 0; i < extracted.length; i++) {
    var eventData = extracted[i];
    if (
      eventData.title &&
      hasUsableDatetime(eventData) &&
      eventData.confidence >= CONFIG.CONFIDENCE_THRESHOLD
    ) {
      try {
        if (rememberedEventStillOnCalendar_(state, threadId, eventData)) {
          duplicates.push(eventData);
        } else {
          var event = createCalendarEvent(eventData);
          eventData.calendarEventId = event.getId();
          rememberEvent_(state, threadId, eventData, event.getId());
          created.push(eventData);
        }
      } catch (err) {
        eventData.createError = calendarCreateFailureText_(eventData, err);
        Logger.log(eventData.createError);
        blocked.push(eventData);
      }
    } else {
      skipped.push(eventData);
    }
  }

  var question = extraction.followUp && extraction.followUp.question;
  var needsQuestion =
    (extraction.followUp && extraction.followUp.needed) || skipped.length > 0;

  if (!created.length && blocked.length) {
    throw new Error(
      blocked
        .map(function (eventData) {
          return eventData.createError;
        })
        .join('\n\n')
    );
  }

  if (created.length) {
    thread.removeLabel(awaitingLabel);
    thread.removeLabel(needsReviewLabel);
    thread.addLabel(processedLabel);
    if (CONFIG.EMAIL_SELF_ON_SUCCESS) {
      notifySuccess_(message, created, skipped.concat(blocked));
    }
    return;
  }

  if (duplicates.length && !needsQuestion) {
    thread.removeLabel(awaitingLabel);
    thread.removeLabel(needsReviewLabel);
    thread.addLabel(processedLabel);
    notifyAlreadyOnCalendar_(message, duplicates);
    return;
  }

  if (needsQuestion) {
    thread.removeLabel(needsReviewLabel);
    thread.addLabel(awaitingLabel);
    notifyFollowUp_(message, question || buildFallbackQuestion_(skipped));
    return;
  }

  thread.removeLabel(awaitingLabel);
  thread.addLabel(needsReviewLabel);
  if (CONFIG.EMAIL_SELF_ON_NEEDS_REVIEW) {
    notifyNeedsReview_(message, reviewReason_(skipped), skipped.length ? skipped : null);
  }
}

/**
 * Joins the original message and the newest replies into one transcript for Gemini.
 */
function buildConversationTranscript_(messages) {
  var indexes = transcriptMessageIndexes_(messages.length);
  var lines = [];
  for (var n = 0; n < indexes.length; n++) {
    var message = messages[indexes[n]];
    var role = messageIsFromScript_(message) ? 'Scheduler' : 'Sender';
    var body =
      role === 'Sender' ? senderMessageText_(message) : schedulerMessageText_(message);
    lines.push(
      '--- ' + role + ' | ' + message.getDate() + ' | ' + (message.getSubject() || '(no subject)')
    );
    if (role === 'Sender') {
      lines.push(formatSenderMessage_(body));
    } else {
      lines.push(capTranscriptText_(body));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Includes the original message and the newest messages so a later reply does not drop the forwarded email.
 */
function transcriptMessageIndexes_(count) {
  var indexes = [];
  var start = Math.max(0, count - 6);
  if (count > 0 && start > 0) {
    indexes.push(0);
  }
  for (var i = start; i < count; i++) {
    indexes.push(i);
  }
  return indexes;
}

/**
 * Returns the longer of the plain body and visible HTML so a short plaintext preview does not replace the email.
 */
function senderMessageText_(message) {
  var plain = normalizeExtractedText_(message.getPlainBody() || '');
  var fromHtml = '';
  try {
    fromHtml = htmlToText_(message.getBody() || '');
  } catch (err) {
    fromHtml = '';
  }
  if (fromHtml.length > plain.length) {
    return fromHtml;
  }
  return plain || fromHtml;
}

/**
 * Returns the script reply as plain text, falling back to visible HTML when the plain body is empty.
 */
function schedulerMessageText_(message) {
  var plain = normalizeExtractedText_(message.getPlainBody() || '');
  if (plain) {
    return plain;
  }
  try {
    return htmlToText_(message.getBody() || '');
  } catch (err) {
    return '';
  }
}

/**
 * Turns an HTML email into visible text by dropping styles, scripts, and tags.
 */
function htmlToText_(html) {
  var text = String(html || '');
  if (!text) {
    return '';
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, function(tag, alt) {
    var label = String(alt || '').trim();
    return label ? ' ' + label + ' ' : ' ';
  });
  text = text.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|h[1-6]|li|blockquote|table|section|article|header|footer)>/gi, '\n');
  text = text.replace(/<\/t[dh]>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities_(text);
  return normalizeExtractedText_(text);
}

/**
 * Decodes named and numeric HTML entities in extracted email text.
 */
function decodeHtmlEntities_(text) {
  var named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '-',
    mdash: '-',
    hellip: '...',
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
    bull: '*',
    middot: '·'
  };
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function(entity, body) {
    if (body.charAt(0) === '#') {
      var hex = body.charAt(1).toLowerCase() === 'x';
      var code = parseInt(hex ? body.substring(2) : body.substring(1), hex ? 16 : 10);
      if (!isFinite(code) || code < 0 || code > 0x10ffff) {
        return entity;
      }
      return String.fromCodePoint(code);
    }
    var key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : entity;
  });
}

/**
 * Collapses spacing in extracted email text so length comparisons reflect visible wording.
 */
function normalizeExtractedText_(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Leaves normal email text intact and, only past the transcript limit, keeps both the beginning and the end.
 */
function capTranscriptText_(text, limit) {
  var max = limit || CONFIG.TRANSCRIPT_CHAR_LIMIT || 200000;
  var value = String(text || '');
  if (value.length <= max) {
    return value;
  }
  var marker = '\n[middle omitted]\n';
  var keep = max - marker.length;
  if (keep < 2) {
    return value.substring(0, max);
  }
  var head = Math.floor(keep / 2);
  var tail = keep - head;
  return value.substring(0, head) + marker + value.substring(value.length - tail);
}

/**
 * Splits a forwarded message so text above the forward wrapper is instructions and the rest is the source email.
 */
function splitForwardInstructions_(body) {
  var text = String(body || '');
  var patterns = [
    /-{3,}\s*Forwarded message\s*-{3,}/i,
    /Begin forwarded message:?/i,
    /-{3,}\s*Original Message\s*-{3,}/i
  ];
  var earliest = -1;
  var matchLength = 0;
  for (var i = 0; i < patterns.length; i++) {
    var match = patterns[i].exec(text);
    if (match && (earliest === -1 || match.index < earliest)) {
      earliest = match.index;
      matchLength = match[0].length;
    }
  }
  if (earliest === -1) {
    return { instructions: '', source: text };
  }
  return {
    instructions: text.substring(0, earliest).trim(),
    source: text.substring(earliest + matchLength).trim()
  };
}

/**
 * Formats a sender message, isolating an optional note typed above the forwarded email.
 */
function formatSenderMessage_(body, limit) {
  var parts = splitForwardInstructions_(body);
  var source = capTranscriptText_(parts.source, limit);
  if (!parts.instructions) {
    return source;
  }
  var instructions = capTranscriptText_(parts.instructions, 8000);
  return [
    'Sender instructions:',
    instructions,
    '',
    'Source email:',
    source || '(none)'
  ].join('\n');
}

/**
 * Returns the newest message in the thread that was not sent by this script.
 */
function latestInboundMessage_(messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    if (!messageIsFromScript_(messages[i])) {
      return messages[i];
    }
  }
  return null;
}

/**
 * Returns true when a script reply is only the temporary Gemini overload notice, so the thread should be tried again.
 */
function scriptMessageIsGeminiOutage_(message) {
  var plain = message.getPlainBody() || '';
  return (
    plain.indexOf('HTTP 503') !== -1 ||
    plain.indexOf('HTTP 429') !== -1 ||
    plain.indexOf('high demand') !== -1 ||
    plain.indexOf('UNAVAILABLE') !== -1
  );
}

/**
 * Returns true when Gemini failed because of overload or a server error rather than a bad request.
 */
function isRetryableGeminiFailure_(err) {
  if (err && err.retryable === true) {
    return true;
  }
  var text = String(err || '');
  return (
    text.indexOf('HTTP 503') !== -1 ||
    text.indexOf('HTTP 429') !== -1 ||
    text.indexOf('HTTP 500') !== -1 ||
    text.indexOf('HTTP 502') !== -1 ||
    text.indexOf('HTTP 504') !== -1 ||
    text.indexOf('high demand') !== -1 ||
    text.indexOf('UNAVAILABLE') !== -1
  );
}

/**
 * Leaves a thread eligible for the next trigger after a temporary Gemini failure, without emailing the sender.
 */
function deferGeminiRetry_(thread, needsReviewLabel, state, threadId) {
  thread.removeLabel(needsReviewLabel);
  if (!state[threadId]) {
    state[threadId] = { events: [] };
  }
  state[threadId].geminiRetry = true;
  state[threadId].updated = new Date().getTime();
  saveThreadState_(state);
  Logger.log('Gemini was unavailable for thread ' + threadId + '; will retry on the next run.');
}

/**
 * Returns true when the message was sent by the Gmail account that runs this script.
 */
function messageIsFromScript_(message) {
  var me = '';
  try {
    me = Session.getActiveUser().getEmail() || '';
  } catch (err) {
    me = '';
  }
  var from = message.getFrom() || '';
  var address = from;
  var match = from.match(/<([^>]+)>/);
  if (match) {
    address = match[1];
  }
  if (me) {
    return address.toLowerCase() === me.toLowerCase();
  }
  var plain = message.getPlainBody() || '';
  if (plain.indexOf('Schedule →') === 0) {
    return true;
  }
  var firstLine = plain.split('\n')[0].trim();
  var statuses = [
    'SCHEDULE SUCCESSFUL',
    'SCHEDULE INFO REQUIRED',
    'SCHEDULE FAILED',
    'SCHEDULE ALREADY EXISTS'
  ];
  for (var s = 0; s < statuses.length; s++) {
    if (firstLine === statuses[s]) {
      return true;
    }
  }
  return false;
}

/**
 * Records title, start, and calendar event id from earlier success replies so a follow-up can check the calendar.
 */
function seedCreatedEventsFromThread_(state, threadId, messages) {
  ensureThreadEvents_(state, threadId);
  for (var i = 0; i < messages.length; i++) {
    if (!messageIsFromScript_(messages[i])) {
      continue;
    }
    ingestCreatedEventsFromReply_(state[threadId].events, messages[i].getPlainBody() || '');
  }
}

/**
 * Adds title-and-start records, including calendar event ids, found in one scheduler reply.
 */
function ingestCreatedEventsFromReply_(events, body) {
  var lines = String(body || '').split('\n');
  var pendingTitle = null;
  var pendingSignature = null;
  for (var j = 0; j < lines.length; j++) {
    var line = lines[j];
    if (line.indexOf('Title: ') === 0) {
      if (pendingSignature) {
        rememberSeededEvent_(events, pendingSignature, '');
      }
      pendingTitle = line.substring('Title: '.length).trim();
      pendingSignature = null;
    } else if (line.indexOf('Start: ') === 0 && pendingTitle) {
      pendingSignature =
        pendingTitle.toLowerCase() + '|' + line.substring('Start: '.length).trim();
    } else if (line.indexOf('Calendar event id: ') === 0 && pendingSignature) {
      rememberSeededEvent_(
        events,
        pendingSignature,
        line.substring('Calendar event id: '.length).trim()
      );
      pendingTitle = null;
      pendingSignature = null;
    }
  }
  if (pendingSignature) {
    rememberSeededEvent_(events, pendingSignature, '');
  }
}

/**
 * Returns true when a remembered event with this title and start is still on the primary calendar.
 */
function rememberedEventStillOnCalendar_(state, threadId, eventData) {
  var events = state[threadId] && state[threadId].events;
  if (!events || !events.length) {
    return false;
  }
  var signature = eventSignature_(eventData);
  var sawSignature = false;
  var sawMissingId = false;
  for (var i = 0; i < events.length; i++) {
    var record = eventRecord_(events[i]);
    if (record.signature !== signature) {
      continue;
    }
    sawSignature = true;
    if (record.eventId) {
      if (calendarEventExistsById_(record.eventId)) {
        return true;
      }
    } else {
      sawMissingId = true;
    }
  }
  if (!sawSignature) {
    return false;
  }
  if (sawMissingId) {
    return calendarHasMatchingEvent_(eventData);
  }
  return false;
}

/**
 * Remembers a created event and writes the thread state so a later follow-up can see it.
 */
function rememberEvent_(state, threadId, eventData, eventId) {
  ensureThreadEvents_(state, threadId);
  rememberSeededEvent_(state[threadId].events, eventSignature_(eventData), eventId || '');
  state[threadId].updated = new Date().getTime();
  saveThreadState_(state);
}

/**
 * Stores one title-and-start record, upgrading a missing calendar event id when the reply includes one.
 */
function rememberSeededEvent_(events, signature, eventId) {
  if (!signature) {
    return;
  }
  var id = eventId || '';
  for (var i = 0; i < events.length; i++) {
    var record = eventRecord_(events[i]);
    if (record.signature !== signature) {
      continue;
    }
    if (!id || record.eventId === id) {
      return;
    }
    if (!record.eventId) {
      events[i] = { signature: signature, eventId: id };
      return;
    }
  }
  events.push({ signature: signature, eventId: id });
}

/**
 * Normalizes a stored event entry so older title-and-start strings still compare with newer id records.
 */
function eventRecord_(entry) {
  if (entry && typeof entry === 'object') {
    return {
      signature: String(entry.signature || ''),
      eventId: String(entry.eventId || '')
    };
  }
  return { signature: String(entry || ''), eventId: '' };
}

/**
 * Ensures the thread has an events list before a create or a success reply is recorded.
 */
function ensureThreadEvents_(state, threadId) {
  if (!state[threadId]) {
    state[threadId] = { events: [] };
  }
  if (!state[threadId].events) {
    state[threadId].events = [];
  }
}

/**
 * Builds the title-and-start key used to tell an already created event from a new one.
 */
function eventSignature_(eventData) {
  return String(eventData.title || '').trim().toLowerCase() + '|' + String(eventData.start || '').trim();
}

/**
 * Loads the remembered events and last handled message id for each Gmail thread.
 */
function loadThreadState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.THREAD_STATE_PROPERTY);
  if (!raw) {
    return {};
  }
  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

/**
 * Saves thread state, keeping the most recently updated threads so the script property stays small.
 */
function saveThreadState_(state) {
  var ids = [];
  for (var id in state) {
    if (Object.prototype.hasOwnProperty.call(state, id)) {
      ids.push(id);
    }
  }
  ids.sort(function (a, b) {
    return (state[a].updated || 0) - (state[b].updated || 0);
  });
  while (ids.length > 40) {
    delete state[ids.shift()];
  }
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.THREAD_STATE_PROPERTY,
    JSON.stringify(state)
  );
}

/**
 * Builds a clarifying question from incomplete event drafts when Gemini did not write one.
 */
function buildFallbackQuestion_(events) {
  if (!events || !events.length) {
    return 'Reply with the event title, date, and start time, or say that it is all-day.';
  }
  var lines = ['Reply with whatever is still missing (title, date, time, or which dates to keep):'];
  for (var i = 0; i < events.length; i++) {
    var eventData = events[i];
    lines.push(
      '- ' +
        (eventData.title || 'Untitled') +
        ' | start: ' +
        (eventData.start || 'missing') +
        ' | all-day: ' +
        (eventData.allDay ? 'yes' : 'no')
    );
  }
  return lines.join('\n');
}

/**
 * Searches each Gmail query and returns each thread once.
 */
function collectThreads_(queries) {
  var seen = {};
  var threads = [];
  for (var q = 0; q < queries.length; q++) {
    var found = GmailApp.search(queries[q], 0, 50);
    for (var i = 0; i < found.length; i++) {
      var id = found[i].getId();
      if (seen[id]) {
        continue;
      }
      seen[id] = true;
      threads.push(found[i]);
    }
  }
  return threads;
}

/**
 * Explains why none of the extracted drafts were created on the calendar.
 */
function reviewReason_(events) {
  if (!events || !events.length) {
    return 'No appointment or explicit date in this email was specific enough to put on the calendar.';
  }
  var parts = [];
  for (var i = 0; i < events.length; i++) {
    var eventData = events[i];
    var title = eventData.title || 'Untitled';
    if (!hasUsableDatetime(eventData)) {
      parts.push(title + ': no usable start date, so no time was invented.');
    } else if (!eventData.title) {
      parts.push('A date was found (' + eventData.start + ') but it had no title.');
    } else if (eventData.confidence < CONFIG.CONFIDENCE_THRESHOLD) {
      parts.push(
        title +
          ': confidence ' +
          eventData.confidence +
          ' is below ' +
          CONFIG.CONFIDENCE_THRESHOLD +
          '.'
      );
    }
  }
  return parts.join(' ') || 'No event met the confidence and date requirements.';
}

/**
 * Creates an every-5-minutes installable trigger for processForwardedEmails, then processes current mail once.
 * Run this once from the Apps Script editor after authorizing the project.
 */
function setupTrigger() {
  var handlers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < handlers.length; i++) {
    if (handlers[i].getHandlerFunction() === 'processForwardedEmails') {
      ScriptApp.deleteTrigger(handlers[i]);
    }
  }
  ScriptApp.newTrigger('processForwardedEmails')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Created every-5-minutes trigger for processForwardedEmails.');
  processForwardedEmails();
}

/**
 * Gets an existing Gmail label by name or creates it if missing.
 */
function getOrCreateLabel_(name) {
  var label = GmailApp.getUserLabelByName(name);
  if (!label) {
    label = GmailApp.createLabel(name);
  }
  return label;
}

/**
 * Returns true when the message To, Cc, or Delivered-To header contains the schedule plus-address.
 */
function messageTargetsPlusAddress_(message, plusAddress) {
  var needle = String(plusAddress || '').trim().toLowerCase();
  if (!needle) {
    return false;
  }
  var fields = [message.getTo() || '', message.getCc() || '', message.getBcc() || ''];
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].toLowerCase().indexOf(needle) !== -1) {
      return true;
    }
  }
  var raw = message.getRawContent() || '';
  var headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    headerEnd = raw.indexOf('\n\n');
  }
  var headers = headerEnd === -1 ? raw : raw.substring(0, headerEnd);
  return headers.toLowerCase().indexOf(needle) !== -1;
}

/**
 * Returns true if the thread already has a user label with the given name.
 */
function threadHasLabel_(thread, labelName) {
  var labels = thread.getLabels();
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].getName() === labelName) {
      return true;
    }
  }
  return false;
}

/**
 * Replies to the sender listing each Calendar event created from the forwarded email.
 */
function notifySuccess_(message, createdEvents, skippedEvents) {
  var count = createdEvents.length;
  var lines = [
    count + (count === 1 ? ' event' : ' events') + ' scheduled.',
    '',
    'Original subject: ' + (message.getSubject() || '(none)'),
    'Gmail message id: ' + message.getId(),
    ''
  ];
  for (var i = 0; i < createdEvents.length; i++) {
    var eventData = createdEvents[i];
    lines.push('Title: ' + (eventData.title || '(none)'));
    lines.push('Start: ' + (eventData.start || '(none)'));
    if (eventData.calendarEventId) {
      lines.push('Calendar event id: ' + eventData.calendarEventId);
    }
    lines.push('End: ' + (eventData.end || '(none)'));
    lines.push('All-day: ' + (eventData.allDay ? 'yes' : 'no'));
    lines.push('Location: ' + (eventData.location || '(none)'));
    lines.push('Confidence: ' + eventData.confidence);
    if (eventData.description) {
      lines.push('Description: ' + eventData.description);
    }
    lines.push('');
  }
  if (skippedEvents && skippedEvents.length) {
    var failedCreates = [];
    var otherSkipped = [];
    for (var s = 0; s < skippedEvents.length; s++) {
      if (skippedEvents[s] && skippedEvents[s].createError) {
        failedCreates.push(skippedEvents[s]);
      } else {
        otherSkipped.push(skippedEvents[s]);
      }
    }
    if (failedCreates.length) {
      lines.push('Not created:');
      for (var f = 0; f < failedCreates.length; f++) {
        lines.push(failedCreates[f].createError);
        lines.push('');
      }
    }
    if (otherSkipped.length) {
      lines.push('Skipped (not created):');
      lines.push(JSON.stringify(otherSkipped, null, 2));
      lines.push('');
    }
  }
  lines.push(
    'The thread was labeled "' +
      CONFIG.PROCESSED_LABEL +
      '". Check your primary Google Calendar for the new event' +
      (count === 1 ? '.' : 's.')
  );
  message.reply(withScheduleStatus_('SCHEDULE SUCCESSFUL', lines));
}

/**
 * Replies that the events from this follow-up are already on the calendar, so nothing new was created.
 */
function notifyAlreadyOnCalendar_(message, duplicates) {
  var lines = [
    'The event(s) have already been scheduled.',
    '',
    'Original subject: ' + (message.getSubject() || '(none)'),
    ''
  ];
  for (var i = 0; i < duplicates.length; i++) {
    lines.push(
      '- ' + (duplicates[i].title || '(none)') + ' | ' + (duplicates[i].start || '(none)')
    );
  }
  lines.push('');
  lines.push('Reply again if you want a different event added.');
  message.reply(withScheduleStatus_('SCHEDULE ALREADY EXISTS', lines));
}

/**
 * Replies to the sender with one clarifying question and asks them to answer on this thread.
 */
function notifyFollowUp_(message, question) {
  var lines = [
    'Response needed before event(s) can be scheduled.',
    '',
    question,
    '',
    'Reply to this email with the missing details. I will read the reply and try again.'
  ];
  message.reply(withScheduleStatus_('SCHEDULE INFO REQUIRED', lines));
}

/**
 * Replies to the sender with a short needs-review note including the subject and reason.
 */
function notifyNeedsReview_(message, reason, eventData) {
  var lines = [
    'Event could not be scheduled automatically.',
    '',
    'Original subject: ' + (message.getSubject() || '(none)'),
    'Gmail message id: ' + message.getId(),
    'Reason: ' + reason,
    ''
  ];
  if (eventData) {
    lines.push('Extracted draft (not created):');
    lines.push(JSON.stringify(eventData, null, 2));
    lines.push('');
  }
  lines.push(
    'The thread was labeled "' +
      CONFIG.NEEDS_REVIEW_LABEL +
      '". Review the email and add the event manually if needed.'
  );
  message.reply(withScheduleStatus_('SCHEDULE FAILED', lines));
}

/**
 * Puts an all-caps schedule status on the first line of an outbound reply, then the rest of the message.
 */
function withScheduleStatus_(status, lines) {
  return [String(status).toUpperCase(), ''].concat(lines).join('\n');
}
