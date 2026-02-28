import { describe, it, expect } from 'vitest';
import { parseFromFileMap } from '../xml-parser';
import { MavlinkMetadataRegistry } from '../registry';

const HEARTBEAT_XML = `<?xml version="1.0"?>
<mavlink>
  <enums>
    <enum name="MAV_TYPE">
      <description>Vehicle type</description>
      <entry value="0" name="MAV_TYPE_GENERIC"><description>Generic</description></entry>
      <entry value="2" name="MAV_TYPE_QUADROTOR"><description>Quadrotor</description></entry>
    </enum>
    <enum name="MAV_AUTOPILOT">
      <description>Autopilot type</description>
      <entry value="0" name="MAV_AUTOPILOT_GENERIC"><description>Generic</description></entry>
      <entry value="3" name="MAV_AUTOPILOT_ARDUPILOTMEGA"><description>ArduPilot</description></entry>
    </enum>
  </enums>
  <messages>
    <message id="0" name="HEARTBEAT">
      <description>Heartbeat message</description>
      <field type="uint8_t" name="type" enum="MAV_TYPE">Vehicle type</field>
      <field type="uint8_t" name="autopilot" enum="MAV_AUTOPILOT">Autopilot type</field>
      <field type="uint8_t" name="base_mode">Base mode flags</field>
      <field type="uint32_t" name="custom_mode">Custom mode</field>
      <field type="uint8_t" name="system_status">System status</field>
      <field type="uint8_t_mavlink_version" name="mavlink_version">MAVLink version</field>
    </message>
  </messages>
</mavlink>`;

const EXTENSION_XML = `<?xml version="1.0"?>
<mavlink>
  <messages>
    <message id="100" name="TEST_EXTENSIONS">
      <description>Test message with extensions</description>
      <field type="uint32_t" name="time_boot_ms">Timestamp</field>
      <field type="uint8_t" name="status">Status</field>
      <extensions/>
      <field type="float" name="extra_value">Extension field</field>
    </message>
  </messages>
</mavlink>`;

const BASE_XML = `<?xml version="1.0"?>
<mavlink>
  <enums>
    <enum name="BASE_ENUM">
      <entry value="0" name="BASE_ZERO"><description>Zero</description></entry>
    </enum>
  </enums>
  <messages>
    <message id="200" name="BASE_MSG">
      <description>Base message</description>
      <field type="uint16_t" name="value">A value</field>
    </message>
  </messages>
</mavlink>`;

const CHILD_XML = `<?xml version="1.0"?>
<mavlink>
  <include>base.xml</include>
  <messages>
    <message id="201" name="CHILD_MSG">
      <description>Child message</description>
      <field type="uint32_t" name="data">Some data</field>
    </message>
  </messages>
</mavlink>`;

describe('parseFromFileMap', () => {
  it('parses a minimal XML with one message and produces valid JSON', () => {
    const files = new Map([['heartbeat.xml', HEARTBEAT_XML]]);
    const json = parseFromFileMap(files, 'heartbeat.xml');
    const parsed = JSON.parse(json);

    expect(parsed.schema_version).toBe('1.0.0');
    expect(parsed.dialect.name).toBe('heartbeat');
    expect(parsed.messages).toBeDefined();
    expect(parsed.enums).toBeDefined();
    expect(parsed.messages['0']).toBeDefined();
    expect(parsed.messages['0'].name).toBe('HEARTBEAT');
  });

  it('computes CRC extra for HEARTBEAT as 50', () => {
    const files = new Map([['test.xml', HEARTBEAT_XML]]);
    const json = parseFromFileMap(files, 'test.xml');
    const parsed = JSON.parse(json);

    expect(parsed.messages['0'].crc_extra).toBe(50);
  });

  it('reorders fields: uint32_t sorts before uint8_t', () => {
    const files = new Map([['test.xml', HEARTBEAT_XML]]);
    const json = parseFromFileMap(files, 'test.xml');
    const parsed = JSON.parse(json);

    const fields = parsed.messages['0'].fields;
    // custom_mode (uint32_t, 4 bytes) should come first
    expect(fields[0].name).toBe('custom_mode');
    expect(fields[0].base_type).toBe('uint32_t');
    // Then the uint8_t fields
    expect(fields[1].base_type).toBe('uint8_t');
  });

  it('calculates correct offsets after reordering', () => {
    const files = new Map([['test.xml', HEARTBEAT_XML]]);
    const json = parseFromFileMap(files, 'test.xml');
    const parsed = JSON.parse(json);

    const fields = parsed.messages['0'].fields;
    // custom_mode (uint32_t): offset 0, size 4
    expect(fields[0].name).toBe('custom_mode');
    expect(fields[0].offset).toBe(0);
    expect(fields[0].size).toBe(4);
    // First uint8_t field: offset 4
    expect(fields[1].offset).toBe(4);
    expect(fields[1].size).toBe(1);
  });

  it('computes correct encoded_length', () => {
    const files = new Map([['test.xml', HEARTBEAT_XML]]);
    const json = parseFromFileMap(files, 'test.xml');
    const parsed = JSON.parse(json);

    // HEARTBEAT: 1 uint32_t (4) + 5 uint8_t (5) = 9
    expect(parsed.messages['0'].encoded_length).toBe(9);
  });

  it('extension fields come after non-extension fields with correct offsets', () => {
    const files = new Map([['test.xml', EXTENSION_XML]]);
    const json = parseFromFileMap(files, 'test.xml');
    const parsed = JSON.parse(json);

    const fields = parsed.messages['100'].fields;
    // Non-extension: uint32_t (offset 0, size 4), uint8_t (offset 4, size 1)
    const nonExt = fields.filter((f: Record<string, unknown>) => !f.extension);
    const ext = fields.filter((f: Record<string, unknown>) => f.extension);

    expect(nonExt.length).toBe(2);
    expect(ext.length).toBe(1);

    // uint32_t sorts first
    expect(nonExt[0].name).toBe('time_boot_ms');
    expect(nonExt[0].offset).toBe(0);
    expect(nonExt[1].name).toBe('status');
    expect(nonExt[1].offset).toBe(4);

    // Extension field comes after
    expect(ext[0].name).toBe('extra_value');
    expect(ext[0].offset).toBe(5); // after all non-extension fields
    expect(ext[0].extension).toBe(true);

    // encoded_length should only count non-extension fields
    expect(parsed.messages['100'].encoded_length).toBe(5);
  });

  it('resolves <include> tags across files', () => {
    const files = new Map([
      ['child.xml', CHILD_XML],
      ['base.xml', BASE_XML],
    ]);
    const json = parseFromFileMap(files, 'child.xml');
    const parsed = JSON.parse(json);

    // Child's own message
    expect(parsed.messages['201']).toBeDefined();
    expect(parsed.messages['201'].name).toBe('CHILD_MSG');

    // Included base message
    expect(parsed.messages['200']).toBeDefined();
    expect(parsed.messages['200'].name).toBe('BASE_MSG');

    // Included base enum
    expect(parsed.enums['BASE_ENUM']).toBeDefined();
  });

  it('parses enums with correct entries', () => {
    const files = new Map([['test.xml', HEARTBEAT_XML]]);
    const json = parseFromFileMap(files, 'test.xml');
    const parsed = JSON.parse(json);

    const mavType = parsed.enums['MAV_TYPE'];
    expect(mavType).toBeDefined();
    expect(mavType.entries['2'].name).toBe('MAV_TYPE_QUADROTOR');
    expect(mavType.bitmask).toBe(false);
  });

  it('parse result is loadable by MavlinkMetadataRegistry', () => {
    const files = new Map([['test.xml', HEARTBEAT_XML]]);
    const json = parseFromFileMap(files, 'test.xml');

    const registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(json);

    expect(registry.messageCount).toBe(1);
    const heartbeat = registry.getMessageById(0);
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.name).toBe('HEARTBEAT');
    expect(heartbeat!.crcExtra).toBe(50);
    expect(heartbeat!.encodedLength).toBe(9);
    expect(heartbeat!.fields.length).toBe(6);

    expect(registry.resolveEnumValue('MAV_TYPE', 2)).toBe('MAV_TYPE_QUADROTOR');
  });

  it('throws for missing main file', () => {
    const files = new Map<string, string>();
    expect(() => parseFromFileMap(files, 'missing.xml')).toThrow('Main file not found');
  });

  it('handles missing include files gracefully', () => {
    const xml = `<?xml version="1.0"?>
<mavlink>
  <include>nonexistent.xml</include>
  <messages>
    <message id="1" name="TEST">
      <description>Test</description>
      <field type="uint8_t" name="val">Value</field>
    </message>
  </messages>
</mavlink>`;

    const files = new Map([['test.xml', xml]]);
    // Should not throw — missing includes are silently skipped
    const json = parseFromFileMap(files, 'test.xml');
    const parsed = JSON.parse(json);
    expect(parsed.messages['1']).toBeDefined();
  });
});
