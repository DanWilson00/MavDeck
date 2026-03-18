import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeBaudDivisor, FtdiSerialPort, FTDI_VENDOR_ID } from '../ftdi-serial-port';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ControlTransferCall {
  requestType: string;
  recipient: string;
  request: number;
  value: number;
  index: number;
}

/** Create a mock USBDevice with recordable control transfers. */
function makeMockDevice(overrides?: {
  interfaces?: number;
  interfaceClass?: number;
  endpoints?: Array<{ type: string; direction: string; endpointNumber: number }>;
  vendorId?: number;
  productId?: number;
}) {
  const endpoints = overrides?.endpoints ?? [
    { type: 'bulk', direction: 'in', endpointNumber: 1 },
    { type: 'bulk', direction: 'out', endpointNumber: 2 },
  ];
  const interfaceClass = overrides?.interfaceClass ?? 0xFF;
  const numInterfaces = overrides?.interfaces ?? 1;

  const interfaces = Array.from({ length: numInterfaces }, (_, i) => ({
    interfaceNumber: i,
    alternate: {
      interfaceClass,
      endpoints,
    },
  }));

  const controlTransfers: ControlTransferCall[] = [];

  return {
    device: {
      vendorId: overrides?.vendorId ?? 0x0403,
      productId: overrides?.productId ?? 0x6001,
      opened: false,
      configuration: { interfaces },
      open: vi.fn(async function (this: { opened: boolean }) { this.opened = true; }),
      close: vi.fn(async function (this: { opened: boolean }) { this.opened = false; }),
      selectConfiguration: vi.fn(async () => {}),
      claimInterface: vi.fn(async () => {}),
      releaseInterface: vi.fn(async () => {}),
      controlTransferOut: vi.fn(async (setup: ControlTransferCall) => {
        controlTransfers.push({ ...setup });
      }),
      transferIn: vi.fn(async () => {
        throw new Error('no more data');
      }),
      transferOut: vi.fn(async () => {}),
      forget: vi.fn(async () => {}),
    } as unknown as USBDevice,
    controlTransfers,
  };
}

// ── Baud divisor golden values ──────────────────────────────────────────────

describe('computeBaudDivisor', () => {
  const BASE_CLOCK = 3_000_000;

  function actualBaud(divisor: { value: number; index: number }): number {
    const intPart = divisor.value & 0x3FFF;
    const subBit2 = (divisor.value >> 14) & 1;
    const subBits10 = divisor.index & 0x03;
    const subCode = (subBit2 << 2) | subBits10;

    const fractions = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
    const effectiveDivisor = intPart + fractions[subCode];
    return BASE_CLOCK / effectiveDivisor;
  }

  const goldenValues: [baud: number, expectedInt: number, expectedSubCode: number][] = [
    [9600, 312, 4],     // 312.5 → int=312, frac≈0.5 → code 4
    [19200, 156, 2],    // 156.25 → int=156, frac≈0.25 → code 2
    [57600, 52, 1],     // 52.083 → int=52, frac≈0.125 → code 1
    [115200, 26, 0],    // 26.042 → int=26, frac≈0 → code 0
    [921600, 3, 2],     // 3.255 → int=3, frac≈0.25 → code 2
  ];

  for (const [baud, expectedInt, expectedSubCode] of goldenValues) {
    it(`encodes ${baud} baud correctly`, () => {
      const result = computeBaudDivisor(baud);
      const intPart = result.value & 0x3FFF;
      const subBit2 = (result.value >> 14) & 1;
      const subBits10 = result.index & 0x03;
      const subCode = (subBit2 << 2) | subBits10;

      expect(intPart).toBe(expectedInt);
      expect(subCode).toBe(expectedSubCode);
    });
  }

  // All MavDeck baud rates produce < 1% error
  const allBauds = [9600, 19200, 38400, 57600, 115200, 230400, 500000, 921600, 1000000];
  for (const baud of allBauds) {
    it(`${baud} baud has < 1% error`, () => {
      const divisor = computeBaudDivisor(baud);
      const actual = actualBaud(divisor);
      const error = Math.abs(actual - baud) / baud;
      expect(error).toBeLessThan(0.01);
    });
  }
});

// ── open() control transfer sequence ────────────────────────────────────────

describe('FtdiSerialPort.open', () => {
  let disconnectListeners: Array<(e: unknown) => void>;

  beforeEach(() => {
    disconnectListeners = [];
    vi.stubGlobal('navigator', {
      usb: {
        addEventListener: vi.fn((_event: string, cb: (e: unknown) => void) => {
          disconnectListeners.push(cb);
        }),
        removeEventListener: vi.fn(),
      },
    });
  });

  it('sends the correct vendor control transfers in order at 115200 baud', async () => {
    const { device, controlTransfers } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    await port.open({ baudRate: 115200 });

    // Verify device setup sequence
    expect((device as unknown as { open: ReturnType<typeof vi.fn> }).open).toHaveBeenCalledOnce();
    expect((device as unknown as { selectConfiguration: ReturnType<typeof vi.fn> }).selectConfiguration).toHaveBeenCalledWith(1);
    expect((device as unknown as { claimInterface: ReturnType<typeof vi.fn> }).claimInterface).toHaveBeenCalledWith(0);

    // 6 control transfers in exact order
    expect(controlTransfers).toHaveLength(6);

    // Reset
    expect(controlTransfers[0]).toEqual({
      requestType: 'vendor', recipient: 'device',
      request: 0x00, value: 0x0000, index: 0x0000,
    });

    // Set baud (115200 → divisor int=26, sub=0)
    const expectedDivisor = computeBaudDivisor(115200);
    expect(controlTransfers[1]).toEqual({
      requestType: 'vendor', recipient: 'device',
      request: 0x03, value: expectedDivisor.value, index: expectedDivisor.index,
    });

    // Set data: 8N1
    expect(controlTransfers[2]).toEqual({
      requestType: 'vendor', recipient: 'device',
      request: 0x04, value: 0x0008, index: 0x0000,
    });

    // Set flow: none
    expect(controlTransfers[3]).toEqual({
      requestType: 'vendor', recipient: 'device',
      request: 0x02, value: 0x0000, index: 0x0000,
    });

    // DTR on
    expect(controlTransfers[4]).toEqual({
      requestType: 'vendor', recipient: 'device',
      request: 0x01, value: 0x0101, index: 0x0000,
    });

    // RTS on
    expect(controlTransfers[5]).toEqual({
      requestType: 'vendor', recipient: 'device',
      request: 0x01, value: 0x0202, index: 0x0000,
    });
  });

  it('sends correct baud divisor for 9600', async () => {
    const { device, controlTransfers } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    await port.open({ baudRate: 9600 });

    // Set baud is the 2nd transfer (index 1)
    const baudTransfer = controlTransfers[1];
    expect(baudTransfer.request).toBe(0x03);

    // 9600 → 312.5 → int=312, sub=0.5 (code 4) → value bit 14 = 1, index = 0
    const divisor = computeBaudDivisor(9600);
    expect(baudTransfer.value).toBe(divisor.value);
    expect(baudTransfer.index).toBe(divisor.index);

    // Verify bit 14 is set (sub-int code 4 → bit 2 set → goes to value bit 14)
    expect(baudTransfer.value & (1 << 14)).not.toBe(0);
  });

  it('sends correct baud divisor for 921600', async () => {
    const { device, controlTransfers } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    await port.open({ baudRate: 921600 });

    const baudTransfer = controlTransfers[1];
    const divisor = computeBaudDivisor(921600);
    expect(baudTransfer.value).toBe(divisor.value);
    expect(baudTransfer.index).toBe(divisor.index);

    // 921600 → 3.255 → int=3, sub≈0.25 (code 2) → index bits 1:0 = 2
    expect(baudTransfer.index & 0x03).toBe(2);
  });

  it('tolerates InvalidStateError from selectConfiguration (Android)', async () => {
    const { device } = makeMockDevice();
    (device as unknown as { selectConfiguration: ReturnType<typeof vi.fn> }).selectConfiguration
      .mockRejectedValueOnce(new DOMException('already selected', 'InvalidStateError'));

    const port = new FtdiSerialPort(device);
    // Should not throw
    await port.open({ baudRate: 115200 });

    expect((device as unknown as { claimInterface: ReturnType<typeof vi.fn> }).claimInterface).toHaveBeenCalled();
  });

  it('re-throws non-InvalidStateError from selectConfiguration', async () => {
    const { device } = makeMockDevice();
    (device as unknown as { selectConfiguration: ReturnType<typeof vi.fn> }).selectConfiguration
      .mockRejectedValueOnce(new DOMException('access denied', 'SecurityError'));

    const port = new FtdiSerialPort(device);
    await expect(port.open({ baudRate: 115200 })).rejects.toThrow('access denied');
  });

  it('registers a USB disconnect listener', async () => {
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    await port.open({ baudRate: 115200 });

    expect(navigator.usb.addEventListener).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });
});

// ── close() cleanup ─────────────────────────────────────────────────────────

describe('FtdiSerialPort.close', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      usb: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  it('releases interface, closes device, and removes disconnect listener', async () => {
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);
    await port.open({ baudRate: 115200 });

    await port.close();

    expect((device as unknown as { releaseInterface: ReturnType<typeof vi.fn> }).releaseInterface).toHaveBeenCalledWith(0);
    expect((device as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    expect(navigator.usb.removeEventListener).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });

  it('nulls out readable and writable after close', async () => {
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);
    await port.open({ baudRate: 115200 });

    // Access streams to lazily create them
    const _r = port.readable;
    const _w = port.writable;
    expect(_r).not.toBeNull();
    expect(_w).not.toBeNull();

    await port.close();

    expect(port.readable).toBeNull();
    expect(port.writable).toBeNull();
  });
});

// ── setBaudRate ──────────────────────────────────────────────────────────────

describe('FtdiSerialPort.setBaudRate', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      usb: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  it('sends a SET_BAUD vendor transfer with correct divisor', async () => {
    const { device, controlTransfers } = makeMockDevice();
    const port = new FtdiSerialPort(device);
    await port.open({ baudRate: 115200 });

    // Clear the open() transfers
    controlTransfers.length = 0;

    await port.setBaudRate(57600);

    expect(controlTransfers).toHaveLength(1);
    const divisor = computeBaudDivisor(57600);
    expect(controlTransfers[0]).toEqual({
      requestType: 'vendor',
      recipient: 'device',
      request: 0x03,
      value: divisor.value,
      index: divisor.index,
    });
  });

  it('can change baud rate multiple times', async () => {
    const { device, controlTransfers } = makeMockDevice();
    const port = new FtdiSerialPort(device);
    await port.open({ baudRate: 115200 });
    controlTransfers.length = 0;

    await port.setBaudRate(9600);
    await port.setBaudRate(921600);

    expect(controlTransfers).toHaveLength(2);
    expect(controlTransfers[0].request).toBe(0x03);
    expect(controlTransfers[1].request).toBe(0x03);

    const div9600 = computeBaudDivisor(9600);
    expect(controlTransfers[0].value).toBe(div9600.value);
    expect(controlTransfers[0].index).toBe(div9600.index);

    const div921600 = computeBaudDivisor(921600);
    expect(controlTransfers[1].value).toBe(div921600.value);
    expect(controlTransfers[1].index).toBe(div921600.index);
  });
});

// ── Modem status stripping ──────────────────────────────────────────────────

describe('FtdiSerialPort readable', () => {
  it('strips 2-byte modem status from bulk-IN data', async () => {
    const statusAndData = new Uint8Array([0x01, 0x60, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    const readable = port.readable;
    expect(readable).not.toBeNull();

    let callCount = 0;
    (device as unknown as Record<string, unknown>).transferIn = async () => {
      callCount++;
      if (callCount === 1) {
        return { data: new DataView(statusAndData.buffer) };
      }
      throw new Error('done');
    };

    const reader = readable!.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    expect(value).toEqual(new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]));
  });

  it('skips status-only packets (≤2 bytes) and returns next real data', async () => {
    const statusOnly = new Uint8Array([0x01, 0x60]);
    const realData = new Uint8Array([0x01, 0x60, 0xFF]);
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    const readable = port.readable;
    let callCount = 0;
    (device as unknown as Record<string, unknown>).transferIn = async () => {
      callCount++;
      if (callCount < 3) {
        return { data: new DataView(statusOnly.buffer) };
      }
      if (callCount === 3) {
        return { data: new DataView(realData.buffer) };
      }
      throw new Error('done');
    };

    const reader = readable!.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(value).toEqual(new Uint8Array([0xFF]));
  });

  it('handles null data gracefully', async () => {
    const realData = new Uint8Array([0x01, 0x60, 0x42]);
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    const readable = port.readable;
    let callCount = 0;
    (device as unknown as Record<string, unknown>).transferIn = async () => {
      callCount++;
      if (callCount === 1) {
        return { data: null }; // null data
      }
      if (callCount === 2) {
        return { data: new DataView(realData.buffer) };
      }
      throw new Error('done');
    };

    const reader = readable!.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    expect(value).toEqual(new Uint8Array([0x42]));
  });
});

// ── Writable stream ─────────────────────────────────────────────────────────

describe('FtdiSerialPort writable', () => {
  it('writes chunks via transferOut to the correct endpoint', async () => {
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    const writable = port.writable;
    expect(writable).not.toBeNull();

    const writer = writable!.getWriter();
    const chunk = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    await writer.write(chunk);
    writer.releaseLock();

    expect((device as unknown as { transferOut: ReturnType<typeof vi.fn> }).transferOut)
      .toHaveBeenCalledWith(2, chunk); // endpoint 2 is our bulk OUT
  });
});

// ── getInfo ─────────────────────────────────────────────────────────────────

describe('FtdiSerialPort.getInfo', () => {
  it('returns correct vendor/product IDs', () => {
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);
    expect(port.getInfo()).toEqual({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
    });
  });

  it('returns correct IDs for custom-PID FTDI device', () => {
    const { device } = makeMockDevice({ vendorId: 0x0403, productId: 0x1234 });
    const port = new FtdiSerialPort(device);
    expect(port.getInfo()).toEqual({
      usbVendorId: 0x0403,
      usbProductId: 0x1234,
    });
  });
});

// ── forget() ────────────────────────────────────────────────────────────────

describe('FtdiSerialPort.forget', () => {
  it('delegates to device.forget()', async () => {
    const { device } = makeMockDevice();
    const port = new FtdiSerialPort(device);

    await port.forget();

    expect((device as unknown as { forget: ReturnType<typeof vi.fn> }).forget).toHaveBeenCalledOnce();
  });
});

// ── Constructor validation ──────────────────────────────────────────────────

describe('FtdiSerialPort constructor validation', () => {
  it('rejects device with no configuration', () => {
    const device = { configuration: null } as unknown as USBDevice;
    expect(() => new FtdiSerialPort(device)).toThrow('no active configuration');
  });

  it('rejects multi-interface device (FT2232H/FT4232H)', () => {
    const device = {
      configuration: {
        interfaces: [
          { interfaceNumber: 0, alternate: { interfaceClass: 0xFF, endpoints: [] } },
          { interfaceNumber: 1, alternate: { interfaceClass: 0xFF, endpoints: [] } },
        ],
      },
    } as unknown as USBDevice;
    expect(() => new FtdiSerialPort(device)).toThrow('Multi-port FTDI');
  });

  it('rejects device with no bulk endpoints', () => {
    const device = {
      configuration: {
        interfaces: [{
          interfaceNumber: 0,
          alternate: {
            interfaceClass: 0xFF,
            endpoints: [],
          },
        }],
      },
    } as unknown as USBDevice;
    expect(() => new FtdiSerialPort(device)).toThrow('bulk IN and OUT endpoints');
  });

  it('rejects device with only bulk IN (no OUT)', () => {
    const device = {
      configuration: {
        interfaces: [{
          interfaceNumber: 0,
          alternate: {
            interfaceClass: 0xFF,
            endpoints: [
              { type: 'bulk', direction: 'in', endpointNumber: 1 },
            ],
          },
        }],
      },
    } as unknown as USBDevice;
    expect(() => new FtdiSerialPort(device)).toThrow('bulk IN and OUT endpoints');
  });

  it('rejects non-vendor-specific interface class', () => {
    const device = {
      configuration: {
        interfaces: [{
          interfaceNumber: 0,
          alternate: {
            interfaceClass: 0x02,
            endpoints: [
              { type: 'bulk', direction: 'in', endpointNumber: 1 },
              { type: 'bulk', direction: 'out', endpointNumber: 2 },
            ],
          },
        }],
      },
    } as unknown as USBDevice;
    expect(() => new FtdiSerialPort(device)).toThrow('vendor-specific interface class');
  });

  it('ignores non-bulk endpoints when discovering IN/OUT', () => {
    const device = {
      configuration: {
        interfaces: [{
          interfaceNumber: 0,
          alternate: {
            interfaceClass: 0xFF,
            endpoints: [
              { type: 'interrupt', direction: 'in', endpointNumber: 3 },
              { type: 'bulk', direction: 'in', endpointNumber: 1 },
              { type: 'bulk', direction: 'out', endpointNumber: 2 },
            ],
          },
        }],
      },
    } as unknown as USBDevice;
    // Should succeed — non-bulk endpoints are skipped
    const port = new FtdiSerialPort(device);
    expect(port.getInfo().usbVendorId).toBe(undefined); // no vendorId on this mock
  });
});

// ── FTDI_VENDOR_ID export ───────────────────────────────────────────────────

describe('FTDI_VENDOR_ID', () => {
  it('is 0x0403', () => {
    expect(FTDI_VENDOR_ID).toBe(0x0403);
  });
});

// ── serial-backend routing ──────────────────────────────────────────────────

describe('serial-backend', () => {
  it('getSerialBackend returns webusb when only USB is available', async () => {
    vi.stubGlobal('navigator', { usb: {}, userAgent: '' });
    const { getSerialBackend } = await import('../serial-backend');
    expect(getSerialBackend()).toBe('webusb');
  });

  it('getSerialBackend returns native when Web Serial is available on non-Android', async () => {
    vi.stubGlobal('navigator', { serial: {}, usb: {}, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    const { getSerialBackend } = await import('../serial-backend');
    expect(getSerialBackend()).toBe('native');
  });

  it('getSerialBackend returns webusb on Android even when Web Serial exists', async () => {
    vi.stubGlobal('navigator', {
      serial: {},
      usb: {},
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0',
    });
    const { getSerialBackend } = await import('../serial-backend');
    expect(getSerialBackend()).toBe('webusb');
  });

  it('getSerialBackend returns null when neither is available', async () => {
    vi.stubGlobal('navigator', { userAgent: '' });
    const { getSerialBackend } = await import('../serial-backend');
    expect(getSerialBackend()).toBeNull();
  });
});
