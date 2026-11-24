# Verification plan

| Case | Expected behavior | Verification path |
|---|---|---|
| F01-H1 | Windows opens the InsForge project chooser and rejects insecure origins | `node test/smoke-desktop.mjs` |
| F01-H2 | Enabled providers redirect through InsForge, and a browser can approve the desktop app | `node test/smoke-browser-sign-in.mjs` with an authorized InsForge project |
| F01-H3 | InsForge OAuth state and PKCE must match before a workspace cookie is issued | API test with simulated upstream responses |
| F01-N1 | Pairing rejects changed proofs and expired codes, limits guesses, and revokes the desktop cookie on sign-out | API tests |
| F02-H1 | Host creates and opens a LiveKit room | Desktop and RTC smoke tests |
| F03-N1 | Missing/wrong passcode and invalid sessions cannot obtain a grant | API tests |
| F03-H1 | Guest waits, host admits, then guest connects | RTC smoke test |
| F03-H2 | An invitee without an account enters an opted-in meeting and receives video after host admission | `node test/smoke-guest-meeting.mjs` |
| F03-N2 | Guest access needs a waiting room, honors passcodes, and is scoped to a single room | API tests |
| F05-H1 | A remote client receives video frames, audio tracks, and a data message | RTC smoke test |
| F23-H1 | The host changes camera devices during a call and the guest still receives video | Guest-meeting smoke test with synthetic devices |
| F23-H2 | Settings check microphone input, play a speaker tone, and save volume and starting layout | Guest-meeting smoke test with synthetic devices |
| F23-H3 | The camera preview honors mirroring and stops when the user leaves Video settings | Guest-meeting smoke test with synthetic devices |
| F23-H4 | A saved theme, elapsed timer, and shortcut assignment apply after reload and inside a call | Guest-meeting smoke test |
| F23-N1 | Remapped meeting keys leave media alone when the chat message box has focus | Guest-meeting smoke test |
| F06-H2 | Screen-share settings reach capture, and pausing incoming camera subscriptions preserves the presentation | Guest-meeting smoke test with synthetic capture and loopback LiveKit |
| F05-H2 | Call statistics displays measured bitrate from received media | Guest-meeting smoke test with loopback LiveKit |
| F09-N1 | Guests cannot moderate or access private notes; host locks and ends a room | API tests |
| F10-H1 | A LiveKit call disconnects removed guests and ends for the host | RTC smoke test |
| F11-H1 | Two clients exchange encrypted tracks and in-room data | RTC smoke test |
| F13-E1 | A competing note save returns a conflict instead of overwriting newer data | API tests |
| F06-H1 | A toolbar click opens the Windows capture source picker | Desktop smoke test |
| F06-P1 | Physical display capture, physical devices, and off-LAN TURN | Platform and deployment verification |
| F04-H1 | Weekly schedule is atomic and rescheduling requires host ownership | API tests |
| F22-H1 | Eligible guests can vote once and cannot open or close polls | API tests |
| F17-H1 | Admitted guests can draw and only the host can clear the board | API tests |
| F17-H2 | A host assigns guests to named breakout rooms and closes them to reunite the meeting | Four-client guest-meeting smoke test with loopback LiveKit |
| F17-H3 | Room chat stays inside the assigned room and host announcements reach both rooms | Four-client guest-meeting smoke test |
| F17-N1 | Guests cannot manage rooms or request an unrelated room grant. The server stops issuing breakout grants after removal or closure | API tests |
| F18-H1 | Host captions appear for a guest. The guest can hide the overlay and save caption history as text | Four-client guest-meeting smoke test |
| F24-H1 | A decline blocks recording. After affirmative consent, the host can capture and save a WebM when the guest withdraws consent | Four-client guest-meeting smoke test |
| F24-N1 | Joining an active meeting stops the existing recorder without capturing an unapproved session | Four-client guest-meeting smoke test checks the stop and the newcomer has no recording notice |
| F25-H1 | A host delegates moderation to a connected signed-in attendee, who can admit, lock, and manage breakouts until revoked | API and four-client guest-meeting smoke tests |
| F25-N1 | Delegation and ending the meeting require the owner. Revocation and a new connection invalidate old grants. Accountless attendees are ineligible | API tests and live revocation in the guest-meeting smoke test |
| F26-H1 | Bulk mute targets attendee microphones and preserves moderator microphones and presentation audio | API and four-client guest-meeting smoke tests |
| F27-H1 | A moderator stops an attendee camera and sends a private microphone prompt. Only the attendee can accept the prompt and turn on their microphone | API and four-client guest-meeting smoke tests |
| F28-H1 | A saved image survives reload, renders in preview, and is visible to another participant. Changing to blur updates the published camera | Browser smoke test with loopback LiveKit and synthetic camera |
| F28-N1 | Blocking the bundled model keeps the camera off. The host can switch the effect off and start the regular camera | Browser smoke test with an intercepted model request |
| F29-H1 | The host hands off control to another attendee, who can caption and end the meeting after the former host leaves | API and four-client LiveKit smoke tests |
| F30-H1 | The Windows picker supports cancelling or opting into display audio. Remote attendees receive audio, and stopping a share releases both tracks | Windows smoke and four-client LiveKit smoke tests |
| F04-H2 | Daily, weekday, weekly and monthly schedules produce the previewed dates, custom intervals and up to 52 dates are supported, and each occurrence exports as a distinct calendar event | Calendar unit and browser smoke tests |
| F18-H2 | A host assigns or revokes a manual caption typist, and a forged or stale caption grant is rejected | Caption protocol unit and four-client LiveKit smoke tests |
| F31-H1 | A moderator moves an attendee to the waiting room, then readmits them with their camera and microphone off | API and four-client LiveKit smoke tests |
| F32-H1 | A viewer sees the presenter’s drawn strokes and can draw only after the presenter grants access. Clearing removes the marks for both clients | Four-client LiveKit smoke test |
| F14-H1 | Every matching participant session must consent, and only the requesting host can list and download the completed MP4 | Cloud recording API tests with Egress and storage fixtures |
| F14-N1 | The recorder subscribes only to approved media sessions and exits when an unapproved person connects | Cloud recording template smoke test with bundled LiveKit |
| F17-H4 | An admitted attendee joins and switches self-select rooms, then returns to the main meeting with camera and microphone off | API and four-client LiveKit smoke tests |
| F18-H3 | Windows audio produces English text offline, and a participant who opts in sends captions through the host | Windows speech smoke and four-client LiveKit smoke tests |
| F18-H4 | A viewer translates English into Hindi or Spanish and exports the translation with the source caption | Four-client LiveKit smoke test and isolated browser and Windows model checks |
| F17-H5 | A timed breakout returns attendees with camera and microphone off. Its deadline cannot be extended by a later close request. An attendee cannot schedule a close | API and four-client LiveKit smoke tests |
| F18-H5 | A viewer’s caption size and contrast apply locally to the live overlay | Four-client LiveKit smoke test |
| F32-H2 | A presenter draws shapes and text and exports a PNG. Attendees can see the marks and only the presenter gets the save control | Four-client LiveKit smoke test |
| F33-H1 | An attendee exports active track metrics in JSON without participant identities or network data | Four-client LiveKit smoke test |
| F15-H1 | A participant generates an editable summary from explicit source text while external requests are blocked | Workspace browser smoke test |
| F16-H1 | A private calendar feed shows only its owner’s schedule and reflects edits. Rotation and revocation invalidate the old URL | API tests |
| F19-H1 | Signed-in team members exchange messages. Removing a member clears access, and all issued invite codes are invalidated | API and workspace browser smoke tests |
| F20-H1 | Tasks and Canvas persist with account isolation and optimistic concurrency checks | API and workspace browser smoke tests |
| F20-H2 | A local clip is recorded, played after reload, exported as WebM and deleted, and the selected track is released when recording stops | Workspace browser smoke test with synthetic display source |
| F20-H3 | Guests make a reservation and receive a meeting link. Competing requests cannot claim the same slot | API and workspace browser smoke tests |
| F15-H2 | Locally collected captions become an editable recap after leaving. Long transcripts stay in order across model sections | Workspace browser and recap unit tests |
| F16-H2 | OAuth state and PKCE bind a Google account to the organizer, and a linked event can be pushed or pulled with conflict checking | Google Calendar API contract test with fixtures |
| F23-H5 | Push-to-talk publishes a microphone only while held and releases on keyup and blur | Workspace browser smoke with fake media |
| F30-H2 | Audio-only sharing transmits an audible track with no screen video, then releases the captured source | Four-client LiveKit and native Windows capture smoke tests |
| F16-H3 | Organizer opts in to background synchronization. Only one-sided changes are applied and conflicts pause sync | Google and Outlook API fixtures and Outlook browser smoke test |
| F19-H2 | Outlook Mail consent is separate from Calendar. Inbox and Sent show plain text. Compose requires confirmation | Outlook API fixtures and browser smoke test |
| F34-H1 | Enabling the Windows tray hides the minimized app and reminders omit meeting details | Unpacked Windows smoke test |
| F19-H3 | Channel members post a threaded attachment and download it. Outsiders and removed members are denied. Removing the file preserves its message | API and workspace browser smoke tests |
| F35-H1 | A selected weekday series previews and exports the same meeting times. Ordinal and last-weekday patterns preserve wall time through DST | Schedule unit and workspace browser smoke tests |
| F36-H1 | A selected desktop accent persists when the app theme changes or the workspace reloads | Workspace browser smoke test |
| F37-H1 | Series changes preserve invite URLs and calendar UIDs. Canceling upcoming meetings leaves an opened meeting available. Stale writes are rejected | API, schedule unit, and workspace browser smoke tests |
| F38-H1 | The organizer prepares rooms for a standard meeting and loads the plan after starting. Other accounts cannot read or change the scheduled plan | API and workspace browser smoke tests |
| F39-H1 | Audio settings records and plays a local sample. Ending capture stops the input track and discarding the sample clears playback | Workspace browser smoke test |
| F38-H2 | Verified accounts enter their pre-assigned rooms only after admission. Late arrivals are matched and raw rosters are private | API and two-client LiveKit workspace smoke tests |
| F32-H3 | Undo and redo change the displayed annotations on presenter and attendee clients. Attendees cannot edit the history | Multi-client LiveKit smoke test |
| F12-P1 | 100-person load, 30-hour duration, and production availability | Deployment-scale verification |

Run `npm test` for the API suite. The RTC tests use two isolated browser pages and a real loopback LiveKit server. The desktop test is aimed at the Windows development build.
