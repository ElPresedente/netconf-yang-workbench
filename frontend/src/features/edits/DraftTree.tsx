import { useState } from 'react';
import type { EditOperation, SchemaNode } from '../../../../shared/types';
import { addSchema, canAdd, isIncluded, removeNode, setValue, toChanges, updateNode, type DraftNode } from './tree';

export function DraftTree({ tree, roots, setTree, busy }: { tree: DraftNode[]; roots: SchemaNode[]; setTree: (tree: DraftNode[]) => void; busy: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const patch = (id: string, change: (n: DraftNode) => DraftNode) => setTree(updateNode(tree, id, change));
  function row(node: DraftNode, blocked = false) {
    const { schema } = node;
    const included = isIncluded(node);
    const destructive = included && ['delete', 'remove'].includes(node.operation);
    const locked = blocked || destructive;
    const key = schema.isKey;
    const scalar = schema.kind === 'leaf';
    const changed = node.existing && scalar && node.value !== node.original && !key;
    const label = schema.kind === 'list' ? schema.keys.map(k => `${k}=${JSON.stringify(node.children.find(c => c.schema.name === k && c.schema.isKey)?.value ?? '')}`).join(', ') : '';
    const fields = schema.children.filter(c => canAdd(roots, c) && (c.kind === 'list' || !node.children.some(n => n.schema.path === c.path)) && `${c.name} ${c.module}`.toLowerCase().includes(query.toLowerCase()));
    return <li key={node.id} data-draft-id={node.id} data-schema-path={schema.path}>
      <div className={`draft-row ${destructive ? 'draft-destructive' : changed ? 'draft-modified' : ''}`}>
        {!scalar && <button aria-label={`Toggle ${schema.name}`} aria-expanded={!collapsed.has(node.id)} onClick={() => setCollapsed(old => { const next = new Set(old); next.has(node.id) ? next.delete(node.id) : next.add(node.id); return next; })}>{collapsed.has(node.id) ? '▸' : '▾'}</button>}
        <span title={schema.path}>{schema.name}{label && ` [${label}]`}</span>
        {schema.type && <span className="type">: {schema.type}</span>}
        {key && <span className="tag">key{node.existing ? ', readonly' : ', required'}</span>}
        {schema.presence && <span className="tag">presence</span>}
        {scalar && <>
          {node.existing && !key && node.original != null && <span className="draft-original">{node.original} →</span>}
          {schema.type === 'empty' ? <label><input type="checkbox" aria-label={`Present ${schema.name}`} disabled={busy || locked} checked={included} onChange={e => patch(node.id, n => ({ ...n, included: e.target.checked }))} />present</label> : schema.type === 'boolean' && !key ? <select aria-label={`Value ${schema.name}`} disabled={busy || locked} value={node.value ?? ''} onChange={e => setTree(setValue(tree, node.id, e.target.value))}><option value="" disabled>Choose…</option><option>true</option><option>false</option></select> : <input aria-label={`${key ? 'Key' : 'Value'} ${schema.name}`} readOnly={key && node.existing} disabled={busy || locked} value={node.value ?? ''} onChange={e => setTree(setValue(tree, node.id, e.target.value))} />}
        </>}
        {!key && <>
          <span className="tag">{destructive ? node.operation.toUpperCase() : changed ? 'modified' : included ? node.existing ? 'included' : 'new' : node.existing ? 'untouched' : 'structure'}</span>
          <select aria-label={`Operation ${schema.name}`} disabled={busy || blocked} value={included ? node.operation : ''} onChange={e => patch(node.id, n => ({ ...n, operation: e.target.value as EditOperation, included: true }))}><option value="" disabled>Operation…</option>{['merge', 'replace', 'create', 'delete', 'remove'].map(op => <option key={op}>{op}</option>)}</select>
          <button aria-label={`Unstage ${schema.name}`} disabled={busy || blocked} onClick={() => setTree(removeNode(tree, node.id))}>×</button>
        </>}
      </div>
      {!collapsed.has(node.id) && !scalar && <ul>{node.children.map(child => row(child, blocked || destructive))}
        {!locked && <li className="draft-add"><button disabled={busy} onClick={() => { setPicker(picker === node.id ? null : node.id); setQuery(''); }}>+ Add field</button>
          {picker === node.id && <div className="field-picker"><input autoFocus aria-label="Find field" placeholder="Find configurable field…" value={query} onChange={e => setQuery(e.target.value)} />{fields.map(field => <button key={field.path} disabled={busy} title={field.path} onClick={() => { setTree(addSchema(tree, roots, field.path, node.id)); setPicker(null); }}>Add {field.name}{field.kind === 'list' ? ' instance' : ''}</button>)}{!fields.length && <span>No available fields.</span>}</div>}
        </li>}
      </ul>}
    </li>;
  }
  return <div className="draft-editor">
    <p className="draft-guidance">Schema → add new configuration · Last response → edit existing instances · Preview → Execute</p>
    {!tree.length ? <p className="empty">Add configuration from Schema or choose Edit in draft in Last response.</p> : <ul className="draft-tree">{tree.map(n => row(n))}</ul>}
    <details className="draft-summary"><summary>Draft summary · {toChanges(tree).length} changes</summary>{toChanges(tree).map(c => <div key={c.id}><b>{c.operation}</b> <code>{c.schemaPath}</code> {c.ancestorKeys.map(k => JSON.stringify(k.values)).join(' / ')} {c.value}</div>)}</details>
  </div>;
}
