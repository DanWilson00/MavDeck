/**
 * Spoof byte source for testing without real MAVLink hardware.
 *
 * Generates realistic MAVLink telemetry frames at configurable rates.
 * Simulates a vehicle flying a figure-8 pattern over Los Angeles
 * with realistic attitude, position, and system status updates.
 */

import type { ByteCallback, IByteSource } from './byte-source';
import { MavlinkFrameBuilder } from '../mavlink/frame-builder';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';

/** Status text entries with severity levels. */
const STATUS_MESSAGES: ReadonlyArray<readonly [number, string]> = [
  [6, 'All systems nominal'],
  [6, 'GPS lock acquired'],
  [6, 'Battery voltage nominal'],
  [6, 'Telemetry link stable'],
  [5, 'Altitude hold active'],
  [5, 'Navigation mode enabled'],
  [6, 'Sensor calibration complete'],
  [4, 'Low battery warning'],
  [3, 'Engine temperature high'],
  [2, 'Critical: IMU failure'],
] as const;

/** Degrees-to-radians conversion factor. */
const DEG_TO_RAD = Math.PI / 180;

/** Meters per degree of latitude at equator. */
const METERS_PER_DEG_LAT = 111320;

/** Minimum STATUSTEXT interval in seconds. */
const STATUS_MIN_DELAY_S = 3;

/** Maximum STATUSTEXT interval in seconds. */
const STATUS_MAX_DELAY_S = 8;

export class SpoofByteSource implements IByteSource {
  private readonly registry: MavlinkMetadataRegistry;
  private readonly frameBuilder: MavlinkFrameBuilder;
  private readonly callbacks = new Set<ByteCallback>();

  private readonly systemId: number;
  private readonly componentId: number;

  // Timer handles
  private fastTelemetryTimer: ReturnType<typeof setInterval> | null = null;
  private slowTelemetryTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private statusTextTimer: ReturnType<typeof setTimeout> | null = null;

  private _isConnected = false;
  private sequenceNumber = 0;

  // Simulation state
  private simulationTime = 0;
  private latitude = 34.0522;
  private longitude = -118.2437;
  private altitude = 75.0;     // Start in middle of [50, 100] range
  private groundSpeed = 15.0;  // Start in middle of [5, 25] range
  private heading = 0;
  private roll = 0;            // radians
  private pitch = 0;           // radians
  private yaw = 0;             // radians
  private batteryVoltage = 12.6;
  private throttle = 50;
  private statusTextIndex = 0;

  constructor(
    registry: MavlinkMetadataRegistry,
    systemId = 1,
    componentId = 1,
  ) {
    this.registry = registry;
    this.frameBuilder = new MavlinkFrameBuilder(registry);
    this.systemId = systemId;
    this.componentId = componentId;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onData(callback: ByteCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  async connect(): Promise<void> {
    if (this._isConnected) {
      await this.disconnect();
    }

    this._isConnected = true;

    // Fast telemetry at 10 Hz: ATTITUDE, GLOBAL_POSITION_INT, VFR_HUD
    this.fastTelemetryTimer = setInterval(
      () => this.generateFastTelemetry(),
      100,
    );

    // Slow telemetry at 1 Hz: SYS_STATUS
    this.slowTelemetryTimer = setInterval(
      () => this.generateSlowTelemetry(),
      1000,
    );

    // Heartbeat at 1 Hz
    this.heartbeatTimer = setInterval(
      () => this.generateHeartbeat(),
      1000,
    );

    // STATUSTEXT at random 3-8s intervals
    this.scheduleNextStatusText();
  }

  async write(_data: Uint8Array): Promise<void> {
    // No-op stub — Phase 2 will implement loopback
  }

  async disconnect(): Promise<void> {
    if (this.fastTelemetryTimer !== null) {
      clearInterval(this.fastTelemetryTimer);
      this.fastTelemetryTimer = null;
    }
    if (this.slowTelemetryTimer !== null) {
      clearInterval(this.slowTelemetryTimer);
      this.slowTelemetryTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.statusTextTimer !== null) {
      clearTimeout(this.statusTextTimer);
      this.statusTextTimer = null;
    }
    this._isConnected = false;
  }

  // -------------------------------------------------------------------
  // Private: frame emission
  // -------------------------------------------------------------------

  private emitMessage(
    messageName: string,
    values: Record<string, number | string | number[]>,
  ): void {
    if (!this._isConnected) return;

    const frame = this.frameBuilder.buildFrame({
      messageName,
      values,
      systemId: this.systemId,
      componentId: this.componentId,
      sequence: this.nextSequence(),
    });

    for (const cb of this.callbacks) {
      cb(frame);
    }
  }

  private nextSequence(): number {
    const seq = this.sequenceNumber;
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFF;
    return seq;
  }

  // -------------------------------------------------------------------
  // Private: telemetry generation
  // -------------------------------------------------------------------

  private generateFastTelemetry(): void {
    if (!this._isConnected) return;

    this.simulationTime += 100;
    const timeBootMs = this.simulationTime;
    const timeInSeconds = this.simulationTime / 1000;

    // Update simulation state
    this.updateSimulationState(timeInSeconds);

    const headingRad = this.heading * DEG_TO_RAD;

    // GLOBAL_POSITION_INT (#33)
    this.emitMessage('GLOBAL_POSITION_INT', {
      time_boot_ms: timeBootMs,
      lat: Math.round(this.latitude * 1e7),
      lon: Math.round(this.longitude * 1e7),
      alt: Math.round(this.altitude * 1000),
      relative_alt: Math.round(this.altitude * 1000),
      vx: Math.round(this.groundSpeed * Math.cos(headingRad) * 100),
      vy: Math.round(this.groundSpeed * Math.sin(headingRad) * 100),
      vz: 0,
      hdg: Math.round(this.heading * 100),
    });

    // ATTITUDE (#30)
    this.emitMessage('ATTITUDE', {
      time_boot_ms: timeBootMs,
      roll: this.roll,
      pitch: this.pitch,
      yaw: this.yaw,
      rollspeed: 0,
      pitchspeed: 0,
      yawspeed: 0,
    });

    // VFR_HUD (#74)
    this.emitMessage('VFR_HUD', {
      airspeed: this.groundSpeed,
      groundspeed: this.groundSpeed,
      heading: Math.round(this.heading),
      throttle: this.throttle,
      alt: this.altitude,
      climb: 0,
    });
  }

  private generateSlowTelemetry(): void {
    if (!this._isConnected) return;

    // Battery slow drain
    this.batteryVoltage -= 0.001;
    this.batteryVoltage = clamp(this.batteryVoltage, 10.0, 13.0);

    this.emitMessage('SYS_STATUS', {
      onboard_control_sensors_present: 0x7FF,
      onboard_control_sensors_enabled: 0x7FF,
      onboard_control_sensors_health: 0x7FF,
      load: 100,
      voltage_battery: Math.round(this.batteryVoltage * 1000),
      current_battery: -1,
      battery_remaining: 85,
      drop_rate_comm: 0,
      errors_comm: 0,
      errors_count1: 0,
      errors_count2: 0,
      errors_count3: 0,
      errors_count4: 0,
    });
  }

  private generateHeartbeat(): void {
    if (!this._isConnected) return;

    this.emitMessage('HEARTBEAT', {
      type: 2,              // MAV_TYPE_QUADROTOR
      autopilot: 3,         // MAV_AUTOPILOT_ARDUPILOTMEGA
      base_mode: 0x81,
      custom_mode: 0,
      system_status: 4,     // MAV_STATE_ACTIVE
      mavlink_version: 3,
    });
  }

  private scheduleNextStatusText(): void {
    if (!this._isConnected) return;

    const delayMs = (STATUS_MIN_DELAY_S +
      Math.floor(Math.random() * (STATUS_MAX_DELAY_S - STATUS_MIN_DELAY_S + 1))) * 1000;

    this.statusTextTimer = setTimeout(() => {
      this.generateStatusText();
      this.scheduleNextStatusText();
    }, delayMs);
  }

  private generateStatusText(): void {
    if (!this._isConnected) return;

    const [severity, text] = STATUS_MESSAGES[this.statusTextIndex % STATUS_MESSAGES.length];
    this.statusTextIndex++;

    this.emitMessage('STATUSTEXT', {
      severity,
      text,
    });
  }

  // -------------------------------------------------------------------
  // Private: simulation model
  // -------------------------------------------------------------------

  private updateSimulationState(timeInSeconds: number): void {
    // Altitude random walk bounded [50, 100]m
    this.altitude += (Math.random() - 0.5) * 0.1;  // +-0.05
    this.altitude = clamp(this.altitude, 50, 100);

    // Groundspeed random walk bounded [5, 25] m/s
    this.groundSpeed += (Math.random() - 0.5) * 0.6;  // +-0.3
    this.groundSpeed = clamp(this.groundSpeed, 5, 25);

    // Heading: figure-8 pattern
    const baseHeading = (timeInSeconds * 15) % 360;
    const headingVariation = 30 * Math.sin(timeInSeconds * 0.5);
    this.heading = ((baseHeading + headingVariation) % 360 + 360) % 360;

    // Roll random walk bounded [-20deg, 20deg] in radians
    this.roll += (Math.random() - 0.5) * 0.1;  // +-0.05 rad
    this.roll = clamp(this.roll, -20 * DEG_TO_RAD, 20 * DEG_TO_RAD);

    // Pitch random walk bounded [-15deg, 15deg] in radians
    this.pitch += (Math.random() - 0.5) * 0.1;  // +-0.05 rad
    this.pitch = clamp(this.pitch, -15 * DEG_TO_RAD, 15 * DEG_TO_RAD);

    // Yaw follows heading
    this.yaw = this.heading * DEG_TO_RAD;

    // GPS position update
    const headingRad = this.heading * DEG_TO_RAD;
    const latRad = this.latitude * DEG_TO_RAD;
    this.latitude += (this.groundSpeed * Math.cos(headingRad) * 0.1) / METERS_PER_DEG_LAT;
    this.longitude += (this.groundSpeed * Math.sin(headingRad) * 0.1) / (METERS_PER_DEG_LAT * Math.cos(latRad));

    // Throttle random walk bounded [0, 100]
    this.throttle += Math.round((Math.random() - 0.5) * 10);
    this.throttle = clamp(this.throttle, 0, 100);
  }
}

/** Clamp a value to the range [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
