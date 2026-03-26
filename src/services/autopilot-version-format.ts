const SW_VERSION_FIELDS = new Set([
  'flight_sw_version',
  'middleware_sw_version',
  'os_sw_version',
]);

const CUSTOM_VERSION_FIELDS = new Set([
  'flight_custom_version',
  'middleware_custom_version',
  'os_custom_version',
]);

const VERSION_TYPE_LABELS: Record<number, string> = {
  0: 'dev',
  64: 'alpha',
  128: 'beta',
  192: 'rc',
  // 255 = official → no suffix
};

function formatSwVersion(value: number): string | null {
  if (value === 0) return null;
  const major = (value >>> 24) & 0xFF;
  const minor = (value >>> 16) & 0xFF;
  const patch = (value >>> 8) & 0xFF;
  const type = value & 0xFF;
  const suffix = VERSION_TYPE_LABELS[type];
  return suffix ? `v${major}.${minor}.${patch}-${suffix}` : `v${major}.${minor}.${patch}`;
}

function formatCustomVersion(bytes: number[]): string | null {
  if (bytes.every(b => b === 0)) return null;
  // ASCII git hash bytes — trim trailing nulls
  const end = bytes.indexOf(0);
  const chars = end === -1 ? bytes : bytes.slice(0, end);
  return String.fromCharCode(...chars);
}

function formatUid(value: number): string | null {
  if (value === 0) return null;
  return '0x' + value.toString(16).toUpperCase().padStart(16, '0');
}

function readLeUint32(bytes: number[], offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    ((bytes[offset + 3] << 24) >>> 0)  // >>> 0 to ensure unsigned
  );
}

function formatUid2(bytes: number[]): string | null {
  if (bytes.every(b => b === 0)) return null;
  // Read 3 LE uint32s, display in reverse word order: word2, word1, word0
  const word0 = readLeUint32(bytes, 0);
  const word1 = readLeUint32(bytes, 4);
  const word2 = readLeUint32(bytes, 8);
  return (
    word2.toString(16).toUpperCase().padStart(8, '0') +
    word1.toString(16).toUpperCase().padStart(8, '0') +
    word0.toString(16).toUpperCase().padStart(8, '0')
  );
}

/**
 * Format AUTOPILOT_VERSION fields for human-readable display.
 * Returns null if the field doesn't need special formatting.
 */
export function formatAutopilotVersionField(
  fieldName: string,
  value: number | string | number[],
): string | null {
  if (SW_VERSION_FIELDS.has(fieldName) && typeof value === 'number') {
    return formatSwVersion(value);
  }
  if (CUSTOM_VERSION_FIELDS.has(fieldName) && Array.isArray(value)) {
    return formatCustomVersion(value);
  }
  if (fieldName === 'uid' && typeof value === 'number') {
    return formatUid(value);
  }
  if (fieldName === 'uid2' && Array.isArray(value)) {
    return formatUid2(value);
  }
  return null;
}
