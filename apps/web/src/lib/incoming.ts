import { formatQty, ruDate, type IncomingInfoDto } from '@zapas/shared';

/** Одной строкой, что и когда едет: «Молоко 40 л, ЗК-000771, привезут 16.10.2026». */
export function describeIncoming(i: IncomingInfoDto): string {
  return `${i.productName} ${formatQty(i.quantity, i.unit)}, заказ ${i.orderNumber}, привезут ${ruDate(i.arrivesOn)}`;
}
