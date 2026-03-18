import { describe, expect, it } from 'vitest';
import { getSerialPortIdentity, matchesSerialPortIdentity } from '../serial-port-identity';

describe('serial-port-identity', () => {
  it('includes usbSerialNumber when present', () => {
    const port = {
      getInfo: () => ({
        usbVendorId: 0x0403,
        usbProductId: 0x6001,
        serialNumber: 'ftdi-123',
      }),
    } as unknown as SerialPort;

    expect(getSerialPortIdentity(port)).toEqual({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      usbSerialNumber: 'ftdi-123',
    });
  });

  it('requires serial number match when the identity includes one', () => {
    const port = {
      getInfo: () => ({
        usbVendorId: 0x0403,
        usbProductId: 0x6001,
        serialNumber: 'ftdi-123',
      }),
    } as unknown as SerialPort;

    expect(matchesSerialPortIdentity(port, {
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      usbSerialNumber: 'ftdi-123',
    })).toBe(true);

    expect(matchesSerialPortIdentity(port, {
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      usbSerialNumber: 'ftdi-999',
    })).toBe(false);
  });

  it('falls back to vendor/product matching when the identity has no serial number', () => {
    const port = {
      getInfo: () => ({
        usbVendorId: 0x0403,
        usbProductId: 0x6001,
        serialNumber: 'ftdi-123',
      }),
    } as unknown as SerialPort;

    expect(matchesSerialPortIdentity(port, {
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
    })).toBe(true);
  });
});
