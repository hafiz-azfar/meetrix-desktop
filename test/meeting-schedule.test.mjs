import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingOccurrences } from '../src/meeting-schedule.js';
import { meetingCalendar } from '../src/calendar.js';

process.env.TZ = 'America/New_York';

const iso = times => times.map(time => time.toISOString());

test('daily and weekly schedules preserve the chosen wall time across daylight saving', () => {
  const now = Date.parse('2026-03-01T00:00:00Z');
  assert.deepEqual(iso(meetingOccurrences('2026-03-07T09:30', 'daily', 3, now)), [
    '2026-03-07T14:30:00.000Z', '2026-03-08T13:30:00.000Z', '2026-03-09T13:30:00.000Z',
  ]);
  assert.deepEqual(iso(meetingOccurrences('2026-03-05T11:00', 'weekly', 2, now)), [
    '2026-03-05T16:00:00.000Z', '2026-03-12T15:00:00.000Z',
  ]);
  assert.deepEqual(iso(meetingOccurrences('2026-03-07T02:30', 'daily', 3, now)), [
    '2026-03-07T07:30:00.000Z', '2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z',
  ]);
});

test('weekday meetings skip weekends and monthly meetings clamp each month independently', () => {
  const now = Date.parse('2028-01-01T00:00:00Z');
  assert.deepEqual(iso(meetingOccurrences('2028-01-28T10:15', 'weekdays', 3, now)), [
    '2028-01-28T15:15:00.000Z', '2028-01-31T15:15:00.000Z', '2028-02-01T15:15:00.000Z',
  ]);
  assert.deepEqual(iso(meetingOccurrences('2028-01-31T08:00', 'monthly', 4, now)), [
    '2028-01-31T13:00:00.000Z', '2028-02-29T13:00:00.000Z', '2028-03-31T12:00:00.000Z', '2028-04-30T12:00:00.000Z',
  ]);
  assert.throws(() => meetingOccurrences('2028-01-29T10:15', 'weekdays', 3, now), /Monday through Friday/);
  assert.throws(() => meetingOccurrences('2028-02-30T10:15', 'daily', 3, now), /valid meeting date/);
  assert.throws(() => meetingOccurrences('2028-01-28T10:15', 'daily', 53, now), /52 occurrences/);
  assert.throws(() => meetingOccurrences('2028-12-01T10:15', 'monthly', 4, now), /within the next year/);
});

test('longer schedules and custom intervals preserve local start times', () => {
  const now = Date.parse('2026-03-01T00:00:00Z');
  const long = meetingOccurrences('2026-03-05T11:00', 'weekly', 52, now);
  assert.equal(long.length, 52);
  assert.equal(long.at(-1).getHours(), 11);
  assert.deepEqual(iso(meetingOccurrences('2026-03-05T11:00', 'weekly', 3, now, 2)), [
    '2026-03-05T16:00:00.000Z', '2026-03-19T15:00:00.000Z', '2026-04-02T15:00:00.000Z',
  ]);
  assert.throws(() => meetingOccurrences('2026-03-05T11:00', 'weekly', 3, now, 0), /repeat interval/);
});

test('calendar files include distinct event IDs and fold escaped Unicode text correctly', () => {
  const startAt = Date.parse('2028-01-28T15:15:00Z');
  const title = 'Meetrix 😀 हिंदी '.repeat(8) + 'Roadmap, Q1; path\\name\r\nBEGIN:VEVENT';
  const calendar = meetingCalendar([
    { id: 'abcdefghijklmnop', title, startAt, duration: 45 },
    { id: 'qrstuvwxyzabcdef', title: 'Second occurrence', startAt: startAt + 86400000, duration: 45 },
  ], 'https://workspace.meetrix.test', Date.parse('2028-01-01T00:00:00Z'));
  const lines = calendar.split('\r\n');
  assert.ok(lines.every(line => Buffer.byteLength(line, 'utf8') <= 75));
  assert.ok(lines.some(line => line.startsWith(' ')));
  assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 2);
  assert.ok(calendar.endsWith('END:VCALENDAR\r\n'));
  const unfolded = calendar.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('Roadmap\\, Q1\\; path\\\\name\\nBEGIN:VEVENT'));
  assert.ok(unfolded.includes('UID:abcdefghijklmnop@workspace.meetrix.test\r\n'));
  assert.ok(unfolded.includes('DTSTART:20280128T151500Z\r\nDTEND:20280128T160000Z\r\n'));
  assert.ok(unfolded.includes('DESCRIPTION:Join in Meetrix: https://workspace.meetrix.test/join?m=abcdefghijklmnop'));
  assert.ok(unfolded.includes('URL:https://workspace.meetrix.test/join?m=qrstuvwxyzabcdef'));
});

test('weekly selections repeat in their chosen weeks and stop on the end date', () => {
  const now = Date.parse('2026-03-01T00:00:00Z');
  const weeklyDays = [1, 5];
  assert.deepEqual(iso(meetingOccurrences('2026-03-04T11:00', 'weekly', 1, now, 2, { weeklyDays, until: '2026-03-20' })), [
    '2026-03-04T16:00:00.000Z', '2026-03-06T16:00:00.000Z', '2026-03-16T15:00:00.000Z',
    '2026-03-18T15:00:00.000Z', '2026-03-20T15:00:00.000Z',
  ]);
  assert.throws(() => meetingOccurrences('2026-03-04T11:00', 'weekly', 1, now, 1, { until: '2026-03-04' }), /at least two/);
  assert.throws(() => meetingOccurrences('2026-03-04T11:00', 'daily', 1, now, 1, { until: '2026-08-01' }), /no more than 52/);
});

test('monthly ordinal and last-weekday patterns handle short months and DST', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(iso(meetingOccurrences('2026-01-30T09:15', 'monthly', 3, now, 1, { monthlyPattern: 'last' })), [
    '2026-01-30T14:15:00.000Z', '2026-02-27T14:15:00.000Z', '2026-03-27T13:15:00.000Z',
  ]);
  assert.deepEqual(iso(meetingOccurrences('2026-01-30T09:15', 'monthly', 3, now, 1, { monthlyPattern: 'ordinal' })), [
    '2026-01-30T14:15:00.000Z', '2026-05-29T13:15:00.000Z', '2026-07-31T13:15:00.000Z',
  ]);
  assert.throws(() => meetingOccurrences('2026-01-23T09:15', 'monthly', 3, now, 1, { monthlyPattern: 'last' }), /starting month/);
});
