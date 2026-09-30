/**
 * Main entry: poll Gmail for plus-address forwards, extract events via Gemini, create Calendar events.
 * Install a time-driven trigger with setupTrigger() (run once from the editor).
 */
function processForwardedEmails() {
  var query = buildGmailSearchQuery();
  var threads = GmailApp.search(query, 0, 50);
  var processedLabel = getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
  var needsReviewLabel = getOrCreateLabel_(CONFIG.NEEDS_REVIEW_LABEL);

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    if (threadHasLabel_(thread, CONFIG.PROCESSED_LABEL) ||
        threadHasLabel_(thread, CONFIG.NEEDS_REVIEW_LABEL)) {
      continue;
    }

    var messages = thread.getMessages();
    var message = messages[messages.length - 1];
    try {
      processOneMessage_(message, thread, processedLabel, needsReviewLabel);
    } catch (err) {
      Logger.log(
        'Failed processing message ' + message.getId() + ': ' + err
      );
      thread.addLabel(needsReviewLabel);
      if (CONFIG.EMAIL_SELF_ON_NEEDS_REVIEW) {
        notifyNeedsReview_(message, String(err), null);
      }
    }
  }
}

/**
 * Processes a single Gmail message: Gemini extract → Calendar create or needs-review label.
 */
function processOneMessage_(message, thread, processedLabel, needsReviewLabel) {
  var subject = message.getSubject();
  var body = message.getPlainBody() || message.getBody();
  var eventData = extractEventFromEmail(subject, body);

  var confidenceOk =
    eventData.confidence >= CONFIG.CONFIDENCE_THRESHOLD;
  var datetimeOk = hasUsableDatetime(eventData);

  if (!confidenceOk || !datetimeOk) {
    thread.addLabel(needsReviewLabel);
    if (CONFIG.EMAIL_SELF_ON_NEEDS_REVIEW) {
      var reason = !datetimeOk
        ? 'Missing or unusable start datetime (script will not invent times).'
        : 'Confidence ' +
          eventData.confidence +
          ' is below threshold ' +
          CONFIG.CONFIDENCE_THRESHOLD +
          '.';
      notifyNeedsReview_(message, reason, eventData);
    }
    return;
  }

  createCalendarEvent(eventData);
  thread.addLabel(processedLabel);
  if (CONFIG.EMAIL_SELF_ON_SUCCESS) {
    notifySuccess_(message, eventData);
  }
}

/**
 * Creates an every-5-minutes installable trigger for processForwardedEmails.
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
 * Emails the account owner a short confirmation after a Calendar event is created.
 */
function notifySuccess_(message, eventData) {
  var recipient = Session.getActiveUser().getEmail();
  if (!recipient) {
    return;
  }
  var lines = [
    'Hey Forward → Calendar created an event.',
    '',
    'Original subject: ' + (message.getSubject() || '(none)'),
    'Gmail message id: ' + message.getId(),
    '',
    'Title: ' + (eventData.title || '(none)'),
    'Start: ' + (eventData.start || '(none)'),
    'End: ' + (eventData.end || '(none)'),
    'All-day: ' + (eventData.allDay ? 'yes' : 'no'),
    'Location: ' + (eventData.location || '(none)'),
    'Confidence: ' + eventData.confidence,
    ''
  ];
  if (eventData.description) {
    lines.push('Description: ' + eventData.description);
    lines.push('');
  }
  lines.push(
    'The thread was labeled "' +
      CONFIG.PROCESSED_LABEL +
      '". Check your primary Google Calendar for the new event.'
  );
  GmailApp.sendEmail(
    recipient,
    '[schedule-processed] ' + (eventData.title || message.getSubject() || 'Event created'),
    lines.join('\n')
  );
}

/**
 * Emails the account owner a short needs-review note with subject and reason.
 */
function notifyNeedsReview_(message, reason, eventData) {
  var recipient = Session.getActiveUser().getEmail();
  if (!recipient) {
    return;
  }
  var lines = [
    'Hey Forward → Calendar could not create an event automatically.',
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
  GmailApp.sendEmail(
    recipient,
    '[schedule-needs-review] ' + (message.getSubject() || 'Forwarded email'),
    lines.join('\n')
  );
}
