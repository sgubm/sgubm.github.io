// scoring.js
// Requires Luxon loaded globally: luxon.DateTime

const { DateTime } = luxon;

const DEFAULT_RULES = {
  // local minutes from midnight
  green:  { start: 9 * 60,  end: 18 * 60, score: 3 },   // 09:00 <= t < 18:00
  yellow1:{ start: 6 * 60 + 30, end: 9 * 60,  score: 2 },   // 06:30 <= t < 09:00
  yellow2:{ start: 18 * 60, end: 23 * 60 + 30, score: 2 }, // 18:00 <= t < 23:30
  redScore: 0,
  blockedScore: -100,

  // preference boosts
  earlyBirdBoostRange: { start: 7 * 60, end: 10 * 60, boost: 1 },  // 07:00-10:00
  nightOwlBoostRange:  { start: 18 * 60, end: 22 * 60, boost: 1 }  // 18:00-22:00
};

export function generateUtcSlots48() {
  const slots = [];
  for (let i = 0; i < 48; i++) {
    slots.push(i * 30); // utc minutes from midnight
  }
  return slots;
}

function parseHHMMToMinutes(hhmm) {
  // "07:30" -> 450
  const [hh, mm] = hhmm.split(":").map(Number);
  return (hh * 60) + (mm || 0);
}

function isInRange(localMin, start, end) {
  // [start, end) with wrap-around support (e.g., 23:00-01:00)
  if (start === end) return true; // full-day block
  if (start < end) return localMin >= start && localMin < end;
  // wraps midnight
  return localMin >= start || localMin < end;
}

function getBaseScoreAndBand(localMin, rules) {
  const { green, yellow1, yellow2, redScore } = rules;

  if (isInRange(localMin, green.start, green.end)) {
    return { baseScore: green.score, band: "green" };
  }
  if (isInRange(localMin, yellow1.start, yellow1.end) || isInRange(localMin, yellow2.start, yellow2.end)) {
    return { baseScore: yellow1.score, band: "yellow" }; // both yellow bands score same
  }
  return { baseScore: redScore, band: "red" };
}

function preferenceBoost(localMin, preference, rules) {
  if (preference === "early_bird") {
    const r = rules.earlyBirdBoostRange;
    return isInRange(localMin, r.start, r.end) ? r.boost : 0;
  }
  if (preference === "night_owl") {
    const r = rules.nightOwlBoostRange;
    return isInRange(localMin, r.start, r.end) ? r.boost : 0;
  }
  return 0;
}

/**
 * Check if local time falls in a blocked window.
 * @param {number} localMin - minutes from midnight (local)
 * @param {Array} noMeetingWindows - [{ start, end, date? }], date optional = apply only on that day (YYYY-MM-DD)
 * @param {string} [localDateStr] - user's local date "YYYY-MM-DD" for this slot (when windows have .date)
 */
function isBlocked(localMin, noMeetingWindows, localDateStr) {
  if (!Array.isArray(noMeetingWindows) || noMeetingWindows.length === 0) return false;

  return noMeetingWindows.some(w => {
    if (w.date != null && w.date !== "") {
      if (localDateStr == null || localDateStr !== w.date) return false;
    }
    const start = parseHHMMToMinutes(w.start);
    const end   = parseHHMMToMinutes(w.end);
    return isInRange(localMin, start, end);
  });
}

function localMinutesFromUtcSlot(dateISO, utcStartMin, tz) {
  // dateISO like "2026-02-25"
  // Create time at UTC midnight then add minutes, convert to user's timezone
  const utc = DateTime.fromISO(dateISO, { zone: "utc" }).startOf("day").plus({ minutes: utcStartMin });
  const local = utc.setZone(tz);
  return {
    localMin: local.hour * 60 + local.minute,
    localISO: local.toISO(),
    localLabel: local.toFormat("HH:mm"),
    localDate: local.toFormat("yyyy-MM-dd")
  };
}

/**
 * Score a set of users across 48 half-hour UTC slots.
 *
 * users: array of user objects from users.json
 * opts:
 *  - dateISO: meeting date in YYYY-MM-DD (important for DST correctness)
 *  - rules: override DEFAULT_RULES
 *  - selectedNames: optional Set/array of names to include (checkbox selection)
 *  - team: optional string to filter by team (e.g. "Engineering")
 *  - excludeNames: optional Set/array of names to exclude (e.g. "I will not attend")
 *  - includeYourselfName: optional string — always include this person in participants (unless in excludeNames); used when "Show times as" is set to a person
 *  - excludeNullTimezones: default true
 *  - includeRedParticipants: default true — each slot gets redParticipants: [{ name, timezone, localLabel }]
 */
export function scoreSlots48(users, opts = {}) {
  const {
    dateISO = DateTime.now().toISODate(),
    rules = DEFAULT_RULES,
    selectedNames = null,
    team = null,
    excludeNames = null,
    includeYourselfName = null,
    excludeNullTimezones = true,
    includeRedParticipants = true
  } = opts;

  const selectedSet = selectedNames
    ? (selectedNames instanceof Set ? selectedNames : new Set(selectedNames))
    : null;
  const excludeSet = excludeNames
    ? (excludeNames instanceof Set ? excludeNames : new Set(excludeNames))
    : null;

  let participants = users.filter(u => {
    if (excludeSet && excludeSet.has(u.name)) return false;
    if (selectedSet && selectedSet.size > 0 && !selectedSet.has(u.name)) return false;
    if (team != null && team !== "" && u.team !== team) return false;
    if (excludeNullTimezones && !u.timezone) return false;
    return true;
  });

  // Always include "yourself" (person from "Show times as") in the meeting pool so their availability is reflected
  if (includeYourselfName && !excludeSet?.has(includeYourselfName)) {
    const yourself = users.find(u => u.name === includeYourselfName);
    if (yourself && (yourself.timezone || !excludeNullTimezones) && !participants.find(p => p.name === includeYourselfName)) {
      participants = [...participants, yourself];
    }
  }

  const utcSlots = generateUtcSlots48();

  const results = utcSlots.map(utcStartMin => {
    let totalScore = 0;
    let greenCount = 0;
    let yellowCount = 0;
    let redCount = 0;
    let blockedCount = 0;
    const redParticipants = includeRedParticipants ? [] : undefined;

    for (const user of participants) {
      const { localMin, localLabel, localDate } = localMinutesFromUtcSlot(dateISO, utcStartMin, user.timezone);

      // hard block (pass local date so date-specific rules apply)
      if (isBlocked(localMin, user.noMeetingWindows, localDate)) {
        totalScore += rules.blockedScore;
        blockedCount += 1;
        continue;
      }

      const { baseScore, band } = getBaseScoreAndBand(localMin, rules);
      totalScore += baseScore + preferenceBoost(localMin, user.preference, rules);

      if (band === "green") greenCount += 1;
      else if (band === "yellow") yellowCount += 1;
      else {
        redCount += 1;
        if (redParticipants) {
          redParticipants.push({
            name: user.name,
            timezone: user.timezone,
            localLabel
          });
        }
      }
    }

    const slotResult = {
      utcStartMin,
      totalScore,
      greenCount,
      yellowCount,
      redCount,
      blockedCount,
      participantsCount: participants.length
    };
    if (redParticipants) slotResult.redParticipants = redParticipants;
    return slotResult;
  });

  return {
    dateISO,
    participants,
    slots: results
  };
}

/**
 * Fair ranking (recommended):
 * 1) fewer blocked
 * 2) fewer red
 * 3) higher totalScore
 * 4) higher greenCount
 */
export function rankSlots(slots) {
  return [...slots].sort((a, b) => {
    if (a.blockedCount !== b.blockedCount) return a.blockedCount - b.blockedCount;
    if (a.redCount !== b.redCount) return a.redCount - b.redCount;
    if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
    return b.greenCount - a.greenCount;
  });
}