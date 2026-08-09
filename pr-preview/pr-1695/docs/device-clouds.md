# Device Clouds & Farms

Use a device cloud or farm when an agent needs to automate a hosted mobile device without an interactive login. Choose the provider that owns the devices and credentials for your workflow:

- [BrowserStack](/agent-device/pr-preview/pr-1695/docs/browserstack.md) — hosted Android and iOS App Automate sessions through WebDriver.
- [AWS Device Farm](/agent-device/pr-preview/pr-1695/docs/aws-device-farm.md) — hosted Android and iOS remote-access sessions through AWS.
- [Limrun](/agent-device/pr-preview/pr-1695/docs/limrun.md) — direct iOS simulator and Android emulator instances.

All three integrations use the local `agent-device` daemon. `connect` verifies credentials and the supplied configuration, then saves non-secret connection state; it does not allocate a device. BrowserStack and AWS Device Farm allocate their hosted session on `open`. Limrun allocates its direct instance on the first device command, such as `install` or `open`.

For each provider, the standard lifecycle is:

1. Put provider credentials in CI secrets or another non-interactive credential source.
2. Run `agent-device connect <provider>` with the provider selectors.
3. Follow the printed next command to install or open the app.
4. Run normal device commands, then `agent-device close` and `agent-device disconnect`.

Use the provider guide for its connection selectors, client configuration, MCP bootstrap, artifacts, and troubleshooting. Generated remote profiles are safe to store as non-secret configuration: they may include app IDs, ARNs, device names, OS versions, and labels, but never provider API keys or AWS secret keys.
