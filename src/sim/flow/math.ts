/** 使用率から、待ち時間の伸びと溢れずに通る割合を求める小さな式 */
import { MAX_QUEUE_RHO } from '../config';

export const GB_PER_KB = 8e-6;
/** 使用率 rho の資源での待ち時間の伸び */
export const q = (rho: number) => 1 / (1 - Math.min(rho, MAX_QUEUE_RHO));
/** 使用率 rho の資源を通って溢れずに済む割合 */
export const pass = (rho: number) => (rho <= 1 ? 1 : 1 / rho);
export const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
