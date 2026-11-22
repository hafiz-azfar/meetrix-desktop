# Meetrix

Meetrix is a Windows and web app for scheduled and instant video meetings. It uses Electron and React for the client, Clerk for accounts, and LiveKit for calls. The Node server owns admission, meeting history, and LiveKit credentials.

## Run on Windows

The Windows installer opens Meetrix as an Electron app. A local build can bundle a loopback-only LiveKit server and the publishable key for a Clerk development instance. Sign in with an account in that instance. To meet with people on other devices, choose **Meetrix → Connect to a server** and enter the HTTPS address of a hosted Meetrix workspace. A hosted workspace also works in a web browser.

### Build locally

Install Node.js 22.15+ and npm, then run:

```powershell
npm ci
Copy-Item .env.example .env
# Set CLERK_PUBLISHABLE_KEY to your Clerk development instance's publishable key.
# Clear the three LIVEKIT_* values for the bundled Windows runtime.
npm run dist:local
```

The installer is written to `release/Meetrix-Setup-0.1.0-x64.exe`. The local Windows runtime extracts a checksum-verified upstream LiveKit release and generates fresh media-server credentials at startup. Clerk sign-in still needs internet access. Local invite URLs are usable on the same PC.

Run `npm run dist` for a distributable installer that starts at the workspace connection screen. It omits the locally configured Clerk publishable key. Installer and executable code signing are left to the distributor.

## Host a workspace

1. Create a Clerk production instance for the app domain. Enable email sign-in and account verification for the desktop client. The embedded Electron window permits navigation within its configured app origin.
2. Provision LiveKit Cloud or a self-managed LiveKit instance with TLS and room administration. For self-managed LiveKit use `room.auto_create: false` and `room.enable_remote_unmute: false`. Configure WebRTC connectivity and TURN for the networks your users will join from.
3. Copy `.env.example` to `.env`. Set `NODE_ENV=production`, the exact public HTTPS `APP_ORIGIN`, the Clerk production publishable key, and the three LiveKit values. Keep LiveKit API credentials only on the application server.
4. Run `npm ci`, `npm run build`, and `npm start`. Put the HTTP listener behind your TLS proxy. Set `TRUST_PROXY_HOPS` only when the listener accepts traffic exclusively through the expected proxy chain. Route all Meetrix instances to a single application process with a persistent, backed-up SQLite volume.
5. For container hosting, build with `docker build -t meetrix .` and mount persistent storage at `/app/data`. Supply the same server settings at runtime. The image listens on port 4317.

Clerk verification uses its public signing keys. A Clerk secret key is unnecessary for this authentication flow. Use LiveKit Cloud if you require provider-side revocation of previously issued room tokens. Meetrix denies new grants after removal and uses 50-second initial room tokens. [Clerk JWT verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification) · [LiveKit token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/)

## Meeting features

- Create a room, schedule a one-time or weekly series, reschedule an occurrence, or download an iCalendar invitation. Join by invite link or meeting code.
- Test devices before joining. Switch between gallery and speaker layouts, share a display or window, chat in the room, react, and raise a hand.
- Hosts can require a passcode and waiting room, admit or decline requests, lock the room, mute or remove participants, and end the meeting.
- Standard rooms have shared notes with revision checks and Markdown export, host-run polls, and a shared whiteboard with PNG export. Optional encrypted rooms protect LiveKit media and in-room data with a manually shared client-generated key. Save the key separately if you plan to reopen the room with the same group. Encrypted meetings disable server-stored notes, polls, and whiteboards. [LiveKit encryption](https://docs.livekit.io/transport/encryption/)
- Rooms are configured for up to 100 concurrent participants and close after 30 hours. Deployment capacity depends on your LiveKit infrastructure and network.

For current coverage and remaining work, see [the feature comparison](replica/parity.md) and [the security model](SECURITY.md).

## Verification

```powershell
npm test
npm run build
npm audit --omit=dev
npm run stage:runtime
node test/smoke-rtc.mjs
```

The Windows RTC smoke test uses Chrome or the Playwright Chromium build when CI is set. It uses disposable simulated identities and media devices while exercising a real LiveKit server. The desktop smoke test launches the unpacked build and checks the Clerk sign-in form. To test a full account flow against a development instance, run `node test/smoke-desktop.mjs --clerk-account`. This adds a clearly named test user to your development instance. Set `MEETRIX_QA_EMAIL` to an existing Clerk test email ending in `+clerk_test@example.com` to exercise email-code sign-in instead.

## License

[MIT](LICENSE). Upstream LiveKit and Chromium components retain their respective licenses.
