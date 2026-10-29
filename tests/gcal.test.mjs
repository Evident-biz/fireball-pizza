// Google Calendar feed parsing: which Pacific days count as busy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBusy } from '../netlify/lib/gcal.mjs';

const NOW = new Date('2026-10-29T12:00:00Z');
const ics = (...events) => ['BEGIN:VCALENDAR', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const busy = (text) => Object.fromEntries([...parseBusy(text, { now: NOW, keywords: ['farmers market'] })].sort());

test('timed and all-day events, in Pacific time', () => {
  const days = busy(ics(
    ['BEGIN:VEVENT', 'UID:a', 'SUMMARY:Wedding', 'DTSTART;TZID=America/Los_Angeles:20261205T170000', 'DTEND;TZID=America/Los_Angeles:20261205T220000', 'END:VEVENT'],
    // 11pm-1am Pacific, written in UTC: touches both days.
    ['BEGIN:VEVENT', 'UID:b', 'SUMMARY:Late party', 'DTSTART:20261212T070000Z', 'DTEND:20261212T090000Z', 'END:VEVENT'],
    // All-day end dates are exclusive.
    ['BEGIN:VEVENT', 'UID:c', 'SUMMARY:Vacation', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261227', 'END:VEVENT'],
  ));
  assert.deepEqual(Object.keys(days), ['2026-12-05', '2026-12-11', '2026-12-12', '2026-12-24', '2026-12-25', '2026-12-26']);
});

test('free, cancelled, past and farmers market events are ignored', () => {
  const days = busy(ics(
    ['BEGIN:VEVENT', 'UID:a', 'SUMMARY:Reminder', 'TRANSP:TRANSPARENT', 'DTSTART;VALUE=DATE:20261201', 'DTEND;VALUE=DATE:20261202', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:b', 'SUMMARY:Called off', 'STATUS:CANCELLED', 'DTSTART;VALUE=DATE:20261202', 'DTEND;VALUE=DATE:20261203', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:c', 'SUMMARY:Old job', 'DTSTART;VALUE=DATE:20260101', 'DTEND;VALUE=DATE:20260102', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:d', 'SUMMARY:Modesto Farmers Market', 'DTSTART;TZID=America/Los_Angeles:20261105T080000', 'DTEND;TZID=America/Los_Angeles:20261105T130000', 'RRULE:FREQ=WEEKLY;BYDAY=TH,SA', 'END:VEVENT'],
  ));
  assert.deepEqual(days, {});
});

test('recurring events: weekly with a skipped and a moved occurrence, monthly, and daylight saving', () => {
  const days = busy(ics(
    ['BEGIN:VEVENT', 'UID:w', 'SUMMARY:Brewery', 'DTSTART;TZID=America/Los_Angeles:20261106T170000', 'DTEND;TZID=America/Los_Angeles:20261106T200000',
      'RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3', 'EXDATE;TZID=America/Los_Angeles:20261113T170000', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:w', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261120T170000', 'SUMMARY:Brewery (moved)',
      'DTSTART;TZID=America/Los_Angeles:20261121T170000', 'DTEND;TZID=America/Los_Angeles:20261121T200000', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:m', 'SUMMARY:Corp lunch', 'DTSTART;TZID=America/Los_Angeles:20261015T120000', 'DTEND;TZID=America/Los_Angeles:20261015T140000',
      'RRULE:FREQ=MONTHLY;UNTIL=20270115T235959Z', 'END:VEVENT'],
    // 11pm nightly across the Nov 1 clock change: must stay on its own day.
    ['BEGIN:VEVENT', 'UID:d', 'SUMMARY:Night', 'DTSTART;TZID=America/Los_Angeles:20261030T230000', 'DTEND;TZID=America/Los_Angeles:20261030T233000',
      'RRULE:FREQ=DAILY;COUNT=4', 'END:VEVENT'],
  ));
  assert.deepEqual(days['2026-11-06'], ['Brewery']);
  assert.equal(days['2026-11-13'], undefined, 'skipped occurrence');
  assert.equal(days['2026-11-20'], undefined, 'moved occurrence leaves its original day');
  assert.deepEqual(days['2026-11-21'], ['Brewery (moved)']);
  assert.deepEqual(['2026-11-15', '2026-12-15', '2027-01-15'].map((d) => !!days[d]), [true, true, true]);
  assert.equal(days['2027-02-15'], undefined, 'stops at UNTIL');
  assert.deepEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map((d) => days[d]?.[0]), ['Night', 'Night', 'Night', 'Night']);
  assert.equal(days['2026-11-03'], undefined);
});

test('folded lines and escaped titles from Google are read correctly', () => {
  const days = busy('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Smith\\, Jones\r\n  reunion\r\nDTSTART;VALUE=DATE:20261207\r\nDTEND;VALUE=DATE:20261208\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.deepEqual(days['2026-12-07'], ['Smith, Jones reunion']);
});
