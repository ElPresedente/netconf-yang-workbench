import type { NetconfAPI, Result } from '../../../shared/types';
declare global { interface Window { netconf: NetconfAPI } }
export const api = window.netconf;
export function unwrap<T>(response: Result<T>): T {
  if (response.error) throw new Error(`${response.error.message}${response.error.details ? ` — ${response.error.details}` : ''}`);
  return response.result;
}
