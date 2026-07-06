# Changelog

## Unreleased

- Added `agent-device acp`: a deterministic stdio ACP (Agent Client Protocol) agent for Zed and other ACP clients. Prompt lines are agent-device commands in CLI syntax, executed through the same client path as MCP tools, with tool-call streaming, sticky per-session target flags, and inline screenshot images.

## 0.15.0

- Breaking: `apps` discovery and public app-list helpers now default to user-installed apps. Use `--all` or `filter: 'all'` to include system/OEM apps.
- Breaking: removed the `agent-device/android-apps` public subpath. Use the Android app helpers from `agent-device/android-adb`.
- Breaking: removed the `agent-device/daemon` public subpath. Use `agent-device/contracts` for daemon request/response types.
- Breaking: removed public local ADB bypass/selection helpers such as `spawnAndroidAdbBySerial` and `resolveAndroidAdbProvider`; use `createLocalAndroidAdbProvider(device)` or pass providers directly to the helpers from `agent-device/android-adb`.
- Added Android ADB provider helpers for exec, stream, clipboard, keyboard, app lifecycle, logcat, and port reverse workflows.
