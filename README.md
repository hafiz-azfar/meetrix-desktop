# Meetrix

Meetrix is a Windows and web app for scheduled and instant video meetings. This trial uses InsForge for accounts, Electron and React for the client, and LiveKit for calls. The Node server owns admission, meeting history, and LiveKit credentials.

## Run on Windows

The InsForge trial installs alongside the earlier Meetrix app. At first launch, enter your InsForge project URL under **Local workspace**. Supply its public `ANON_KEY` when required by the project's configuration. The hosted workspace option accepts the HTTPS address of a Meetrix server running this branch.

Select **Continue in your browser** and choose an enabled provider such as Google or GitHub. Enter the code displayed in Meetrix to approve the desktop session. The app discovers provider buttons from your project's public InsForge settings. Its sign-in screen is built into Meetrix.

Local calls use the bundled loopback LiveKit runtime. For meetings across devices, connect to a hosted Meetrix workspace.

### Build locally

Install Node.js 22.15+ and npm, then run:

```powershell
npm ci
npm run dist
```

The installer is written to `release/Meetrix-InsForge-Setup-0.1.4-x64.exe`. To preconfigure the installer with a project, copy `.env.example` to `.env`, fill the InsForge settings, and run `npm run dist:local`. If your project requires an anon key, use its public anon key. Installer and executable signing are left to the distributor.

## Host a workspace

1. Enable your providers in the InsForge project and allow its redirect to the Meetrix HTTPS origin. The OAuth provider callback goes to InsForge. InsForge then returns the browser to `/api/auth/callback` on the Meetrix origin.
2. Provision LiveKit with TLS and TURN. For self-managed LiveKit, set `room.auto_create: false` and `room.enable_remote_unmute: false`.
3. Set `NODE_ENV=production`, the exact HTTPS `APP_ORIGIN`, `INSFORGE_URL`, the public `INSFORGE_ANON_KEY` when needed, and the three LiveKit values. Keep LiveKit API credentials on the server.
4. Run `npm ci`, `npm run build`, and `npm start` behind a TLS proxy. Use a single process with a backed-up SQLite volume. Set `TRUST_PROXY_HOPS` to match your actual proxy setup.
5. For container hosting, build with `docker build -t meetrix .`, supply the same server settings, and mount persistent storage at `/app/data`. The image listens on port 4317.

Meetrix keys account ownership by the InsForge project and user ID. Earlier Clerk meeting records remain associated with their original identities. Moving those records requires explicit account linking.

## Meeting features

- Instant and recurring meetings, links and meeting codes, plus iCalendar invitations.
- Audio, video, gallery and speaker views, screen sharing, chat, and reactions.
- Microphone, camera, and speaker selection before joining or from **Devices** during a call. Browser support determines speaker availability.
- **Settings** includes a live microphone meter, a speaker test tone, noise reduction, camera preview and mirroring, and saved defaults for joining a call. Preview and diagnostic media stays on your device.
- Host moderation, passcodes, room locks, waiting rooms, and participant removal.
- Hosts can allow invitees without accounts. The waiting room still applies, and the host sees those invitees labeled as unverified guests.
- Shared notes, polls, and whiteboards. Encrypted rooms use a shared, client-generated key for LiveKit media and in-room data.

[Feature comparison](replica/parity.md) · [Security model](SECURITY.md)

## Verification

Run `npm test`, `npm run build`, and `npm audit`. The API tests exercise OAuth state, PKCE, workspace cookies, desktop pairing, and guest access. The Windows smoke test can check a packaged trial with `node test/smoke-browser-sign-in.mjs`. With an InsForge project configured, it checks configured Google and GitHub redirects. Optional `MEETRIX_QA_EMAIL` and `MEETRIX_QA_PASSWORD` enable the complete test using an existing test account. After staging the runtime, use `node test/smoke-rtc.mjs` for two-client LiveKit verification and `node test/smoke-guest-meeting.mjs` for the guest join and device-switching workflows.

## License

[MIT](LICENSE). Upstream dependencies retain their respective licenses.
