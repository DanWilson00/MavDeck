import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { PlotSignalConfig } from '../models';
import { formatSignalLabel, getDisplayUnit, type UnitProfile } from './unit-display';

interface SignalIdentity {
  messageType: string;
  fieldName: string;
  fieldKey: string;
}

export function getSignalRawUnit(
  registry: MavlinkMetadataRegistry,
  signal: SignalIdentity,
): string {
  return registry
    .getMessageByName(signal.messageType)
    ?.fields.find(field => field.name === signal.fieldName)
    ?.units ?? '';
}

export function getSignalDisplayUnit(
  registry: MavlinkMetadataRegistry,
  signal: SignalIdentity,
  unitProfile: UnitProfile,
): string {
  return getDisplayUnit(
    getSignalRawUnit(registry, signal),
    unitProfile,
    { fieldName: signal.fieldName },
  );
}

export function formatSignalDisplayLabel(
  registry: MavlinkMetadataRegistry,
  signal: PlotSignalConfig,
  unitProfile: UnitProfile,
): string {
  return formatSignalLabel(
    signal.fieldKey,
    getSignalRawUnit(registry, signal),
    unitProfile,
    { messageType: signal.messageType, fieldName: signal.fieldName },
  );
}
