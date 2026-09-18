import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BackendStatus, Result } from '../shared/types';

interface Pending { resolve: (result: Result<unknown>) => void }
const failure = (message: string): Result<never> => ({ error: { code: 'backend_error', message } });

export class BackendProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private stderr = '';
  private stopping = false;
  private exited = false;
  status: BackendStatus = { ready: false };

  start(root: string) {
    const local = path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const python = process.env.NETCONF_PYTHON || (existsSync(local) ? local : (process.platform === 'win32' ? 'python' : 'python3'));
    const cwd = process.env.NETCONF_BACKEND_PATH || path.join(root, 'backend');
    const child = this.child = spawn(python, ['-u', '-m', 'netconf_backend.main'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stdin.on('error', () => this.fail('Python backend input closed'));
    child.on('error', (error) => this.fail(`Python backend failed to start: ${error.message}`));
    child.on('close', (code, signal) => {
      this.exited = true;
      this.fail(this.stopping ? 'Backend stopped' : `Python backend exited (${signal || code}). ${this.stderr || 'Check Python and system libyang installation.'}`);
    });
    const startup = setTimeout(() => {
      if (!this.status.ready && !this.status.error) {
        this.fail(`Python backend did not become ready. ${this.stderr}`);
        child.kill();
      }
    }, 15000);
    startup.unref();
  }

  private fail(message: string) {
    this.status = { ready: false, error: message };
    for (const pending of this.pending.values()) pending.resolve(failure(message));
    this.pending.clear();
    this.emit('backend.status', this.status);
    this.emit('connection.stateChanged', { state: 'disconnected', capabilities: [] });
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    // Effective schema trees may be large, but malformed stdout must not grow forever.
    if (this.buffer.length > 128 * 1024 * 1024) {
      this.fail('Python backend message exceeded 128 MiB');
      this.child?.kill();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const message: unknown = JSON.parse(line);
        if (!message || typeof message !== 'object') throw new Error('Invalid message');
        const obj = message as Record<string, unknown>;
        if (typeof obj.id === 'number') {
          const pending = this.pending.get(obj.id);
          if (pending) {
            this.pending.delete(obj.id);
            pending.resolve(('error' in obj ? { error: obj.error } : { result: obj.result }) as Result<unknown>);
          }
        } else if (obj.event === 'backend.ready') {
          this.status = { ready: true };
          this.emit('backend.status', this.status);
        } else if (typeof obj.event === 'string' && ['connection.stateChanged', 'connection.closed', 'schema.progress', 'log.entry'].includes(obj.event)) {
          this.emit(obj.event, obj.data);
        } else throw new Error('Unknown message');
      } catch {
        this.fail('Invalid JSON protocol output from Python backend');
        this.child?.kill();
        return;
      }
    }
  }

  request(method: string, params: unknown = {}): Promise<Result<unknown>> {
    if (!this.child || !this.status.ready || this.stopping && method !== 'shutdown') {
      return Promise.resolve(failure(this.status.error || 'Python backend is not ready'));
    }
    const id = ++this.nextId;
    return new Promise(resolve => {
      this.pending.set(id, { resolve });
      // Do not log this line: connect contains an ephemeral password.
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) this.fail('Failed to write to Python backend');
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || this.exited) return;
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    if (this.status.ready) void this.request('shutdown');
    child.stdin.end();
    const term = setTimeout(() => child.kill('SIGTERM'), 6000);
    const kill = setTimeout(() => child.kill('SIGKILL'), 8000);
    await exited;
    clearTimeout(term); clearTimeout(kill);
  }
}
