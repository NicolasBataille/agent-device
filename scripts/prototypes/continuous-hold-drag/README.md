# Continuous hold-drag prototype

> THROWAWAY PROTOTYPE for
> [react-native-reorderable issue 21](https://github.com/thiagobrez/react-native-reorderable/issues/21).

## Question

Can agent-device synthesize one uninterrupted pointer lifecycle—source hold,
movement, optional destination hold, then release—while preserving
accessibility selectors in deterministic `.ad` recordings?

The prototype adds this experimental syntax:

```sh
pnpm ad gesture drag \
  'label="Blue card, position 1"' \
  'label="Yellow card, position 3"' \
  800 700 250 \
  --session reorder --platform ios --device 'iPhone 17 Pro'
```

The timing arguments are `sourceHoldMs`, `moveMs`, and `destinationHoldMs`.
The runtime resolves both selectors immediately before dispatch, then lowers
them to the existing cross-platform timestamped pointer trajectory. Repeated
source and destination samples create the holds without releasing contact.

## Evidence

### Native SwiftUI reorder on iOS 27

The selector-authored gesture moved Blue from position 1 to position 3. The
post-drop accessibility tree exposed exactly five rows in this order:

```text
Green card, position 1
Yellow card, position 2
Blue card, position 3
Orange card, position 4
Pink card, position 5
```

The side-by-side probe independently exposed `native dropped → G · Y · B · O · P`.
The active-drag frames in [native-ios-contact-sheet.png](native-ios-contact-sheet.png)
show SwiftUI's translucent source/preview and live destination placeholder
before release. The primary recording is [native-ios.mp4](native-ios.mp4).

### Reanimated + Gesture Handler fallback on iOS 27

The same command surface moved fallback Blue below Green. The probe exposed
one begin, one threshold crossing, and one drop:

```text
fallback began blue
fallback center 95pt crossed into index 1
fallback dropped blue → G · B · Y · O · P
```

The active-drag frames in
[fallback-ios-contact-sheet.png](fallback-ios-contact-sheet.png) show Green
displaced and the outlined Blue row held at the pending insertion point before
release. The primary recording is [fallback-ios.mp4](fallback-ios.mp4).

### Deterministic recording and replay

[native-ios.ad](native-ios.ad) retains both accessibility selectors and all
three timing phases. From a clean source daemon, public replay completed its
three steps in 9.8 seconds and the destination guard verified
`Blue card, position 3`. A post-replay snapshot independently confirmed the
five-row order above.

The first replay attempt failed before gesture dispatch because the authoring
daemon retained the XCTest runner lease. Stopping that daemon, as required by
`agent-device help validate`, made the identical script pass. CI must preserve
that prepare/authoring-daemon handoff rule.

## Status

- PASS: one uninterrupted hold → move → destination hold → release on iOS.
- PASS: element-to-element targeting through accessibility labels, without
  test-only IDs.
- PASS: native SwiftUI reorder and fallback reorder on iOS 27.
- PASS: selector-preserving `.ad` publication and clean-daemon headless replay.
- PASS: observable active destination feedback, callback trace, and resulting
  order on both iOS engines.
- BLOCKED: Android device proof. The current host has Android Studio but no
  Android SDK, `adb`, emulator, APK, or authenticated remote-device provider.
  Installing a multi-gigabyte Android toolchain was deliberately not folded
  into this throwaway branch.

The iOS results establish that the architecture is viable. They do not settle
the issue's cross-platform harness decision until the same public command is
run against an Android fallback build.
