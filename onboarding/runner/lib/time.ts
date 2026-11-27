/**
 * A time of day as a spoken reply or its transcription may render it. One
 * exported pattern shared by the production smoke suite and the integration
 * runner, so both tolerate the model's wording (AGENTS.md).
 *
 * Accepted: digits with or without minutes ("8", "08:30", "7.30", "0730"),
 * hour words ("eight", "twenty", "seven thirty"), clock phrases ("half past
 * seven", "quarter to eight"), "eight o'clock", "noon", "midnight", with
 * a.m./p.m./am/pm or "in the morning/afternoon/evening/night".
 */
const ONES = 'one|two|three|four|five|six|seven|eight|nine';
const TEENS = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TENS = 'twenty|thirty|forty|fifty';
const MINUTE_WORDS = `oh[-\\s](?:${ONES})|(?:${TENS})(?:[-\\s](?:${ONES}))?|(?:${TEENS})`;
const HOUR_WORDS = `(?:${ONES}|${TEENS}|${TENS})(?:[-\\s](?:${ONES}))?`;
/** 7:30, 7.30, 07:30 as digits. */
const DIGIT_HHMM = '(?:\\d{1,2}[:.]\\d{2})';
/** 0730 or 2012 as four digits. */
const DIGIT_HOUR_MINUTES = '(?:[01]\\d|2[0-3])[0-5]\\d';
/** "half past seven", "twenty past seven", "quarter to eight". */
const CLOCK_WORD = `(?:half|quarter|(?:${MINUTE_WORDS}))\\s+(?:past|to)\\s+${HOUR_WORDS}`;
/** "seven thirty", "eight oh five". */
const SPOKEN_HHMM = `${HOUR_WORDS}\\s+(?:${MINUTE_WORDS})`;
const HOUR_OCLOCK = `(?:${HOUR_WORDS})\\s+o['’]?clock`;
/** A bare hour: 1-12 or "twenty" as a word. */
const BARE_HOUR_WORD = `(?:${ONES}|ten|eleven|twelve|twenty)`;
/** A bare hour as digits: 0-9, 00-19, 20-23. */
const BARE_HOUR_DIGITS = '(?:[01]?\\d|2[0-3])';
const MERIDIEM = `a\\.?m\\.?|p\\.?m\\.?|in the (?:morning|afternoon|evening|night)`;

const ALTERNATIVES = [
  DIGIT_HHMM,
  DIGIT_HOUR_MINUTES,
  CLOCK_WORD,
  SPOKEN_HHMM,
  HOUR_OCLOCK,
  BARE_HOUR_WORD,
  BARE_HOUR_DIGITS,
  'noon',
  'midnight',
];

export const SPOKEN_TIME = new RegExp(`\\b(?:${ALTERNATIVES.join('|')})\\b(?:\\s*(?:${MERIDIEM}))?`, 'i');
