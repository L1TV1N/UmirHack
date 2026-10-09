import { formatMoney, formatQty, type OrderLineDto } from '@zapas/shared';

interface Head {
  number: string;
  createdAt: Date;
  supplierName: string;
  locationName: string;
  locationAddress: string | null;
  expectedOn: string | null;
  comment: string | null;
  total: number;
  timeZone: string;
}

// Неразрывные пробелы в письме и мессенджере выглядят странно и ломают поиск, поэтому заменяем обычными
const plain = (s: string) => s.replace(/[  ]/g, ' ');

/** Текст заказа для поставщика: его читает человек, поэтому без таблиц и служебных полей. */
export function orderText(head: Head, items: OrderLineDto[]): string {
  const date = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: head.timeZone }).format(head.createdAt);
  const lines = [`Заказ ${head.number} от ${date}`, `Поставщик: ${head.supplierName}`, `Доставка: ${head.locationName}${head.locationAddress ? `, ${head.locationAddress}` : ''}`];
  if (head.expectedOn) {
    const [y, m, d] = head.expectedOn.split('-');
    lines.push(`Желаемая дата поставки: ${d}.${m}.${y}`);
  }
  lines.push('');
  items.forEach((i, n) => {
    lines.push(`${n + 1}. ${i.productName} (${i.sku}): ${formatQty(i.quantity, i.unit)} × ${formatMoney(i.unitCost)} = ${formatMoney(i.sum)}`);
  });
  lines.push('', `Итого: ${items.length} поз. на ${formatMoney(head.total)}`);
  if (head.comment) lines.push('', `Комментарий: ${head.comment}`);
  return plain(lines.join('\n'));
}
