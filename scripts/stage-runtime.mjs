import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { insforgeSettings } from '../server/auth.mjs';
import { readMeetingPolicy } from '../server/meeting-policy.mjs';
import { stageSpeechRuntime } from './stage-speech.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The bundled LiveKit runtime targets Windows x64.');
const runtime = resolve('vendor/runtime');
const archive = resolve('vendor/livekit-windows.zip');
const version = '1.13.11';
const sha256 = '5d071ea43339f0140d24a66f0b2ff8a7bf6c4d0dceb19b30abca835670213667';
await mkdir(runtime, { recursive: true });
if (!existsSync(archive)) {
  const url = 'https://github.com/livekit/livekit/releases/download/v' + version + '/livekit_' + version + '_windows_amd64.zip';
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('LiveKit runtime download failed.');
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
}
const bytes = await readFile(archive);
if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('LiveKit runtime download failed SHA-256 verification.');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:MEETRIX_ZIP -DestinationPath $env:MEETRIX_RUNTIME -Force'], {
  env: { ...process.env, MEETRIX_ZIP: archive, MEETRIX_RUNTIME: runtime }, stdio: 'inherit', windowsHide: true,
});
await stageSpeechRuntime(runtime);
const settings = process.argv.includes('--local-insforge') ? insforgeSettings(process.env.INSFORGE_URL, process.env.INSFORGE_ANON_KEY) : {};
const meetingPolicy = readMeetingPolicy(process.env);
if (Object.values(meetingPolicy).some(Boolean)) settings.meetingPolicy = meetingPolicy;
await writeFile(resolve(runtime, 'local-instance.json'), JSON.stringify(settings));
