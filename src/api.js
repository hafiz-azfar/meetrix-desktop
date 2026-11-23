import { meetingCalendar } from './calendar.js';

export { invitation } from './calendar.js';

export function apiFor() {
  return async (path, options = {}) => {
    const response = await fetch('/api' + path, {
      method: options.method || 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: options.signal,
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload.error || 'The request did not complete.'), { status: response.status });
    return payload;
  };
}

export function parseInvitation(input) {
  let code = input.trim();
  if (code.includes('://')) {
    try {
      const url = new URL(code);
      if (url.origin !== location.origin) throw new Error('other server');
      code = url.searchParams.get('m') || '';
    } catch { throw new Error('Enter an invite link from this Meetrix server or paste the meeting code.'); }
  }
  if (!/^[A-Za-z0-9_-]{16}$/.test(code)) throw new Error('Enter a 16-character meeting code.');
  return code;
}

export function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function calendarInvite(meeting) {
  download('meetrix-' + meeting.id + '.ics', meetingCalendar([meeting], location.origin), 'text/calendar;charset=utf-8');
}

export function calendarSeries(meetings) {
  download('meetrix-series.ics', meetingCalendar(meetings, location.origin), 'text/calendar;charset=utf-8');
}
