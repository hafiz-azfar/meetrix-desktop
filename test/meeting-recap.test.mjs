import assert from 'node:assert/strict';
import test from 'node:test';
import { recapChunks } from '../src/meeting-recap.js';

test('recap sections keep every caption in order beyond the visible history', () => {
  const started = Date.parse('2026-11-24T05:00:00Z');
  const entries = Array.from({ length: 1200 }, (_, index) => ({
    at: started + index * 1000, line: 'Decision ' + index + ': confirm the release timeline.', speaker: 'Organizer',
  }));
  const chunks = recapChunks(entries);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.text.length <= 1800));
  assert.equal(chunks[0].first, started);
  assert.equal(chunks.at(-1).last, entries.at(-1).at);
  assert.deepEqual(chunks.flatMap(chunk => chunk.text.split('\n')),
    entries.map(entry => entry.speaker + ': ' + entry.line));
  assert.deepEqual(recapChunks([]), []);
});
