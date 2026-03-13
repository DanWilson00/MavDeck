import { describe, expect, it } from 'vitest';
import { convertDisplayValue, formatDisplayValue, getDisplayUnit } from '../unit-display';

describe('unit-display', () => {
  it('keeps values and units untouched in raw mode', () => {
    expect(convertDisplayValue(Math.PI, 'rad', 'raw')).toBe(Math.PI);
    expect(getDisplayUnit('rad', 'raw')).toBe('rad');
    expect(convertDisplayValue(1200, 'mm', 'raw', { fieldName: 'alt' })).toBe(1200);
    expect(getDisplayUnit('degE7', 'raw')).toBe('degE7');
  });

  it('converts metric-friendly engineering units', () => {
    expect(convertDisplayValue(Math.PI, 'rad', 'metric')).toBeCloseTo(180);
    expect(getDisplayUnit('rad', 'metric')).toBe('deg');
    expect(convertDisplayValue(2500, 'mm', 'metric', { fieldName: 'alt' })).toBeCloseTo(2.5);
    expect(getDisplayUnit('mm', 'metric', { fieldName: 'alt' })).toBe('m');
    expect(convertDisplayValue(123456789, 'degE7', 'metric')).toBeCloseTo(12.3456789);
  });

  it('converts imperial and aviation units', () => {
    expect(convertDisplayValue(1000, 'mm', 'imperial', { fieldName: 'alt' })).toBeCloseTo(3.28084, 4);
    expect(getDisplayUnit('mm', 'imperial', { fieldName: 'alt' })).toBe('ft');
    expect(convertDisplayValue(10, 'm/s', 'aviation')).toBeCloseTo(19.4384, 4);
    expect(getDisplayUnit('m/s', 'aviation')).toBe('kt');
    expect(convertDisplayValue(1852, 'm', 'aviation', { fieldName: 'distance_to_home' })).toBeCloseTo(1);
    expect(getDisplayUnit('m', 'aviation', { fieldName: 'distance_to_home' })).toBe('nm');
  });

  it('leaves unsupported units unchanged', () => {
    expect(convertDisplayValue(12, 'V', 'metric')).toBe(12);
    expect(getDisplayUnit('V', 'metric')).toBe('V');
  });

  it('covers real common.xml unit cases', () => {
    expect(convertDisplayValue(Math.PI / 2, 'rad', 'metric')).toBeCloseTo(90);
    expect(convertDisplayValue(75000, 'mm', 'aviation', { fieldName: 'alt' })).toBeCloseTo(246.063, 3);
    expect(convertDisplayValue(123456789, 'degE7', 'imperial')).toBeCloseTo(12.3456789);
    expect(convertDisplayValue(1234, 'cdeg', 'metric', { fieldName: 'hdg' })).toBeCloseTo(12.34);
  });

  it('formats display values by unit and surface', () => {
    expect(formatDisplayValue(246.063, 'ft', 'monitor', { fieldName: 'alt' })).toBe('246');
    expect(formatDisplayValue(246.063, 'ft', 'plot', { fieldName: 'alt' })).toBe('246.1');
    expect(formatDisplayValue(19.4384, 'kt', 'plot', { fieldName: 'groundspeed' })).toBe('19.4');
    expect(formatDisplayValue(12.3456789, 'deg', 'map', { fieldName: 'lat' })).toBe('12.345679');
    expect(formatDisplayValue(12.34, 'deg', 'map', { fieldName: 'hdg' })).toBe('12.3');
    expect(formatDisplayValue(2.5, 'm', 'monitor', { fieldName: 'alt' })).toBe('2.5');
  });
});
