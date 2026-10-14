import type { Unit } from './enums';

export const ORDER_STATUSES = ['draft', 'sent', 'confirmed', 'shipped', 'partial', 'received', 'declined', 'refused', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'Черновик',
  sent: 'Отправлен поставщику',
  confirmed: 'Подтверждён поставщиком',
  shipped: 'Отгружен',
  partial: 'Принят частично',
  received: 'Принят',
  declined: 'Поставщик отказал',
  refused: 'Отказ от поставки',
  cancelled: 'Отменён',
};

/** Заказы, по которым товар ещё ждём: их остаток считается «в пути». */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['sent', 'confirmed', 'shipped', 'partial'];

export const MAX_ORDER_LINES = 200;

export interface OrderLineDto {
  productId: string;
  productName: string;
  sku: string;
  unit: Unit;
  /** Срок годности продукта в сутках: при приёмке по заказу подставляется срок. */
  shelfLifeDays: number | null;
  quantity: number;
  unitCost: number;
  sum: number;
  receivedQty: number;
}

export interface OrderDto {
  id: string;
  number: string;
  status: OrderStatus;
  supplierId: string;
  supplierName: string;
  supplierEmail: string | null;
  locationId: string;
  locationName: string;
  expectedOn: string | null;
  comment: string | null;
  total: number;
  lines: number;
  createdAt: string;
  createdBy: string | null;
  sentAt: string | null;
  closedAt: string | null;
  /** Письмо поставщику ушло. */
  emailedAt: string | null;
  /** Почему письмо не ушло (короткая причина). */
  emailError: string | null;
  /** Дата поставки, которую обещал поставщик в своём кабинете. */
  deliveryOn: string | null;
  /** Последнее сообщение поставщика. */
  supplierNote: string | null;
  /** Решение покупателя при приёмке: замечание или причина отказа. */
  buyerNote: string | null;
  /** Заказ дошёл до кабинета поставщика. */
  portalPushedAt: string | null;
  /** Почему заказ не дошёл до кабинета поставщика, пока пробуем снова. */
  portalError: string | null;
}

export interface OrderEventDto {
  id: string;
  side: 'buyer' | 'supplier';
  status: string;
  text: string;
  actor: string;
  at: string;
}

export interface OrderDetailDto extends OrderDto {
  items: OrderLineDto[];
  events: OrderEventDto[];
  /** Готовый текст заказа: его можно отправить поставщику в мессенджер или по почте. */
  text: string;
}

export interface OrderSuggestionLineDto {
  productId: string;
  productName: string;
  sku: string;
  unit: Unit;
  quantity: number;
  unitCost: number;
  sum: number;
  /** Остаток без просрочки. */
  available: number;
  /** Уже заказано и ещё не принято. */
  incoming: number;
  perDay: number;
  /** На сколько суток хватит остатка и того, что в пути. Пусто, если продажи не измерены. */
  daysCover: number | null;
  packSize: number;
  reason: string;
}

export interface OrderSuggestionDto {
  supplierId: string;
  supplierName: string;
  supplierEmail: string | null;
  leadTimeDays: number;
  minOrderSum: number;
  locationId: string;
  locationName: string;
  lines: OrderSuggestionLineDto[];
  total: number;
  /** Суммы не хватает до минимального заказа поставщика. */
  belowMinimum: boolean;
  /** Уже есть черновик на этого поставщика и точку. */
  draftId: string | null;
}

/** Событие «заказ отправлен»: для интеграции с кабинетом поставщика, EDI или собственным сервисом. */
export interface OrderSentPayload {
  event: 'order.sent';
  createdAt: string;
  order: {
    id: string;
    number: string;
    supplier: { id: string; name: string; email: string | null };
    location: { id: string; name: string };
    expectedOn: string | null;
    comment: string | null;
    total: number;
    lines: { sku: string; barcode: string | null; name: string; unit: Unit; quantity: number; unitCost: number }[];
  };
}
