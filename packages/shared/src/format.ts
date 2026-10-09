import { UNIT_LABELS, type Unit } from './enums';

const qtyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const moneyWhole = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});
const moneyCents = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatNumber(value: number): string {
  return qtyFormat.format(value);
}

export function formatQty(value: number, unit?: Unit): string {
  const n = qtyFormat.format(value);
  return unit ? `${n} ${UNIT_LABELS[unit]}` : n;
}

/** Целые рубли, если копеек нет, иначе с копейками. */
export function formatMoney(value: number): string {
  return Number.isInteger(value) ? moneyWhole.format(value) : moneyCents.format(value);
}

export function formatMoneyWhole(value: number): string {
  return moneyWhole.format(Math.round(value));
}

export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export function daysWord(n: number): string {
  return `${n} ${plural(n, ['день', 'дня', 'дней'])}`;
}

/** Человеческая подпись срока по числу суток до окончания. */
export function describeDaysLeft(daysLeft: number): string {
  if (daysLeft < 0) return `просрочено ${daysWord(-daysLeft)} назад`;
  if (daysLeft === 0) return 'истекает сегодня';
  if (daysLeft === 1) return 'истекает завтра';
  return `ещё ${daysWord(daysLeft)}`;
}
