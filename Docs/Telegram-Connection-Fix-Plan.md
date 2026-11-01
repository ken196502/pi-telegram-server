# Restore Telegram inbound connections

The gateway connects to Telegram, but both Pi sessions fail WebSocket registration
because the extension uses the global inbound token instead of each bot's token.

1. Resolve the selected bot's inbound token in the extension; require a specific
   token in multi-bot mode and keep the single-bot global configuration supported.
2. Remove the obsolete HTTP server reference from extension shutdown.
3. Start the gateway before waiting for WebSocket registration in the launcher.
4. Test extension registration against a local WebSocket hub, shutdown, and launch
   ordering. Run the repository checks and tests.
5. Reload the extension in the existing Pi sessions and verify both registrations
   through gateway health, preserving their conversations.
