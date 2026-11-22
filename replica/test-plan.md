# Verification plan

| Case | Expected behavior | Verification path |
|---|---|---|
| F01-H1 | Windows opens the Clerk form and starts its local media server | `node test/smoke-desktop.mjs` with a local build |
| F01-H2 | Clerk test account signs up and the Meetrix backend accepts its session | `node test/smoke-desktop.mjs --clerk-account` |
| F02-H1 | Host creates and opens a LiveKit room | Desktop and RTC smoke tests |
| F03-N1 | Missing/wrong passcode and invalid sessions cannot obtain a grant | API tests |
| F03-H1 | Guest waits, host admits, then guest connects | RTC smoke test |
| F05-H1 | A remote client receives video frames, audio tracks, and a data message | RTC smoke test |
| F09-N1 | Guests cannot moderate or access private notes; host locks and ends a room | API tests |
| F10-H1 | A LiveKit call disconnects removed guests and ends for the host | RTC smoke test |
| F11-H1 | Two clients exchange encrypted tracks and in-room data | RTC smoke test |
| F13-E1 | A competing note save returns a conflict instead of overwriting newer data | API tests |
| F06-H1 | A toolbar click opens the Windows capture source picker | Desktop smoke test |
| F06-P1 | Physical display capture, physical devices, and off-LAN TURN | Platform and deployment verification |
| F04-H1 | Weekly schedule is atomic and rescheduling requires host ownership | API tests |
| F22-H1 | Eligible guests can vote once and cannot open or close polls | API tests |
| F17-H1 | Admitted guests can draw and only the host can clear the board | API tests |
| F12-P1 | 100-person load, 30-hour duration, and production availability | Deployment-scale verification |

Run `npm test` for the API suite. The RTC tests use two isolated browser pages and a real loopback LiveKit server. The desktop test is aimed at the Windows development build.
