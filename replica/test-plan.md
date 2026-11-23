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
| F12-P1 | 100-person load, 30-hour duration, and production availability | Deployment-scale verification |

Run `npm test` for the API suite. The RTC tests use two isolated browser pages and a real loopback LiveKit server. The desktop test is aimed at the Windows development build.
