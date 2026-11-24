const encoder = new TextEncoder();

const textValue = value => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  .replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, '\\$&');
const stamp = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function fold(line) {
  let result = '';
  let bytes = 0;
  for (const char of line) {
    const length = encoder.encode(char).length;
    if (bytes + length > 75) {
      result += '\r\n ';
      bytes = 1;
    }
    result += char;
    bytes += length;
  }
  return result;
}

export function invitation(meetingId, origin = location.origin) {
  const url = new URL('/join', origin);
  url.searchParams.set('m', meetingId);
  return url.href;
}

export function meetingCalendar(meetings, origin, exportedAt = Date.now()) {
  const host = new URL(origin).hostname;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meetrix//Meetings//EN', 'CALSCALE:GREGORIAN'];
  for (const meeting of meetings) {
    const invite = invitation(meeting.id, origin);
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + textValue(meeting.id + '@' + host),
      'SEQUENCE:' + (meeting.sequence ?? 0),
      'DTSTAMP:' + stamp(exportedAt),
      'DTSTART:' + stamp(meeting.startAt),
      'DTEND:' + stamp(Number(meeting.startAt) + meeting.duration * 60000),
      'SUMMARY:' + textValue(meeting.title),
      'DESCRIPTION:' + textValue('Join in Meetrix: ' + invite),
      'URL:' + invite,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR', '');
  return lines.map(fold).join('\r\n');
}
