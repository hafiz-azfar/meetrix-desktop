import { useCallback, useEffect, useRef, useState } from 'react';

export const placementTopic = 'meetrix.room-placement';
export const hostRolesTopic = 'meetrix.host-roles';

export function useRoomPlacement(api, initial) {
  const [session, setSession] = useState(() => ({ ...initial, roomId: initial.roomId ?? initial.meeting.id }));
  const [roles, setRoles] = useState(() => ({
    hostIdentity: initial.hostIdentity, hostVersion: initial.hostVersion ?? 0, coHosts: initial.coHosts ?? [],
  }));
  const [ended, setEnded] = useState(false);
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
  const { routingKey, roomId, meeting } = session;

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
          method: 'POST', body: { key: routingKey, roomId }, signal: controller.signal,
        });
        if (!controller.signal.aborted) updateRoles(next);
        if (!controller.signal.aborted && next.token && next.roomId !== roomId) {
          keepChecking = false;
          setSession(current => ({
            ...current, ...next, media: { camera: false, microphone: false },
            roomNotice: next.breakoutName
              ? 'Moved to ' + next.breakoutName + '. Your microphone and camera are off.'
              : 'Returned to the main meeting. Your microphone and camera are off.',
          }));
        }
      } catch (failure) {
        if (!controller.signal.aborted && [401, 403, 410].includes(failure.status)) {
          keepChecking = false;
          setEnded(true);
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted && keepChecking) schedule(expedite ? 80 : 11000 + Math.random() * 2000);
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
  }, [api, roomId, routingKey, meeting.id, ended, updateRoles]);

  return { session, ended, roles, updateRoles, refreshPlacement };
}
