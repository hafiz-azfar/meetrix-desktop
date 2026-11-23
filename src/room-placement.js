import { useCallback, useEffect, useRef, useState } from 'react';

export const placementTopic = 'meetrix.room-placement';
export const hostRolesTopic = 'meetrix.host-roles';

export function useRoomPlacement(api, initial) {
  const [session, setSession] = useState(() => ({ ...initial, roomId: initial.roomId ?? initial.meeting.id }));
  const [roles, setRoles] = useState(() => ({
    hostIdentity: initial.hostIdentity, hostVersion: initial.hostVersion ?? 0, coHosts: initial.coHosts ?? [],
  }));
  const [ended, setEnded] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [breakoutChoices, setBreakoutChoices] = useState(initial.breakoutChoices ?? []);
  const hint = useRef(null);
  const refreshPlacement = useCallback(() => hint.current?.(), []);
  const updateRoles = useCallback(snapshot => {
    const { hostIdentity, hostVersion, coHosts } = snapshot;
    if (typeof hostIdentity !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(hostIdentity) ||
        !Number.isSafeInteger(hostVersion) || hostVersion < 0) return;
    setRoles(previous => hostVersion < previous.hostVersion ? previous : {
      hostIdentity, hostVersion, coHosts: Array.isArray(coHosts) ? coHosts : previous.coHosts,
    });
  }, []);
  const { routingKey, roomId, meeting, placementEpoch = 0 } = session;
  const chooseBreakout = useCallback(async destination => {
    if (!routingKey || ended || waiting) throw new Error('Attendee room selection is unavailable.');
    try {
      await api('/meetings/' + meeting.id + '/placement', {
        method: 'POST', body: { key: routingKey, roomId, placementEpoch, breakoutRoomId: destination || null },
      });
    } finally { refreshPlacement(); }
  }, [api, ended, meeting.id, placementEpoch, refreshPlacement, roomId, routingKey, waiting]);

  useEffect(() => {
    if (!routingKey || ended) return;
    const controller = new AbortController();
    let timer;
    let pending = false;
    let expedite = false;
    function schedule(delay) {
      clearTimeout(timer);
      timer = setTimeout(check, delay);
    }
    async function check() {
      pending = true;
      let keepChecking = true;
      try {
        const next = await api('/meetings/' + meeting.id + '/placement', {
          method: 'POST', body: { key: routingKey, roomId, placementEpoch }, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (next.waiting) {
          setBreakoutChoices([]);
          setWaiting(true);
          return;
        }
        setBreakoutChoices(next.breakoutChoices ?? []);
        updateRoles(next);
        const readmission = next.placementEpoch > placementEpoch;
        if (next.token && (next.roomId !== roomId || readmission)) {
          keepChecking = false;
          setSession(current => ({
            ...current, ...next, media: { camera: false, microphone: false },
            roomNotice: next.breakoutName
              ? 'Moved to ' + next.breakoutName + '. Your microphone and camera are off.'
              : readmission
                ? 'Readmitted to the meeting. Your microphone and camera are off.'
                : 'Returned to the main meeting. Your microphone and camera are off.',
          }));
          setWaiting(false);
        }
      } catch (failure) {
        if (!controller.signal.aborted && [401, 403, 410].includes(failure.status)) {
          keepChecking = false;
          setEnded(true);
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted && keepChecking) schedule(expedite ? 80 : (waiting ? 3000 : 11000) + Math.random() * 2000);
        expedite = false;
      }
    }
    hint.current = () => { if (pending) expedite = true; else schedule(80); };
    schedule(1200);
    return () => {
      hint.current = null;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, roomId, routingKey, meeting.id, placementEpoch, waiting, ended, updateRoles]);

  return { session, ended, waiting, roles, updateRoles, refreshPlacement, breakoutChoices, chooseBreakout };
}
