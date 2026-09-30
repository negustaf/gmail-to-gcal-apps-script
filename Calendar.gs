/**
 * Creates a Google Calendar event on the primary calendar from extracted event JSON.
 * Handles timed ISO datetimes and all-day YYYY-MM-DD (or date-only) values.
 * Returns the created CalendarEvent.
 */
function createCalendarEvent(eventData) {
  if (!eventData || !eventData.title) {
    throw new Error('Cannot create calendar event without a title.');
  }
  if (!eventData.start) {
    throw new Error('Cannot create calendar event without a start datetime.');
  }

  var calendar = CalendarApp.getDefaultCalendar();
  var event;

  if (eventData.allDay) {
    var startDate = parseAllDayDate_(eventData.start);
    var endDate = eventData.end
      ? parseAllDayDate_(eventData.end)
      : new Date(startDate.getTime() + 24 * 60 * 60 * 1000);

    // CalendarApp all-day end is exclusive; ensure at least one day span.
    if (endDate.getTime() <= startDate.getTime()) {
      endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
    }
    event = calendar.createAllDayEvent(eventData.title, startDate, endDate);
  } else {
    var start = parseIsoDateTime_(eventData.start);
    var end = eventData.end
      ? parseIsoDateTime_(eventData.end)
      : new Date(start.getTime() + 60 * 60 * 1000);
    if (end.getTime() <= start.getTime()) {
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }
    event = calendar.createEvent(eventData.title, start, end);
  }

  if (eventData.location) {
    event.setLocation(eventData.location);
  }
  if (eventData.description) {
    event.setDescription(eventData.description);
  }

  return event;
}

/**
 * Parses an all-day date string (YYYY-MM-DD or ISO datetime) into a Date at local midnight.
 */
function parseAllDayDate_(value) {
  var dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3])
    );
  }
  var dt = parseIsoDateTime_(value);
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/**
 * Parses an ISO 8601 datetime string into a Date, throwing on invalid input.
 */
function parseIsoDateTime_(value) {
  var normalized = String(value).trim();
  // Apps Script Date accepts most ISO forms; space→T helps some Gemini outputs.
  if (/^\d{4}-\d{2}-\d{2} \d/.test(normalized)) {
    normalized = normalized.replace(' ', 'T');
  }
  var date = new Date(normalized);
  if (isNaN(date.getTime())) {
    throw new Error('Invalid ISO datetime from Gemini: ' + value);
  }
  return date;
}

/**
 * Returns true when the extracted event has enough timing data to create a calendar entry.
 */
function hasUsableDatetime(eventData) {
  return !!(eventData && eventData.start);
}
