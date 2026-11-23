export const captionLength = 240;
const controls = /[\u0000-\u001f\u007f]/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sid = /^PA_[a-zA-Z0-9]{1,64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function readCaptionText(value) {
  if (typeof value !== 'string') return null;
  const line = value.trim();
  return line && line.length <= captionLength && !controls.test(line) ? line : null;
}

export function readPublishedCaption(payload) {
  if (payload.byteLength > captionLength * 4) return null;
  try { return readCaptionText(decoder.decode(payload)); }
  catch { return null; }
}

export function readCaptionerPacket(payload, hostVersion) {
  if (payload.byteLength > 2048) return null;
  try {
    const packet = JSON.parse(decoder.decode(payload));
    if (!packet || packet.hostVersion !== hostVersion || typeof packet.sid !== 'string' || !sid.test(packet.sid)) return null;
    if (packet.kind === 'access' && typeof packet.allowed === 'boolean') return packet;
    if (typeof packet.id !== 'string' || !uuid.test(packet.id)) return null;
    if (packet.kind === 'result' && typeof packet.accepted === 'boolean') return packet;
    if (packet.kind === 'submission') {
      const line = readCaptionText(packet.line);
      return line ? { ...packet, line } : null;
    }
  } catch { /* Ignore malformed room data. */ }
  return null;
}

export function isCaptionHost(hostIdentity, participant) {
  return Boolean(participant?.sid && participant.identity === hostIdentity);
}

export function matchesCaptioner(assignment, participant) {
  return Boolean(participant?.sid && assignment?.identity === participant.identity && assignment.sid === participant.sid);
}
