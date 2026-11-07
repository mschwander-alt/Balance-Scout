import type { BsbBridge } from '../electron/shared';
type Bridge = BsbBridge & { app: BsbBridge['app'] & { loadResult(id: string): Promise<unknown> } };
declare global {
  interface Window { bsb: Bridge }
}
export const bsb = (): Bridge => window.bsb;
