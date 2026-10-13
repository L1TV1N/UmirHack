import { z } from 'zod';
import { hasForbiddenChars } from './schemas';
import { webhookUrl } from './integrations';

/** Документы «Запаса», которые можно выгружать во внешнюю учётную систему. */
export const EXCHANGE_DOC_KINDS = ['receipt', 'writeoff', 'transfer', 'inventory'] as const;
export type ExchangeDocKind = (typeof EXCHANGE_DOC_KINDS)[number];
export const EXCHANGE_DOC_LABELS: Record<ExchangeDocKind, string> = {
  receipt: 'Приход',
  writeoff: 'Списание',
  transfer: 'Перемещение',
  inventory: 'Инвентаризация (недостача)',
};

export const EXCHANGE_KINDS = ['onec', 'iiko'] as const;
export type ExchangeKind = (typeof EXCHANGE_KINDS)[number];
export const EXCHANGE_KIND_LABELS: Record<ExchangeKind, string> = { onec: '1С', iiko: 'iiko' };

/** Имя объекта или реквизита в интерфейсе OData 1С: буквы (в том числе русские), цифры и подчёркивание. */
const odataName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}_][\p{L}\p{N}_]*$/u, 'Имя может содержать только буквы, цифры и подчёркивание');

const constantValue = z.union([z.string().max(200), z.number(), z.boolean()]);

/** Как собрать документ 1С из документа «Запаса»: какой объект, какая табличная часть и какие реквизиты. */
export const oneCDocMapping = z.strictObject({
  /** Например, Document_ПоступлениеТоваровУслуг. */
  entity: odataName,
  /** Табличная часть со строками, например Товары. */
  table: odataName,
  header: z.strictObject({
    date: odataName.default('Date'),
    organization: odataName.optional(),
    warehouse: odataName.optional(),
    warehouseTo: odataName.optional(),
    counterparty: odataName.optional(),
    comment: odataName.optional(),
  }),
  /** Постоянные реквизиты: например, ВидОперации. */
  constants: z.record(odataName, constantValue).default({}),
  line: z.strictObject({
    product: odataName,
    quantity: odataName,
    price: odataName.optional(),
    sum: odataName.optional(),
  }),
});
export type OneCDocMapping = z.infer<typeof oneCDocMapping>;

const catalogRef = z.strictObject({
  entity: odataName,
  /** Реквизит, по которому ищем соответствие: Артикул, Код. */
  codeField: odataName,
  nameField: odataName.default('Description'),
});

export const ONEC_PRESETS = ['ut11', 'retail3', 'unf', 'bp3', 'custom'] as const;
export type OneCPreset = (typeof ONEC_PRESETS)[number];
export const ONEC_PRESET_LABELS: Record<OneCPreset, string> = {
  ut11: '1С:Управление торговлей 11',
  retail3: '1С:Розница 3',
  unf: '1С:Управление нашей фирмой',
  bp3: '1С:Бухгалтерия предприятия 3.0',
  custom: 'Своя настройка',
};

export const oneCProfile = z.strictObject({
  preset: z.enum(ONEC_PRESETS),
  /** Корень интерфейса OData на сервере 1С. */
  odataPath: z
    .string()
    .trim()
    .max(200)
    .regex(/^\/[A-Za-z0-9_\-./]*$/, 'Путь начинается с «/»')
    .default('/odata/standard.odata'),
  /** Идентификатор (Ref_Key) организации, от имени которой создаются документы. */
  organizationKey: z.uuid().optional(),
  catalogs: z.strictObject({
    product: catalogRef,
    supplier: catalogRef.optional(),
    location: catalogRef.optional(),
  }),
  documents: z.strictObject({
    receipt: oneCDocMapping.optional(),
    writeoff: oneCDocMapping.optional(),
    transfer: oneCDocMapping.optional(),
    /** Оприходование излишков по инвентаризации. */
    surplus: oneCDocMapping.optional(),
  }),
  /** Проводить документ сразу после создания. */
  post: z.boolean().default(true),
});
export type OneCProfile = z.infer<typeof oneCProfile>;

const systemName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы');

const docKinds = z
  .array(z.enum(EXCHANGE_DOC_KINDS))
  .min(1, 'Выберите хотя бы один вид документа')
  .max(EXCHANGE_DOC_KINDS.length)
  .refine((v) => new Set(v).size === v.length, 'Виды документов не должны повторяться');

export const createExchangeSystemBody = z.strictObject({
  kind: z.enum(EXCHANGE_KINDS),
  name: systemName,
  baseUrl: webhookUrl,
  username: z.string().trim().max(120).optional(),
  password: z.string().max(200).optional(),
  profile: oneCProfile,
  docKinds,
  /** Пусто: документы всех точек. */
  locationId: z.uuid().nullable().optional(),
});
export type CreateExchangeSystemBody = z.infer<typeof createExchangeSystemBody>;

export const updateExchangeSystemBody = z.strictObject({
  name: systemName.optional(),
  baseUrl: webhookUrl.optional(),
  username: z.string().trim().max(120).nullable().optional(),
  password: z.string().max(200).optional(),
  profile: oneCProfile.optional(),
  docKinds: docKinds.optional(),
  locationId: z.uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateExchangeSystemBody = z.infer<typeof updateExchangeSystemBody>;

export const LINK_ENTITIES = ['product', 'supplier', 'location'] as const;
export type LinkEntity = (typeof LINK_ENTITIES)[number];
export const LINK_ENTITY_LABELS: Record<LinkEntity, string> = { product: 'Продукт', supplier: 'Поставщик', location: 'Точка (склад)' };

export const linkBody = z.strictObject({
  entity: z.enum(LINK_ENTITIES),
  localId: z.uuid(),
  remoteKey: z.uuid(),
});
export type LinkBody = z.infer<typeof linkBody>;

export const remoteSearchQuery = z.object({
  entity: z.enum(LINK_ENTITIES),
  q: z.string().trim().max(80).default(''),
});

export const exchangeJobsQuery = z.object({
  systemId: z.uuid().optional(),
  status: z.enum(['pending', 'done', 'blocked', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const pushDocumentBody = z.strictObject({ systemId: z.uuid() });

export interface ExternalSystemDto {
  id: string;
  kind: ExchangeKind;
  name: string;
  baseUrl: string;
  username: string | null;
  hasPassword: boolean;
  profile: OneCProfile;
  docKinds: ExchangeDocKind[];
  locationId: string | null;
  locationName: string | null;
  enabled: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  createdAt: string;
  counts: { pending: number; blocked: number; failed: number; done: number };
}

export interface ExchangeMissingDto {
  entity: LinkEntity;
  localId: string;
  name: string;
  code: string | null;
}

export interface ExchangeJobDto {
  id: string;
  systemId: string;
  systemName: string;
  documentId: string;
  documentNumber: string;
  documentKind: string;
  locationName: string;
  status: 'pending' | 'done' | 'blocked' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  remoteNumber: string | null;
  missing: ExchangeMissingDto[];
  createdAt: string;
  doneAt: string | null;
}

export interface ExchangeCheckDto {
  ok: boolean;
  /** Что именно проверили и чего не хватает, по пунктам. */
  items: { ok: boolean; text: string }[];
}

export interface RemoteItemDto {
  key: string;
  code: string | null;
  name: string;
}

export interface ExchangePresetDto {
  preset: OneCPreset;
  label: string;
  profile: OneCProfile;
}

// Подключение касс

export const POS_VENDORS = ['generic', 'evotor', 'frontol', 'atol', 'iiko', 'sigma'] as const;
export type PosVendor = (typeof POS_VENDORS)[number];
export const POS_VENDOR_LABELS: Record<PosVendor, string> = {
  generic: 'Другая касса (настроить разбор)',
  evotor: 'Эвотор',
  frontol: 'Фронтол',
  atol: 'АТОЛ',
  iiko: 'iiko',
  sigma: 'Sigma',
};

const pathList = z.array(z.string().trim().min(1).max(200)).min(1).max(8);

/** Как найти в присланном чеке номер, тип и строки. Путь записывается через точку: body.positions. Для csv и xlsx-подобных выгрузок это названия колонок. */
export const posRules = z.strictObject({
  format: z.enum(['json', 'xml', 'csv']),
  /** Где лежит список чеков. Пусто: само тело чек или массив чеков. */
  receipts: z.string().trim().max(200).optional(),
  id: pathList,
  /** Где лежит тип документа: продажа или возврат. */
  type: pathList.optional(),
  /** Значения типа, которые означают возврат. */
  returnValues: z.array(z.string().trim().min(1).max(40)).max(10).default(['PAYBACK', 'SELL_RETURN', 'RETURN', 'REFUND', 'возврат']),
  /** Где лежит список строк внутри чека. Для csv не нужен: строки сгруппированы по номеру чека. */
  lines: z.string().trim().max(200).optional(),
  code: pathList.optional(),
  barcode: pathList.optional(),
  name: pathList.optional(),
  quantity: pathList,
  price: pathList.optional(),
  delimiter: z.enum([';', ',', '\t', '|']).default(';'),
});
export type PosRules = z.infer<typeof posRules>;

export interface PosPresetDto {
  vendor: PosVendor;
  label: string;
  hint: string;
  rules: PosRules;
  sample: string;
  sampleType: string;
}

export const createPosConnectionBody = z.strictObject({
  name: systemName,
  locationId: z.uuid(),
  vendor: z.enum(POS_VENDORS),
  rules: posRules.optional(),
});
export type CreatePosConnectionBody = z.infer<typeof createPosConnectionBody>;

export const updatePosConnectionBody = z.strictObject({
  name: systemName.optional(),
  vendor: z.enum(POS_VENDORS).optional(),
  rules: posRules.nullable().optional(),
});

export interface PosConnectionDto {
  id: string;
  name: string;
  keyPrefix: string;
  locationId: string;
  locationName: string;
  vendor: PosVendor;
  rules: PosRules;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  counts: { done: number; pending: number; rejected: number; returns: number };
}

export interface PosConnectionCreatedDto extends PosConnectionDto {
  /** Показывается один раз. */
  key: string;
}

export interface PosNormalizedLine {
  code: string | null;
  barcode: string | null;
  name: string | null;
  quantity: number;
  price: number | null;
}

export interface PosInboxDto {
  id: string;
  keyId: string;
  connectionName: string;
  externalId: string;
  kind: 'sale' | 'return';
  status: 'done' | 'pending_match' | 'rejected' | 'return_logged';
  lines: PosNormalizedLine[];
  unmatched: string[];
  error: string | null;
  documentNumber: string | null;
  receivedAt: string;
}

export interface PosPreviewDto {
  receipts: {
    externalId: string;
    kind: 'sale' | 'return';
    lines: (PosNormalizedLine & { match: { entity: 'product' | 'dish'; id: string; name: string } | { entity: 'ignore' } | null })[];
  }[];
}

export interface PosUnmatchedDto {
  ref: string;
  keyId: string;
  connectionName: string;
  name: string | null;
  receipts: number;
  quantity: number;
}

export const posIngestQuery = z.object({ dryRun: z.enum(['1', 'true']).optional() });

export const posMapBody = z.strictObject({
  keyId: z.uuid(),
  ref: z.string().trim().min(1).max(200),
  entity: z.enum(['product', 'dish', 'ignore']),
  entityId: z.uuid().optional(),
});
export type PosMapBody = z.infer<typeof posMapBody>;

export const posInboxQuery = z.object({
  keyId: z.uuid().optional(),
  status: z.enum(['done', 'pending_match', 'rejected', 'return_logged']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const posPreviewBody = z.strictObject({ payload: z.string().min(1).max(500_000) });
