function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function colorFromQuality(q) {
  const hue = 120 * clamp01(q); // 0 red -> 120 green
  return `hsl(${hue}, 85%, 45%)`;
}

function computeQuality(slot, minScore, maxScore) {
  const range = Math.max(1, maxScore - minScore);
  const normScore = (slot.totalScore - minScore) / range;

  const total =
    slot.greenCount +
    slot.yellowCount +
    slot.redCount +
    slot.blockedCount;

  const redRatio = total > 0 ? slot.redCount / total : 1;

  return clamp01(normScore) * Math.pow(1 - redRatio, 2);
}

/**
 * @param {number} utcMinutes - minutes from UTC midnight
 * @param {boolean|string} timezone - true = UTC, false = browser TZ, or IANA timezone string (e.g. "America/New_York")
 * @param {string} [dateISO] - optional "YYYY-MM-DD" so UTC moment is on the correct day (affects TZ conversion)
 */
export function formatTime(utcMinutes, timezone = true, dateISO = null) {
  const base = dateISO
    ? (() => { const [y, m, d] = dateISO.split("-").map(Number); return Date.UTC(y, m - 1, d, 0, 0); })()
    : Date.UTC(2026, 0, 1, 0, 0);
  const d = new Date(base + utcMinutes * 60 * 1000);
  const tz = timezone === true ? "UTC" : (timezone === false ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz
  }).format(d);
}

/**
 * Local minutes from midnight in the display timezone for a slot (for ordering rows 00:00 → 23:30).
 */
function getLocalMinutesFromMidnight(utcStartMin, dateISO, displayTimezone) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, 0, 0) + utcStartMin * 60 * 1000;
  const tz = displayTimezone === true ? "UTC" : (displayTimezone === false ? Intl.DateTimeFormat().resolvedOptions().timeZone : displayTimezone);
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "numeric", hour12: false, timeZone: tz }).formatToParts(new Date(utcMs));
  const hour = parseInt(parts.find(p => p.type === "hour").value, 10);
  const minute = parseInt(parts.find(p => p.type === "minute").value, 10);
  return hour * 60 + minute;
}

/**
 * Returns true if the slot (30-min ending at utcStartMin+30) has already passed on dateISO.
 */
function isSlotPast(dateISO, utcStartMin) {
  if (!dateISO) return false;
  const [y, m, d] = dateISO.split("-").map(Number);
  const slotEndMs = Date.UTC(y, m - 1, d, 0, 0) + (utcStartMin + 30) * 60 * 1000;
  return slotEndMs <= Date.now();
}

/**
 * Build "Name: HH:mm" for each participant when < 6 people.
 */
function formatPerPersonTimes(utcStartMin, dateISO, participants) {
  if (!dateISO || !participants || participants.length >= 6) return null;
  return participants
    .filter(p => p.timezone)
    .map(p => `${p.name}: ${formatTime(utcStartMin, p.timezone, dateISO)}`)
    .join(" · ");
}

/**
 * Render heatmap as vertical calendar (Google Calendar style).
 * opts: { topSlots: Set<utcStartMin>, displayTimezone: string|boolean, dateISO: string, participants: Array }
 */
export function renderHeatmap(container, slots, opts = {}) {
  const { topSlots = new Set(), displayTimezone = true, dateISO = null, participants = null } = opts;
  const showPerPerson = participants && participants.length > 0 && participants.length < 6;

  const scores = slots.map(s => s.totalScore);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  // Order rows 00:00 → 23:30 in the display timezone (not UTC order, which can show 16:00→15:30 west of UTC)
  const orderedSlots = dateISO && displayTimezone !== true
    ? [...slots].sort((a, b) => getLocalMinutesFromMidnight(a.utcStartMin, dateISO, displayTimezone) - getLocalMinutesFromMidnight(b.utcStartMin, dateISO, displayTimezone))
    : slots;

  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "calendar-vertical";

  orderedSlots.forEach(slot => {
    const quality = computeQuality(slot, minScore, maxScore);
    const color = colorFromQuality(quality);

    const row = document.createElement("div");
    row.className = "calendar-row";

    const timeLabel = document.createElement("div");
    timeLabel.className = "calendar-time";
    const timeStr = dateISO ? formatTime(slot.utcStartMin, displayTimezone, dateISO) : "";
    timeLabel.textContent = timeStr || `${Math.floor(slot.utcStartMin / 60)}:${String(slot.utcStartMin % 60).padStart(2, "0")}`;
    if (isSlotPast(dateISO, slot.utcStartMin)) {
      timeLabel.classList.add("past");
    }

    const cell = document.createElement("div");
    cell.className = "calendar-cell cell";
    if (topSlots.has(slot.utcStartMin)) {
      cell.classList.add("top");
    }
    if (isSlotPast(dateISO, slot.utcStartMin)) {
      cell.classList.add("past");
    }
    cell.style.background = color;

    const total =
      slot.greenCount +
      slot.yellowCount +
      slot.redCount +
      slot.blockedCount;

    const timeLabelStr = typeof displayTimezone === "string" ? `${displayTimezone}` : (displayTimezone ? "UTC" : "local");
    cell.title =
      `${formatTime(slot.utcStartMin, displayTimezone, dateISO)} (${timeLabelStr})\n` +
      `Score: ${slot.totalScore}\n` +
      `Green: ${slot.greenCount}\n` +
      `Yellow: ${slot.yellowCount}\n` +
      `Red: ${slot.redCount}\n` +
      `Participants: ${total}`;

    row.appendChild(timeLabel);
    row.appendChild(cell);
    wrapper.appendChild(row);

    if (showPerPerson) {
      const perPersonText = formatPerPersonTimes(slot.utcStartMin, dateISO, participants);
      if (perPersonText) {
        const perPersonRow = document.createElement("div");
        perPersonRow.className = "calendar-row calendar-row-per-person";
        const perPersonLabel = document.createElement("div");
        perPersonLabel.className = "calendar-time";
        perPersonLabel.setAttribute("aria-hidden", "true");
        const perPersonCell = document.createElement("div");
        perPersonCell.className = "calendar-cell calendar-per-person-times";
        perPersonCell.textContent = perPersonText;
        if (isSlotPast(dateISO, slot.utcStartMin)) perPersonCell.classList.add("past");
        perPersonRow.appendChild(perPersonLabel);
        perPersonRow.appendChild(perPersonCell);
        wrapper.appendChild(perPersonRow);
      }
    }
  });

  container.appendChild(wrapper);
}

/**
 * Ticks as row labels are built into the vertical calendar; this fills a legacy container or can show UTC hours.
 */
export function renderTicks(container) {
  if (!container) return;
  container.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "ticks-vertical";
  wrap.setAttribute("aria-hidden", "true");

  for (let i = 0; i < 24; i++) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.textContent = formatTime(i * 60);
    wrap.appendChild(tick);
  }
  container.appendChild(wrap);
}
