import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CandidateAction, ConnectionInfo, EditIntent, RequestIntent, RequestResponse, SchemaNode } from '../../../../shared/types';
import { api, unwrap } from '../../api/netconf-api';
import { editCapabilities } from '../edits/state';
import { relevantLists, supportedDatastores, supportedWithDefaults } from './state';
interface Props {
  candidateModified?: boolean;
  onCandidateAttempt: (action: CandidateAction, success: boolean) => void;
  editToolbarTarget?: HTMLElement | null;
  clearDraft?: () => void; hasDraft?: boolean;
  editMode: boolean; setEditMode: (value: boolean) => void; draft: EditIntent; setDraft: (value: EditIntent) => void; onEditAttempt: (draft: EditIntent, success: boolean) => void;
  intent: RequestIntent; setIntent: (value: RequestIntent) => void; roots: SchemaNode[];
  previewTarget?: HTMLElement | null; responseTarget?: HTMLElement | null;
  onExecute?: () => void; onResponse?: (response: RequestResponse) => void;
  info: ConnectionInfo; busy: boolean; run: (action: () => Promise<void>) => Promise<void>;
}
export function RequestBuilder({ candidateModified, onCandidateAttempt, editToolbarTarget, clearDraft, hasDraft, intent, setIntent, roots, info, busy, run, previewTarget, responseTarget, onExecute, onResponse, editMode, setEditMode, draft, setDraft, onEditAttempt }: Props) {
  const activeIntent = editMode ? draft : intent;
  const count = editMode ? draft.changes.length : intent.selectedPaths.length;
  const editCaps = editCapabilities(info.capabilities);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<{ intent: RequestIntent | EditIntent; xml: string } | null>(null);
  const [error, setError] = useState('');
  const [executionError, setExecutionError] = useState('');
  const [response, setResponse] = useState<RequestResponse | null>(null);
  useEffect(() => {
    let alive = true;
    setPreview(null); setError('');
    if (!roots.length || !count) return;
    const timer = setTimeout(() => {
      void (editMode ? api.previewEdit(draft) : api.previewRequest(intent)).then(result => {
        if (!alive) return;
        if (result.error) setError(result.error.message);
        else setPreview({ intent: activeIntent, xml: result.result.xml });
      }).catch(e => { if (alive) setError(String(e)); });
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [activeIntent, roots, info.capabilities, editMode]);
  const candidateAction = (action: CandidateAction) => void run(async () => {
    onExecute?.(); setResponse(null); setExecutionError(''); setNotice('');
    const label = action === 'commit' ? 'Commit' : 'Discard changes';
    try {
      const result = unwrap(await (action === 'commit' ? api.commitCandidate() : api.discardCandidate()));
      setResponse(result);
      onCandidateAttempt(action, result.errors.length === 0);
      setNotice(result.errors.length ? `${label} returned errors; affected snapshots may be stale. Draft retained.`
        : `${label} succeeded. Draft retained; snapshots were not refreshed.`);
    } catch (e) {
      onCandidateAttempt(action, false);
      setNotice(`${label} outcome uncertain; affected snapshots may be stale. Draft retained.`);
      setExecutionError(e instanceof Error ? e.message : 'Candidate action failed');
      throw e;
    }
  });
  const output = (content: ReactNode, target?: HTMLElement | null) => target ? createPortal(content, target) : null;
  const stores = supportedDatastores(info.capabilities);
  const defaultModes = supportedWithDefaults(info.capabilities);
  const controls = <section className="request-controls">
      <label>Operation<select aria-label="Operation" disabled={busy} value={editMode ? 'edit-config' : intent.operation} onChange={e => { setEditMode(e.target.value === 'edit-config'); if (e.target.value !== 'edit-config') setIntent({ ...intent, operation: e.target.value as RequestIntent['operation'], datastore: e.target.value === 'get' ? null : 'running' }); }}><option value="get">GET</option><option value="get-config">GET-CONFIG</option><option value="edit-config" disabled={!editCaps.editableTargets.length}>EDIT-CONFIG</option></select></label>
      {!editMode && intent.operation === 'get-config' && <label>Source datastore<select aria-label="Source datastore" disabled={busy} value={intent.datastore || 'running'} onChange={e => setIntent({ ...intent, datastore: e.target.value as RequestIntent['datastore'] })}>{stores.map(d => <option key={d}>{d}</option>)}</select></label>}
      {!editMode && defaultModes !== null && <label>With defaults<select aria-label="With defaults" disabled={busy || info.state !== 'connected'} value={intent.withDefaults || ''} onChange={e => setIntent({ ...intent, withDefaults: (e.target.value || null) as RequestIntent['withDefaults'] })}><option value="">Server default</option>{defaultModes.map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label>}
      {!editCaps.editableTargets.length && <span>EDIT-CONFIG unavailable: server must advertise candidate or writable-running.</span>}
      {editMode && <>
        <label>Target<select aria-label="Edit target" disabled={busy} value={draft.target} onChange={e => setDraft({ ...draft, target: e.target.value as EditIntent['target'] })}>{editCaps.editableTargets.map(d => <option key={d}>{d}</option>)}</select></label>
        <label>Default operation<select aria-label="Default operation" disabled={busy} value={draft.defaultOperation || ''} onChange={e => setDraft({ ...draft, defaultOperation: (e.target.value || null) as EditIntent['defaultOperation'] })}><option value="">Server/RFC default</option>{['merge', 'replace', 'none'].map(v => <option key={v}>{v}</option>)}</select></label>
        {!!editCaps.supportedTestOptions.length && <label>Test option<select aria-label="Test option" disabled={busy} value={draft.testOption || ''} onChange={e => setDraft({ ...draft, testOption: (e.target.value || null) as EditIntent['testOption'] })}><option value="">Server/RFC default</option>{editCaps.supportedTestOptions.map(v => <option key={v}>{v}</option>)}</select></label>}
        <label>Error option<select aria-label="Error option" disabled={busy} value={draft.errorOption || ''} onChange={e => setDraft({ ...draft, errorOption: (e.target.value || null) as EditIntent['errorOption'] })}><option value="">Server/RFC default</option>{['stop-on-error', 'continue-on-error', ...(editCaps.supportsRollbackOnError ? ['rollback-on-error'] : [])].map(v => <option key={v}>{v}</option>)}</select></label>
      </>}
      <button disabled={busy || info.state !== 'connected' || !preview || preview.intent !== activeIntent || !roots.length} onClick={() => void run(async () => { onExecute?.(); setResponse(null); setExecutionError(''); setNotice('');
        try {
          const result = unwrap(await (editMode ? api.executeEdit(draft) : api.executeRequest(intent)));
          setResponse(result);
          if (editMode) {
            onEditAttempt(draft, result.errors.length === 0);
            setNotice(result.errors.length ? draft.testOption === 'test-only' ? 'Validation returned errors; configuration unchanged. Draft retained.' : 'Edit returned errors; configuration may have partially changed. Draft retained.' : draft.testOption === 'test-only' ? 'Test completed; configuration unchanged. Draft retained.' : draft.target === 'candidate' ? 'Candidate modified; not committed. Draft retained.' : 'Running modified. Draft retained.');
          } else onResponse?.(result);
        }
        catch (e) { if (editMode) onEditAttempt(draft, false); setExecutionError(e instanceof Error ? e.message : 'Request failed'); throw e; } })}>Execute</button>
      {!editMode && <><button disabled={busy || !intent.selectedPaths.length} onClick={() => setIntent({ ...intent, selectedPaths: [], listKeyValues: {} })}>Clear selection</button>
      <span>{intent.selectedPaths.length} explicit selections · empty keys match all entries</span></>}
      {editMode && <button disabled={busy || !(hasDraft ?? draft.changes.length)} onClick={() => clearDraft?.()}>Clear draft</button>}
      {editMode && draft.target === 'candidate' && info.state === 'connected' && editCaps.editableTargets.includes('candidate') && <>
        <button disabled={busy} title="Apply the device's candidate configuration to running" onClick={() => candidateAction('commit')}>Commit</button>
        <button disabled={busy} title="Replace the device's candidate configuration with running" onClick={() => candidateAction('discard')}>Discard changes</button>
        {candidateModified && <span role="status" title="Local observation only; other NETCONF clients may also modify candidate">This session modified candidate</span>}
      </>}
      {editMode && <span>{draft.changes.length} staged changes · no automatic commit or refresh</span>}
    </section>;
  return <>
    {editMode && editToolbarTarget ? createPortal(controls, editToolbarTarget) : controls}
    {!editMode && <div className="key-fields">{relevantLists(roots, intent.selectedPaths).map(list => <fieldset key={list.path} disabled={busy}><legend title={list.path}>{list.name} keys <code>{list.path}</code></legend>{list.keys.map(key => <label key={key}>{key}<input aria-label={`${list.path} key ${key}`} value={intent.listKeyValues[list.path]?.[key] || ''} onChange={e => setIntent({ ...intent, listKeyValues: { ...intent.listKeyValues, [list.path]: { ...intent.listKeyValues[list.path], [key]: e.target.value } } })} /></label>)}</fieldset>)}</div>}
    {output(<section className="pane preview"><h2>Request preview</h2><div className="scroll">{error ? <p role="alert" className="error">{error}</p> : <pre>{preview?.intent === activeIntent ? preview.xml : count ? 'Preparing preview…' : editMode ? hasDraft ? 'Edit a value or choose a node operation to include it in the payload.' : 'Add configuration to the Edit draft tree to preview edit-config.' : 'Check schema nodes to build a subtree filter.'}</pre>}</div></section>, previewTarget)}
    {output(<section className="pane response"><h2>Response</h2><div className="scroll">{notice && <p role="status">{notice}</p>}{executionError && <p className="error" role="alert">{executionError}</p>}{response?.parseWarning && <p className="error" role="alert">{response.parseWarning}</p>}{response?.errors.map((error, i) => <div role="alert" className="error" key={i}>{Object.entries(error).map(([key, value]) => <div key={key}><b>{key}</b>: {value}</div>)}</div>)}<pre>{response?.rawXml || 'No request executed.'}</pre></div></section>, responseTarget)}
  </>;
}
