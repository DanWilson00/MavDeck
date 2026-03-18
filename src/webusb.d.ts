interface USBControlTransferParameters {
  requestType: 'standard' | 'class' | 'vendor';
  recipient: 'device' | 'interface' | 'endpoint' | 'other';
  request: number;
  value: number;
  index: number;
}

interface USBInTransferResult {
  data?: DataView;
}

interface USBEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
}

interface USBAlternateInterface {
  interfaceClass: number;
  endpoints: USBEndpoint[];
}

interface USBInterface {
  interfaceNumber: number;
  alternate: USBAlternateInterface;
}

interface USBConfiguration {
  interfaces: USBInterface[];
}

interface USBDevice {
  vendorId: number;
  productId: number;
  opened: boolean;
  configuration: USBConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<unknown>;
  controlTransferOut(setup: USBControlTransferParameters): Promise<unknown>;
  forget(): Promise<void>;
}

interface USBConnectionEvent extends Event {
  readonly device: USBDevice;
}

interface USB extends EventTarget {
  requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<USBDevice>;
  getDevices(): Promise<USBDevice[]>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: USBConnectionEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: USBConnectionEvent) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface Navigator {
  usb: USB;
}
