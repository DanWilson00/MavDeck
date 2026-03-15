import type { SerialPortIdentity } from './serial-probe-service';

export function getSerialPortIdentity(port: SerialPort): SerialPortIdentity | null {
  const info = port.getInfo();
  if (info.usbVendorId != null && info.usbProductId != null) {
    return { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId };
  }
  return null;
}

export function matchesSerialPortIdentity(port: SerialPort, identity: SerialPortIdentity): boolean {
  const portIdentity = getSerialPortIdentity(port);
  return portIdentity?.usbVendorId === identity.usbVendorId
    && portIdentity.usbProductId === identity.usbProductId;
}
