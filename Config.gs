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

  /** Gmail label applied when confidence is low or datetime is missing and follow-ups are exhausted. */
  NEEDS_REVIEW_LABEL: 'schedule-needs-review',

  /** Gmail label applied while waiting for the sender to reply with missing event details. */
  AWAITING_REPLY_LABEL: 'schedule-awaiting-reply',

  /** Script Property that remembers events a thread created, so a later reply does not duplicate one still on the calendar. */
  THREAD_STATE_PROPERTY: 'SCHEDULE_THREAD_STATE',

  /** Generative Language API model id tried first. */
  GEMINI_MODEL: 'gemini-3.8-flash',

  /** Free models on the same API key, tried in order after GEMINI_MODEL exhausts its attempts. */
  GEMINI_FALLBACK_MODELS: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],

  /** Attempts for a transient Gemini HTTP failure such as 503 high demand, including the first call. */
  GEMINI_MAX_ATTEMPTS: 4,

  /** Attempts for each fallback model before moving to the next one. */
  GEMINI_FALLBACK_ATTEMPTS: 2,

  /** Base delay in milliseconds before retrying Gemini; each later attempt waits twice as long. */
  GEMINI_RETRY_BASE_MS: 1000,

  /** IANA timezone used when interpreting event times and all-day dates. */
  TIMEZONE: Session.getScriptTimeZone() || 'America/New_York',

  /** Minimum confidence (0–1) required to create a Calendar event. */
  CONFIDENCE_THRESHOLD: 0.7,

  /** Only consider messages newer than this Gmail search window. */
  SEARCH_NEWER_THAN: '7d',

  /** When true, reply to the sender after a Calendar event is created. */
  EMAIL_SELF_ON_SUCCESS: true,

  /** When true, reply to the sender when a message needs review. */
  EMAIL_SELF_ON_NEEDS_REVIEW: true,

  /** Visible characters of each message sent to Gemini after HTML is reduced to text. */
  TRANSCRIPT_CHAR_LIMIT: 200000
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
    CONFIG.NEEDS_REVIEW_LABEL +
    ' -label:' +
    CONFIG.AWAITING_REPLY_LABEL
  );
}

/**
 * Builds the Gmail search for threads this script already touched, so a later sender reply is still picked up.
 */
function buildAwaitingReplyQuery() {
  return (
    '(label:' +
    CONFIG.AWAITING_REPLY_LABEL +
    ' OR label:' +
    CONFIG.PROCESSED_LABEL +
    ' OR label:' +
    CONFIG.NEEDS_REVIEW_LABEL +
    ') newer_than:' +
    CONFIG.SEARCH_NEWER_THAN
  );
}
