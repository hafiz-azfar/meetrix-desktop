# Meetrix 0.1 feature comparison

| Area | Meetrix coverage | Remaining scope |
|---|---|---|
| Meetings | Instant meetings, one-time or weekly scheduling, signed-in guests, audio, camera, gallery/speaker mode, and screen/window sharing | Calendar sync and richer recurrence rules, extra display modes, and dial-in |
| Collaboration | In-room chat, raised hands, reactions, polls, whiteboard, and shared notes | Persistent team chat, breakout rooms, and attachments |
| Host controls | Lobby, passcode, lock, admit/decline, mute, remove, and end | Co-host roles, organization-wide policy, and independent security evaluation |
| Pro meeting features | 30-hour room cap, 100-participant configuration, and optional end-to-end encryption | Capacity/load verification, cloud recording and storage, AI notes, translated captions, and transcription |
| Workplace suite | Desktop and web meeting workspaces | Mail, calendar sync, Canvas, Clips, Tasks, and booking pages |

**Reference coverage.** The installed Windows client provided three local screen captures. Paid-plan comparison came from Zoom's public product plan. Visual layout follows Meetrix's own design. [Zoom Workplace plans](https://www.zoom.com/en/products/virtual-meetings/)

**Verification scope.** Automated API tests cover admission, host permissions, passcodes, short room grants, encrypted room rules, and note revisions. The Windows RTC test runs two clients against a real LiveKit server. It uses synthetic camera and microphone devices. See [the test plan](test-plan.md) for commands and scope.

**Release status.** Meetrix 0.1 is an open-source early release. Replica scored the 22 selected comparison rows at 72.4 out of 100, with seven of eight core rows complete. The scheduling row received partial credit because guests receive a downloadable calendar file and shared link. Automatic email delivery and calendar synchronization remain open. Workplace-wide parity, production capacity, and operating controls are future scope.
