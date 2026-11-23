import { useCallback, useEffect, useRef, useState } from 'react';

export const placementTopic = 'meetrix.room-placement';

export function useRoomPlacement(api, initial) {
  const [session, setSession] = useState(() => ({ ...initial, roomId: initial.roomId ?? initial.meeting.id }));
  const [coHosts, setCoHosts] = useState(initial.coHosts ?? []);
  const [ended, setEnded] = useState(false);
  const hint = useRef(null);
  const refreshPlacement = useCallback(() => hint.current?.(), []);
  const { routingKey, roomId, meeting } = session;

  useEffect(() => {
    if (!routingKey || ended) return;
    const controller = new AbortController();
    let timer;
    let pending = false;
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
        if (!controller.signal.aborted && next.coHosts) setCoHosts(next.coHosts);
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
        if (!controller.signal.aborted && keepChecking) schedule(11000 + Math.random() * 2000);
      }
    }
    hint.current = () => { if (!pending) schedule(80); };
    schedule(1200);
    return () => {
      hint.current = null;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, roomId, routingKey, meeting.id, ended]);

  return { session, ended, coHosts, refreshPlacement };
}
