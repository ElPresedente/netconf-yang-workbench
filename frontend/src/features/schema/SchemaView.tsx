import { useEffect, useState } from 'react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { readPreference, usePreference, writePreference } from '../workbench/preferences';
import type { DataNode, EditIntent, RetrievalProvenance, SchemaNode, YangModuleInfo } from '../../../../shared/types';

import { DraftTree } from '../edits/DraftTree';
import { addRuntime, addSchema, canAdd, type DraftNode } from '../edits/tree';
import type { EditOperation } from '../../../../shared/types';

interface Selection { paths: string[]; toggle: (node: SchemaNode) => void; disabled: boolean; inherited?: boolean; add?: (node: SchemaNode) => void }
function Node({ node, select, depth = 0, paths, toggle, disabled, add, inherited = false }: Selection & { node: SchemaNode; select: (node: SchemaNode) => void; depth?: number }) {
  const checked = inherited || paths.includes(node.path);
  const hasSelected = (n: SchemaNode): boolean => paths.includes(n.path) || n.children.some(hasSelected);
  const checkbox = ['container', 'list', 'leaf', 'leaf-list'].includes(node.kind) && <input type="checkbox" aria-label={`Include ${node.path}`} checked={checked} ref={el => { if (el) el.indeterminate = !checked && node.children.some(hasSelected); }} disabled={disabled || inherited} onClick={e => e.stopPropagation()} onChange={() => toggle(node)} />;
  const label = <><span>{node.name}</span> {node.isKey && <b className="tag">key</b>}
    {node.kind === 'list' && <span className="tag">list [{node.keys.join(', ')}]</span>}
    {node.kind === 'leaf-list' && <span className="tag">leaf-list</span>}
    {node.type && <span className="type"> : {node.type}</span>}
    {node.default !== null && (!Array.isArray(node.default) || node.default.length > 0) && <span className="default"> = {JSON.stringify(node.default)}</span>}
    {!node.config && <span className="tag state-tag">state</span>}
    {node.presence && <span className="tag">presence</span>}
    {node.mandatory && <span title="Mandatory"> *</span>}</>;
  const action = add && <span className="palette-action" onClick={e => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); e.stopPropagation(); }}><button disabled={disabled} aria-label={`Add ${node.path}`} onClick={() => add(node)}>{node.kind === 'list' ? '+ Add instance' : '+'}</button></span>;
  return <li>{checkbox}{node.children.length ? <details open={depth < 2}>
    <summary onClick={() => select(node)} title={node.path}>{label}{action}</summary>
    <ul>{node.children.map(child => <Node key={child.id} node={child} select={select} depth={depth + 1} paths={paths} toggle={toggle} disabled={disabled} inherited={checked} add={add && canAdd([child], child) ? add : undefined} />)}</ul>
  </details> : <><button className="leaf" onClick={() => select(node)} title={node.path}>{label}</button>{action}</>}</li>;
}
function DataRow({ node, index, select, add, busy }: { add?: (node: DataNode, operation?: EditOperation) => void; busy: boolean; node: DataNode; index: Map<string, SchemaNode>; select: (node: DataNode) => void }) {
  const schema = index.get(node.schemaPath);
  const label = <><span>{node.name}</span>{Object.keys(node.keyValues).length > 0 && <span className="tag"> [{Object.entries(node.keyValues).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}]</span>}{schema?.type && <span className="type"> : {schema.type}</span>}{node.value !== null && <span className="default"> = {['boolean', 'uint8', 'uint16', 'uint32', 'uint64', 'int8', 'int16', 'int32', 'int64', 'decimal64'].includes(schema?.type || '') ? node.value : JSON.stringify(node.value)}</span>}{node.config === false && <span className="tag state-tag">state</span>}</>;
  const actions = add && schema && canAdd([...index.values()], schema) && node.config !== false && <span className="palette-action" onClick={e => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); e.stopPropagation(); }}><button disabled={busy} aria-label={`Edit ${node.instancePath}`} onClick={() => add(node)}>{node.kind === 'leaf' ? 'Edit in draft' : 'Edit instance'}</button><select aria-label={`Action ${node.instancePath}`} disabled={busy} value="" onChange={e => add(node, e.target.value as EditOperation)}><option value="">⋮</option><option value="delete">Delete</option><option value="remove">Remove</option></select></span>;
  return <li>{node.children.length ? <details open><summary title={node.instancePath} onClick={() => select(node)}>{label}{actions}</summary><ul>{node.children.map(child => <DataRow key={child.id} node={child} index={index} select={select} add={add} busy={busy} />)}</ul></details> : <><button className="leaf" title={node.instancePath} onClick={() => select(node)}>{label}</button>{actions}</>}</li>;
}
function Inspector({ selected, runtime }: { selected: SchemaNode | null; runtime: DataNode | null }) {
  const fields = {
    ...(runtime ? { Name: runtime.name, Kind: runtime.kind, Value: runtime.value, 'Schema path': runtime.schemaPath, 'Instance path': runtime.instancePath, Module: runtime.module, Namespace: runtime.namespace, Config: runtime.config, 'List key values': Object.entries(runtime.keyValues).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ') }
      : selected ? { Name: selected.name, Kind: selected.kind, Module: selected.module, Namespace: selected.namespace, Path: selected.path, Config: selected.config, Keys: selected.keys.join(', ') } : {}),
    ...(selected ? { Type: selected.type, Default: selected.default === null ? null : JSON.stringify(selected.default), Units: selected.units, Mandatory: selected.mandatory, Presence: selected.presence } : {}),
  };
  return <aside className="inspector pane"><h2>Node inspector</h2><div className="node-info scroll">{selected || runtime ? <>
    <table><tbody>{Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== '').map(([name, value]) => <tr key={name}><th>{name}</th><td>{['Path', 'Namespace', 'Schema path', 'Instance path'].includes(name) ? <input readOnly aria-label={name} value={String(value)} onFocus={e => e.target.select()} /> : String(value)}</td></tr>)}</tbody></table>
    {selected?.description && <p>{selected.description}</p>}
  </> : <p>Click a node to inspect it. Checkboxes independently select request data.</p>}</div></aside>;
}
export function SchemaView({ setEditToolbarTarget, draftTree, setDraftTree, activateEdit, modules, roots, paths, toggle, disabled, dataNodes = null, draft, editMode, provenance, retrievalXml }: Selection & { setEditToolbarTarget: (target: HTMLDivElement | null) => void; draftTree: DraftNode[]; setDraftTree: (tree: DraftNode[]) => void; activateEdit: () => void; modules: YangModuleInfo[]; roots: SchemaNode[]; dataNodes?: DataNode[] | null; draft: EditIntent; editMode: boolean; provenance: RetrievalProvenance | null; retrievalXml: string }) {
  const [selected, setSelected] = useState<SchemaNode | null>(null);
  const [runtime, setRuntime] = useState<DataNode | null>(null);
  useEffect(() => { setRuntime(null); }, [dataNodes]);
  const [mode, setMode] = useState<'schema' | 'data' | 'draft'>('schema');
  useEffect(() => { if (!editMode) setMode(old => old === 'draft' ? 'schema' : old); }, [editMode]);
  const openDraft = () => { setMode('draft'); activateEdit(); };
  const [search, setSearch] = useState('');
  const [sidebar, setSidebar] = usePreference('sidebar', true);
  const [inspector, setInspector] = usePreference('inspector', true);
  const index = new Map<string, SchemaNode>();
  const visit = (node: SchemaNode) => { index.set(node.path, node); node.children.forEach(visit); }; roots.forEach(visit);
  const query = search.trim().toLowerCase();
  const filter = (nodes: SchemaNode[]): SchemaNode[] => nodes.flatMap(node => {
    if (!query || node.name.toLowerCase().includes(query) || node.module.toLowerCase().includes(query)) return [node];
    const children = filter(node.children); return children.length ? [{ ...node, children }] : [];
  });
  const layoutKey = `schema-layout-${sidebar}-${inspector}`;
  return <div className="schema-workspace">
    <div className="workspace-tabs">
      <button aria-pressed={sidebar} onClick={() => setSidebar(!sidebar)}>{sidebar ? 'Hide' : 'Show'} sidebar</button>
      <div role="tablist" aria-label="Tree mode"><button role="tab" aria-selected={mode === 'schema'} onClick={() => setMode('schema')}>Schema</button><button role="tab" aria-selected={mode === 'data'} onClick={() => setMode('data')}>Last response{provenance?.stale ? ' · stale' : ''}</button>{editMode && <button role="tab" aria-selected={mode === 'draft'} onClick={openDraft}>Edit draft</button>}</div>
      <button aria-pressed={inspector} onClick={() => setInspector(!inspector)}>{inspector ? 'Hide' : 'Show'} inspector</button>
    </div>
    <Group key={layoutKey} className="schema-layout" orientation="horizontal" defaultLayout={readPreference<Layout | undefined>(layoutKey, undefined)} onLayoutChanged={layout => writePreference(layoutKey, layout)}>
      {sidebar && <><Panel id="sidebar" defaultSize="18%" minSize="120px"><aside className="modules pane"><h2>Schema · Modules <span>{modules.length}</span></h2><input aria-label="Schema search" placeholder="Filter schema names…" value={search} onChange={e => setSearch(e.target.value)} /><div className="scroll">
        {modules.length ? modules.map(m => <div className="module" key={`${m.name}@${m.revision}`}><code>{m.name}</code><small>{m.revision || 'No revision'}</small></div>) : <p className="empty">No models loaded.</p>}
      </div></aside></Panel><Separator className="splitter horizontal" /></>}
      <Panel id="tree" minSize="20%"><section className="tree pane"><h2>{mode === 'schema' ? 'Effective data schema' : mode === 'draft' ? 'Edit draft' : 'Last response data'}<span>{mode === 'schema' ? `${roots.length} roots` : mode === 'draft' ? `${draft.changes.length} changes · local draft` : `${provenance?.operation.toUpperCase() || 'Returned instances'} ${provenance?.datastore || ''}${provenance?.stale ? ' · Data may have changed since this response' : ''}`}</span></h2>
        {mode === 'draft' && <div className="draft-toolbar" ref={setEditToolbarTarget} />}
        {mode === 'data' && retrievalXml && <details className="retrieval-xml"><summary>Raw retrieval response</summary><pre>{retrievalXml}</pre></details>}
        <div className="scroll">{mode === 'draft' ? <DraftTree tree={draftTree} roots={roots} setTree={setDraftTree} busy={disabled} /> : mode === 'schema' ? roots.length ? <ul className="schema-tree">{filter(roots).map(n => <Node key={n.id} node={n} select={node => setSelected(index.get(node.path) || node)} paths={paths} toggle={node => toggle(index.get(node.path) || node)} disabled={disabled} add={editMode && canAdd(roots, n) ? node => { setDraftTree(addSchema(draftTree, roots, node.path)); openDraft(); } : undefined} />)}</ul> : <p className="empty">Connect, then choose Load YANG models to inspect the compiled data tree.</p> : dataNodes === null ? <p className="empty">No successfully parsed response for this schema. Execute a GET or GET-CONFIG.</p> : dataNodes.length ? <ul className="schema-tree runtime-tree">{dataNodes.map(node => <DataRow key={node.id} node={node} index={index} select={setRuntime} busy={disabled} add={editMode ? (runtime, operation) => { setDraftTree(addRuntime(draftTree, roots, dataNodes, runtime, operation)); openDraft(); } : undefined} />)}</ul> : <p className="empty">The response contained no data nodes.</p>}</div>
      </section></Panel>
      {inspector && <><Separator className="splitter horizontal" /><Panel id="inspector" defaultSize="27%" minSize="180px"><div className="inspector-content scroll"><Inspector selected={mode === 'schema' ? selected : runtime ? index.get(runtime.schemaPath) || null : null} runtime={mode === 'data' ? runtime : null} /><p className="draft-guidance">Author configuration in the central Edit draft tree. Leaf-lists and state data are read-only.</p></div></Panel></>}
    </Group>
  </div>;
}
