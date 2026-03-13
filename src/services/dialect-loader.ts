import { parseFromFileMap, normalizeDialectFilename } from '../mavlink/xml-parser';
import type { MavlinkWorkerBridge } from './worker-bridge';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';

/** Fetch bundled XML dialect files and parse to JSON string. */
export async function loadBundledDialect(): Promise<string> {
  const fileMap = new Map<string, string>();
  const [commonResp, standardResp, minimalResp] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}dialects/common.xml`),
    fetch(`${import.meta.env.BASE_URL}dialects/standard.xml`),
    fetch(`${import.meta.env.BASE_URL}dialects/minimal.xml`),
  ]);
  if (!commonResp.ok || !standardResp.ok || !minimalResp.ok) {
    throw new Error('Failed to load bundled dialect XML files');
  }
  fileMap.set('common.xml', await commonResp.text());
  fileMap.set('standard.xml', await standardResp.text());
  fileMap.set('minimal.xml', await minimalResp.text());
  return parseFromFileMap(fileMap, 'common.xml');
}

/** Initialize both the worker bridge and metadata registry with a dialect JSON string. */
export async function initDialect(
  workerBridge: MavlinkWorkerBridge,
  registry: MavlinkMetadataRegistry,
  json: string,
): Promise<void> {
  await workerBridge.init(json);
  registry.loadFromJsonString(json);
}

/**
 * Detect dialect XML files referenced by `<include>` elements but not present in the file map.
 * Returns a deduplicated list of missing filenames.
 */
export function detectMissingIncludes(fileMap: Map<string, string>): string[] {
  const parser = new DOMParser();
  const missing: string[] = [];
  for (const [, content] of fileMap) {
    const doc = parser.parseFromString(content, 'text/xml');
    for (const el of doc.querySelectorAll('include')) {
      const inc = el.textContent?.trim() ?? '';
      const normalized = normalizeDialectFilename(inc);
      if (normalized && !fileMap.has(normalized)) {
        missing.push(normalized);
      }
    }
  }
  return [...new Set(missing)];
}

/**
 * Auto-detect the main (root) dialect file from a set of XML files.
 * The main file is the one not referenced by any other file's `<include>` elements.
 */
export function detectMainDialect(fileMap: Map<string, string>): string {
  const filenames = [...fileMap.keys()];
  if (filenames.length === 1) return filenames[0];

  // Collect all included filenames across all files
  const included = new Set<string>();
  const parser = new DOMParser();
  for (const [, content] of fileMap) {
    const doc = parser.parseFromString(content, 'text/xml');
    const els = doc.querySelectorAll('include');
    for (const el of els) {
      const inc = el.textContent?.trim() ?? '';
      const normalized = normalizeDialectFilename(inc);
      included.add(normalized);
    }
  }

  // Main file = not referenced by any include
  const roots = filenames.filter(f => !included.has(f));
  if (roots.length === 1) return roots[0];
  if (roots.length > 1) {
    throw new Error(
      `Multiple root dialects found: ${roots.join(', ')}. Select only the main dialect and its dependencies.`
    );
  }
  throw new Error(
    `Cannot auto-detect main dialect. Files: ${filenames.join(', ')}. All appear in include chains: ${[...included].join(', ')}.`
  );
}
