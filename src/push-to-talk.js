import { useEffect, useRef, useState } from 'react';
import { ConnectionState, RoomEvent, Track, createLocalAudioTrack } from 'livekit-client';

const focusTargets = 'input, select, textarea, button, a, summary, [role="button"], [contenteditable]:not([contenteditable="false"])';

export function usePushToTalk(room, { key, online, deviceId, reduceNoise, onError }) {
  const job = useRef(null);
  const queued = useRef(false);
  const [status, setStatus] = useState('');

  async function cleanup(current) {
    if (current.cleaning) return;
    current.cleaning = true;
    const track = current.track;
    track?.stop();
    if (track) await room.localParticipant.unpublishTrack(track, true).catch(() => {});
    if (job.current === current) {
      job.current = null;
      current.afterCleanup();
    }
  }

  function cancel() {
    const waiting = queued.current;
    queued.current = false;
    const active = job.current;
    if (!active?.held) return waiting;
    active.held = false;
    active.track?.stop();
    setStatus('');
    if (active.started) void cleanup(active);
    return true;
  }

  useEffect(() => {
    if (!online || !['Space', 'Backquote', 'F8'].includes(key)) return;
    const participant = room.localParticipant;
    let disposed = false;
    async function open(active) {
      try {
        const earlier = participant.getTrackPublication(Track.Source.Microphone)?.track;
        if (earlier) await participant.unpublishTrack(earlier, true);
        if (!active.held || disposed) return;
        active.track = await createLocalAudioTrack({ noiseSuppression: reduceNoise,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}) });
        if (!active.held || disposed || room.state !== ConnectionState.Connected) { active.held = false; return; }
        await participant.publishTrack(active.track, { source: Track.Source.Microphone, stopMicTrackOnMute: true });
        if (active.held && !disposed) setStatus('Talking while key is held');
      } catch {
        if (active.held && !disposed) onError('Push-to-talk could not open the microphone.');
        active.held = false;
        if (!disposed) setStatus('');
      } finally {
        active.started = true;
        if (!active.held || disposed) await cleanup(active);
      }
    }
    function usable(target) {
      return !disposed && !document.hidden && document.hasFocus() && !target?.closest?.(focusTargets) &&
        !document.querySelector('dialog[open]') && room.state === ConnectionState.Connected;
    }
    function begin() {
      const active = { held: true, afterCleanup: () => {
        if (!queued.current) return;
        queued.current = false;
        if (!participant.isMicrophoneEnabled && usable(document.activeElement)) begin();
      } };
      job.current = active;
      setStatus('Opening microphone while key is held…');
      void open(active);
    }
    function down(event) {
      if (event.code !== key || event.isComposing || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey ||
          event.shiftKey || !usable(event.target)) return;
      if (job.current?.held || queued.current) { event.preventDefault(); return; }
      if (event.repeat || (!job.current && participant.isMicrophoneEnabled)) return;
      event.preventDefault();
      if (job.current) queued.current = true;
      else begin();
    }
    function up(event) { if (event.code === key && cancel()) event.preventDefault(); }
    function visibility() { if (document.hidden) cancel(); }
    function focus(event) { if (event.target?.closest?.(focusTargets)) cancel(); }
    function muted(publication, owner) {
      if (owner === participant && publication.track === job.current?.track) cancel();
    }
    function connection(state) { if (state !== ConnectionState.Connected) cancel(); }

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', cancel);
    window.addEventListener('pagehide', cancel);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('focusin', focus);
    room.on(RoomEvent.TrackMuted, muted);
    room.on(RoomEvent.ConnectionStateChanged, connection);
    return () => {
      disposed = true;
      cancel();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pagehide', cancel);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('focusin', focus);
      room.off(RoomEvent.TrackMuted, muted);
      room.off(RoomEvent.ConnectionStateChanged, connection);
    };
  }, [room, key, online, deviceId, reduceNoise, onError]);

  return { status, cancel, busy: () => Boolean(job.current) };
}
