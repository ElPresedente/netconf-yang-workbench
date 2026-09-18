import type { Datastore, RequestIntent, SchemaNode, WithDefaultsMode } from '../../../../shared/types';
export const emptyRequest = (): RequestIntent => ({ operation: 'get', datastore: null, withDefaults: null, selectedPaths: [], listKeyValues: {} });
export function supportedDatastores(capabilities: string[]): Datastore[] {
  const caps = new Set(capabilities.map(c => c.split('?')[0]));
  return ['running', ...(['candidate', 'startup'] as const).filter(d => caps.has(`urn:ietf:params:netconf:capability:${d}:1.0`))];
}
export function relevantLists(roots: SchemaNode[], paths: string[]): SchemaNode[] {
  const selected = new Set(paths), lists: SchemaNode[] = [];
  function visit(node: SchemaNode): boolean {
    // Selecting a subtree includes all entries below it, without nested key filters.
    // Only the selected list itself and lists on its ancestor path need inputs.
    const explicit = selected.has(node.path);
    const descendants = explicit ? [] : node.children.map(visit);
    const relevant = explicit || descendants.some(Boolean);
    if (relevant && node.kind === 'list' && node.keys.length) lists.push(node);
    return relevant;
  }
  roots.forEach(visit);
  return lists;
}

// null means the capability is absent; an empty array means no valid modes advertised.
export function supportedWithDefaults(capabilities: string[]): WithDefaultsMode[] | null {
  const uri = capabilities.find(c => c.split('?')[0] === 'urn:ietf:params:netconf:capability:with-defaults:1.0');
  if (uri === undefined) return null;
  // Match ncclient's literal capability parameter parsing.
  const params = Object.fromEntries((uri.split('?')[1] || '').split('&').map(p => p.split('=')).filter(p => p.length === 2));
  const valid = (mode: string): mode is WithDefaultsMode => ['report-all', 'trim', 'explicit', 'report-all-tagged'].includes(mode);
  if (!valid(params['basic-mode'])) return [];
  return [...new Set([params['basic-mode'], ...(params['also-supported'] || '').split(',')].filter(valid))];
}
