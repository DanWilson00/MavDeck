import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { ConnectionManager } from './connection-manager';
import type { LogViewerService } from './log-viewer-service';
import type { SerialSessionController } from './serial-session-controller';
import type { MavlinkWorkerBridge } from './worker-bridge';

interface RuntimeServices {
  workerBridge: MavlinkWorkerBridge;
  connectionManager: ConnectionManager;
  registry: MavlinkMetadataRegistry;
  logViewerService: LogViewerService;
  serialSessionController: SerialSessionController;
}

let runtimeServices: RuntimeServices | null = null;

export function setRuntimeServices(services: RuntimeServices): void {
  runtimeServices = services;
}

export function clearRuntimeServices(): void {
  runtimeServices = null;
}

function requireRuntimeServices(): RuntimeServices {
  if (!runtimeServices) {
    throw new Error('Runtime services are not initialized');
  }
  return runtimeServices;
}

export function getWorkerBridge(): MavlinkWorkerBridge {
  return requireRuntimeServices().workerBridge;
}

export function getConnectionManager(): ConnectionManager {
  return requireRuntimeServices().connectionManager;
}

export function getRegistry(): MavlinkMetadataRegistry {
  return requireRuntimeServices().registry;
}

export function getLogViewerService(): LogViewerService {
  return requireRuntimeServices().logViewerService;
}

export function getSerialSessionController(): SerialSessionController {
  return requireRuntimeServices().serialSessionController;
}
