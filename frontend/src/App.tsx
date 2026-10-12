import { useEffect, useMemo, useRef, useState } from 'react';
import { api, unwrap } from './api/netconf-api';
import type { DataNode, RetrievalProvenance, BackendStatus, ConnectionInfo, ConnectionParams, LogEntry, SchemaNode, SchemaProgress, YangModuleInfo } from '../../shared/types';
import { ConnectionForm } from './features/connection/ConnectionForm';
import { SchemaView } from './features/schema/SchemaView';
import { RequestBuilder } from './features/requests/RequestBuilder';
import { toChanges, type DraftNode } from './features/edits/tree';
import { afterCandidate, afterEdit, editCapabilities, emptyEdit } from './features/edits/state';
import { emptyRequest, relevantLists } from './features/requests/state';
import { Group, Panel, Separator, usePanelRef, type Layout } from 'react-resizable-panels';
import { readPreference, usePreference, writePreference } from './features/workbench/preferences';
import { LogView } from './features/logs/LogView';

export default function App() {
  const [editOptions, setEditOptions] = useState(emptyEdit);
  const [draftTree, setDraftTree] = useState<DraftNode[]>([]);
  const draft = useMemo(() => ({ ...editOptions, changes: toChanges(draftTree) }), [editOptions, draftTree]);
  const setDraft = (value: ReturnType<typeof emptyEdit>) => { setEditOptions(value); if (!value.changes.length) setDraftTree([]); };
  const [candidateModified, setCandidateModified] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [retrievalXml, setRetrievalXml] = useState('');
  const [provenance, setProvenance] = useState<RetrievalProvenance | null>(null);
  const [dataNodes, setDataNodes] = useState<DataNode[] | null>(null);
  const [outputTab, setOutputTab] = usePreference<'preview' | 'response' | 'logs'>('outputTab', 'preview');
  const [dockOpen, setDockOpen] = usePreference('dockOpen', true);
  const [editToolbarTarget, setEditToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [previewTarget, setPreviewTarget] = useState<HTMLDivElement | null>(null);
  const [responseTarget, setResponseTarget] = useState<HTMLDivElement | null>(null);
  const outputPanel = usePanelRef();
  const [maximized, setMaximized] = useState(false);
  const previousDockSize = useRef(32);
  useEffect(() => {
    const panel = outputPanel.current;
    if (!panel) return;
    if (!dockOpen) panel.collapse();
    else {
      if (panel.isCollapsed()) panel.expand();
      if (maximized) panel.resize('85%');
    }
  }, [dockOpen, maximized, outputPanel]);
  const [intent, setIntent] = useState(emptyRequest);
  const [backend, setBackend] = useState<BackendStatus>({ ready: false });
  const [info, setInfo] = useState<ConnectionInfo>({ state: 'disconnected', capabilities: [] });
  const [modules, setModules] = useState<YangModuleInfo[]>([]);
  const [roots, setRoots] = useState<SchemaNode[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<SchemaProgress | null>(null);
  const [generation, setGeneration] = useState(0);
  const inFlight = useRef(false);
  const capabilityKey = JSON.stringify([...new Set(info.capabilities)].sort());
  useEffect(() => {
    if (info.state === 'connected') {
      const caps = editCapabilities(info.capabilities);
      setEditOptions(old => ({ ...old, target: caps.editableTargets.includes(old.target) ? old.target : caps.editableTargets[0] || 'candidate', testOption: null, errorOption: null }));
    }
    setIntent(old => old.withDefaults == null ? old : { ...old, withDefaults: null });
  }, [capabilityKey, info.sessionId, info.state]);

  useEffect(() => {
    if (!api) { setBackend({ ready: false, error: 'Desktop preload bridge is unavailable. Start this application through Electron.' }); return; }
    let alive = true;
    let stateEvent = false;
    let statusEvent = false;
    const off = [api.onConnectionStateChanged(value => { stateEvent = true; setInfo(value); }),
      api.onBackendStatus(value => { statusEvent = true; setBackend(value); }), api.onSchemaProgress(setProgress),
      api.onLog(entry => setLogs(old => [...old, entry].slice(-300)))];
    void api.getBackendStatus().then(value => { if (alive && !statusEvent) setBackend(value); });
    void api.getConnectionState().then(value => { if (alive && !stateEvent && !value.error) setInfo(value.result); });
    return () => { alive = false; off.forEach(f => f()); };
  }, []);
  useEffect(() => {
    if (!backend.ready || !api) return;
    let alive = true;
    // Read the existing snapshot on renderer reload; these getters never fetch.
    void Promise.all([api.getModules(), api.getSchemaTree()]).then(([mods, tree]) => {
      if (alive && !inFlight.current && !mods.error && !tree.error) {
        setModules(mods.result); setRoots(tree.result.roots);
      }
    });
    return () => { alive = false; };
  }, [backend.ready]);
  async function operation(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Operation failed'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const connect = async (params: ConnectionParams) => operation(async () => {
    setCandidateModified(false);
    setDataNodes(null); setProvenance(null); setRetrievalXml(''); setDraft({ ...emptyEdit(), target: editCapabilities(info.capabilities).editableTargets[0] || 'candidate' }); setEditMode(false); setIntent(emptyRequest()); setModules([]); setRoots([]); setGeneration(g => g + 1); setProgress(null);
    unwrap(await api.connect(params));
    // Events own the state; a late response must not overwrite transport loss.
  });
  const fetchSchemas = () => operation(async () => {
    setLoading(true); setProgress(null);
    try {
      unwrap(await api.fetchSchemas());
      const loadedModules = unwrap(await api.getModules());
      const tree = unwrap(await api.getSchemaTree());
      setDataNodes(null); setProvenance(null); setRetrievalXml(''); setDraft({ ...emptyEdit(), target: editCapabilities(info.capabilities).editableTargets[0] || 'candidate' }); setEditMode(false); setIntent(emptyRequest()); setModules(loadedModules); setRoots(tree.roots); setGeneration(g => g + 1);
    } finally { setLoading(false); }
  });
  return <main>
    <header>
          <div className="brand"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></svg></span><h1>netconf-client</h1></div>
          <span>NETCONF / YANG workbench</span>
          <span className={`backend-status ${backend.ready ? 'ready' : 'unavailable'}`} role="status">{backend.ready ? 'Backend ready' : 'Backend unavailable'}</span>
        </header>
    {backend.error && <div role="alert" className="error">{backend.error}</div>}
    <ConnectionForm info={info} ready={backend.ready} busy={busy} connect={connect} disconnect={() => void operation(async () => { unwrap(await api.disconnect()); })} />
    <div className="toolbar"><button disabled={!backend.ready || busy || info.state !== 'connected'} onClick={() => void fetchSchemas()}>{loading ? 'Loading schemas…' : 'Load YANG models'}</button>
      <span>{loading ? (progress ? `${progress.current}/${progress.total} · ${progress.module}` : 'Discovering server schema…') : modules.length ? `${modules.length} compiled modules${info.state !== 'connected' ? ' · retained for inspection (disconnected)' : ''}` : 'Models load only on request.'}</span>
      {loading && <span>Disconnect available after loading finishes.</span>}
    </div>
    {error && <div className="error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    <RequestBuilder editToolbarTarget={editToolbarTarget} editMode={editMode} setEditMode={setEditMode} draft={draft} setDraft={setEditOptions} clearDraft={() => setDraftTree([])} hasDraft={draftTree.length > 0} candidateModified={candidateModified} onCandidateAttempt={(action, success) => { setProvenance(old => afterCandidate(old, action)); if (success) setCandidateModified(false); }} onEditAttempt={(edit, success) => { setProvenance(old => afterEdit(old, edit)); if (success && edit.target === 'candidate' && edit.testOption !== 'test-only') setCandidateModified(true); }} key={`request-${generation}`} intent={intent} setIntent={setIntent} roots={roots} info={info} busy={busy} run={operation} previewTarget={previewTarget} responseTarget={responseTarget} onExecute={() => { setOutputTab('response'); setDockOpen(true); }} onResponse={response => { if (response.dataNodes !== undefined) { setDataNodes(response.dataNodes); setRetrievalXml(response.rawXml); setProvenance({ operation: intent.operation, datastore: intent.datastore, stale: false }); } }} />
    <Group className="workbench" orientation="vertical" defaultLayout={readPreference<Layout | undefined>('vertical', undefined)} onLayoutChanged={layout => { if (dockOpen && layout.output > 10) writePreference('vertical', layout); }}>
      <Panel id="workspace" minSize="12%">
    <SchemaView setEditToolbarTarget={setEditToolbarTarget} draftTree={draftTree} setDraftTree={setDraftTree} activateEdit={() => setEditMode(true)} retrievalXml={retrievalXml} draft={draft} editMode={editMode} provenance={provenance} key={`schema-${generation}`} dataNodes={dataNodes} modules={modules} roots={roots} paths={intent.selectedPaths} disabled={busy} toggle={node => {
      const descendants = new Set<string>();
      const collect = (n: SchemaNode) => { descendants.add(n.path); n.children.forEach(collect); }; collect(node);
      const selectedPaths = intent.selectedPaths.filter(p => !descendants.has(p));
      if (!intent.selectedPaths.includes(node.path)) selectedPaths.push(node.path);
      const lists = new Set(relevantLists(roots, selectedPaths).map(n => n.path));
      setIntent({ ...intent, selectedPaths, listKeyValues: Object.fromEntries(Object.entries(intent.listKeyValues).filter(([p]) => lists.has(p))) });
    }} />
      </Panel>
      {dockOpen && <Separator className="splitter vertical" />}
      <Panel id="output" panelRef={outputPanel} collapsible collapsedSize="36px" defaultSize="32%" minSize="15%" maxSize="88%">
        <section className="output-dock">
          <div className="dock-header" onDoubleClick={() => { if (!dockOpen) setDockOpen(true); else { if (!maximized) previousDockSize.current = dockOpen ? outputPanel.current?.getSize().asPercentage || 32 : readPreference<Layout>('vertical', { output: 32 }).output; outputPanel.current?.resize(maximized ? `${previousDockSize.current}%` : '85%'); setMaximized(!maximized); } }}>
            <div role="tablist" aria-label="Output"><button role="tab" aria-selected={outputTab === 'preview'} onClick={() => { setOutputTab('preview'); setDockOpen(true); }}>Preview</button><button role="tab" aria-selected={outputTab === 'response'} onClick={() => { setOutputTab('response'); setDockOpen(true); }}>Response</button><button role="tab" aria-selected={outputTab === 'logs'} onClick={() => { setOutputTab('logs'); setDockOpen(true); }}>Session log</button></div>
            <button aria-label="Maximize output" onClick={() => { setDockOpen(true); if (!maximized) previousDockSize.current = dockOpen ? outputPanel.current?.getSize().asPercentage || 32 : readPreference<Layout>('vertical', { output: 32 }).output; outputPanel.current?.resize(maximized ? `${previousDockSize.current}%` : '85%'); setMaximized(!maximized); }}>{maximized ? 'Restore' : 'Maximize'}</button>
            <button onClick={() => { setDockOpen(!dockOpen); setMaximized(false); }}>{dockOpen ? 'Collapse output' : 'Expand output'}</button>
          </div>
          <div className="output-content" hidden={!dockOpen || outputTab !== 'preview'} ref={setPreviewTarget} />
          <div className="output-content" hidden={!dockOpen || outputTab !== 'response'} ref={setResponseTarget} />
          <div className="output-content" hidden={!dockOpen || outputTab !== 'logs'}><LogView logs={logs} clear={() => setLogs([])} /></div>
        </section>
      </Panel>
    </Group>
    <footer>No automatic connections or reconnections.</footer>
  </main>;
}
