import type { ApiResult, BsbBridge } from '../electron/shared';

declare global {
  interface Window {
    bsb: BsbBridge;
  }
}

export const bsb = (): BsbBridge => window.bsb;

export class ApiFailure extends Error {
  constructor(public readonly status: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}

/** Aufruf mit Fehler als Exception – vereinfacht die Oberfläche */
export async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const r: ApiResult<T> = await bsb().api.request<T>(method, path, body);
  if (!r.ok) throw new ApiFailure(r.status, r.error ?? `Fehler ${r.status}`, r.data);
  return r.data as T;
}
