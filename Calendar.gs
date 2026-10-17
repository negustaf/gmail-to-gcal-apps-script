/**
 * Creates a Google Calendar event on the primary calendar from extracted event JSON.
 * Handles timed ISO datetimes and all-day YYYY-MM-DD (or date-only) values.
 * Returns the created CalendarEvent.
 */
function createCalendarEvent(eventData, extras) {
  try {
    resolveEventLocation_(eventData);
    var event = createCalendarEventFromData_(eventData);
    applyExtraCalendarFields_(event, eventData, extras || {});
    return event;
  } catch (err) {
    rethrowCalendarCreateFailure_(eventData, err);
  }
}

// Creates the Calendar event and tags validation or CalendarApp failures with the field or API step.
function createCalendarEventFromData_(eventData) {
  if (!eventData || !eventData.title) {
    throw calendarInputError_('Missing title.', 'title');
  }
  if (!eventData.start) {
    throw calendarInputError_('Missing start.', 'start');
  }

  var calendar = CalendarApp.getDefaultCalendar();
  var options = buildCalendarEventOptions_(eventData);
  var event;

  if (eventData.allDay) {
    var startDate = parseAllDayDate_(eventData.start, 'start');
    var endDate = eventData.end ? parseAllDayDate_(eventData.end, 'end') : null;

    // CalendarApp all-day end is exclusive; ensure at least one day span.
    if (!endDate || endDate.getTime() <= startDate.getTime()) {
      endDate = addCalendarDays_(startDate, 1);
    }
    event = runCalendarStep_(
      'createAllDayEvent',
      { allDay: true, start: startDate, end: endDate },
      function () {
        return calendar.createAllDayEvent(eventData.title, startDate, endDate, options);
      }
    );
  } else {
    var start = parseIsoDateTime_(eventData.start, 'start');
    var end = eventData.end
      ? parseIsoDateTime_(eventData.end, 'end')
      : new Date(start.getTime() + 60 * 60 * 1000);
    if (end.getTime() <= start.getTime()) {
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }
    event = runCalendarStep_('createEvent', { allDay: false, start: start, end: end }, function () {
      return calendar.createEvent(eventData.title, start, end, options);
    });
  }

  return event;
}

/** Builds CalendarApp create options for description, location, guests, and invite delivery. */
function buildCalendarEventOptions_(eventData) {
  var options = {};
  if (eventData.location) {
    options.location = eventData.location;
  }
  if (eventData.description) {
    options.description = eventData.description;
  }
  if (eventData.guests && eventData.guests.length) {
    options.guests = eventData.guests.join(',');
    options.sendInvites = true;
  }
  return options;
}

// Replaces a place name with the Google Maps formatted address, or keeps the original text when nothing matches.
function resolveEventLocation_(eventData) {
  var plain = eventData.location ? String(eventData.location).trim() : '';
  if (!plain) {
    eventData.location = null;
    eventData.locationIsMapped = false;
    return;
  }
  var forceAirport =
    !!eventData.isFlight &&
    !eventData.locationFromPrompt &&
    !/\d/.test(plain) &&
    plain.indexOf(',') === -1;
  var query = forceAirport && !/airport/i.test(plain) ? plain + ' airport' : plain;
  var matched = geocodeLocation_(query, forceAirport || /airport/i.test(query));
  if (!matched && query !== plain) {
    matched = geocodeLocation_(plain, false);
  }
  eventData.location = matched || plain;
  eventData.locationIsMapped = !!matched;
}

// Looks up one place and prefers an airport result when the event is a flight.
function geocodeLocation_(query, preferAirport) {
  try {
    var response = Maps.newGeocoder().geocode(query);
    if (!response || response.status !== 'OK' || !response.results || !response.results.length) {
      return null;
    }
    if (preferAirport) {
      for (var i = 0; i < response.results.length; i++) {
        var airport = response.results[i];
        var types = airport.types || [];
        if (types.indexOf('airport') !== -1 && airport.formatted_address) {
          return airport.formatted_address;
        }
      }
      return null;
    }
    var first = response.results[0];
    if (first.partial_match || !first.formatted_address) {
      return null;
    }
    return first.formatted_address;
  } catch (err) {
    Logger.log('Geocode failed for ' + query + ': ' + err);
    return null;
  }
}

// Adds reminders, free/busy, the event link, and attachments after the event exists.
function applyExtraCalendarFields_(event, eventData, extras) {
  eventData.fieldWarnings = eventData.fieldWarnings || [];
  try {
    applyReminders_(event, eventData.reminders);
  } catch (err) {
    eventData.fieldWarnings.push('Reminders were not saved (' + err + ').');
  }
  if (eventData.showAs === 'free') {
    try {
      event.setTransparency(CalendarApp.EventTransparency.TRANSPARENT);
    } catch (err) {
      eventData.fieldWarnings.push('Show as free was not saved (' + err + ').');
    }
  }
  try {
    eventData.calendarAttachments = collectCalendarAttachments_(eventData, extras);
    eventData.attachmentTitles = attachmentTitles_(eventData.calendarAttachments);
    if (
      eventData.attachEmailFiles &&
      !(eventData.driveUrls && eventData.driveUrls.length) &&
      !eventData.calendarAttachments.length
    ) {
      eventData.fieldWarnings.push('No email attachment matched the prompt.');
    }
    patchCalendarLinkAndFiles_(event, eventData);
  } catch (err) {
    eventData.fieldWarnings.push('Link or attachments were not saved (' + err + ').');
  }
}

// Replaces default alerts with the lead times requested in the email prompt.
function applyReminders_(event, reminders) {
  if (!reminders || !reminders.length) {
    return;
  }
  event.removeAllReminders();
  for (var i = 0; i < reminders.length; i++) {
    var minutes = reminders[i].minutes;
    if (reminders[i].method === 'email') {
      event.addEmailReminder(minutes);
    } else {
      event.addPopupReminder(minutes);
    }
  }
}

// Uploads email files the prompt asked to attach and includes any Drive links from the prompt.
function collectCalendarAttachments_(eventData, extras) {
  var files = [];
  var driveUrls = eventData.driveUrls || [];
  for (var i = 0; i < driveUrls.length && files.length < 25; i++) {
    files.push({ fileUrl: driveUrls[i], title: 'Drive file' });
  }
  if (!eventData.attachEmailFiles) {
    return files;
  }
  var cache = extras.attachmentCache || {};
  var messages = extras.messages || [];
  var blobs = emailAttachmentBlobs_(messages, eventData.attachmentNames);
  for (var b = 0; b < blobs.length && files.length < 25; b++) {
    var key = blobs[b].key;
    if (!cache[key]) {
      cache[key] = uploadCalendarAttachment_(blobs[b].blob);
    }
    files.push(cache[key]);
  }
  return files;
}

// Collects non-inline email files, limited to named files when the prompt names them.
function emailAttachmentBlobs_(messages, names) {
  var blobs = [];
  var seen = {};
  for (var i = 0; i < messages.length; i++) {
    if (messageIsFromScript_(messages[i])) {
      continue;
    }
    var attachments = messages[i].getAttachments({
      includeInlineImages: false,
      includeAttachments: true
    });
    for (var a = 0; a < attachments.length; a++) {
      var file = attachments[a];
      var name = file.getName() || 'attachment';
      if (!attachmentNameMatches_(name, names)) {
        continue;
      }
      if (file.getSize && file.getSize() > 15 * 1024 * 1024) {
        continue;
      }
      var key = name + ':' + (file.getSize ? file.getSize() : blobs.length);
      if (seen[key]) {
        continue;
      }
      seen[key] = true;
      blobs.push({ key: key, blob: file.copyBlob() });
    }
  }
  if (!blobs.length && names && names.length) {
    return emailAttachmentBlobs_(messages, []);
  }
  return blobs;
}

// Returns true when no filenames were requested or this file matches one of them.
function attachmentNameMatches_(name, names) {
  if (!names || !names.length) {
    return true;
  }
  var fileName = String(name || '').toLowerCase();
  for (var i = 0; i < names.length; i++) {
    var wanted = String(names[i] || '').toLowerCase();
    if (wanted && (fileName.indexOf(wanted) !== -1 || wanted.indexOf(fileName) !== -1)) {
      return true;
    }
  }
  return false;
}

// Saves one email file into Drive so Calendar can attach it.
function uploadCalendarAttachment_(blob) {
  var folder = getScheduleAttachmentFolder_();
  var file = folder.createFile(blob);
  return {
    fileUrl: file.getUrl(),
    title: file.getName(),
    mimeType: file.getMimeType() || blob.getContentType() || 'application/octet-stream'
  };
}

// Finds or creates the Drive folder that holds files attached to scheduled events.
function getScheduleAttachmentFolder_() {
  var name = 'Schedule attachments';
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(name);
}

// Writes the event link and Drive attachments through the Calendar API.
function patchCalendarLinkAndFiles_(event, eventData) {
  var files = eventData.calendarAttachments || [];
  if (!eventData.url && !files.length) {
    return;
  }
  var patch = {};
  if (eventData.url) {
    patch.source = {
      url: eventData.url,
      title: String(eventData.title || 'Link').substring(0, 200)
    };
  }
  if (files.length) {
    patch.attachments = files;
  }
  var id = String(event.getId() || '');
  var at = id.indexOf('@');
  if (at !== -1) {
    id = id.substring(0, at);
  }
  Calendar.Events.patch(patch, 'primary', id, { supportsAttachments: files.length > 0 });
}

// Lists attachment titles for the confirmation email.
function attachmentTitles_(files) {
  var titles = [];
  for (var i = 0; i < files.length; i++) {
    if (files[i].title) {
      titles.push(files[i].title);
    }
  }
  return titles;
}

// Formats reminder lead times for the confirmation email.
function formatRemindersForReport_(reminders) {
  var parts = [];
  for (var i = 0; i < reminders.length; i++) {
    parts.push(reminders[i].minutes + ' min ' + reminders[i].method);
  }
  return parts.join(', ');
}

// Runs one CalendarApp call and records the step and the dates that were passed when that call fails.
function runCalendarStep_(step, passed, fn) {
  try {
    return fn();
  } catch (err) {
    if (err && !err.step) {
      err.step = step;
    }
    if (err && passed && !err.passed) {
      err.passed = passed;
    }
    throw err;
  }
}

// Builds an Error whose field property names the event property that failed validation.
function calendarInputError_(message, field) {
  var err = new Error(message);
  err.field = field;
  return err;
}

// Replaces a calendar-create error with the cause, the attempted event, and a valid example.
function rethrowCalendarCreateFailure_(eventData, err) {
  if (err && err.calendarCreateFailure) {
    throw err;
  }
  var wrapped = new Error(describeCalendarCreateFailure_(eventData, err));
  wrapped.calendarCreateFailure = true;
  throw wrapped;
}

// Returns the calendar-create failure report, reusing one that was already attached to the error.
function calendarCreateFailureText_(eventData, err) {
  if (err && err.calendarCreateFailure) {
    return String(err.message || err);
  }
  return describeCalendarCreateFailure_(eventData, err);
}

// Builds a concise calendar-create failure report with the cause, attempted fields, and a valid example.
function describeCalendarCreateFailure_(eventData, err) {
  var cause = err && err.message ? String(err.message) : String(err || 'Unknown error');
  var step = err && err.step ? String(err.step) : '';
  var field = err && err.field ? String(err.field) : '';
  var lines = ['Calendar create failed' + (step ? ' during ' + step : '') + ': ' + cause];
  lines.push('Attempted: ' + summarizeCalendarAttempt_(eventData) + '.');
  if (err && err.passed) {
    lines.push('Passed to Calendar: ' + summarizePassedToCalendar_(err.passed) + '.');
  }
  lines.push(calendarFailureExampleLine_(eventData, field));
  return lines.join('\n');
}

// Lists the extracted fields that were about to be written, truncating long text so the report stays readable.
function summarizeCalendarAttempt_(eventData) {
  var data = eventData || {};
  return [
    'title=' + quoteCalendarValue_(data.title),
    'start=' + quoteCalendarValue_(data.start),
    'end=' + quoteCalendarValue_(data.end),
    'allDay=' + (data.allDay ? 'yes' : 'no'),
    'location=' + quoteCalendarValue_(data.location),
    'description=' + quoteCalendarValue_(data.description),
    'guests=' + quoteCalendarValue_(formatGuestsForReport_(data.guests)),
    'url=' + quoteCalendarValue_(data.url),
    'showAs=' + quoteCalendarValue_(data.showAs),
    'confidence=' +
      (data.confidence == null || data.confidence === '' ? '(none)' : String(data.confidence))
  ].join(', ');
}

/** Joins guest emails for failure reports, or returns empty when none were extracted. */
function formatGuestsForReport_(guests) {
  if (!guests || !guests.length) {
    return '';
  }
  return guests.join(', ');
}

// Quotes a field for the failure report, or (none) when the extracted value is missing.
function quoteCalendarValue_(value) {
  if (value == null || String(value).trim() === '') {
    return '(none)';
  }
  var text = String(value);
  if (text.length > 180) {
    text = text.substring(0, 180) + '…';
  }
  return JSON.stringify(text);
}

// Formats the start and end Date objects that CalendarApp actually received.
function summarizePassedToCalendar_(passed) {
  var pattern = passed.allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ss";
  var zone = CONFIG.TIMEZONE || Session.getScriptTimeZone() || 'UTC';
  return (
    'start=' +
    JSON.stringify(Utilities.formatDate(passed.start, zone, pattern)) +
    ', end=' +
    JSON.stringify(Utilities.formatDate(passed.end, zone, pattern)) +
    ', allDay=' +
    (passed.allDay ? 'yes' : 'no')
  );
}

// Returns a valid event JSON example with the broken field corrected, plus the format rule that field must follow.
function calendarFailureExampleLine_(eventData, field) {
  var data = eventData || {};
  var allDay = !!data.allDay;
  var missingStart = data.start == null || String(data.start).trim() === '';
  var missingEnd = data.end == null || String(data.end).trim() === '';
  var start =
    field === 'start' || missingStart
      ? allDay
        ? '2026-10-02'
        : '2026-10-02T15:00:00'
      : String(data.start);
  var end = field === 'end' || missingEnd ? sampleCalendarEnd_(start, allDay) : String(data.end);
  if (exampleEndIsNotAfterStart_(start, end, allDay)) {
    end = sampleCalendarEnd_(start, allDay);
  }
  var example = {
    title: data.title && field !== 'title' ? String(data.title) : 'Team standup',
    start: start,
    end: end,
    allDay: allDay
  };
  var note = allDay
    ? 'All-day dates are YYYY-MM-DD and end is exclusive, so one day on 2026-10-02 uses end 2026-10-03.'
    : 'Timed start and end are ISO 8601 and end must be after start, for example 2026-10-02T15:00:00 to 2026-10-02T16:00:00.';
  if (field === 'title') {
    note = 'Title must be a non-empty string, for example "Team standup".';
  }
  return 'Example: ' + JSON.stringify(example) + ' ' + note;
}

// Returns true when end is missing, equal to start, or earlier, so the example must use a later end.
function exampleEndIsNotAfterStart_(start, end, allDay) {
  if (allDay) {
    return String(end || '') <= String(start || '');
  }
  var startDate = new Date(String(start || '').replace(' ', 'T'));
  var endDate = new Date(String(end || '').replace(' ', 'T'));
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return false;
  }
  return endDate.getTime() <= startDate.getTime();
}

// Builds an end one day or one hour after start so the example stays a valid span.
function sampleCalendarEnd_(start, allDay) {
  var zone = CONFIG.TIMEZONE || Session.getScriptTimeZone() || 'UTC';
  if (allDay) {
    var day = String(start || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (day) {
      var next = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1);
      return Utilities.formatDate(next, zone, 'yyyy-MM-dd');
    }
    return '2026-10-03';
  }
  var when = new Date(String(start || '').replace(' ', 'T'));
  if (!isNaN(when.getTime())) {
    return Utilities.formatDate(new Date(when.getTime() + 60 * 60 * 1000), zone, "yyyy-MM-dd'T'HH:mm:ss");
  }
  return '2026-10-02T16:00:00';
}

/**
 * Parses an all-day date string (YYYY-MM-DD or ISO datetime) into a Date at local midnight.
 */
function parseAllDayDate_(value, field) {
  var dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3])
    );
  }
  var dt = parseIsoDateTime_(value, field || 'start');
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/** Returns local midnight the given number of calendar days after date. */
function addCalendarDays_(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Parses an ISO 8601 datetime string into a Date, throwing on invalid input.
 */
function parseIsoDateTime_(value, field) {
  var normalized = String(value).trim();
  // Apps Script Date accepts most ISO forms; space→T helps some Gemini outputs.
  if (/^\d{4}-\d{2}-\d{2} \d/.test(normalized)) {
    normalized = normalized.replace(' ', 'T');
  }
  var date = new Date(normalized);
  if (isNaN(date.getTime())) {
    var label = field || 'datetime';
    throw calendarInputError_('Invalid ' + label + ' ' + JSON.stringify(String(value)) + '.', label);
  }
  return date;
}

/**
 * Returns true when the extracted event has enough timing data to create a calendar entry.
 */
function hasUsableDatetime(eventData) {
  return !!(eventData && eventData.start);
}

/**
 * Returns true when the calendar event id still points at an event on the primary calendar.
 */
function calendarEventExistsById_(eventId) {
  if (!eventId) {
    return false;
  }
  try {
    var event = CalendarApp.getEventById(eventId);
    if (!event) {
      return false;
    }
    event.getStartTime();
    return true;
  } catch (err) {
    var text = String(err);
    if (
      text.indexOf('not found') !== -1 ||
      text.indexOf('Not Found') !== -1 ||
      text.indexOf('deleted') !== -1 ||
      text.indexOf('does not exist') !== -1
    ) {
      return false;
    }
    throw err;
  }
}

/**
 * Returns true when the primary calendar still has an event with the same title and start.
 */
function calendarHasMatchingEvent_(eventData) {
  if (!eventData || !eventData.title || !eventData.start) {
    return false;
  }
  var calendar = CalendarApp.getDefaultCalendar();
  var title = String(eventData.title).trim().toLowerCase();
  var start;
  var rangeStart;
  var rangeEnd;
  if (eventData.allDay) {
    start = parseAllDayDate_(eventData.start, 'start');
    rangeStart = start;
    rangeEnd = addCalendarDays_(start, 1);
  } else {
    start = parseIsoDateTime_(eventData.start, 'start');
    rangeStart = new Date(start.getTime() - 12 * 60 * 60 * 1000);
    rangeEnd = new Date(start.getTime() + 12 * 60 * 60 * 1000);
  }
  var events = calendar.getEvents(rangeStart, rangeEnd);
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (String(event.getTitle() || '').trim().toLowerCase() !== title) {
      continue;
    }
    if (eventData.allDay) {
      if (!event.isAllDayEvent()) {
        continue;
      }
      var eventStart = event.getAllDayStartDate();
      if (
        eventStart.getFullYear() === start.getFullYear() &&
        eventStart.getMonth() === start.getMonth() &&
        eventStart.getDate() === start.getDate()
      ) {
        return true;
      }
    } else if (!event.isAllDayEvent() && event.getStartTime().getTime() === start.getTime()) {
      return true;
    }
  }
  return false;
}
