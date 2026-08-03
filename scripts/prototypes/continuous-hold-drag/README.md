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

### Reanimated + Gesture Handler fallback on Android 17

The same accessibility-label-authored gesture (`Fallback Blue card` to
`Fallback Yellow card`) ran on the Pixel 10 Pro emulator against the fallback
probe's 220 ms long-press activation threshold. Blue moved below Yellow, and
the Android accessibility tree exposed the complete lifecycle and resulting
order:

```text
fallback began blue
fallback center 88pt crossed into index 1
fallback center 159pt crossed into index 2
fallback dropped blue → G · Y · B · O · P
```

The active-drag frames in
[android-fallback-contact-sheet.png](android-fallback-contact-sheet.png) show
the Blue row moving continuously while Green and Yellow occupy their pending
positions. The primary recording is
[android-fallback.mp4](android-fallback.mp4).

### Deterministic recording and replay

[native-ios.ad](native-ios.ad) retains both accessibility selectors and all
three timing phases. From a clean source daemon, public replay completed its
three steps in 9.8 seconds and the destination guard verified
`Blue card, position 3`. A post-replay snapshot independently confirmed the
five-row order above.

[android-fallback.ad](android-fallback.ad) records the Android device context,
source readiness guard, selectors, timings, and destination-order guard. Its
four steps replayed headlessly in 11.2 seconds from a clean daemon.

The first replay attempt failed before gesture dispatch because the authoring
daemon retained the XCTest runner lease. Stopping that daemon, as required by
`agent-device help validate`, made the identical script pass. CI must preserve
that prepare/authoring-daemon handoff rule.

## Status

- PASS: one uninterrupted hold → move → destination hold → release on iOS.
- PASS: element-to-element targeting through accessibility labels, without
  test-only IDs.
- PASS: native SwiftUI reorder and fallback reorder on iOS 27.
- PASS: fallback long-press activation, continuous drag, boundary crossings,
  drop callback, and final order on an Android 17 Pixel 10 Pro emulator.
- PASS: selector-preserving `.ad` publication and clean-daemon headless replay.
- PASS: observable active destination feedback, callback trace, and resulting
  order on both iOS engines.
- PASS: the same timestamped pointer plan dispatches through the Android
  MotionEvent backend without releasing contact before the final sample.

The iOS and Android results establish that the architecture is viable for the
issue's required native and fallback harness lanes. This Android probe is
deliberately smaller than the planned production fallback engine; it proves
gesture synthesis and observable reorder behavior, not the full portable
contract.
