import CoreGraphics
import XCTest

func isCoordinateTextInputCandidate(
  enabled: Bool,
  frame: CGRect,
  point: CGPoint,
  tolerance: CGFloat = 2
) -> Bool {
  enabled
    && !frame.isEmpty
    && point.x >= frame.minX - tolerance
    && point.x <= frame.maxX + tolerance
    && point.y >= frame.minY - tolerance
    && point.y <= frame.maxY + tolerance
}

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testCoordinateTextInputCandidateMustBeEnabledAndContainTheTouchPoint() {
    let frame = CGRect(x: 10, y: 20, width: 100, height: 40)
    let point = CGPoint(x: 50, y: 40)

    XCTAssertTrue(
      isCoordinateTextInputCandidate(
        enabled: true,
        frame: frame,
        point: point
      )
    )
    XCTAssertFalse(
      isCoordinateTextInputCandidate(
        enabled: false,
        frame: frame,
        point: point
      )
    )
    XCTAssertFalse(
      isCoordinateTextInputCandidate(
        enabled: true,
        frame: frame,
        point: CGPoint(x: 200, y: 200)
      )
    )
  }
#endif
}
