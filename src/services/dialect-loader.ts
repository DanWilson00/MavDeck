import { parseFromFileMap } from '../mavlink/xml-parser';

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
