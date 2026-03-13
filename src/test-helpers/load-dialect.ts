/**
 * Test helper — loads bundled XML dialect files and parses to JSON string.
 * Used by tests that need a registry-compatible JSON string.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseFromFileMap } from '../mavlink/xml-parser';

const DIALECTS_DIR = resolve(__dirname, '../../public/dialects');

export function loadCommonDialectJson(): string {
  const fileMap = new Map<string, string>();
  fileMap.set('common.xml', readFileSync(resolve(DIALECTS_DIR, 'common.xml'), 'utf-8'));
  fileMap.set('standard.xml', readFileSync(resolve(DIALECTS_DIR, 'standard.xml'), 'utf-8'));
  fileMap.set('minimal.xml', readFileSync(resolve(DIALECTS_DIR, 'minimal.xml'), 'utf-8'));
  return parseFromFileMap(fileMap, 'common.xml');
}
