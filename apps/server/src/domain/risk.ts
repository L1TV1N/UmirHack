import { compareFefo } from './fefo';

export interface RiskBatch {
  id: string;
  remainingMilli: number;
  expiresOn: string;
  receivedOn: string;
  daysLeft: number;
}

export type RiskBasis = 'forecast' | 'rules' | 'expired';

export interface BatchRisk {
  batchId: string;
  atRiskMilli: number;
  basis: RiskBasis;
}

/** Ниже этой уверенности скорости не верим и смотрим только на срок. */
export const LOW_CONFIDENCE = 0.5;
/** В режиме «по срокам» под угрозой считается всё, что истекает в ближайшие сутки этого окна. */
export const RULES_WINDOW_DAYS = 3;
/** Дальше этого срока партию не считаем рискованной: прогноз на месяцы вперёд ничего не стоит. */
export const RISK_HORIZON_DAYS = 14;

/**
 * Сколько из каждой партии не успеем продать до окончания срока.
 * Партии идут по FEFO: партия i может продаваться только когда ушли все предыдущие,
 * поэтому до её срока доступно v * (дней + 1) продаж минус то, что нужно на предыдущие.
 */
export function computeBatchRisks(
  batches: readonly RiskBatch[],
  velocityPerDay: number,
  confidence: number,
): Map<string, BatchRisk> {
  const result = new Map<string, BatchRisk>();
  const velocityMilli = velocityPerDay * 1000;
  let cumulative = 0;

  for (const b of [...batches].sort(compareFefo)) {
    if (b.remainingMilli <= 0) continue;

    if (b.daysLeft < 0) {
      result.set(b.id, { batchId: b.id, atRiskMilli: b.remainingMilli, basis: 'expired' });
      continue;
    }

    if (b.daysLeft > RISK_HORIZON_DAYS) {
      result.set(b.id, { batchId: b.id, atRiskMilli: 0, basis: 'forecast' });
      cumulative += b.remainingMilli;
      continue;
    }

    if (confidence < LOW_CONFIDENCE) {
      const atRisk = b.daysLeft <= RULES_WINDOW_DAYS ? b.remainingMilli : 0;
      result.set(b.id, { batchId: b.id, atRiskMilli: atRisk, basis: 'rules' });
      cumulative += b.remainingMilli;
      continue;
    }

    const horizon = b.daysLeft + 1;
    const sellable = Math.min(Math.max(velocityMilli * horizon - cumulative, 0), b.remainingMilli);
    result.set(b.id, {
      batchId: b.id,
      atRiskMilli: Math.round(b.remainingMilli - sellable),
      basis: 'forecast',
    });
    cumulative += b.remainingMilli;
  }
  return result;
}
