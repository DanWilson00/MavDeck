import type { SerialPortIdentity } from './serial-probe-service';
import type { PortLike } from './serial-backend';

interface SerialPortInfoWithSerial extends SerialPortInfo {
  serialNumber?: string;
}

export function getSerialPortIdentity(port: SerialPort | PortLike): SerialPortIdentity | null {
  const info = port.getInfo() as SerialPortInfoWithSerial;
  if (info.usbVendorId != null && info.usbProductId != null) {
    return {
      usbVendorId: info.usbVendorId,
      usbProductId: info.usbProductId,
      ...(info.serialNumber ? { usbSerialNumber: info.serialNumber } : {}),
    };
  }
  return null;
}

export function matchesSerialPortIdentity(port: SerialPort | PortLike, identity: SerialPortIdentity): boolean {
  const portIdentity = getSerialPortIdentity(port);
  if (!portIdentity) {
    return false;
  }

  if (identity.usbSerialNumber != null) {
    return portIdentity.usbVendorId === identity.usbVendorId
      && portIdentity.usbProductId === identity.usbProductId
      && portIdentity.usbSerialNumber === identity.usbSerialNumber;
  }

  return portIdentity.usbVendorId === identity.usbVendorId
    && portIdentity.usbProductId === identity.usbProductId;
}
