# Security model

- Meetrix exchanges InsForge OAuth codes on the server. The OAuth return requires a one-time browser state and PKCE verifier. The app scopes user identities to the configured InsForge project.
- The browser and desktop receive independent, revocable Meetrix cookies for up to 12 hours. Session credentials are hashed at rest. Cookies are HttpOnly and SameSite=Strict, with Secure enabled for HTTPS. Changing the identity provider leaves historical ownership records under their original account identifiers.
- Desktop sign-in uses the system browser. An authenticated browser session must approve a short-lived pairing code, and only the requesting app can redeem the request. The app opens a browser URL built from the active workspace origin.
- Electron content runs in a sandbox with context isolation and guarded navigation. The settings window exposes a limited connection interface. The local server binds to loopback.
- Host controls check meeting ownership. Passcodes use salted scrypt. The API validates bodies, rate-limits requests, and issues 50-second initial room grants.
- Accountless attendance requires explicit host opt-in and waiting room admission. A tab keeps a random proof scoped to the meeting. The guest endpoint gives admitted invitees a LiveKit room grant. Workspace APIs, including stored notes, polls, and whiteboards, still require an account.
- Breakout assignments are host-only. A routing key is issued after admission and stored as a hash. It can fetch only the assigned LiveKit grant for that meeting and identity. Guests who are removed cannot request replacement grants. LiveKit carries room chat and media separately per breakout. Automatic moves mute the microphone and turn off the camera, and closing a room retires its ID. Failed room cleanup is retried by the server.
- Notes, poll ballots, and whiteboards are stored in SQLite for standard rooms. Protect the storage volume and backups. Use one backend process for a workspace to keep moderation queues and limits coherent.
- Encrypted rooms use LiveKit media and data encryption. The host distributes the random key separately. Signaling and meeting metadata are still visible to the deployment. Modified clients can publish unencrypted tracks.
- Self-managed LiveKit can accept a previously issued unexpired token after removal. LiveKit Cloud offers provider-side revocation. Hosted deployments require HTTPS and WSS.
- Application signing, production load verification, and independent security assessment remain release work.

Use GitHub's private vulnerability reporting option when available. Keep credentials and private meeting information out of public issues.
