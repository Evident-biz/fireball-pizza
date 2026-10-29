// Reads the private Google Calendar (its "Secret address in iCal format") so the date check
// knows about jobs that were only put on the calendar, not entered as orders.
//
// Settings (Netlify environment variables):
//   GOOGLE_CALENDAR_ICS_URL      the secret iCal address. Several can be comma separated.
//   CALENDAR_IGNORE_KEYWORDS     comma separated; events whose title contains one are ignored.
//                                Defaults to "farmers market" (market days have their own rule).
//
// Any other event (all-day or timed, including recurring ones) makes its day busy. Events
// marked "Free" in Google Calendar are ignored. Dates are in Pacific time.
// The feed is cached for 5 minutes. If Google can't be reached the check is skipped, and the
// order system still works from its own bookings.

const TIME_ZONE = 'America/Los_Angeles';
const CACHE_MS = 5 * 60 * 1000;
const HORIZON_DAYS = 550; // how far ahead recurring events are expanded

let memoryCache = null; // { at, busy: Map<date, string[]> }

export function calendarConfigured() {
  return !!process.env.GOOGLE_CALENDAR_ICS_URL;
}

function ignoreKeywords() {
  return (process.env.CALENDAR_IGNORE_KEYWORDS ?? 'farmers market')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

// Map of 'YYYY-MM-DD' -> [event titles]. Returns an empty map when not configured or unreachable.
export async function busyDates(store) {
  if (!calendarConfigured()) return new Map();
  if (memoryCache && Date.now() - memoryCache.at < CACHE_MS) return memoryCache.busy;

  const cached = store ? await store.get('cache/gcal', { type: 'json' }).catch(() => null) : null;
  if (cached && Date.now() - cached.at < CACHE_MS) {
    memoryCache = { at: cached.at, busy: new Map(cached.busy) };
    return memoryCache.busy;
  }

  try {
    const urls = process.env.GOOGLE_CALENDAR_ICS_URL.split(',').map((u) => u.trim()).filter(Boolean);
    const busy = new Map();
    for (const url of urls) {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('Calendar feed returned ' + res.status);
      for (const [date, titles] of parseBusy(await res.text())) {
        busy.set(date, [...(busy.get(date) || []), ...titles]);
      }
    }
    memoryCache = { at: Date.now(), busy };
    if (store) await store.setJSON('cache/gcal', { at: memoryCache.at, busy: [...busy] }).catch(() => {});
    return busy;
  } catch (err) {
    console.error('Fireball calendar: could not read Google Calendar, skipping it for this check.', err.message);
    // Fall back to the last good copy, however old, rather than nothing.
    if (cached) return new Map(cached.busy);
    return new Map();
  }
}

// ---------- iCal parsing ----------

export function parseBusy(ics, { now = new Date(), keywords = ignoreKeywords() } = {}) {
  const events = parseEvents(ics);
  const overrides = new Map(); // uid -> Map(recurrenceKey -> event)
  for (const e of events) {
    if (e.recurrenceId) {
      if (!overrides.has(e.uid)) overrides.set(e.uid, new Map());
      overrides.get(e.uid).set(e.recurrenceId.key, e);
    }
  }

  const from = addDays(dateInZone(now), -1);
  const until = addDays(dateInZone(now), HORIZON_DAYS);
  const busy = new Map();
  const mark = (e, start, end) => {
    if (e.cancelled || e.free) return;
    const title = e.summary || 'Busy';
    if (keywords.some((k) => title.toLowerCase().includes(k))) return;
    for (const day of daysCovered(start, end)) {
      if (day < from || day > until) continue;
      busy.set(day, [...(busy.get(day) || []), title]);
    }
  };

  for (const e of events) {
    if (e.recurrenceId || !e.start) continue;
    if (!e.rrule) {
      mark(e, e.start, e.end);
      continue;
    }
    const length = e.end ? e.end.ms - e.start.ms : 0;
    for (const start of expand(e, until)) {
      const override = overrides.get(e.uid)?.get(start.key);
      if (override) continue; // handled below with its own times
      if (e.exdates.has(start.key)) continue;
      mark(e, start, { ...start, ms: start.ms + length, allDay: start.allDay });
    }
  }
  for (const map of overrides.values()) {
    for (const o of map.values()) if (o.start) mark(o, o.start, o.end);
  }
  return busy;
}

function parseEvents(ics) {
  const lines = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: new Set() }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [name, ...paramParts] = line.slice(0, idx).split(';');
    const params = Object.fromEntries(paramParts.map((p) => p.split('=')));
    const value = line.slice(idx + 1);
    switch (name) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1'); break;
      case 'DTSTART': cur.start = parseTime(value, params); break;
      case 'DTEND': cur.end = parseTime(value, params); break;
      case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map((p) => p.split('='))); break;
      case 'EXDATE': for (const v of value.split(',')) cur.exdates.add(parseTime(v, params).key); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseTime(value, params); break;
      case 'STATUS': cur.cancelled = value === 'CANCELLED'; break;
      case 'TRANSP': cur.free = value === 'TRANSPARENT'; break;
    }
  }
  return events;
}

// Returns { ms, date, allDay, key }. `date` is the Pacific calendar day the moment falls on.
function parseTime(value, params = {}) {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const date = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8);
    return { ms: Date.parse(date + 'T00:00:00Z'), date, allDay: true, key: date };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  let ms;
  if (z) ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  else ms = zonedToUtc(+y, +mo - 1, +d, +h, +mi, +s, params.TZID || TIME_ZONE);
  return { ms, date: dateInZone(new Date(ms)), allDay: false, key: new Date(ms).toISOString() };
}

// Wall-clock time in a time zone -> UTC milliseconds. Two passes so times near a daylight
// saving change land on the right offset. Unknown zone names fall back to Pacific.
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const zone = validZone(tz) ? tz : TIME_ZONE;
  const wall = Date.UTC(y, mo, d, h, mi, s);
  const firstGuess = wall - tzOffsetMs(new Date(wall), zone);
  return wall - tzOffsetMs(new Date(firstGuess), zone);
}

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function dateInZone(date, tz = TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Every Pacific day an event touches. All-day ends are exclusive; a timed event ending exactly
// at midnight doesn't spill into the next day.
function daysCovered(start, end) {
  const days = [];
  if (start.allDay) {
    const last = end && end.allDay ? addDays(end.date, -1) : start.date;
    for (let d = start.date; d <= last && days.length < 60; d = addDays(d, 1)) days.push(d);
    return days;
  }
  const lastMoment = end && end.ms > start.ms ? end.ms - 1 : start.ms;
  const last = dateInZone(new Date(lastMoment));
  for (let d = start.date; d <= last && days.length < 60; d = addDays(d, 1)) days.push(d);
  return days;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Occurrence starts for a recurring event, up to `until`. Handles the patterns Google Calendar
// creates: DAILY / WEEKLY (with BYDAY) / MONTHLY (same day of month) / YEARLY, INTERVAL, COUNT, UNTIL.
function* expand(e, until) {
  const r = e.rrule;
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const untilDate = r.UNTIL ? parseTime(r.UNTIL) : null;
  const stop = untilDate ? (untilDate.date < until ? untilDate.date : until) : until;
  const byDay = r.BYDAY ? r.BYDAY.split(',').map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((i) => i >= 0) : null;
  // Pacific wall-clock time of day of the first occurrence, in ms after local midnight.
  const timeOfDay = e.start.allDay ? 0 : e.start.ms + tzOffsetMs(new Date(e.start.ms), TIME_ZONE) - Date.parse(e.start.date + 'T00:00:00Z');

  const at = (date) => {
    if (e.start.allDay) return { ms: Date.parse(date + 'T00:00:00Z'), date, allDay: true, key: date };
    // Keep the same Pacific wall-clock time on every occurrence (daylight saving aware).
    const local = new Date(Date.parse(date + 'T00:00:00Z') + timeOfDay);
    const ms = zonedToUtc(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), TIME_ZONE);
    return { ms, date, allDay: false, key: new Date(ms).toISOString() };
  };

  let produced = 0;
  const startDate = e.start.date;
  if (freq === 'WEEKLY') {
    const days = byDay && byDay.length ? byDay : [new Date(startDate + 'T00:00:00Z').getUTCDay()];
    // Walk week by week from the week containing the start.
    let weekStart = addDays(startDate, -new Date(startDate + 'T00:00:00Z').getUTCDay());
    for (let guard = 0; guard < 2000 && weekStart <= stop; guard++, weekStart = addDays(weekStart, 7 * interval)) {
      for (const dow of [...days].sort()) {
        const date = addDays(weekStart, dow);
        if (date < startDate || date > stop) continue;
        if (produced++ >= count) return;
        yield at(date);
      }
    }
    return;
  }
  for (let i = 0, guard = 0; guard < 5000; i++, guard++) {
    let date;
    if (freq === 'DAILY') date = addDays(startDate, i * interval);
    else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      const d = new Date(startDate + 'T00:00:00Z');
      if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + i * interval);
      else d.setUTCFullYear(d.getUTCFullYear() + i * interval);
      date = d.toISOString().slice(0, 10);
      if (date.slice(8) !== startDate.slice(8)) continue; // e.g. the 31st in a 30-day month
    } else {
      yield e.start; // unsupported pattern: at least count the first occurrence
      return;
    }
    if (date > stop) return;
    if (produced++ >= count) return;
    yield at(date);
  }
}
