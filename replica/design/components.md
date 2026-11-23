# Meetrix desktop interface

The workspace uses light surfaces and a violet accent. The call stage uses a dark surface for participant video and shared content. Runtime colors live in `src/tokens.css`, and `tokens.json` records the pairs used for contrast checks.

| Surface | Layout | States and behavior |
| --- | --- | --- |
| Sign-in | Centered card with the provider actions and guest join | Loading providers, connection error with retry, browser pairing, and signed-out guest entry |
| Home | Sidebar, workspace header, three meeting actions, and the upcoming agenda | Works with an empty agenda and with real scheduled or open rooms. Narrow windows stack the meeting actions |
| Meetings | Meeting list with upcoming and past views | Schedule, join, copy an invite, export a calendar file, reschedule, and see ended meetings |
| Settings | A category rail and a content panel | Audio groups device routing, volume, and checks. Video groups camera selection and a local preview. Meeting defaults control the starting layout and device state |
| Preflight | A named modal with local video, microphone and camera controls, and device selection | Waiting and connection states stay visible. Media toggles apply to that meeting |
| In a meeting | Header, media stage, participant panel, and meeting controls | Device settings and speaker volume remain available during the call. Camera mirroring applies to the local view |

Buttons and fields use visible focus rings. Screen readers get the dialog title and named controls. Diagnostic captures stop when the user leaves the category.
