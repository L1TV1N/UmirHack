/**
 * Количества хранятся в БД с тремя знаками. В расчётах работаем с целыми
 * тысячными долями, чтобы не накапливать ошибку чисел с плавающей точкой.
 */
export function toMilli(value: number): number {
  return Math.round(value * 1000);
}

export function fromMilli(milli: number): number {
  return milli / 1000;
}

export function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
