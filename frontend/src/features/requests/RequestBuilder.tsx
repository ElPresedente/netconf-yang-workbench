import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ConnectionInfo, RequestIntent, RequestResponse, SchemaNode } from '../../../../shared/types';
import { api, unwrap } from '../../api/netconf-api';
import { relevantLists, supportedDatastores, supportedWithDefaults } from './state';
interface Props {
  intent: RequestIntent; setIntent: (value: RequestIntent) => void; roots: SchemaNode[];
  previewTarget?: HTMLElement | null; responseTarget?: HTMLElement | null;
  onExecute?: () => void; onResponse?: (response: RequestResponse) => void;
  info: ConnectionInfo; busy: boolean; run: (action: () => Promise<void>) => Promise<void>;
}
export function RequestBuilder({ intent, setIntent, roots, info, busy, run, previewTarget, responseTarget, onExecute, onResponse }: Props) {
  const [preview, setPreview] = useState<{ intent: RequestIntent; xml: string } | null>(null);
  const [error, setError] = useState('');
  const [executionError, setExecutionError] = useState('');
  const [response, setResponse] = useState<RequestResponse | null>(null);
  useEffect(() => {
    let alive = true;
    setPreview(null); setError('');
    if (!roots.length || !intent.selectedPaths.length) return;
    const timer = setTimeout(() => {
      void api.previewRequest(intent).then(result => {
        if (!alive) return;
        if (result.error) setError(result.error.message);
        else setPreview({ intent, xml: result.result.xml });
      }).catch(e => { if (alive) setError(String(e)); });
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [intent, roots, info.capabilities]);
  const output = (content: ReactNode, target?: HTMLElement | null) => target ? createPortal(content, target) : null;
  const stores = supportedDatastores(info.capabilities);
  const defaultModes = supportedWithDefaults(info.capabilities);
  return <>
    <section className="request-controls">
      <label>Operation<select aria-label="Operation" disabled={busy} value={intent.operation} onChange={e => setIntent({ ...intent, operation: e.target.value as RequestIntent['operation'], datastore: e.target.value === 'get' ? null : 'running' })}><option value="get">GET</option><option value="get-config">GET-CONFIG</option></select></label>
      {intent.operation === 'get-config' && <label>Source datastore<select aria-label="Source datastore" disabled={busy} value={intent.datastore || 'running'} onChange={e => setIntent({ ...intent, datastore: e.target.value as RequestIntent['datastore'] })}>{stores.map(d => <option key={d}>{d}</option>)}</select></label>}
      {defaultModes !== null && <label>With defaults<select aria-label="With defaults" disabled={busy || info.state !== 'connected'} value={intent.withDefaults || ''} onChange={e => setIntent({ ...intent, withDefaults: (e.target.value || null) as RequestIntent['withDefaults'] })}><option value="">Server default</option>{defaultModes.map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label>}
      <button disabled={busy || info.state !== 'connected' || !preview || preview.intent !== intent || !roots.length} onClick={() => void run(async () => { onExecute?.(); setResponse(null); setExecutionError('');
        try { const result = unwrap(await api.executeRequest(intent)); setResponse(result); onResponse?.(result); }
        catch (e) { setExecutionError(e instanceof Error ? e.message : 'Request failed'); throw e; } })}>Execute</button>
      <button disabled={busy || !intent.selectedPaths.length} onClick={() => setIntent({ ...intent, selectedPaths: [], listKeyValues: {} })}>Clear selection</button>
      <span>{intent.selectedPaths.length} explicit selections · empty keys match all entries</span>
    </section>
    <div className="key-fields">{relevantLists(roots, intent.selectedPaths).map(list => <fieldset key={list.path} disabled={busy}><legend title={list.path}>{list.name} keys <code>{list.path}</code></legend>{list.keys.map(key => <label key={key}>{key}<input aria-label={`${list.path} key ${key}`} value={intent.listKeyValues[list.path]?.[key] || ''} onChange={e => setIntent({ ...intent, listKeyValues: { ...intent.listKeyValues, [list.path]: { ...intent.listKeyValues[list.path], [key]: e.target.value } } })} /></label>)}</fieldset>)}</div>
    {output(<section className="pane preview"><h2>Request preview</h2><div className="scroll">{error ? <p role="alert" className="error">{error}</p> : <pre>{preview?.intent === intent ? preview.xml : intent.selectedPaths.length ? 'Preparing preview…' : 'Check schema nodes to build a subtree filter.'}</pre>}</div></section>, previewTarget)}
    {output(<section className="pane response"><h2>Response</h2><div className="scroll">{executionError && <p className="error" role="alert">{executionError}</p>}{response?.parseWarning && <p className="error" role="alert">{response.parseWarning}</p>}{response?.errors.map((error, i) => <div role="alert" className="error" key={i}>{Object.entries(error).map(([key, value]) => <div key={key}><b>{key}</b>: {value}</div>)}</div>)}<pre>{response?.rawXml || 'No request executed.'}</pre></div></section>, responseTarget)}
  </>;
}
