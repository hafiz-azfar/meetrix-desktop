import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const breakoutEmail = z.email().max(254).transform(value => value.toLowerCase());

export function breakoutEmailKey(db, scope) {
  const purpose = 'breakout-email-matching';
  const read = db.prepare('SELECT value FROM workspace_secrets WHERE name = ?');
  if (!read.get(purpose)) {
    db.prepare('INSERT OR IGNORE INTO workspace_secrets(name, value) VALUES (?, ?)').run(purpose, randomBytes(32));
  }
  const { value: secret } = read.get(purpose);
  return email => {
    const parsed = breakoutEmail.safeParse(email);
    return parsed.success ? createHmac('sha256', secret).update(scope).update('\0').update(parsed.data).digest('hex') : null;
  };
}
