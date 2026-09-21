import type { DataNode, EditChange, EditOperation, SchemaNode } from '../../../../shared/types';
import { editable, runtimeKeys, schemaChain } from './state';

// UI identity survives incomplete/edited keys. Wire identity is always schema + ordered keys.
export interface DraftNode {
  id: string; schema: SchemaNode; children: DraftNode[];
  value: string | null; original?: string | null; existing: boolean;
  included: boolean; operation: EditOperation; instancePath?: string;
}
const make = (schema: SchemaNode, existing = false): DraftNode => ({
  id: crypto.randomUUID(), schema, children: [], value: null, existing, included: false,
  operation: schema.kind === 'list' && !existing ? 'create' : 'merge',
});
export function canAdd(roots: SchemaNode[], node: SchemaNode) {
  return editable(node) && schemaChain(roots, node.path).every(n => n.config && (n.kind !== 'list' || n.keys.length > 0));
}
function keys(node: DraftNode, values: Record<string, string> = {}) {
  node.children = node.schema.keys.map(name => {
    const schema = node.schema.children.find(c => c.isKey && c.name === name)!;
    return { ...make(schema, node.existing), value: values[name] ?? null };
  });
}
export function updateNode(tree: DraftNode[], id: string, change: (n: DraftNode) => DraftNode): DraftNode[] {
  return tree.map(n => n.id === id ? change(n) : { ...n, children: updateNode(n.children, id, change) });
}
export function removeNode(tree: DraftNode[], id: string): DraftNode[] {
  return tree.filter(n => n.id !== id).map(n => ({ ...n, children: removeNode(n.children, id) }));
}
export function setValue(tree: DraftNode[], id: string, value: string): DraftNode[] {
  return updateNode(tree, id, n => n.schema.isKey && n.existing ? n : { ...n, value, included: n.schema.isKey ? false : n.included || !n.existing });
}
export function isIncluded(n: DraftNode) {
  return !n.schema.isKey && (n.included || n.existing && n.schema.kind === 'leaf' && n.value !== n.original);
}
export function addSchema(tree: DraftNode[], roots: SchemaNode[], path: string, parentId?: string): DraftNode[] {
  const chain = schemaChain(roots, path);
  if (!chain.length || !canAdd(roots, chain[chain.length - 1])) return tree;
  const copy = structuredClone(tree);
  let siblings = copy;
  let start = 0;
  if (parentId) {
    const find = (nodes: DraftNode[]): DraftNode | undefined => {
      for (const n of nodes) { if (n.id === parentId) return n; const child = find(n.children); if (child) return child; }
    };
    const parent = find(copy);
    if (!parent) return tree;
    start = chain.findIndex(n => n.path === parent.schema.path) + 1;
    if (!start) return tree;
    siblings = parent.children;
  }
  for (let i = start; i < chain.length; i++) {
    const schema = chain[i], target = i === chain.length - 1;
    let node = siblings.find(n => n.schema.path === schema.path && (schema.kind !== 'list' || !target && !n.existing));
    if (!node) {
      node = make(schema);
      if (schema.kind === 'list') { keys(node); node.included = true; }
      siblings.push(node);
    }
    if (target && (schema.kind !== 'container' || schema.presence)) node.included = true;
    siblings = node.children;
  }
  return copy;
}
export function addRuntime(tree: DraftNode[], roots: SchemaNode[], data: DataNode[], runtime: DataNode, operation?: EditOperation): DraftNode[] {
  const chain = schemaChain(roots, runtime.schemaPath);
  const context = runtimeKeys(data, runtime.id);
  if (!context || !chain.length || runtime.config === false || !canAdd(roots, chain[chain.length - 1])) return tree;
  const copy = structuredClone(tree);
  let siblings = copy;
  let target: DraftNode | undefined;
  for (const schema of chain) {
    const values = context.find(k => k.listSchemaPath === schema.path)?.values || {};
    let node = siblings.find(n => n.schema.path === schema.path && (schema.kind !== 'list' || schema.keys.every(k => n.children.find(c => c.schema.isKey && c.schema.name === k)?.value === values[k])));
    if (!node) {
      node = make(schema, true);
      if (schema.kind === 'list') keys(node, values);
      siblings.push(node);
    }
    // Addressing keys from runtime cannot be renamed in place, even if a schema branch existed.
    if (schema.kind === 'list') node.children.forEach(c => { if (c.schema.isKey) c.existing = true; });
    target = node;
    siblings = node.children;
  }
  if (!target) return tree;
  const populate = (node: DraftNode, source: DataNode) => {
    node.instancePath = source.instancePath;
    if (node.original === undefined) { node.original = source.value; if (!node.included) node.value = source.value; }
    node.existing = true;
    for (const child of source.children) {
      const schema = node.schema.children.find(c => c.path === child.schemaPath);
      if (!schema || schema.isKey || !canAdd(roots, schema) || child.config === false) continue;
      let item = node.children.find(n => n.schema.path === schema.path && (schema.kind !== 'list' || schema.keys.every(k => n.children.find(c => c.schema.name === k)?.value === child.keyValues[k])));
      if (!item) { item = make(schema, true); if (schema.kind === 'list') keys(item, child.keyValues); node.children.push(item); }
      populate(item, child);
    }
  };
  populate(target, runtime);
  if (target.schema.kind === 'leaf' || operation) target.included = true;
  if (operation) target.operation = operation;
  return copy;
}
export function toChanges(tree: DraftNode[]): EditChange[] {
  const changes: EditChange[] = [];
  function visit(node: DraftNode, ancestors: EditChange['ancestorKeys']) {
    if (node.schema.isKey) return;
    const context = node.schema.kind === 'list' ? [...ancestors, { listSchemaPath: node.schema.path, values: Object.fromEntries(node.schema.keys.flatMap(k => {
      const key = node.children.find(c => c.schema.isKey && c.schema.name === k);
      return key?.value == null ? [] : [[k, key.value]];
    })) }] : ancestors;
    const destructive = isIncluded(node) && ['delete', 'remove'].includes(node.operation);
    if (isIncluded(node)) changes.push({ id: node.id, schemaPath: node.schema.path, operation: node.operation, ancestorKeys: context,
      value: node.schema.kind === 'leaf' && node.schema.type !== 'empty' && !destructive ? node.value : null,
      source: node.existing ? 'runtime' : 'schema', type: node.schema.type, instancePath: node.instancePath, currentValue: node.original });
    if (!destructive) node.children.forEach(child => visit(child, context));
  }
  tree.forEach(n => visit(n, []));
  return changes;
}
