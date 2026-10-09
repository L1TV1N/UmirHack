export const ROLES = ['admin', 'manager', 'storekeeper', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  storekeeper: 'Кладовщик',
  viewer: 'Наблюдатель',
};

export const UNITS = ['kg', 'l', 'pcs'] as const;
export type Unit = (typeof UNITS)[number];

export const UNIT_LABELS: Record<Unit, string> = {
  kg: 'кг',
  l: 'л',
  pcs: 'шт',
};

export const LOCATION_KINDS = ['warehouse', 'kitchen', 'shop'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  warehouse: 'Склад',
  kitchen: 'Кухня',
  shop: 'Магазин',
};

export const DOCUMENT_KINDS = ['receipt', 'sale', 'writeoff', 'transfer', 'inventory'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  receipt: 'Приход',
  sale: 'Продажа',
  writeoff: 'Списание',
  transfer: 'Перемещение',
  inventory: 'Инвентаризация',
};

export const MOVEMENT_TYPES = [
  'receipt',
  'sale',
  'writeoff',
  'adjustment_in',
  'adjustment_out',
  'transfer_in',
  'transfer_out',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  receipt: 'Приход',
  sale: 'Продажа',
  writeoff: 'Списание',
  adjustment_in: 'Излишек',
  adjustment_out: 'Недостача',
  transfer_in: 'Перемещение (приём)',
  transfer_out: 'Перемещение (отправка)',
};

export const WRITEOFF_REASONS = ['expired', 'spoiled', 'damaged', 'shortage', 'other'] as const;
export type WriteoffReason = (typeof WRITEOFF_REASONS)[number];

export const WRITEOFF_REASON_LABELS: Record<WriteoffReason, string> = {
  expired: 'Истёк срок',
  spoiled: 'Порча',
  damaged: 'Бой, повреждение',
  shortage: 'Недостача',
  other: 'Прочее',
};

export const EXPIRY_STATUSES = ['expired', 'critical', 'soon', 'ok'] as const;
export type ExpiryStatus = (typeof EXPIRY_STATUSES)[number];

export const EXPIRY_STATUS_LABELS: Record<ExpiryStatus, string> = {
  expired: 'Просрочено',
  critical: 'Критично',
  soon: 'Скоро истекает',
  ok: 'В норме',
};

export const INVENTORY_STATUSES = ['draft', 'committed', 'cancelled'] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  draft: 'Черновик',
  committed: 'Проведена',
  cancelled: 'Отменена',
};

export const RECOMMENDATION_TYPES = ['writeoff', 'discount', 'transfer', 'promote', 'reorder'] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_TYPE_LABELS: Record<RecommendationType, string> = {
  writeoff: 'Списать',
  discount: 'Скидка',
  transfer: 'Переместить',
  promote: 'Продвигать',
  reorder: 'Заказать',
};

export const STOP_REASON_CODES = ['out_of_stock', 'all_expired', 'missing_ingredients', 'manual'] as const;
export type StopReasonCode = (typeof STOP_REASON_CODES)[number];

/** Порядок ролей по полномочиям: чем больше число, тем шире права. */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  storekeeper: 1,
  manager: 2,
  admin: 3,
};

export function hasRole(role: Role, atLeast: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[atLeast];
}

/** Admin и manager видят все точки, остальные только назначенные. */
export function seesAllLocations(role: Role): boolean {
  return role === 'admin' || role === 'manager';
}
