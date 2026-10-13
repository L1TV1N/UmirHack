import type {
  DocumentKind,
  ExpiryStatus,
  InventoryStatus,
  LocationKind,
  MovementType,
  RecommendationType,
  Role,
  StopReasonCode,
  Unit,
  WriteoffReason,
} from './enums';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

export interface UserDto {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  locationIds: string[];
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
}

export interface SessionDto {
  accessToken: string;
  expiresIn: number;
  user: UserDto;
}

export interface LocationDto {
  id: string;
  code: string;
  name: string;
  kind: LocationKind;
  address: string | null;
  /** Координаты для прогноза погоды. */
  latitude: number | null;
  longitude: number | null;
  isActive: boolean;
}

export interface CategoryDto {
  id: string;
  name: string;
}

export interface SupplierDto {
  id: string;
  name: string;
  inn: string | null;
  phone: string | null;
  note: string | null;
  email: string | null;
  /** Сколько суток от заказа до поставки. */
  leadTimeDays: number;
  /** Меньше этой суммы поставщик заказ не принимает. */
  minOrderSum: number;
  /** Раз в сутки готовить черновики заказов по продуктам этого поставщика. */
  autoOrder: boolean;
  isActive: boolean;
}

export interface ProductDto {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: string;
  categoryName: string;
  unit: Unit;
  minStock: number;
  shelfLifeDays: number | null;
  price: number;
  cost: number;
  sellable: boolean;
  /** Товар животного происхождения: к партии нужен ВСД из «Меркурия». */
  requiresVsd: boolean;
  /** Товар подлежит маркировке: к партии нужны коды «Честного знака». */
  requiresMarking: boolean;
  /** Поставщик, у которого заказываем по умолчанию. */
  defaultSupplierId: string | null;
  defaultSupplierName: string | null;
  /** Кратность заказа: фасовка или ящик. Заказ округляется вверх до целого числа таких упаковок. */
  packSize: number;
  isActive: boolean;
}

export interface DishItemDto {
  productId: string;
  productName: string;
  unit: Unit;
  quantity: number;
}

export interface DishDto {
  id: string;
  name: string;
  /** Код блюда в кассовой системе. */
  code: string | null;
  price: number;
  isActive: boolean;
  items: DishItemDto[];
}

export interface PromotionRef {
  id: string;
  percent: number;
  endsOn: string;
}

export type BatchStatus = ExpiryStatus | 'depleted';

export interface BatchDto {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unit: Unit;
  locationId: string;
  locationName: string;
  supplierId: string | null;
  supplierName: string | null;
  documentNo: string | null;
  receivedOn: string;
  expiresOn: string;
  daysLeft: number;
  status: BatchStatus;
  initialQty: number;
  remainingQty: number;
  unitCost: number;
  value: number;
  /** Доля срока годности, которая уже прошла, от 0 до 1. */
  lifeElapsed: number;
  promotion: PromotionRef | null;
}

export interface StockRowDto {
  productId: string;
  sku: string;
  name: string;
  categoryId: string;
  categoryName: string;
  unit: Unit;
  locationId: string;
  locationName: string;
  onHand: number;
  available: number;
  expired: number;
  value: number;
  expiredValue: number;
  batches: number;
  nearestExpiry: string | null;
  daysLeft: number | null;
  status: ExpiryStatus | 'empty';
  minStock: number;
  belowMin: boolean;
}

export interface MovementDto {
  id: string;
  createdAt: string;
  type: MovementType;
  quantity: number;
  unitCost: number;
  unitPrice: number | null;
  reason: WriteoffReason | null;
  comment: string | null;
  productId: string;
  productName: string;
  unit: Unit;
  locationId: string;
  locationName: string;
  batchId: string;
  expiresOn: string;
  documentId: string;
  documentNumber: string;
  dishName: string | null;
  authorName: string;
}

export interface DocumentDto {
  id: string;
  kind: DocumentKind;
  number: string;
  locationId: string;
  locationName: string;
  createdAt: string;
  authorName: string;
  comment: string | null;
  lines: number;
  /** Сумма модулей количества, для списка. */
  totalAmount: number;
}

export interface DocumentDetailDto extends DocumentDto {
  movements: MovementDto[];
}

export interface InventoryLineDto {
  productId: string;
  sku: string;
  productName: string;
  unit: Unit;
  expectedQty: number;
  countedQty: number | null;
  surplusExpiresOn: string | null;
  difference: number | null;
  unitCost: number;
}

export interface InventoryDto {
  id: string;
  locationId: string;
  locationName: string;
  status: InventoryStatus;
  comment: string | null;
  createdAt: string;
  committedAt: string | null;
  authorName: string;
  documentId: string | null;
  linesTotal: number;
  linesCounted: number;
}

export interface InventoryDetailDto extends InventoryDto {
  lines: InventoryLineDto[];
}

export interface PromotionDto {
  id: string;
  batchId: string;
  productName: string;
  locationName: string;
  expiresOn: string;
  remainingQty: number;
  unit: Unit;
  percent: number;
  basePrice: number;
  promoPrice: number;
  endsOn: string;
  createdAt: string;
  cancelledAt: string | null;
}

export interface MissingIngredient {
  productId: string;
  name: string;
  unit: Unit;
  required: number;
  available: number;
}

export interface StopReason {
  code: StopReasonCode;
  text: string;
  missing?: MissingIngredient[];
}

export interface StopListEntryDto {
  key: string;
  entityType: 'product' | 'dish';
  entityId: string;
  name: string;
  locationId: string;
  locationName: string;
  source: 'auto' | 'manual';
  reasons: StopReason[];
  since: string;
  manualId: string | null;
  until: string | null;
  createdBy: string | null;
}

export interface LowPortionDto {
  dishId: string;
  name: string;
  locationId: string;
  locationName: string;
  portions: number;
}

export interface StopForecastDto {
  dishId: string;
  dishName: string;
  locationId: string;
  locationName: string;
  /** Когда блюдо перестанет готовиться, если новых поставок не будет. */
  expectedAt: string;
  hoursLeft: number;
  /** depletion: остаток разойдётся при текущих продажах. expiry: закончится срок годности. */
  cause: 'depletion' | 'expiry';
  portionsNow: number;
  limiting: {
    productId: string;
    productName: string;
    unit: Unit;
    availableNow: number;
    perPortion: number;
    perDay: number | null;
  };
}

/** Веса составляющих оценки поставщика, в сумме 1. Если составляющей нет (не было заказов), оценка считается по остальным. */
export const SUPPLIER_SCORE_WEIGHTS = { fill: 0.35, onTime: 0.25, freshness: 0.2, quality: 0.2 } as const;
/** Остаток срока годности при приёмке, начиная с которого свежесть оценивается полностью. */
export const FRESHNESS_FULL = 0.8;
/** Доля потерь от порчи и боя к принятому, при которой оценка качества нулевая. */
export const SPOILAGE_ZERO_AT = 0.05;

export interface SupplierScoreDto {
  supplierId: string;
  supplierName: string;
  /** От 0 до 100. null: за период нет ни заказов, ни приходов. */
  score: number | null;
  grade: 'A' | 'B' | 'C' | null;
  /** Заказов в расчёте: отправленных, срок которых наступил. */
  orders: number;
  /** Какую часть заказанного по стоимости привезли, от 0 до 1. */
  fillRate: number | null;
  /** Доля заказов, первая поставка по которым пришла не позже обещанной даты. */
  onTimeRate: number | null;
  /** Средняя задержка по заказам в днях, с учётом не привезённых до сих пор. */
  avgDelayDays: number | null;
  /** Какая доля срока годности в среднем оставалась при приёмке (по стоимости), от 0 до 1. */
  freshness: number | null;
  receivedValue: number;
  /** Потери по партиям поставщика за период, все причины, по себестоимости. */
  lossValue: number;
  /** Доля порчи и боя к принятому. */
  spoilageRate: number | null;
  losses: { reason: WriteoffReason; value: number }[];
}

export interface SupplierRatingDto {
  days: number;
  suppliers: SupplierScoreDto[];
  /** Потери по причинам за период по всем партиям, включая те, у которых поставщик не указан. */
  lossesByReason: { reason: WriteoffReason; value: number }[];
  totalLoss: number;
}

export interface RescuedProductDto {
  productId: string;
  productName: string;
  unit: Unit;
  quantity: number;
  revenue: number;
  /** Себестоимость проданного: столько пропало бы при списании. */
  cost: number;
}

export interface RescuedStatsDto {
  days: number;
  /** Выручка с товара, проданного по скидке: без скидки он, скорее всего, дошёл бы до списания. */
  revenue: number;
  /** Себестоимость проданного по скидке: столько пропало бы при списании. */
  cost: number;
  /** Сколько недополучено против обычной цены. */
  discountGiven: number;
  /** Сколько партий уценили и продали хотя бы частично. */
  batches: number;
  /** Что чаще всего спасали, по выручке. */
  products: RescuedProductDto[];
}

export interface ShortageIngredientDto {
  productId: string;
  productName: string;
  unit: Unit;
  /** Сколько раз продукт становился причиной остановки блюд или заканчивался. */
  episodes: number;
  /** Сколько часов суммарно по точкам он не давал приготовить блюдо. */
  hours: number;
  /** Сколько блюд одновременно останавливалось из-за него в худший момент. */
  dishesBlocked: number;
  /** Сколько заказов отклонили из-за него. */
  refusedOrders: number;
  /** Сумма отклонённых заказов с этим продуктом. */
  lostRevenue: number;
  /** Нехватка продолжается сейчас. */
  ongoing: boolean;
}

export interface ShortageStatsDto {
  days: number;
  /** Самые дефицитные ингредиенты: сначала те, что дольше всего не давали готовить. */
  ingredients: ShortageIngredientDto[];
  totals: {
    episodes: number;
    hours: number;
    /** Заказов, отклонённых из-за нехватки, и их общая сумма. */
    refusedOrders: number;
    lostRevenue: number;
  };
}

export interface StopListDto {
  entries: StopListEntryDto[];
  warnings: LowPortionDto[];
}

export interface RecommendationAction {
  kind: 'writeoff' | 'discount' | 'transfer' | 'none';
  percent?: number;
  targetLocationId?: string;
  quantity?: number;
}

export interface RecommendationDto {
  id: string;
  type: RecommendationType;
  /** Чем больше, тем срочнее. */
  priority: number;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  unit: Unit;
  batchId: string | null;
  expiresOn: string | null;
  daysLeft: number | null;
  quantity: number;
  /** Деньги под угрозой по себестоимости. */
  atRiskValue: number;
  headline: string;
  details: string;
  action: RecommendationAction;
  targetLocationName?: string;
  /** Для скидки: сколько ориентировочно вернём выручкой вместо списания. */
  recoveryValue?: number;
  dishes?: { id: string; name: string; portions: number }[];
  reorder?: { suggestedQty: number; daysToZero: number | null; velocityPerDay: number };
}

export interface HotDishReasonDto {
  productId: string;
  productName: string;
  unit: Unit;
  /** Сколько суток до конца срока у ближайшей партии ингредиента. */
  daysLeft: number;
  /** Сколько ингредиента лежит в ближайших по сроку партиях. */
  stockQty: number;
  /** Расход ингредиента на порцию. */
  perPortion: number;
  /** Сколько порций нужно продать, чтобы использовать долю остатка, доставшуюся блюду. */
  portionsToUse: number;
  /** Какую часть истекающего остатка блюдо может израсходовать, от 0 до 1. */
  share: number;
  /** Вклад ингредиента в приоритет, от 0 до 1. */
  contribution: number;
  /** Себестоимость той части остатка, которую блюдо может израсходовать. */
  value: number;
  /** Другие горячие блюда, которым нужен тот же остаток. */
  sharedWith: string[];
}

export interface HotDishDto {
  dishId: string;
  dishName: string;
  price: number;
  locationId: string;
  locationName: string;
  /** От 0 до 100, чем больше, тем настойчивее стоит продвигать. */
  priority: number;
  /** Сколько порций можно приготовить из текущих остатков. */
  portions: number;
  /** Сколько порций продать, чтобы израсходовать главный ингредиент: тот, что сильнее всего влияет на приоритет. */
  portionsToPush: number;
  /** Самый близкий срок среди причин. */
  daysLeft: number;
  /** Себестоимость истекающих продуктов, которые блюдо может израсходовать. */
  atRiskValue: number;
  reasons: HotDishReasonDto[];
  headline: string;
  details: string;
}

export interface HotDishesDto {
  asOf: string;
  locationId: string | null;
  items: HotDishDto[];
}

export interface RecommendationsDto {
  /** Самые важные, до 500 штук. */
  items: RecommendationDto[];
  /** Сколько всего рекомендаций каждого типа. */
  counts: Record<RecommendationType, number>;
  total: number;
}

export interface ExpiryBucketDto {
  key: 'expired' | 'd0_1' | 'd2_3' | 'd4_7' | 'd8_14' | 'd15_plus';
  label: string;
  value: number;
  batches: number;
}

export interface WriteoffTrendPoint {
  date: string;
  expired: number;
  spoiled: number;
  other: number;
}

export interface DashboardDto {
  asOf: string;
  locationId: string | null;
  kpis: {
    stockValue: number;
    expiringSoonValue: number;
    expiringSoonBatches: number;
    expiredValue: number;
    expiredBatches: number;
    atRiskValue: number;
    stopListCount: number;
    lowStockCount: number;
    writeoff30dValue: number;
    revenue30d: number;
  };
  expiryBuckets: ExpiryBucketDto[];
  writeoffTrend: WriteoffTrendPoint[];
  writeoffByReason: { reason: WriteoffReason; value: number }[];
  topRisks: RecommendationDto[];
  /** Блюда, которые стоит продвигать, первые пять. */
  hotDishes: HotDishDto[];
  stopList: StopListEntryDto[];
}

export interface ForecastDto {
  productId: string;
  productName: string;
  unit: Unit;
  locationId: string;
  velocityPerDay: number;
  /** Насколько можно доверять скорости, от 0 до 1. */
  confidence: number;
  available: number;
  daysToZero: number | null;
  history: { date: string; qty: number }[];
  batches: { batchId: string; expiresOn: string; daysLeft: number; remaining: number; atRisk: number }[];
}

export interface AuditEntryDto {
  id: number;
  at: string;
  userEmail: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  ip: string | null;
  details: unknown;
  hash: string;
}

export interface AuditVerifyDto {
  ok: boolean;
  checked: number;
  brokenAt: number | null;
}

export interface SettingsDto {
  expiringSoonDays: number;
  criticalDays: number;
  forecastWindowDays: number;
  reorderCoverDays: number;
  lowPortionThreshold: number;
  digestHour: number;
  useDemandModel: boolean;
  autoWriteoffExpired: boolean;
  telegramConfigured: boolean;
}

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  locationId: string;
  locationName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyCreatedDto extends ApiKeyDto {
  /** Показывается один раз при создании. */
  key: string;
}

export interface TelegramStatusDto {
  /** Бот подключён на сервере. */
  enabled: boolean;
  botUsername: string | null;
  linked: boolean;
  linkedAt: string | null;
  chatUsername: string | null;
}

export interface TelegramLinkCodeDto {
  code: string;
  expiresAt: string;
  /** Ссылка, которая открывает бота и сразу отправляет ему код. */
  deepLink: string | null;
}

/** Один пункт самопроверки: пройден, предупреждение или сбой. */
export interface SelfCheckItemDto {
  id: string;
  group: string;
  title: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface SelfCheckDto {
  checkedAt: string;
  items: SelfCheckItemDto[];
}
