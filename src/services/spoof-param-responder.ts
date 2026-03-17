/**
 * Simulated MAVLink parameter server for spoof/demo mode.
 *
 * Holds a set of parameter values and responds to PARAM_REQUEST_LIST,
 * PARAM_REQUEST_READ, and PARAM_SET messages by emitting PARAM_VALUE
 * response frames through the normal MAVLink wire protocol.
 */

import { MavlinkFrameBuilder } from '../mavlink/frame-builder';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { MavlinkMessage } from '../mavlink/decoder';

interface ParamEntry {
  paramId: string;
  value: number;
  paramType: number;  // 9 = MAV_PARAM_TYPE_REAL32
  paramIndex: number;
}

export class SpoofParamResponder {
  private readonly params: ParamEntry[] = [];
  private readonly frameBuilder: MavlinkFrameBuilder;
  private readonly systemId: number;
  private readonly componentId: number;

  constructor(registry: MavlinkMetadataRegistry, systemId = 1, componentId = 1) {
    this.frameBuilder = new MavlinkFrameBuilder(registry);
    this.systemId = systemId;
    this.componentId = componentId;
    this.initDefaultParams();
  }

  /** Handle a decoded outbound message. Returns response frames to emit. */
  handleMessage(msg: MavlinkMessage): Uint8Array[] {
    switch (msg.name) {
      case 'PARAM_REQUEST_LIST': return this.handleRequestList();
      case 'PARAM_REQUEST_READ': return this.handleRequestRead(msg);
      case 'PARAM_SET': return this.handleParamSet(msg);
      default: return [];
    }
  }

  private handleRequestList(): Uint8Array[] {
    return this.params.map(p => this.buildParamValue(p));
  }

  private handleRequestRead(msg: MavlinkMessage): Uint8Array[] {
    const paramIndex = msg.values.param_index as number;
    const paramId = (msg.values.param_id as string).replace(/\0/g, '');

    let param: ParamEntry | undefined;
    if (paramIndex >= 0) {
      param = this.params[paramIndex];
    } else {
      param = this.params.find(p => p.paramId === paramId);
    }

    if (!param) return [];
    return [this.buildParamValue(param)];
  }

  private handleParamSet(msg: MavlinkMessage): Uint8Array[] {
    const paramId = (msg.values.param_id as string).replace(/\0/g, '');
    const newValue = msg.values.param_value as number;

    const param = this.params.find(p => p.paramId === paramId);
    if (!param) return [];

    param.value = newValue;
    return [this.buildParamValue(param)];
  }

  private buildParamValue(param: ParamEntry): Uint8Array {
    return this.frameBuilder.buildFrame({
      messageName: 'PARAM_VALUE',
      values: {
        param_id: param.paramId,
        param_value: param.value,
        param_type: param.paramType,
        param_count: this.params.length,
        param_index: param.paramIndex,
      },
      systemId: this.systemId,
      componentId: this.componentId,
      sequence: 0,
    });
  }

  private initDefaultParams(): void {
    const defaults: ReadonlyArray<{ id: string; value: number }> = [
      { id: 'WM_MAX_ROLL', value: 0.7 },
      { id: 'WM_MAX_DIVE', value: 0.9 },
      { id: 'SCL_RFADE_EN', value: 0 },
      { id: 'SCL_RFADE_VEL', value: 7.5 },
      { id: 'SCL_TFADE_EN', value: 0 },
      { id: 'SCL_TFADE_STA', value: 11.0 },
      { id: 'SCL_TFADE_END', value: 15.0 },
      { id: 'SCL_DIVEROLL', value: 0.5 },
      { id: 'JS_RATE_LIM', value: 1.0 },
      { id: 'JS_TRIM_INC', value: 0.02 },
      { id: 'JS_TRIM_FRAC', value: 0.0 },
      { id: 'JS_DEADBAND', value: 0.05 },
      { id: 'JS_THUMB_DIR', value: 1 },
      { id: 'UM_MAX_TORQUE', value: 0.8 },
      { id: 'PA_MIN', value: 0.2 },
      { id: 'PA_NEUTRAL', value: 0.4 },
      { id: 'PA_MAX', value: 0.6 },
      { id: 'PA_DIR', value: -1 },
      { id: 'SA_MIN', value: 0.2 },
      { id: 'SA_NEUTRAL', value: 0.4 },
      { id: 'SA_MAX', value: 0.6 },
      { id: 'SA_DIR', value: -1 },
      { id: 'RA_MIN', value: 0.2 },
      { id: 'RA_NEUTRAL', value: 0.5 },
      { id: 'RA_MAX', value: 0.8 },
      { id: 'RA_DIR', value: -1 },
      // Array parameters: pitch FF velocity breakpoints
      { id: 'SCL_PFF_V0', value: 0.0 },
      { id: 'SCL_PFF_V1', value: 5.0 },
      { id: 'SCL_PFF_V2', value: 10.0 },
      { id: 'SCL_PFF_V3', value: 15.0 },
      { id: 'SCL_PFF_V4', value: 20.0 },
      // Array parameters: pitch FF coefficients
      { id: 'SCL_PFF_C0', value: 0.0 },
      { id: 'SCL_PFF_C1', value: 0.0 },
      { id: 'SCL_PFF_C2', value: 0.0 },
      { id: 'SCL_PFF_C3', value: 0.0 },
      { id: 'SCL_PFF_C4', value: 0.0 },
    ];

    for (let i = 0; i < defaults.length; i++) {
      this.params.push({
        paramId: defaults[i].id,
        value: defaults[i].value,
        paramType: 9, // MAV_PARAM_TYPE_REAL32
        paramIndex: i,
      });
    }
  }
}
