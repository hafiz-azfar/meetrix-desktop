# Meetrix 0.1.5 feature comparison

| Area | Meetrix coverage | Remaining scope |
|---|---|---|
| Meetings | Instant meetings, one-time or weekly scheduling, host-approved guests with or without accounts, camera preview, device selection, gallery/speaker mode, and screen/window sharing | Calendar sync and richer recurrence rules, extra display modes, and dial-in |
| Desktop preferences | Light, dark and system themes, chat text size and announcements, reduced motion, and remappable in-app meeting shortcuts | Theme accents, tray behavior, background notifications, and accessibility controls for captions |
| Media preferences | Microphone meter, test tone and volume, noise reduction, mirrored camera preview, and screen-share frame rate and content options | Microphone replay, virtual backgrounds, audio profiles, native driver and hardware options, and computer audio capture |
| In-call display and diagnostics | Fullscreen, elapsed-time display, participant filters, local camera pause, presentation layout, and per-track WebRTC samples | Dual-window layouts, richer network diagnostics, configurable push-to-talk, and a diagnostic export |
| Collaboration | In-room chat, raised hands, reactions, polls, whiteboard, and shared notes | Persistent team chat, breakout rooms, and attachments |
| Host controls | Lobby, passcode, lock, admit/decline, mute, remove, and end | Co-host roles, organization-wide policy, and independent security evaluation |
| Pro meeting features | 30-hour room cap, 100-participant configuration, and optional end-to-end encryption | Capacity/load verification, cloud recording and storage, AI notes, translated captions, and transcription |
| Workplace suite | Desktop and web meeting workspaces | Mail, calendar sync, Canvas, Clips, Tasks, and booking pages |

**Reference coverage.** The earlier research recorded the home, join, and scheduling screens. This pass uses Zoom's public guidance for Windows settings, video pause, and meeting diagnostics. [Windows settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060612) · [Video pause](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065906) · [Meeting statistics](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0070504) · [Zoom Workplace Pro](https://www.zoom.com/en/products/collaboration-tools/zoom-workplace-pro/)

**Verification scope.** API tests cover guest permissions, passcodes, host approval, short-lived grants, and encrypted room rules. A two-client test used a real LiveKit server to exercise accountless join, admission, video delivery, camera switching, and ending the call. The audio and video devices were synthetic. See [the test plan](test-plan.md) for commands and scope.

**Release status.** Replica scored the 23 selected comparison rows at 73.5 out of 100, with seven of eight core rows complete. Scheduling includes a downloadable calendar file and shareable link. Automatic invite email and calendar synchronization remain open. Workplace-wide coverage, production capacity, and operating controls need additional implementation and verification.
