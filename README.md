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

The installer is written to `release/Meetrix-InsForge-Setup-0.1.15-x64.exe`. To preconfigure the installer with a project, copy `.env.example` to `.env`, fill the InsForge settings, and run `npm run dist:local`. If your project requires an anon key, use its public anon key. Installer and executable signing are left to the distributor. Builds fetch the pinned caption models once and cache them in `vendor/caption-models`.

## Host a workspace

1. Enable your providers in the InsForge project and allow its redirect to the Meetrix HTTPS origin. The OAuth provider callback goes to InsForge. InsForge then returns the browser to `/api/auth/callback` on the Meetrix origin.
2. Provision LiveKit with TLS and TURN. For self-managed LiveKit, set `room.auto_create: false` and `room.enable_remote_unmute: false`.
3. Set `NODE_ENV=production`, the exact HTTPS `APP_ORIGIN`, `INSFORGE_URL`, the public `INSFORGE_ANON_KEY` when needed, and the three LiveKit values. Keep LiveKit API credentials on the server.
4. Run `npm ci`, `npm run build`, and `npm start` behind a TLS proxy. Use a single process with a backed-up SQLite volume. Set `TRUST_PROXY_HOPS` to match your actual proxy setup.
5. For container hosting, build with `docker build -t meetrix .`, supply the same server settings, and mount persistent storage at `/app/data`. The image listens on port 4317.

Meetrix keys account ownership by the InsForge project and user ID. Earlier Clerk meeting records remain associated with their original identities. Moving those records requires explicit account linking.

### Hosted cloud recording

Deploy LiveKit Egress with access to the WSS server and the workspace HTTPS origin. Allow Egress to fetch the custom `/recording.html` template. Create a private S3 bucket and scope write and download permissions to `meetrix-recordings/*`. Set `MEETRIX_CLOUD_RECORDING=true` and the `MEETRIX_EGRESS_S3_*` values from `.env.example` on the server. Omit query strings for `/recording.html` from proxy and Egress logs because LiveKit sends the recorder token in the URL. [LiveKit Egress deployment](https://docs.livekit.io/transport/self-hosting/egress/)

In a standard, signed-in-only meeting, the host can request cloud recording under **Record**. Each connected attendee must consent. A job covers up to 30 participants for 30 minutes and stops if the approved roster changes. The requesting host can download the private MP4 from **Meetings → Cloud recordings**. Cloud recording requires the hosted service. The bundled local Windows workspace supports local WebM recording.

## Meeting features

- Schedule one-time, daily, weekday, weekly, or monthly meetings. Daily, weekly, and monthly schedules support custom repeat intervals. A series can contain up to 52 occurrences within the next year. Preview the dates before saving, then download a single occurrence or the whole new series as an iCalendar file for Google Calendar, Outlook, or Apple Calendar.
- Audio, video, gallery and speaker views, screen sharing, chat, and reactions.
- Microphone, camera, and speaker selection before joining or from **Devices** during a call. Browser support determines speaker availability.
- **Settings** includes a live microphone meter, a speaker test tone, noise reduction, camera preview and mirroring, and saved defaults for joining a call. Preview and diagnostic media stays on your device.
- Use **Camera background** in Video settings, the pre-join setup, or a meeting’s **Devices** dialog. Choose blur or a JPEG, PNG, or WebP image from your device. The app saves your selection on this device. The bundled model applies the effect locally before Meetrix publishes your camera.
- Appearance, in-app shortcut assignments, chat accessibility, caption size and contrast, and presentation preferences are saved on your device. From a call, **View preferences** can pause incoming cameras while preserving audio and presentations. **Call statistics** displays sampled WebRTC media measurements and exports a local JSON snapshot of the displayed metrics.
- Host moderation, passcodes, room locks, waiting rooms, and participant removal.
- In standard meetings, hosts and co-hosts can move an attendee back to the waiting room from **People** or **Breakouts**. Readmitted attendees return to the main room with their camera and microphone off.
- In standard meetings, open **People** and select **Transfer host** on a connected, signed-in attendee. The meeting continues under the new host, and the original organizer can stay or leave.
- Turn on **Include sound** in the **Share** dialog to send sound with a display. The Windows app captures system audio with an explicitly selected display. A browser’s source picker determines which other sources provide audio.
- Presenters can use **Annotate** to draw freehand, add lines, arrows, rectangles, ellipses and short labels, let attendees draw, and clear the marks. **Save annotated image** saves a PNG of the current shared frame and visible annotations to the presenter’s device. A presentation’s annotations stay in its LiveKit room and end with that share.
- In a standard meeting, hosts can open **People** and make a connected, signed-in attendee a co-host. Co-hosts can manage the waiting room, lock the room, moderate attendees, and manage breakouts. Hosts can revoke co-host access from the same panel. **Mute attendees** mutes active attendee microphones in the main room. Moderators can stop an attendee’s camera or ask an attendee to turn on their microphone. The attendee chooses whether to unmute.
- Hosts can allow invitees without accounts. The waiting room still applies, and the host sees those invitees labeled as unverified guests.
- In standard meetings, hosts and co-hosts can use **Breakouts** to name up to eight rooms, assign connected attendees manually or evenly, and send text announcements. Hosts can set an automatic time limit when opening the rooms or start a 15-, 30-, or 60-second return countdown while the rooms are open. **Close all rooms** returns attendees to the main meeting immediately. Hosts and co-hosts stay in the main room. Automatic moves start with the microphone and camera off.
- Turn on **Let attendees choose their room** when opening breakouts to let attendees join, switch rooms, and return to the main meeting. Room changes start with the camera and microphone off.
- In the main room of a standard meeting, open **Captions** to read live captions, show or hide them over the stage, and save the caption history on this device. Hosts can type captions themselves or assign a connected attendee to type them.
- Hosts can turn on automatic captions in standard meetings. Each speaker who chooses **Caption my microphone** in the Windows x64 app can share English captions. Recognition runs on that device. Other meeting clients can display the text.
- Under **Captions**, attendees can translate automatic English captions into Hindi or Spanish. The first translated line loads the bundled model. The latest lines appear in the selected language, and caption exports include all available translations alongside the originals.
- Hosts can open **Record**, request permission from everyone in the main room, and start once every connected participant agrees. Meetrix records available meeting audio and the shared screen or up to nine camera tiles. The recording stops if the participant list changes or someone withdraws consent. Use **Save WebM** to keep the file. Recordings stay on the host device and are capped at 30 minutes or approximately 180 MiB per file.
- Shared notes, polls, and whiteboards. Encrypted rooms use a shared, client-generated key for LiveKit media and in-room data.

[Feature comparison](replica/parity.md) · [Security model](SECURITY.md)

## Workspace features

- **Team chat** stores each channel’s recent conversation. A channel owner can create a time-limited invite code and remove members. Only signed-in members can read or send messages.
- **Tasks** stores private to-dos with due dates and completion status. **Canvas** stores private documents with a Markdown preview and export.
- **Clips** records a selected screen or window, with optional microphone audio. A clip lasts up to two minutes and can be played or downloaded as WebM from the local device library.
- **Bookings** publishes available meeting slots. An invitee claims a slot and receives a meeting link and calendar invitation. The host admits them from the waiting room. Public links require a reachable hosted workspace.
- **Calendar subscription** publishes upcoming meetings you organize through a private, revocable link in a hosted HTTPS workspace. Add the URL to a calendar app that supports internet subscriptions. The calendar app controls refresh timing. [Google Calendar](https://support.google.com/calendar/answer/37100) · [Outlook](https://support.microsoft.com/en-us/outlook/add-a-calendar-in-outlook-com-or-outlook-on-the-web) · [Apple Calendar](https://support.apple.com/guide/calendar/subscribe-to-calendars-icl1022/mac)
- **AI meeting summary** in **Notes** drafts a summary of up to 2,400 characters of English notes or recent captions using a bundled on-device model. You can review, edit, and download the draft.

## Verification

Run `npm test`, `npm run build`, and `npm audit`. The API tests exercise OAuth state, PKCE, workspace cookies, desktop pairing, and guest access. The Windows smoke test can check a packaged trial with `node test/smoke-browser-sign-in.mjs`. With an InsForge project configured, it checks configured Google and GitHub redirects. Optional `MEETRIX_QA_EMAIL` and `MEETRIX_QA_PASSWORD` enable the complete test using an existing test account. After staging the runtime, use `node test/smoke-rtc.mjs` for two-client LiveKit verification and `node test/smoke-guest-meeting.mjs` for the guest join and device-switching workflows.

Run `node test/smoke-windows-share.mjs` with the unpacked Windows build to check the display picker and audio track creation. This test samples track state locally and closes the capture immediately.

Run `node test/smoke-windows-speech.mjs` against the unpacked app to check the offline recognizer with a pinned voice sample. Run `node test/smoke-cloud-recording-template.mjs` to verify approved media subscription and roster-change shutdown with bundled LiveKit. Testing storage authorization uses a fixture. Production verification requires a configured Egress worker and bucket.

Run `node test/smoke-caption-translation.mjs` after building to check that both translation models work with external network requests disabled. Add `--desktop` to check the unpacked app.

## License

[MIT](LICENSE). Upstream dependencies retain their respective licenses.
