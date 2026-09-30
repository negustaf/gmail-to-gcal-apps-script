/**
 * Project configuration: plus-address, labels, Gemini model, timezone, and confidence threshold.
 * Set Script Properties SCHEDULE_PLUS_ADDRESS and GEMINI_API_KEY before running.
 */
var CONFIG = {
  /** Script Properties key for the Gemini API key (Google AI Studio). */
  GEMINI_API_KEY_PROPERTY: 'GEMINI_API_KEY',

  /** Script Properties key for your plus-address, e.g. you+schedule@gmail.com. */
  SCHEDULE_PLUS_ADDRESS_PROPERTY: 'SCHEDULE_PLUS_ADDRESS',

  /** Gmail label applied after a Calendar event is created successfully. */
  PROCESSED_LABEL: 'schedule-processed',

  /** Gmail label applied when confidence is low or datetime is missing. */
  NEEDS_REVIEW_LABEL: 'schedule-needs-review',

  /** Generative Language API model id. */
  GEMINI_MODEL: 'gemini-3.8-flash',

  /** IANA timezone used when interpreting event times and all-day dates. */
  TIMEZONE: Session.getScriptTimeZone() || 'America/New_York',

  /** Minimum confidence (0–1) required to create a Calendar event. */
  CONFIDENCE_THRESHOLD: 0.7,

  /** Only consider messages newer than this Gmail search window. */
  SEARCH_NEWER_THAN: '7d',

  /** When true, reply to the sender after a Calendar event is created. */
  EMAIL_SELF_ON_SUCCESS: true,

  /** When true, reply to the sender when a message needs review. */
  EMAIL_SELF_ON_NEEDS_REVIEW: true
};

/**
 * Returns the configured schedule plus-address from Script Properties.
 * Throws if SCHEDULE_PLUS_ADDRESS is missing so misconfiguration fails loudly.
 */
function getSchedulePlusAddress() {
  var address = PropertiesService.getScriptProperties().getProperty(
    CONFIG.SCHEDULE_PLUS_ADDRESS_PROPERTY
  );
  if (!address || !String(address).trim()) {
    throw new Error(
      'Set Script Property SCHEDULE_PLUS_ADDRESS to your plus-address ' +
        '(e.g. you+schedule@gmail.com). See README.md.'
    );
  }
  return String(address).trim();
}

/**
 * Builds the Gmail search for unprocessed plus-address forwards, quoting the address so Gmail does not treat + as the exact-match operator.
 */
function buildGmailSearchQuery() {
  var plusAddress = getSchedulePlusAddress().replace(/"/g, '');
  var quoted = '"' + plusAddress + '"';
  return (
    '(to:' +
    quoted +
    ' OR deliveredto:' +
    quoted +
    ') newer_than:' +
    CONFIG.SEARCH_NEWER_THAN +
    ' -label:' +
    CONFIG.PROCESSED_LABEL +
    ' -label:' +
    CONFIG.NEEDS_REVIEW_LABEL
  );
}
