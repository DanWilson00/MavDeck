import { describe, it, expect } from 'vitest';
import { MavlinkFrameDetector } from '../mavlink-frame-detector';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fake MAVLink v2 frame with the given payload length. */
function fakeV2Frame(payloadLen: number): Uint8Array {
  const frame = new Uint8Array(12 + payloadLen);
  frame[0] = 0xFD; // STX v2
  frame[1] = payloadLen;
  // Rest is zeros (header fields + payload + CRC) — detector doesn't validate
  return frame;
}

/** Build a fake MAVLink v1 frame with the given payload length. */
function fakeV1Frame(payloadLen: number): Uint8Array {
  const frame = new Uint8Array(8 + payloadLen);
  frame[0] = 0xFE; // STX v1
  frame[1] = payloadLen;
  return frame;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('MavlinkFrameDetector', () => {
  it('detects three consecutive v2 frames', () => {
    const detector = new MavlinkFrameDetector();
    const data = concat(fakeV2Frame(9), fakeV2Frame(14), fakeV2Frame(5));
    expect(detector.feed(data)).toBe(true);
  });

  it('detects three consecutive v1 frames', () => {
    const detector = new MavlinkFrameDetector();
    const data = concat(fakeV1Frame(9), fakeV1Frame(5), fakeV1Frame(12));
    expect(detector.feed(data)).toBe(true);
  });

  it('detects mixed v1 + v2 consecutive frames', () => {
    const detector = new MavlinkFrameDetector();
    const data = concat(fakeV1Frame(9), fakeV2Frame(14), fakeV1Frame(5));
    expect(detector.feed(data)).toBe(true);
  });

  it('returns false with only one frame', () => {
    const detector = new MavlinkFrameDetector();
    expect(detector.feed(fakeV2Frame(9))).toBe(false);
  });

  it('returns false with only two frames', () => {
    const detector = new MavlinkFrameDetector();
    const data = concat(fakeV2Frame(9), fakeV2Frame(14));
    expect(detector.feed(data)).toBe(false);
  });

  it('returns false with random garbage', () => {
    const detector = new MavlinkFrameDetector();
    const garbage = new Uint8Array(200);
    for (let i = 0; i < garbage.length; i++) {
      garbage[i] = Math.floor(Math.random() * 0xFC); // avoid 0xFD/0xFE
    }
    expect(detector.feed(garbage)).toBe(false);
  });

  it('detects frames arriving in chunks', () => {
    const detector = new MavlinkFrameDetector();
    const frame1 = fakeV2Frame(9);
    const frame2 = fakeV2Frame(14);
    const frame3 = fakeV2Frame(5);
    const all = concat(frame1, frame2, frame3);

    // Feed first frame — not enough yet
    expect(detector.feed(all.slice(0, frame1.length))).toBe(false);
    // Feed second frame — still not enough
    expect(detector.feed(all.slice(frame1.length, frame1.length + frame2.length))).toBe(false);
    // Feed third frame — now detected
    expect(detector.feed(all.slice(frame1.length + frame2.length))).toBe(true);
  });

  it('detects frames preceded by garbage', () => {
    const detector = new MavlinkFrameDetector();
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    const data = concat(garbage, fakeV2Frame(9), fakeV2Frame(14), fakeV2Frame(5));
    expect(detector.feed(data)).toBe(true);
  });

  it('reset clears buffer so detection starts fresh', () => {
    const detector = new MavlinkFrameDetector();
    detector.feed(concat(fakeV2Frame(9), fakeV2Frame(14)));

    detector.reset();

    // After reset, feeding just one frame should not match
    expect(detector.feed(fakeV2Frame(5))).toBe(false);
  });

  it('handles zero-length payload frames', () => {
    const detector = new MavlinkFrameDetector();
    const data = concat(fakeV2Frame(0), fakeV2Frame(0), fakeV2Frame(0));
    expect(detector.feed(data)).toBe(true);
  });

  it('handles max-length payload frames', () => {
    const detector = new MavlinkFrameDetector();
    const data = concat(fakeV2Frame(255), fakeV2Frame(255), fakeV2Frame(255));
    expect(detector.feed(data)).toBe(true);
  });
});
