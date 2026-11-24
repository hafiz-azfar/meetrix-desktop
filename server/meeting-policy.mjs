import { z } from 'zod';

export const meetingPolicySchema = z.object({
  requireSignIn: z.boolean().default(false),
  requireWaitingRoom: z.boolean().default(false),
  requirePasscode: z.boolean().default(false),
}).strict();

export function readMeetingPolicy(env) {
  const values = {
    requireSignIn: 'MEETRIX_REQUIRE_MEETING_SIGN_IN',
    requireWaitingRoom: 'MEETRIX_REQUIRE_WAITING_ROOM',
    requirePasscode: 'MEETRIX_REQUIRE_MEETING_PASSCODE',
  };
  return Object.fromEntries(Object.entries(values).map(([setting, key]) => {
    const value = env[key] || 'false';
    if (value !== 'true' && value !== 'false') throw new Error(key + ' must be true or false.');
    return [setting, value === 'true'];
  }));
}
