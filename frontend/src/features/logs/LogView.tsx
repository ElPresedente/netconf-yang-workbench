import type { LogEntry } from '../../../../shared/types';
export function LogView({ logs, clear }: { logs: LogEntry[]; clear: () => void }) {
  return <section className="logs pane"><h2>Session log <span>Last 300 entries · XML previews limited to 100 KB</span><button onClick={clear}>Clear</button></h2>
    <div className="scroll" role="log" aria-label="Session log">{logs.length === 0 ? <p className="empty">Connection events and schema operations appear here.</p> : logs.map((log, i) => <div className={`log ${log.level}`} key={i}>
      <span className="log-time">{new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}</span> <b>{log.direction?.toUpperCase() || log.level.toUpperCase()}</b> {log.message}
      {log.payload && <details><summary>XML</summary><pre>{log.payload}</pre></details>}
    </div>)}</div>
  </section>;
}
