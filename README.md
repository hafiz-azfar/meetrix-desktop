# Meetrix

Meetrix is a Windows and web app for scheduled and instant video meetings. This trial uses InsForge for accounts, Electron and React for the client, and LiveKit for calls. The Node server owns admission, meeting history, and LiveKit credentials.

## Run on Windows

The InsForge trial installs alongside the earlier Meetrix app. For an unconfigured installer, enter your InsForge project URL under **Local workspace** on first launch. Supply its public `ANON_KEY` when required by the project's configuration. The hosted workspace option accepts the HTTPS address of a Meetrix server running this branch.

Select **Continue in your browser** and choose an enabled provider such as Google or GitHub. Enter the code displayed in Meetrix to approve the desktop session. The app discovers provider buttons from your project's public InsForge settings. Its sign-in screen is built into Meetrix.

Local calls use the bundled loopback LiveKit runtime. For meetings across devices, connect to a hosted Meetrix workspace.

### Build locally

Install Node.js 22.15+ and npm, then run:

```powershell
npm ci
npm run dist
```

The installer is written to `release/Meetrix-InsForge-Setup-0.1.23-x64.exe`. To preconfigure the installer with a project, copy `.env.example` to `.env`, fill the InsForge settings, and run `npm run dist:local`. If your project requires an anon key, use its public anon key. Installer and executable signing are left to the distributor. Builds fetch the pinned caption models once and cache them in `vendor/caption-models`.

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

### Google Calendar for hosted workspaces

Enable the Google Calendar API and register a Google web OAuth client. Use the exact hosted HTTPS callback `/api/google-calendar/callback`. Set the three `MEETRIX_GOOGLE_CALENDAR_*` variables in `.env.example` on the server. The encryption key must be 32 random bytes encoded as base64url. Keep these values and callback query strings out of logs and client bundles. The workspace requests access to events on calendars the user owns. [Google OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server) · [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)

Connect in a browser from **Meetings → Google Calendar**, then open an unopened meeting’s management menu. Publish and push selected meetings to the connected account’s primary calendar, or pull a changed title and time into Meetrix. Meetrix checks Google’s event version before writing.

### Outlook Calendar and Mail for hosted workspaces

Register a confidential web application in Microsoft Entra and register the exact hosted HTTPS redirect URI ending in `/api/outlook/callback`. Set `MEETRIX_OUTLOOK_CLIENT_ID`, `MEETRIX_OUTLOOK_CLIENT_SECRET`, and `MEETRIX_OUTLOOK_KEY` from `.env.example`. The key must be 32 random bytes encoded as base64url. Set `MEETRIX_OUTLOOK_TENANT` to your tenant ID for an organization-only installation. Keep the secret, encryption key, and callback query strings out of logs and desktop builds. [Microsoft OAuth and delegated permissions](https://learn.microsoft.com/en-us/graph/auth-v2-user?tabs=http)

Connect Outlook Calendar in **Meetings**. Each linked event supports manual push and pull. After publishing or resolving a difference between the two copies, enable **Automatically sync this meeting** on either the Google Calendar or Outlook Calendar card. The server checks linked events about every three minutes. When both copies have changed, Meetrix pauses sync until the organizer chooses which copy to keep. Choose one automatic provider per meeting.

Connect **Mail** separately to read recent Inbox and Sent messages and compose plain-text mail. Sending requires confirmation and reports when Outlook accepts the request. Use **Settings → Accounts** to disconnect Mail or Calendar independently. [Microsoft Graph send mail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)

## Meeting features

- Schedule one-time, daily, weekday, weekly, or monthly meetings. Choose specific weekdays for weekly schedules and a fixed date, ordinal weekday, or last matching weekday for monthly schedules. End a series after a count or on a date. A series can contain up to 52 occurrences within the next year. Preview the dates before saving, then download a single occurrence or the whole new series as an iCalendar file for Google Calendar, Outlook, or Apple Calendar.
- Open an occurrence’s management menu and select **Manage series** to edit dates, names, or durations or cancel upcoming unopened occurrences. Apply changes from the selected occurrence onward or across all upcoming occurrences. Meetrix keeps each occurrence’s invite link and increments its calendar version. Series management applies to series created in 0.1.19 or later. Calendar exports and subscriptions reflect changes. Event cancellations in connected Google or Outlook calendars are handled in the provider.
- Audio, video, gallery and speaker views, screen sharing, chat, and reactions.
- Microphone, camera, and speaker selection before joining or from **Devices** during a call. Browser support determines speaker availability.
- **Settings** includes a live microphone meter, a speaker test tone, noise reduction, camera preview and mirroring, and saved defaults for joining a call. Preview and diagnostic media stays on your device.
- Under **Settings → Audio → Microphone playback**, record up to five seconds and play it back through the selected speaker. The microphone releases when recording ends and the sample is cleared when you leave Audio settings.
- Use **Camera background** in Video settings, the pre-join setup, or a meeting’s **Devices** dialog. Choose blur or a JPEG, PNG, or WebP image from your device. The app saves your selection on this device. The bundled model applies the effect locally before Meetrix publishes your camera.
- Use **Push-to-talk key** under **Keyboard shortcuts** to temporarily open a muted microphone with Space, Backtick, or F8 while the meeting window is focused.
- On Windows, use the notification-area and reminder options in **Settings → Appearance**. While Meetrix is running, reminders appear within five minutes of a scheduled start and omit meeting details. Double-click the Meetrix icon in the notification area to restore the window.
- In **Settings → Appearance**, choose Violet, Teal, Blue, or Berry with the light, dark, or system theme. Meetrix saves the selection on your device, along with in-app shortcuts, chat accessibility, caption appearance, and presentation preferences. From a call, **View preferences** can pause incoming cameras while preserving audio and presentations. **Call statistics** displays sampled WebRTC media measurements and exports a local JSON snapshot of the displayed metrics.
- Host moderation, passcodes, room locks, waiting rooms, and participant removal.
- In standard meetings, hosts and co-hosts can move an attendee back to the waiting room from **People** or **Breakouts**. Readmitted attendees return to the main room with their camera and microphone off.
- In the main room of a standard meeting, open **People** and select **Transfer host** on a connected, signed-in attendee. To transfer and exit in one step, select a new host in the **Leave** dialog and click **Assign host and leave**.
- If a host leaves or loses their connection, a connected co-host can take over after Meetrix observes the host absent for at least 30 seconds. Co-hosts visiting breakouts are eligible. If no eligible co-host is connected, the meeting waits for the current host to return. The meeting stays with the successor after a successful transfer. The workspace and LiveKit must stay online throughout. Exiting a Windows app that runs the workspace locally also shuts down its local services.
- Turn on **Include sound** in the **Share** dialog to send sound with a display, or choose **Share audio only** to send only the selected source’s audio. The Windows app captures system audio with an explicitly selected display. A browser’s source picker determines which other sources provide audio.
- Presenters can use **Annotate** to draw freehand, add lines, arrows, rectangles, ellipses and short labels, and let attendees draw. Presenters can undo or redo marks for everyone in the room or clear the canvas. **Save annotated image** saves a PNG of the current shared frame and visible annotations to the presenter’s device. A presentation’s annotations stay in its LiveKit room and end with that share.
- In a standard meeting, hosts can open **People** and make a connected, signed-in attendee a co-host. Co-hosts can manage the waiting room, lock the room, moderate attendees, and manage breakouts. Hosts can revoke co-host access from the same panel. **Mute attendees** applies to the moderator’s current room. Moderators can stop an attendee’s camera or ask someone in the main room to turn on their microphone. The attendee chooses whether to unmute.
- Hosts can allow invitees without accounts. The waiting room still applies, and the host sees those invitees labeled as unverified guests.
- In standard meetings, hosts and co-hosts can use **Breakouts** to name up to eight rooms, assign connected attendees manually or evenly, and send text announcements. They can set an automatic time limit, start a 15-, 30-, or 60-second return countdown, or use **Close all rooms** to reunite the meeting immediately.
- While breakouts are open, hosts and co-hosts can select **Visit** or reassign attendees to another room. Use **Return to main meeting** to leave a visit. The host can revoke a visiting co-host’s access from **Breakouts**, which also returns that person to the main meeting. Room moves start with the microphone and camera off.
- Turn on **Let attendees choose their room** when opening breakouts to let attendees join, switch rooms, and return to the main meeting. Room changes start with the camera and microphone off.
- From an unopened standard meeting’s management menu, select **Prepare breakout rooms** to save room names, a time limit, and room-choice settings. Add verified sign-in email addresses under **Pre-assign participants**. When a host or co-host selects **Open with scheduled assignments**, matching signed-in attendees move once per breakout run, after ordinary meeting admission. Late arrivals can be matched as they join. Accounts with a session from before upgrading can sign in again to enable matching.
- From the main room, hosts and co-hosts can select one occupied breakout room or all occupied rooms and start a live voice announcement for up to 30 seconds. The announcement has its own microphone capture and preserves the main-room microphone setting. Participants can use **Ask for help** from inside a breakout. The host receives the notice in their current room, and moderators can resolve the request from the room’s entry in **Breakouts**.
- In the main room of a standard meeting, open **Captions** to read live captions, show or hide them over the stage, and save the caption history on this device. Hosts can type captions themselves or assign a connected attendee to type them.
- Hosts can turn on automatic captions in standard meetings. Each speaker who chooses **Caption my microphone** in the Windows x64 app can share English captions. Recognition runs on that device. Other meeting clients can display the text.
- Under **Captions**, attendees can translate automatic English captions into Hindi or Spanish. The first translated line loads the bundled model. The latest lines appear in the selected language, and caption exports include all available translations alongside the originals.
- Hosts can open **Record**, request permission from everyone in the main room, and start once every connected participant agrees. Meetrix records available meeting audio and the shared screen or up to nine camera tiles. The recording stops if the participant list changes or someone withdraws consent. Use **Save WebM** to keep the file. Recordings stay on the host device and are capped at 30 minutes or approximately 180 MiB per file.
- Shared notes, polls, and whiteboards. Encrypted rooms use a shared, client-generated key for LiveKit media and in-room data.

[Feature comparison](replica/parity.md) · [Security model](SECURITY.md)

## Workspace features

- **Team chat** supports threaded replies and private downloads for channel members. Attach a PDF, PNG, JPEG, or UTF-8 TXT, MD, or CSV file up to 1 MiB to a message or reply. The sender or channel owner can remove the file while keeping the conversation. A channel owner can also create a time-limited invite and revoke a member’s access.
- **Tasks** stores private to-dos with due dates and completion status. **Canvas** stores private documents with a Markdown preview and export.
- **Clips** records a selected screen or window, with optional microphone audio. A clip lasts up to two minutes and can be played or downloaded as WebM from the local device library.
- **Bookings** publishes available meeting slots. An invitee claims a slot and receives a meeting link and calendar invitation. The host admits them from the waiting room. Public links require a reachable hosted workspace.
- **Calendar subscription** publishes upcoming meetings you organize through a private, revocable link in a hosted HTTPS workspace. Add the URL to a calendar app that supports internet subscriptions. The calendar app controls refresh timing. [Google Calendar](https://support.google.com/calendar/answer/37100) · [Outlook](https://support.microsoft.com/en-us/outlook/add-a-calendar-in-outlook-com-or-outlook-on-the-web) · [Apple Calendar](https://support.apple.com/guide/calendar/subscribe-to-calendars-icl1022/mac)
- From **Captions**, choose **Start collecting captions** to build a private recap from the shared captions received while you attend. Meetrix drafts it on this device when you leave, or when you select **Draft recap now**. You can review the draft and export it with a separate copy of the source captions.
- **AI meeting summary** in **Notes** drafts a summary of up to 2,400 characters of English notes or recent captions using a bundled on-device model. You can review, edit, and download the draft.

## Verification

Run `npm test`, `npm run build`, and `npm audit`. The API tests exercise OAuth state, PKCE, workspace cookies, desktop pairing, and guest access. The Windows smoke test can check a packaged trial with `node test/smoke-browser-sign-in.mjs`. With an InsForge project configured, it checks configured Google and GitHub redirects. Optional `MEETRIX_QA_EMAIL` and `MEETRIX_QA_PASSWORD` enable the complete test using an existing test account. After staging the runtime, use `node test/smoke-rtc.mjs` for two-client LiveKit verification and `node test/smoke-guest-meeting.mjs` for the guest join and device-switching workflows.

Run `node test/smoke-windows-share.mjs` with the unpacked Windows build to check the display picker and audio track creation. This test samples track state locally and closes the capture immediately.

Run `node test/smoke-windows-speech.mjs` against the unpacked app to check the offline recognizer with a pinned voice sample. Run `node test/smoke-cloud-recording-template.mjs` to verify approved media subscription and roster-change shutdown with bundled LiveKit. Testing storage authorization uses a fixture. Production verification requires a configured Egress worker and bucket.

Run `node test/smoke-caption-translation.mjs` after building to check that both translation models work with external network requests disabled. Add `--desktop` to check the unpacked app.

Run `node test/smoke-outlook.mjs` after building to check the browser flows with simulated Microsoft responses. Run `node test/smoke-windows-system.mjs` against the unpacked build for tray and reminder checks.

## License

[MIT](LICENSE). Upstream dependencies retain their respective licenses.
