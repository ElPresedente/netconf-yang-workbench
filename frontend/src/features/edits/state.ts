import type { CandidateAction, DataNode, EditIntent, RetrievalProvenance, SchemaNode } from '../../../../shared/types';
export const emptyEdit = (): EditIntent => ({ target: 'candidate', defaultOperation: 'none', testOption: null, errorOption: null, changes: [] });
export function editCapabilities(capabilities: string[]) {
  const caps = new Set(capabilities.map(c => c.split('?')[0]));
  const has = (name: string) => caps.has(`urn:ietf:params:netconf:capability:${name}`);
  const validateVersion = has('validate:1.1') ? '1.1' : has('validate:1.0') ? '1.0' : null;
  return {
    editableTargets: (['candidate', 'running'] as const).filter(d => has(`${d === 'running' ? 'writable-running' : d}:1.0`)),
    supportsRollbackOnError: has('rollback-on-error:1.0'), validateVersion,
    supportedTestOptions: (validateVersion ? ['test-then-set', 'set', ...(validateVersion === '1.1' ? ['test-only'] : [])] : []) as NonNullable<EditIntent['testOption']>[],
  };
}
export function schemaChain(roots: SchemaNode[], path: string): SchemaNode[] {
  for (const node of roots) {
    if (node.path === path) return [node];
    const children = schemaChain(node.children, path);
    if (children.length) return [node, ...children];
  }
  return [];
}
export function runtimeKeys(roots: DataNode[], id: string): EditIntent['changes'][number]['ancestorKeys'] | null {
  for (const node of roots) {
    const own = node.kind === 'list' ? [{ listSchemaPath: node.schemaPath, values: node.keyValues }] : [];
    if (node.id === id) return own;
    const below = runtimeKeys(node.children, id);
    if (below !== null) return [...own, ...below];
  }
  return null;
}
export function editable(node: SchemaNode) { return node.config && !node.isKey && ['leaf', 'list', 'container'].includes(node.kind); }
export function afterEdit(previous: RetrievalProvenance | null, edit: EditIntent): RetrievalProvenance | null {
  if (!previous || edit.testOption === 'test-only') return previous;
  const affected = previous.operation === 'get' ? edit.target === 'running' : previous.datastore === edit.target;
  return affected ? { ...previous, stale: true } : previous;
}

// Apply on every attempt: a failure may leave the outcome uncertain.
export function afterCandidate(previous: RetrievalProvenance | null, action: CandidateAction): RetrievalProvenance | null {
  if (!previous) return previous;
  const affected = previous.operation === 'get' ? action === 'commit'
    : previous.datastore === 'candidate' || action === 'commit' && previous.datastore === 'running';
  return affected ? { ...previous, stale: true } : previous;
}
