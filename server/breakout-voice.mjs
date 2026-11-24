import { randomBytes } from 'node:crypto';
import { DataPacket_Kind } from 'livekit-server-sdk';
import { z } from 'zod';
import { breakoutVoiceTopic, voiceBytes, voiceFrameCount, voiceIdPattern, voicePacket, voiceSeconds } from './breakout-voice-format.mjs';

const voiceId = z.string().regex(voiceIdPattern);
const audioLength = Math.ceil(voiceBytes / 3) * 4;
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), roomId: z.string().regex(/^breakout_[A-Za-z0-9_-]{16}$/).optional() }).strict(),
  z.object({ action: z.literal('stop'), broadcast: voiceId }).strict(),
  z.object({ action: z.literal('audio'), broadcast: voiceId, index: z.number().int().min(0).max(voiceFrameCount - 1),
    pcm: z.string().length(audioLength) }).strict(),
]);

export function registerBreakoutVoice(api, { byIdentity, serial, meetingFor, getMeeting, activeRooms, requireSpeaker, send, log, error }) {
  const running = new Map();
  function stop(meeting, actor) {
    if (actor === undefined || running.get(meeting)?.actor === actor) running.delete(meeting);
  }
  function sweep(now = Date.now()) {
    for (const [id, run] of running) if (run.expiresAt <= now || run.lastAt + 3500 <= now) stop(id);
  }

  api.post('/meetings/:id/breakout-voice', byIdentity(270), async (req, res) => {
    const input = command.parse(req.body);
    const meeting = meetingFor(req);
    const result = await serial(meeting.id, async () => {
      const current = getMeeting(meeting.id);
      const now = Date.now();
      const existing = running.get(meeting.id);
      if (existing && (existing.expiresAt <= now || existing.lastAt + 3500 <= now)) stop(meeting.id);
      const prior = running.get(meeting.id);
      if (input.action === 'stop') {
        if (prior?.id === input.broadcast && prior.actor === req.identity) stop(meeting.id);
        return { stopped: true };
      }

      if (input.action === 'start') {
        const participant = await requireSpeaker(current, req.identity);
        if (prior) throw error(409, 'A moderator is already sending a voice announcement.');
        const targets = activeRooms(current).filter(room => !input.roomId || room.id === input.roomId);
        if (!targets.length) throw error(409, 'Select an open breakout room with participants.');
        const run = { id: randomBytes(12).toString('hex'), actor: req.identity, sid: participant.sid,
          targets: new Set(targets.map(room => room.id)), startedAt: now, expiresAt: now + voiceSeconds * 1000,
          lastAt: now, index: -1, count: 0 };
        running.set(meeting.id, run);
        log(meeting.id, req.identity, input.roomId ?? null);
        return { broadcast: run.id, expiresAt: run.expiresAt };
      }

      if (!prior || prior.id !== input.broadcast || prior.actor !== req.identity) {
        throw error(409, 'This voice announcement has stopped.');
      }
      if (input.index <= prior.index) throw error(409, 'This audio frame was already sent.');
      if (prior.count >= Math.floor((now - prior.startedAt) / 200) + 2) {
        throw error(429, 'The voice announcement is arriving too quickly.');
      }
      const pcm = Buffer.from(input.pcm, 'base64');
      if (pcm.length !== voiceBytes || pcm.toString('base64') !== input.pcm) throw error(400, 'The audio frame is invalid.');
      let participant;
      try { participant = await requireSpeaker(current, req.identity); }
      catch (failure) { stop(meeting.id); throw failure; }
      if (participant.sid !== prior.sid || prior.expiresAt <= Date.now()) {
        stop(meeting.id);
        throw error(409, 'The speaker session changed or the voice announcement expired.');
      }
      const targets = activeRooms(current).filter(room => prior.targets.has(room.id));
      if (!targets.length) {
        stop(meeting.id);
        throw error(409, 'The selected breakout rooms are closed or empty.');
      }
      prior.lastAt = now;
      prior.index = input.index;
      prior.count++;
      const data = voicePacket(prior.id, input.index, pcm);
      const settings = { topic: breakoutVoiceTopic };
      const outcomes = await Promise.allSettled(targets.map(room => send(room.id, data, DataPacket_Kind.RELIABLE, settings)));
      if (!outcomes.some(item => item.status === 'fulfilled')) {
        stop(meeting.id);
        throw error(409, 'No selected breakout rooms received audio.');
      }
      return { delivered: outcomes.filter(item => item.status === 'fulfilled').length };
    });
    res.json(result);
  });

  return { sweep, stop, close: () => running.clear() };
}
