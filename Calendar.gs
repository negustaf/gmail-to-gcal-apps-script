/**
 * Creates a Google Calendar event on the primary calendar from extracted event JSON.
 * Handles timed ISO datetimes and all-day YYYY-MM-DD (or date-only) values.
 * Returns the created CalendarEvent.
 */
function createCalendarEvent(eventData) {
  try {
    return createCalendarEventFromData_(eventData);
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
