export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';
export interface ConnectionParams {
  host: string; port: number; username: string; password: string; authMode?: 'password'; profileId?: string;
}
export interface ConnectionInfo {
  protocolVersion?: '1.0' | '1.1' | null; state: ConnectionState; sessionId?: string | null; capabilities: string[];
  host?: string | null; port?: number | null;
}
export interface BackendError { code: string; message: string; details?: string }
export type Result<T> = { result: T; error?: never } | { error: BackendError; result?: never };
export interface SchemaNode {
  id: string; name: string; module: string; namespace: string; path: string;
  kind: 'container' | 'list' | 'leaf' | 'leaf-list' | 'anydata' | 'anyxml';
  config: boolean; mandatory: boolean; presence: boolean; keys: string[]; isKey: boolean;
  units?: string | null; type: string | null; description: string | null;
  default: string | number | boolean | null | (string | number | boolean | null)[];
  children: SchemaNode[];
}
export interface YangModuleInfo { name: string; revision: string | null; namespace: string }
export interface SchemaTree { roots: SchemaNode[] }
export interface SchemaSummary { modulesDownloaded: number; modulesLoaded: number }
export interface LogEntry {
  timestamp: string; level: 'info' | 'warning' | 'error'; message: string;
  direction?: 'tx' | 'rx' | null; payload?: string | null;
}
export interface SchemaProgress { current: number; total: number; module: string }
export interface BackendStatus { ready: boolean; error?: string }
export type CandidateAction = 'commit' | 'discard';
export interface NetconfAPI {
  commitCandidate(): Promise<Result<RequestResponse>>;
  discardCandidate(): Promise<Result<RequestResponse>>;
  previewEdit(params: EditIntent): Promise<Result<{ xml: string }>>;
  executeEdit(params: EditIntent): Promise<Result<RequestResponse>>;
  getProfiles(): Promise<Result<ProfileState>>;
  saveProfile(profile: ProfileSave): Promise<Result<ProfileState>>;
  selectProfile(id: string | null): Promise<Result<ProfileState>>;
  deleteProfile(id: string): Promise<Result<ProfileState>>;
  previewRequest(params: RequestIntent): Promise<Result<{ xml: string }>>;
  executeRequest(params: RequestIntent): Promise<Result<RequestResponse>>;
  connect(params: ConnectionParams): Promise<Result<ConnectionInfo>>;
  disconnect(): Promise<Result<ConnectionInfo>>;
  getConnectionState(): Promise<Result<ConnectionInfo>>;
  fetchSchemas(): Promise<Result<SchemaSummary>>;
  getModules(): Promise<Result<YangModuleInfo[]>>;
  getSchemaTree(): Promise<Result<SchemaTree>>;
  getBackendStatus(): Promise<BackendStatus>;
  onConnectionStateChanged(callback: (data: ConnectionInfo) => void): () => void;
  onSchemaProgress(callback: (data: SchemaProgress) => void): () => void;
  onLog(callback: (data: LogEntry) => void): () => void;
  onBackendStatus(callback: (data: BackendStatus) => void): () => void;
}

export type Datastore = 'running' | 'candidate' | 'startup';
export type WithDefaultsMode = 'report-all' | 'trim' | 'explicit' | 'report-all-tagged';
export interface RequestIntent {
  withDefaults?: WithDefaultsMode | null;
  operation: 'get' | 'get-config'; datastore: Datastore | null;
  selectedPaths: string[]; listKeyValues: Record<string, Record<string, string>>;
}
export interface RequestResponse { dataNodes?: DataNode[]; parseWarning?: string; xml: string; rawXml: string; errors: Record<string, string>[] }

export interface DataNode {
  id: string; name: string; module: string; namespace: string;
  schemaPath: string; instancePath: string; kind: string; value: string | null;
  keyValues: Record<string, string>; config: boolean | null; children: DataNode[];
}
export interface DeviceProfile {
  id: string; displayName: string; host: string; port: number; username: string;
  auth: { type: 'password' }; hasPassword: boolean;
}
export interface ProfileState { profiles: DeviceProfile[]; lastSelectedId: string | null; secureStorageAvailable: boolean }
export interface ProfileSave {
  id?: string; displayName: string; host: string; port: number; username: string;
  auth: { type: 'password' }; rememberPassword: boolean; password?: string;
}

export type EditOperation = 'merge' | 'replace' | 'create' | 'delete' | 'remove';
export interface EditChange {
  id: string; schemaPath: string; operation: EditOperation;
  ancestorKeys: { listSchemaPath: string; values: Record<string, string> }[];
  value?: string | null; source: 'schema' | 'runtime'; type: string | null;
  instancePath?: string; currentValue?: string | null;
}
export interface EditIntent {
  target: 'candidate' | 'running'; defaultOperation: 'merge' | 'replace' | 'none' | null;
  testOption: 'test-then-set' | 'set' | 'test-only' | null;
  errorOption: 'stop-on-error' | 'continue-on-error' | 'rollback-on-error' | null;
  changes: EditChange[];
}
export interface RetrievalProvenance { operation: RequestIntent['operation']; datastore: Datastore | null; stale: boolean }
