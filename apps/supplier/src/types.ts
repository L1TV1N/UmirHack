import type { PortalOrderLine } from '@zapas/shared';

export interface AccountDto {
  id: number;
  inn: string;
  company: string;
  contactName: string;
  email: string;
  phone: string | null;
  createdAt: string;
  /** Сколько покупателей уже прислали заказы на этот ИНН. */
  buyers: number;
}

export type Stage = 'new' | 'work' | 'shipped' | 'closed';

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'Новые',
  work: 'Подтверждены',
  shipped: 'Отгружены',
  closed: 'Закрыты',
};

/** К какой вкладке относится заказ по статусу в «Запасе». */
export function stageOf(status: string): Stage {
  if (status === 'sent') return 'new';
  if (status === 'confirmed') return 'work';
  if (status === 'shipped' || status === 'partial') return 'shipped';
  return 'closed';
}

export const STATUS_TONES: Record<string, 'info' | 'warn' | 'ok' | 'bad' | 'muted'> = {
  sent: 'info',
  confirmed: 'warn',
  shipped: 'warn',
  partial: 'warn',
  received: 'ok',
  declined: 'bad',
  refused: 'bad',
  cancelled: 'muted',
};

export interface OrderRowDto {
  id: number;
  number: string;
  status: string;
  statusLabel: string;
  stage: Stage;
  buyerOrg: string;
  buyerLocation: string;
  expectedOn: string | null;
  deliveryOn: string | null;
  total: number;
  lines: number;
  receivedAt: string;
  updatedAt: string;
  isNew: boolean;
}

export interface OrderEventDto {
  id: number;
  at: string;
  actor: string;
  text: string;
}

export interface OrderDetailDto extends OrderRowDto {
  buyerAddress: string | null;
  comment: string | null;
  buyerNote: string | null;
  supplierNote: string | null;
  items: PortalOrderLine[];
  events: OrderEventDto[];
  /** Что поставщик может сделать сейчас. */
  actions: ('confirm' | 'decline' | 'ship')[];
}

export interface DashboardDto {
  counts: Record<Stage, number>;
  awaitingSum: number;
  monthSum: number;
  buyers: number;
  recent: OrderRowDto[];
}

export interface BuyerDto {
  organization: string;
  locations: { name: string; address: string | null; orders: number; sum: number; lastAt: string }[];
  orders: number;
  sum: number;
}

export interface SessionDto {
  account: AccountDto;
}
