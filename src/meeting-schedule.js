const dayMs = 86_400_000;

export const maxOccurrences = 52;
export const maxRepeatInterval = 12;

export function localDateValue(time) {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function shiftMeetingTimes(meetings, firstLocalTime) {
  const first = Date.parse(firstLocalTime + ':00Z');
  if (!meetings.length || !Number.isFinite(first)) throw new Error('Choose a start time for the first selected occurrence.');
  const anchor = Date.parse(localDateValue(meetings[0].startAt) + ':00Z');
  const delta = first - anchor;
  return meetings.map(meeting => {
    if (!delta) return new Date(meeting.startAt);
    const date = new Date(meeting.startAt);
    const wall = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(),
      date.getMinutes(), date.getSeconds(), date.getMilliseconds()) + delta);
    return new Date(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(),
      wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds());
  });
}

export function meetingOccurrences(value, frequency = 'once', count = 1, now = Date.now(), interval = 1, options = {}) {
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
  const dateLimited = frequency !== 'once' && options.until != null;
  if (frequency !== 'once' && !dateLimited && (!Number.isInteger(count) || count < 2 || count > maxOccurrences)) {
    throw new Error('Choose between 2 and ' + maxOccurrences + ' occurrences.');
  }

  const local = (month, day) => new Date(year, month, day, hours, minutes);
  const weekday = time => time.getDay() >= 1 && time.getDay() <= 5;
  const first = local(month - 1, day);
  const horizon = now + 366 * dayMs;
  if (first.getTime() < now - 60_000 || first.getTime() > horizon) {
    throw new Error('Choose meeting times within the next year.');
  }
  if (frequency === 'weekdays' && !weekday(first)) {
    throw new Error('Choose a Monday through Friday start date for weekday meetings.');
  }
  let until = horizon;
  if (dateLimited) {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(options.until);
    if (!date) throw new Error('Choose a date to end the series.');
    const [endYear, endMonth, endDay] = date.slice(1).map(Number);
    if (endYear < year || endMonth < 1 || endMonth > 12 || endDay < 1 || endDay > lastDay(endYear, endMonth - 1)) {
      throw new Error('Choose a valid date to end the series.');
    }
    const end = new Date(endYear, endMonth - 1, endDay, 23, 59, 59, 999);
    const horizonDate = new Date(horizon);
    horizonDate.setHours(23, 59, 59, 999);
    if (end < first || end > horizonDate) throw new Error('Choose an end date after the first meeting and within the next year.');
    until = Math.min(end.getTime(), horizon);
  }
  const weekStartOffset = (first.getDay() + 6) % 7;
  const weeklyDays = new Set([first.getDay(), ...(options.weeklyDays ?? [])]);
  const monthlyPattern = options.monthlyPattern || 'date';
  if (frequency === 'monthly' && monthlyPattern === 'last' && day + 7 <= lastDay(year, month - 1)) {
    throw new Error('For the last weekday pattern, choose its last occurrence in the starting month.');
  }
  const ordinal = Math.floor((day - 1) / 7);

  const occurrences = [first];
  for (let offset = 1; dateLimited || occurrences.length < count; offset++) {
    let next;
    let included = true;
    if (frequency === 'monthly') {
      const nextMonth = month - 1 + offset * interval;
      const monthEnd = lastDay(year, nextMonth);
      let target = Math.min(day, monthEnd);
      if (monthlyPattern === 'ordinal') {
        target = 1 + (first.getDay() - local(nextMonth, 1).getDay() + 7) % 7 + 7 * ordinal;
        included = target <= monthEnd;
      } else if (monthlyPattern === 'last') {
        target = monthEnd - (local(nextMonth, monthEnd).getDay() - first.getDay() + 7) % 7;
      }
      next = local(nextMonth, target);
    } else {
      next = local(month - 1, day + offset * (frequency === 'daily' ? interval : 1));
      if (frequency === 'weekdays') included = weekday(next);
      if (frequency === 'weekly') {
        included = Math.floor((weekStartOffset + offset) / 7) % interval === 0 && weeklyDays.has(next.getDay());
      }
    }
    if (next.getTime() > until) {
      if (!dateLimited) throw new Error('Choose meeting times within the next year.');
      break;
    }
    if (included) {
      if (occurrences.length === maxOccurrences) throw new Error('Choose an end date with no more than ' + maxOccurrences + ' occurrences.');
      occurrences.push(next);
    }
  }
  if (dateLimited && occurrences.length < 2) throw new Error('The end date must allow at least two occurrences.');
  if (occurrences.some((time, index) => index > 0 && time <= occurrences[index - 1])) {
    throw new Error('Some meeting times overlap after a local clock change. Choose a different start date.');
  }
  return occurrences;
}
