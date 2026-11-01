# Keep Pi alive when Telegram sends /new

Both bot sessions disappear after `/new`. The extension translates it to `/clear`,
whose handler calls Pi's session replacement API.

1. Reproduce `/new` in an isolated named tmux session with a local gateway fixture,
   capturing the process output and exit status without sending Telegram messages.
2. Correct command dispatch and session lifecycle handling based on the failure.
3. Verify repeated `/new`, a fresh conversation, and subsequent inbound messages.
   Cover cancellation and session cleanup where relevant; run repository checks.
4. Restore both live bot sessions from their saved conversations with the fix and
   verify their gateway registrations. Remove temporary test sessions and files.

## Findings and validation

The crash reports and isolated reproduction show an uncaught exception in the
WebSocket client's `onClose` callback. `/new` intentionally closes that client;
the asynchronous close event then tries to notify the old, invalidated Pi UI
context. This affected both bots.

The client now clears its registration state immediately on intentional close
and ignores subsequent socket events. Unexpected disconnects still notify the
caller and reconnect. The `/clear` handler captures plain settings before
replacing the session.

All 91 repository tests pass, including invalidated UI context and late socket
event regressions. An isolated real Pi 1.4.0 process survived three consecutive
inbound `/new` commands, created four distinct session IDs with empty new
contexts, and handled an inbound `/status` afterward. All outbound traffic in
this reproduction stayed on a local fixture server.
