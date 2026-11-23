# Meetrix 0.1.6 feature comparison

| Area | Meetrix coverage | Remaining scope |
|---|---|---|
| Meetings | Instant meetings, one-time or weekly scheduling, host-approved guests with or without accounts, camera preview, device selection, gallery/speaker mode, and screen/window sharing | Calendar sync and richer recurrence rules, extra display modes, and dial-in |
| Desktop preferences | Light, dark and system themes, chat text size and announcements, reduced motion, and remappable in-app meeting shortcuts | Theme accents, tray behavior, background notifications, and accessibility controls for captions |
| Media preferences | Microphone meter, test tone and volume, noise reduction, mirrored camera preview, and screen-share frame rate and content options | Microphone replay, virtual backgrounds, audio profiles, native driver and hardware options, and computer audio capture |
| In-call display and diagnostics | Fullscreen, elapsed-time display, participant filters, local camera pause, presentation layout, and per-track WebRTC samples | Dual-window layouts, richer network diagnostics, configurable push-to-talk, and a diagnostic export |
| Collaboration | In-room chat, raised hands, reactions, polls, whiteboard, shared notes, and host-managed breakout rooms | Persistent team chat and attachments. Breakouts still lack pre-assignment, self-selection, co-host management, countdowns, and voice broadcasts |
| Host controls | Lobby, passcode, lock, admit/decline, mute, remove, and end | Co-host roles, organization-wide policy, and independent security evaluation |
| Pro meeting features | 30-hour room cap, 100-participant configuration, and optional end-to-end encryption | Capacity/load verification, cloud recording and storage, AI notes, translated captions, and transcription |
| Workplace suite | Desktop and web meeting workspaces | Mail, calendar sync, Canvas, Clips, Tasks, and booking pages |

**Reference coverage.** The earlier research recorded the home, join, and scheduling screens. This pass uses Zoom's public breakout-room guidance. [Managing breakout rooms](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062540) · [Windows settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060612) · [Zoom Workplace Pro](https://www.zoom.com/en/products/collaboration-tools/zoom-workplace-pro/)

**Verification scope.** API tests cover admission, breakout grants, removal, and room cleanup. Four browser clients used the bundled LiveKit server to test room assignment, chat isolation, text announcements, and return to the main meeting. Audio and video devices were synthetic. See [the test plan](test-plan.md) for commands and scope.

**Release status.** Replica scored the 23 selected comparison rows at 73.5 out of 100, with seven of eight core rows complete. Scheduling includes a downloadable calendar file and shareable link. Automatic invite email and calendar synchronization remain open. Workplace-wide coverage, production capacity, and operating controls need additional implementation and verification.
