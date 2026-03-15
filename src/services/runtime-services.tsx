import { createContext, useContext, type ParentProps } from 'solid-js';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { ConnectionManager } from './connection-manager';
import type { LogViewerService } from './log-viewer-service';
import type { SerialSessionController } from './serial-session-controller';
import type { MavlinkWorkerBridge } from './worker-bridge';

export interface RuntimeServices {
  workerBridge: MavlinkWorkerBridge;
  connectionManager: ConnectionManager;
  registry: MavlinkMetadataRegistry;
  logViewerService: LogViewerService;
  serialSessionController: SerialSessionController;
}

const RuntimeServicesContext = createContext<RuntimeServices>();

export function RuntimeServicesProvider(
  props: ParentProps<{ services: RuntimeServices }>,
) {
  return (
    <RuntimeServicesContext.Provider value={props.services}>
      {props.children}
    </RuntimeServicesContext.Provider>
  );
}

export function useRuntimeServices(): RuntimeServices {
  const services = useContext(RuntimeServicesContext);
  if (!services) {
    throw new Error('Runtime services are not initialized');
  }
  return services;
}

export function useWorkerBridge(): MavlinkWorkerBridge {
  return useRuntimeServices().workerBridge;
}

export function useConnectionManager(): ConnectionManager {
  return useRuntimeServices().connectionManager;
}

export function useRegistry(): MavlinkMetadataRegistry {
  return useRuntimeServices().registry;
}

export function useLogViewerService(): LogViewerService {
  return useRuntimeServices().logViewerService;
}

export function useSerialSessionController(): SerialSessionController {
  return useRuntimeServices().serialSessionController;
}
