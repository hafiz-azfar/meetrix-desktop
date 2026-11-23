const dayMs = 86_400_000;

export const maxOccurrences = 52;
export const maxRepeatInterval = 12;

export function meetingOccurrences(value, frequency = 'once', count = 1, now = Date.now(), interval = 1) {
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!fields) throw new Error('Choose a meeting date and start time.');
  const [year, month, day, hours, minutes] = fields.slice(1).map(Number);
  const lastDay = (year, month) => new Date(year, month + 1, 0).getDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDay(year, month - 1) || hours > 23 || minutes > 59) {
    throw new Error('Choose a valid meeting date and start time.');
  }
  if (!['once', 'daily', 'weekdays', 'weekly', 'monthly'].includes(frequency)) {
    throw new Error('Choose a supported repeat option.');
  }
  if (frequency === 'once') count = 1;
  if (frequency !== 'once' && frequency !== 'weekdays' &&
      (!Number.isInteger(interval) || interval < 1 || interval > maxRepeatInterval)) {
    throw new Error('Choose a repeat interval from 1 to ' + maxRepeatInterval + '.');
  }
  if (frequency !== 'once' && (!Number.isInteger(count) || count < 2 || count > maxOccurrences)) {
    throw new Error('Choose between 2 and ' + maxOccurrences + ' occurrences.');
  }

  const local = (month, day) => new Date(year, month, day, hours, minutes);
  const weekday = time => time.getDay() >= 1 && time.getDay() <= 5;
  const first = local(month - 1, day);
  if (frequency === 'weekdays' && !weekday(first)) {
    throw new Error('Choose a Monday through Friday start date for weekday meetings.');
  }
  const occurrences = [first];
  let offset = 0;
  while (occurrences.length < count) {
    offset++;
    if (frequency === 'monthly') {
      const nextMonth = month - 1 + offset * interval;
      occurrences.push(local(nextMonth, Math.min(day, lastDay(year, nextMonth))));
    } else {
      const step = frequency === 'weekdays' ? 1 : interval * (frequency === 'weekly' ? 7 : 1);
      const next = local(month - 1, day + offset * step);
      if (frequency !== 'weekdays' || weekday(next)) occurrences.push(next);
    }
  }
  // The server accepts meetings starting within the next 366 days.
  if (occurrences.some(time => time.getTime() < now - 60_000 || time.getTime() > now + 366 * dayMs)) {
    throw new Error('Choose meeting times within the next year.');
  }
  if (occurrences.some((time, index) => index > 0 && time <= occurrences[index - 1])) {
    throw new Error('Some meeting times overlap after a local clock change. Choose a different start date.');
  }
  return occurrences;
}
