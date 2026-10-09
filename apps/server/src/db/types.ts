import type { ColumnType, Generated } from 'kysely';

// numeric приходит из pg строкой, чтобы не терять точность
type Numeric = ColumnType<string, number | string, number | string>;
type NumericNullable = ColumnType<string | null, number | string | null | undefined, number | string | null>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type TimestampNullable = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
// date читается строкой YYYY-MM-DD, см. client.ts
type DateOnly = ColumnType<string, string, string>;
type DateOnlyNullable = ColumnType<string | null, string | null | undefined, string | null>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  full_name: string;
  password_hash: string;
  role: 'admin' | 'manager' | 'storekeeper' | 'viewer';
  is_active: Generated<boolean>;
  failed_attempts: Generated<number>;
  locked_until: TimestampNullable;
  password_changed_at: Timestamp;
  last_login_at: TimestampNullable;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TelegramLinksTable {
  user_id: string;
  chat_id: Numeric;
  username: string | null;
  linked_at: Timestamp;
}

export interface TelegramLinkCodesTable {
  code_hash: string;
  user_id: string;
  expires_at: Date;
  created_at: Timestamp;
}

export interface LocationsTable {
  id: Generated<string>;
  code: string;
  name: string;
  kind: 'warehouse' | 'kitchen' | 'shop';
  address: string | null;
  latitude: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  longitude: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
}

export interface UserLocationsTable {
  user_id: string;
  location_id: string;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: TimestampNullable;
  replaced_by: string | null;
  created_at: Timestamp;
  user_agent: string | null;
  ip: string | null;
}

export interface ApiKeysTable {
  id: Generated<string>;
  name: string;
  key_hash: string;
  key_prefix: string;
  location_id: string;
  created_by: string | null;
  created_at: Timestamp;
  last_used_at: TimestampNullable;
  revoked_at: TimestampNullable;
}

export interface CategoriesTable {
  id: Generated<string>;
  name: string;
}

export interface BatchMarksTable {
  id: Generated<string>;
  batch_id: string;
  gtin: string;
  serial: string;
  code: string;
  created_at: Timestamp;
}

export interface VetCertificatesTable {
  id: Generated<string>;
  number: string;
  batch_id: string;
  product_id: string;
  supplier_id: string | null;
  location_id: string;
  quantity: Numeric;
  received_at: Date;
  due_at: Date;
  status: Generated<'pending' | 'redeemed'>;
  redeemed_at: TimestampNullable;
  redeemed_by: string | null;
  comment: string | null;
}

export interface SupplierItemMapTable {
  supplier_id: string;
  item_key: string;
  product_id: string;
  updated_at: Timestamp;
}

export interface SuppliersTable {
  id: Generated<string>;
  name: string;
  inn: string | null;
  phone: string | null;
  note: string | null;
  email: string | null;
  lead_time_days: Generated<number>;
  min_order_sum: ColumnType<string, number | string | undefined, number | string>;
  auto_order: Generated<boolean>;
  is_active: Generated<boolean>;
}

export interface ProductsTable {
  id: Generated<string>;
  sku: string;
  barcode: string | null;
  name: string;
  category_id: string;
  unit: 'kg' | 'l' | 'pcs';
  min_stock: Numeric;
  shelf_life_days: number | null;
  price: Numeric;
  cost: Numeric;
  sellable: boolean;
  requires_vsd: Generated<boolean>;
  requires_marking: Generated<boolean>;
  default_supplier_id: string | null;
  pack_size: ColumnType<string, number | string | undefined, number | string>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DishesTable {
  id: Generated<string>;
  name: string;
  code: string | null;
  price: Numeric;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DishItemsTable {
  dish_id: string;
  product_id: string;
  quantity: Numeric;
}

export interface DocumentsTable {
  id: Generated<string>;
  kind: 'receipt' | 'sale' | 'writeoff' | 'transfer' | 'inventory';
  number: string;
  location_id: string;
  to_location_id: string | null;
  created_by: string | null;
  actor_name: string;
  comment: string | null;
  idempotency_scope: string | null;
  idempotency_key: string | null;
  idempotency_hash: string | null;
  created_at: Timestamp;
}

export interface BatchesTable {
  id: Generated<string>;
  product_id: string;
  location_id: string;
  supplier_id: string | null;
  origin_document_id: string | null;
  document_no: string | null;
  received_on: DateOnly;
  expires_on: DateOnly;
  initial_qty: Numeric;
  remaining_qty: Numeric;
  unit_cost: Numeric;
  created_by: string | null;
  created_at: Timestamp;
}

export interface StockMovementsTable {
  id: Generated<number>;
  document_id: string;
  batch_id: string;
  product_id: string;
  location_id: string;
  type: 'receipt' | 'sale' | 'writeoff' | 'adjustment_in' | 'adjustment_out' | 'transfer_in' | 'transfer_out';
  quantity: Numeric;
  unit_cost: Numeric;
  unit_price: NumericNullable;
  reason: 'expired' | 'spoiled' | 'damaged' | 'shortage' | 'other' | null;
  dish_id: string | null;
  comment: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface PromotionsTable {
  id: Generated<string>;
  batch_id: string;
  percent: number;
  ends_on: DateOnly;
  created_by: string | null;
  created_at: Timestamp;
  cancelled_at: TimestampNullable;
}

export interface InventoriesTable {
  id: Generated<string>;
  location_id: string;
  status: Generated<'draft' | 'committed' | 'cancelled'>;
  comment: string | null;
  created_by: string;
  created_at: Timestamp;
  committed_at: TimestampNullable;
  document_id: string | null;
}

export interface InventoryLinesTable {
  inventory_id: string;
  product_id: string;
  expected_qty: Numeric;
  counted_qty: NumericNullable;
  surplus_expires_on: DateOnlyNullable;
}

export interface StopListManualTable {
  id: Generated<string>;
  location_id: string;
  product_id: string | null;
  dish_id: string | null;
  reason: string;
  created_by: string | null;
  created_at: Timestamp;
  until: TimestampNullable;
  released_at: TimestampNullable;
  released_by: string | null;
}

export interface StopListStateTable {
  location_id: string;
  entity_type: 'product' | 'dish';
  entity_id: string;
  since: Timestamp;
  reasons: ColumnType<unknown, string, string>;
}

export interface SettingsTable {
  key: string;
  value: ColumnType<unknown, string, string>;
  updated_by: string | null;
  updated_at: Timestamp;
}

export interface AuditLogTable {
  id: Generated<number>;
  at: Timestamp;
  user_id: string | null;
  user_email: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: ColumnType<unknown, string, string>;
  prev_hash: string;
  hash: string;
}

export interface NotificationLogTable {
  id: Generated<number>;
  kind: string;
  dedupe_key: string;
  sent_at: Timestamp;
}

export interface WeatherDailyTable {
  location_id: string;
  day: DateOnly;
  t_max: NumericNullable;
  t_min: NumericNullable;
  precip_mm: NumericNullable;
  is_forecast: boolean;
  fetched_at: Timestamp;
}

export interface CalendarDaysTable {
  day: DateOnly;
  kind: 'off' | 'work';
  note: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface DemandOutlookTable {
  location_id: string;
  product_id: string;
  factor: Numeric;
  computed_for: DateOnly;
  computed_at: Timestamp;
}

export interface PurchaseOrdersTable {
  id: Generated<string>;
  number: string;
  supplier_id: string;
  location_id: string;
  status: Generated<'draft' | 'sent' | 'partial' | 'received' | 'cancelled'>;
  expected_on: DateOnlyNullable;
  comment: string | null;
  total: ColumnType<string, number | string | undefined, number | string>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  sent_at: TimestampNullable;
  sent_by: string | null;
  closed_at: TimestampNullable;
  emailed_at: TimestampNullable;
  email_error: string | null;
}

export interface PurchaseOrderLinesTable {
  order_id: string;
  product_id: string;
  quantity: Numeric;
  unit_cost: Numeric;
  received_qty: ColumnType<string, number | string | undefined, number | string>;
}

export interface WebhookEndpointsTable {
  id: Generated<string>;
  name: string;
  url: string;
  secret_enc: string;
  events: string[];
  location_id: string | null;
  enabled: Generated<boolean>;
  failure_streak: Generated<number>;
  disabled_reason: string | null;
  last_success_at: TimestampNullable;
  last_failure_at: TimestampNullable;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebhookDeliveriesTable {
  id: Generated<string>;
  endpoint_id: string;
  event: string;
  payload: ColumnType<unknown, string, string>;
  status: Generated<'pending' | 'delivered' | 'failed'>;
  attempts: Generated<number>;
  next_attempt_at: Timestamp;
  last_status: number | null;
  last_error: string | null;
  created_at: Timestamp;
  delivered_at: TimestampNullable;
}

export interface StoplistPublishedTable {
  location_id: string;
  entries: ColumnType<unknown, string, string>;
  published_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  locations: LocationsTable;
  user_locations: UserLocationsTable;
  supplier_item_map: SupplierItemMapTable;
  batch_marks: BatchMarksTable;
  vet_certificates: VetCertificatesTable;
  weather_daily: WeatherDailyTable;
  calendar_days: CalendarDaysTable;
  demand_outlook: DemandOutlookTable;
  purchase_orders: PurchaseOrdersTable;
  purchase_order_lines: PurchaseOrderLinesTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  stoplist_published: StoplistPublishedTable;
  telegram_links: TelegramLinksTable;
  telegram_link_codes: TelegramLinkCodesTable;
  refresh_tokens: RefreshTokensTable;
  api_keys: ApiKeysTable;
  categories: CategoriesTable;
  suppliers: SuppliersTable;
  products: ProductsTable;
  dishes: DishesTable;
  dish_items: DishItemsTable;
  documents: DocumentsTable;
  batches: BatchesTable;
  stock_movements: StockMovementsTable;
  promotions: PromotionsTable;
  inventories: InventoriesTable;
  inventory_lines: InventoryLinesTable;
  stop_list_manual: StopListManualTable;
  stop_list_state: StopListStateTable;
  settings: SettingsTable;
  audit_log: AuditLogTable;
  notification_log: NotificationLogTable;
}
