export const meetingShortcuts = [
  { id: 'microphone', label: 'Toggle microphone', key: 'M' },
  { id: 'camera', label: 'Toggle camera', key: 'V' },
  { id: 'people', label: 'Open or close participants', key: 'P' },
  { id: 'chat', label: 'Open or close chat', key: 'C' },
  { id: 'hand', label: 'Raise or lower hand', key: 'H' },
  { id: 'layout', label: 'Switch Gallery and Speaker views', key: 'L' },
  { id: 'quality', label: 'Open or close call statistics', key: 'I' },
  { id: 'fullscreen', label: 'Toggle fullscreen', key: 'F' },
];

export const defaultShortcuts = Object.fromEntries(meetingShortcuts.map(({ id, key }) => [id, key]));

export function shortcutFor(event, shortcuts) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.getModifierState('AltGraph')
    || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey
    || !/^Key[A-Z]$/.test(event.code)) return null;
  if (event.target?.closest?.('input, select, textarea, [contenteditable]:not([contenteditable="false"]), dialog[open]')) return null;
  const key = event.code.slice(3);
  return meetingShortcuts.find(action => shortcuts[action.id] === key)?.id ?? null;
}
