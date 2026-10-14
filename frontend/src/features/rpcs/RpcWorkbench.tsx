import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DataNode, RequestResponse, RpcInputNode, RpcSchemaNode, YangRpc, YangRpcIntent } from '../../../../shared/types';
import { api, unwrap } from '../../api/netconf-api';

function required(n: RpcSchemaNode): boolean { return !n.conditional && (n.mandatory || n.isKey || !!n.minElements || (n.kind === 'container' && !n.presence && n.children.some(required))); }
function create(n: RpcSchemaNode): RpcInputNode {
  return { id: crypto.randomUUID(), schemaPath: n.path, value: n.type === 'empty' ? null : undefined,
    children: n.kind === 'choice' ? [] : initial(n.children) };
}
export function initial(schema: RpcSchemaNode[]): RpcInputNode[] {
  return schema.flatMap(n => required(n) ? Array.from({ length: Math.max(1, n.minElements || 0) }, () => create(n)) : []);
}
function InputTree({ schema, nodes, change, busy, inspect }: { schema: RpcSchemaNode[]; nodes: RpcInputNode[]; change: (v: RpcInputNode[]) => void; busy: boolean; inspect: (n: RpcSchemaNode) => void }) {
  const [search, setSearch] = useState('');
  const available = schema.filter(n => (n.kind === 'list' || n.kind === 'leaf-list' || !nodes.some(i => i.schemaPath === n.path)) && (n.maxElements == null || nodes.filter(i => i.schemaPath === n.path).length < n.maxElements));
  const update = (id: string, value: RpcInputNode) => change(nodes.map(n => n.id === id ? value : n));
  return <div className="rpc-input-tree">
    {schema.flatMap(s => nodes.filter(n => n.schemaPath === s.path).map((n, i) => <div className="rpc-input-node" key={n.id}>
      <div className="rpc-input-row"><button className="leaf" onClick={() => inspect(s)} title={s.description || s.path}>{s.name}{['list', 'leaf-list'].includes(s.kind) ? ` [${i + 1}]` : ''}{required(s) ? ' *' : ''}</button><span className="type">{s.type || s.kind}{s.presence ? ' · presence' : ''}</span>
      {['leaf', 'leaf-list'].includes(s.kind) && (s.type === 'empty' ? <span>included (YANG empty)</span> : s.type === 'boolean' || s.enums?.length ? <select disabled={busy} aria-label={`RPC ${s.path} ${i + 1}`} value={n.value ?? ''} onChange={e => update(n.id, { ...n, value: e.target.value })}><option value="" disabled>Choose value…</option>{(s.type === 'boolean' ? ['true', 'false'] : s.enums || []).map(v => <option key={v}>{v}</option>)}</select> : <input disabled={busy} aria-label={`RPC ${s.path} ${i + 1}`} placeholder="Enter value" value={n.value ?? ''} onChange={e => update(n.id, { ...n, value: e.target.value })} />)}
      {['leaf', 'leaf-list'].includes(s.kind) && s.type !== 'empty' && n.value === undefined && <span className="type">Value not entered</span>}
      {['leaf', 'leaf-list'].includes(s.kind) && s.type === 'string' && <button disabled={busy} aria-label={`Empty string ${s.path} ${i + 1}`} onClick={() => update(n.id, { ...n, value: '' })}>Empty string</button>}
      {['leaf', 'leaf-list'].includes(s.kind) && n.value === '' && <span className="type">empty string</span>}
      {s.kind === 'choice' && <select aria-label={`Case ${s.path}`} disabled={busy} value={n.children[0]?.schemaPath || ''} onChange={e => { const c = s.children.find(c => c.path === e.target.value); update(n.id, { ...n, children: c ? [create(c)] : [] }); }}><option value="">Choose case…</option>{s.children.map(c => <option key={c.path} value={c.path}>{c.name}</option>)}</select>}
      <button disabled={busy || (required(s) && !['list', 'leaf-list'].includes(s.kind))} aria-label={`Remove RPC ${s.name} ${i + 1}`} onClick={() => change(nodes.filter(v => v.id !== n.id))}>Remove</button></div>
      {s.children.length > 0 && <InputTree schema={s.kind === 'choice' ? s.children.filter(c => c.path === n.children[0]?.schemaPath) : s.children} nodes={n.children} change={children => update(n.id, { ...n, children })} busy={busy} inspect={inspect} />}
    </div>))}
    {available.length > 0 && <div className="rpc-add"><input aria-label="Find RPC input field" placeholder="Find optional field…" value={search} onChange={e => setSearch(e.target.value)} disabled={busy} /><select aria-label="Add RPC input field" value="" disabled={busy} onChange={e => { const n = schema.find(s => s.path === e.target.value); if (n) change([...nodes, create(n)]); }}><option value="">+ Add field / entry</option>{available.filter(n => `${n.name} ${n.module}`.toLowerCase().includes(search.toLowerCase())).map(n => <option key={n.path} value={n.path}>{n.name} · {n.kind}{n.minElements ? ` · min ${n.minElements}` : ''}{n.maxElements != null ? ` · max ${n.maxElements}` : ''}</option>)}</select></div>}
  </div>;
}
function Output({ nodes, inspect, schemas }: { nodes: DataNode[]; inspect: (s: RpcSchemaNode) => void; schemas: Map<string, RpcSchemaNode> }) {
  return <ul className="schema-tree">{nodes.map(n => <li key={n.id}><button className="leaf" title={n.instancePath} onClick={() => { const s = schemas.get(n.schemaPath); if (s) inspect(s); }}>{n.name} <span className="type">{schemas.get(n.schemaPath)?.type || n.kind}</span>{n.value !== null ? ` = ${n.value}` : ''}</button>{n.children.length > 0 && <Output nodes={n.children} inspect={inspect} schemas={schemas} />}</li>)}</ul>;
}
export function useRpcState() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<YangRpc | null>(null);
  const [nodes, setNodes] = useState<RpcInputNode[]>([]);
  const [preview, setPreview] = useState<{ intent: YangRpcIntent; xml: string; validationNotice: string } | null>(null);
  const [response, setResponse] = useState<RequestResponse | null>(null);
  const [responseOperation, setResponseOperation] = useState('');
  const [error, setError] = useState('');
  return { search, setSearch, selected, setSelected, nodes, setNodes, preview, setPreview, response, setResponse, responseOperation, setResponseOperation, error, setError,
    reset: () => { setSearch(''); setSelected(null); setNodes([]); setPreview(null); setResponse(null); setResponseOperation(''); setError(''); } };
}
export function RpcWorkbench({ state, operations, busy, connected, run, onAttempt, onExecute, onPreview, previewTarget, responseTarget, inspect }: { state: ReturnType<typeof useRpcState>; operations: YangRpc[]; busy: boolean; connected: boolean; run: (f: () => Promise<void>) => Promise<void>; onAttempt: () => void; onExecute: () => void; onPreview: () => void; previewTarget: HTMLElement | null; responseTarget: HTMLElement | null; inspect: (s: RpcSchemaNode) => void }) {
  const { search, setSearch, selected, setSelected, nodes, setNodes, preview, setPreview, response, setResponse, responseOperation, setResponseOperation, error, setError } = state;
  const current = useMemo(() => ({ operation: selected?.id || '', nodes }), [selected, nodes]);
  const currentRef = useRef(current); currentRef.current = current;
  const index = new Map<string, RpcSchemaNode>();
  const visit = (n: RpcSchemaNode) => { index.set(n.path, n); n.children.forEach(visit); }; selected?.output.forEach(visit);
  const filtered = operations.filter(o => `${o.module} ${o.name}`.toLowerCase().includes(search.toLowerCase()));
  const modules = [...new Set(filtered.map(o => o.module))].sort();
  const previewContent = <section className="pane"><h2>RPC operation preview</h2><p>{preview?.validationNotice}</p>{error && <p role="alert" className="error">{error}</p>}<pre>{preview?.intent === current ? preview.xml : 'Press Preview to validate the current input.'}</pre></section>;
  const responseContent = <section className="pane"><h2>RPC response</h2>{error && <p role="alert" className="error">{error}</p>}{response?.parseWarning && <p role="alert" className="error">{response.parseWarning}</p>}{response?.errors.map((e, i) => <div className="error" role="alert" key={i}>{Object.entries(e).map(([k, v]) => <div key={k}><b>{k}</b>: {v}</div>)}</div>)}<pre>{response?.rawXml || 'No RPC executed.'}</pre></section>;
  return <div className="rpc-workbench">
    <label>Search RPCs<input aria-label="Search RPCs" value={search} onChange={e => setSearch(e.target.value)} /></label>
    <select aria-label="YANG RPC" value={selected?.id || ''} disabled={busy} onChange={e => { const op = operations.find(o => o.id === e.target.value) || null; setSelected(op); setNodes(op ? initial(op.input) : []); setPreview(null); setError(''); }}><option value="">Select an operation…</option>{modules.map(m => <optgroup label={m} key={m}>{filtered.filter(o => o.module === m).map(o => <option value={o.id} key={o.id}>{o.name}</option>)}</optgroup>)}</select>
    {selected ? <><h3>{selected.module}:{selected.name} <small>{selected.status}</small></h3><p>{selected.description}</p><div className="toolbar">
      <button disabled={busy} onClick={() => void run(async () => { onPreview(); setError(''); setPreview(null); const captured = current; try { const p = unwrap(await api.previewYangRpc(captured)); if (currentRef.current === captured) setPreview({ intent: captured, ...p }); } catch (e) { setError(String(e)); } })}>Preview RPC</button>
      <button disabled={busy || !connected || preview?.intent !== current} onClick={() => void run(async () => { setError(''); setResponse(null); setResponseOperation(current.operation); onExecute(); let attempted = false; try { unwrap(await api.previewYangRpc(current)); attempted = true; const result = unwrap(await api.executeYangRpc(current)); setResponse(result); } catch (e) { setError(String(e)); } finally { if (attempted) onAttempt(); } })}>Execute RPC</button>
      <span>Input is local until Execute. Optional fields are absent until added.</span></div>
      {selected.input.length ? <InputTree schema={selected.input} nodes={nodes} change={setNodes} busy={busy} inspect={inspect} /> : <p>This RPC has no input parameters.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="rpc-validation">{preview?.validationNotice}</p>
      <h3>Structured output</h3>{responseOperation === selected.id && response?.rpcOutput ? response.rpcOutput.length ? <Output nodes={response.rpcOutput} schemas={index} inspect={inspect} /> : <p>Successful reply with no output.</p> : <p>{(responseOperation === selected.id ? response?.parseWarning : '') || 'Execute explicitly to inspect returned output.'}</p>}
    </> : <p>Load device models and select a compiled top-level RPC.</p>}
    {previewTarget && createPortal(previewContent, previewTarget)}{responseTarget && createPortal(responseContent, responseTarget)}
  </div>;
}
