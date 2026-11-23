import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captionLength, isCaptionHost, matchesCaptioner, readCaptionerPacket, readPublishedCaption,
} from '../src/caption-protocol.js';

const encoder = new TextEncoder();
const payload = value => encoder.encode(JSON.stringify(value));
const id = '550e8400-e29b-41d4-a716-446655440000';

test('caption grants and submissions are scoped to participant sessions and the current host term', () => {
  const grant = { kind: 'access', hostVersion: 2, sid: 'PA_delegate', allowed: true };
  assert.deepEqual(readCaptionerPacket(payload(grant), 2), grant);
  assert.equal(readCaptionerPacket(payload(grant), 3), null);
  assert.equal(readCaptionerPacket(payload({ ...grant, sid: 'local' }), 2), null);
  assert.equal(isCaptionHost('host', { identity: 'host', sid: 'PA_host' }), true);
  assert.equal(isCaptionHost('host', { identity: 'delegate', sid: 'PA_delegate' }), false);
  const selection = { identity: 'delegate', sid: 'PA_delegate' };
  assert.equal(matchesCaptioner(selection, { ...selection }), true);
  assert.equal(matchesCaptioner(selection, { ...selection, sid: 'PA_rejoined' }), false);
  assert.equal(matchesCaptioner(selection, { ...selection, identity: 'other' }), false);
});

test('caption packet parsing rejects oversized or invalid text and trims valid captions', () => {
  const submission = { kind: 'submission', hostVersion: 2, sid: 'PA_delegate', id, line: '  Meeting starts now.  ' };
  assert.equal(readCaptionerPacket(payload(submission), 2).line, 'Meeting starts now.');
  assert.equal(readCaptionerPacket(payload({ ...submission, line: 'x'.repeat(captionLength + 1) }), 2), null);
  assert.equal(readCaptionerPacket(payload({ ...submission, id: 'spoof' }), 2), null);
  assert.equal(readCaptionerPacket(payload({ ...submission, line: 'bad\nline' }), 2), null);
  assert.equal(readCaptionerPacket(new Uint8Array(2049), 2), null);
  assert.equal(readPublishedCaption(new Uint8Array([0xff])), null);
  assert.equal(readPublishedCaption(encoder.encode('  Valid text  ')), 'Valid text');
});
