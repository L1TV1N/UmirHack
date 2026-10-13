import type { ExchangeCheckDto, ExchangeDocKind, LinkEntity, OneCDocMapping, OneCProfile, RemoteItemDto } from '@zapas/shared';
import type { ExchangeRequest, ExchangeResponse, ExchangeTransport } from './transport';

/** Документ «Запаса» в виде, не зависящем от того, куда он уходит. */
export interface CanonicalDoc {
  id: string;
  number: string;
  kind: ExchangeDocKind;
  createdAt: Date;
  comment: string | null;
  location: { id: string; name: string };
  toLocation: { id: string; name: string } | null;
  supplier: { id: string; name: string; inn: string | null } | null;
  lines: { productId: string; sku: string; name: string; unit: string; quantity: number; unitCost: number; expiresOn: string | null }[];
  /** Для инвентаризации: излишки выгружаются отдельным документом. */
  surplus: { productId: string; sku: string; name: string; unit: string; quantity: number; unitCost: number }[];
}

export interface Connection {
  baseUrl: string;
  username: string | null;
  password: string | null;
  profile: OneCProfile;
}

export class OneCError extends Error {
  constructor(
    message: string,
    /** Повтор имеет смысл: сеть, перегрузка, временная недоступность. */
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

const enc = (s: string) => encodeURIComponent(s);

function authHeaders(c: Connection): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json;odata=nometadata' };
  if (c.username) h.authorization = `Basic ${Buffer.from(`${c.username}:${c.password ?? ''}`, 'utf8').toString('base64')}`;
  return h;
}

export function odataRoot(c: Connection): string {
  return `${c.baseUrl.replace(/\/+$/, '')}${c.profile.odataPath.replace(/\/+$/, '')}`;
}

/** Текст ошибки из ответа 1С: `{"odata.error":{"message":{"value":"..."}}}`. */
export function remoteMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, { message?: { value?: string } | string } | undefined>;
    const err = parsed['odata.error'] ?? parsed.error;
    const msg = typeof err?.message === 'string' ? err.message : err?.message?.value;
    return msg ? String(msg).slice(0, 300) : null;
  } catch {
    return null;
  }
}

function explain(res: ExchangeResponse): OneCError {
  const text = remoteMessage(res.body);
  if (res.status === 401 || res.status === 403) return new OneCError('1С отклонила логин или пароль, или у пользователя нет прав на этот объект', false, res.status);
  if (res.status === 404) return new OneCError(text ?? 'Такого объекта нет в опубликованном интерфейсе 1С (проверьте имена в настройке)', false, 404);
  if (res.status === 408 || res.status === 429 || res.status >= 500) return new OneCError(text ?? `1С ответила ${res.status}`, true, res.status);
  return new OneCError(text ?? `1С ответила ${res.status}`, false, res.status);
}

async function call(t: ExchangeTransport, c: Connection, req: Omit<ExchangeRequest, 'headers'>): Promise<ExchangeResponse> {
  return t.request({ ...req, headers: authHeaders(c) });
}

function json<T>(res: ExchangeResponse): T {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new OneCError('1С вернула ответ не в формате JSON (возможно, адрес указывает не на интерфейс OData)', false, res.status);
  }
}

// $metadata

interface Metadata {
  entities: Map<string, Map<string, string>>;
  complex: Map<string, Map<string, string>>;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? (m[1] as string) : null;
}

function collectTypes(xml: string, tagName: 'EntityType' | 'ComplexType'): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const re = new RegExp(`<${tagName}\\s[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g');
  for (const block of xml.match(re) ?? []) {
    const name = attr(block.slice(0, block.indexOf('>') + 1), 'Name');
    if (!name) continue;
    const props = new Map<string, string>();
    for (const tag of block.match(/<(?:Property|NavigationProperty)\s[^>]*>/g) ?? []) {
      const pn = attr(tag, 'Name');
      if (pn) props.set(pn, attr(tag, 'Type') ?? '');
    }
    out.set(name, props);
  }
  return out;
}

export function parseMetadata(xml: string): Metadata {
  return { entities: collectTypes(xml, 'EntityType'), complex: collectTypes(xml, 'ComplexType') };
}

function checkMapping(md: Metadata, label: string, m: OneCDocMapping): { ok: boolean; text: string }[] {
  const items: { ok: boolean; text: string }[] = [];
  const entity = md.entities.get(m.entity);
  if (!entity) return [{ ok: false, text: `${label}: объекта «${m.entity}» нет в интерфейсе 1С. Проверьте имя или опубликуйте объект` }];
  const headerFields = [m.header.date, m.header.organization, m.header.warehouse, m.header.warehouseTo, m.header.counterparty, m.header.comment, ...Object.keys(m.constants)].filter((x): x is string => Boolean(x));
  const missingHeader = headerFields.filter((f) => !entity.has(f));
  const tableType = entity.get(m.table);
  if (tableType === undefined) {
    items.push({ ok: false, text: `${label}: у «${m.entity}» нет табличной части «${m.table}»` });
  } else {
    const rowName = tableType.replace(/^Collection\(/, '').replace(/\)$/, '').split('.').pop() ?? '';
    const row = md.complex.get(rowName) ?? md.entities.get(rowName);
    const lineFields = [m.line.product, m.line.quantity, m.line.price, m.line.sum].filter((x): x is string => Boolean(x));
    const missingLine = row ? lineFields.filter((f) => !row.has(f)) : [];
    if (!row) items.push({ ok: false, text: `${label}: не удалось найти описание строк табличной части «${m.table}»` });
    else if (missingLine.length > 0) items.push({ ok: false, text: `${label}: в строках «${m.table}» нет реквизитов: ${missingLine.join(', ')}` });
  }
  if (missingHeader.length > 0) items.push({ ok: false, text: `${label}: в «${m.entity}» нет реквизитов: ${missingHeader.join(', ')}` });
  if (items.length === 0) items.push({ ok: true, text: `${label}: «${m.entity}» найден, реквизиты и табличная часть на месте` });
  return items;
}

const KIND_LABEL: Record<string, string> = { receipt: 'Приход', writeoff: 'Списание', transfer: 'Перемещение', surplus: 'Оприходование излишков' };

/** Проверка подключения: отвечает ли сервер, подходят ли логин и пароль и есть ли в интерфейсе нужные объекты и реквизиты. */
export async function checkConnection(t: ExchangeTransport, c: Connection, docKinds: ExchangeDocKind[]): Promise<ExchangeCheckDto> {
  const items: ExchangeCheckDto['items'] = [];
  const res = await call(t, c, { method: 'GET', url: `${odataRoot(c)}/$metadata` });
  if (res.status === 401 || res.status === 403) return { ok: false, items: [{ ok: false, text: 'Сервер ответил, но отклонил логин или пароль. Нужен отдельный пользователь 1С с правом чтения и записи нужных документов' }] };
  if (res.status !== 200) return { ok: false, items: [{ ok: false, text: `Сервер ответил ${res.status}. Проверьте адрес и то, что стандартный интерфейс OData опубликован` }] };
  if (!/<(?:edmx:)?Edmx|<EntityType/i.test(res.body)) return { ok: false, items: [{ ok: false, text: 'Сервер ответил, но это не описание интерфейса OData. Проверьте адрес и путь' }] };
  items.push({ ok: true, text: 'Сервер отвечает, логин и пароль приняты, описание интерфейса получено' });
  const md = parseMetadata(res.body);

  const cats: [string, OneCProfile['catalogs']['product'] | undefined, string][] = [
    ['Справочник номенклатуры', c.profile.catalogs.product, 'product'],
    ['Справочник контрагентов', c.profile.catalogs.supplier, 'supplier'],
    ['Справочник складов', c.profile.catalogs.location, 'location'],
  ];
  for (const [label, cat] of cats) {
    if (!cat) continue;
    const e = md.entities.get(cat.entity);
    if (!e) items.push({ ok: false, text: `${label}: объекта «${cat.entity}» нет в интерфейсе` });
    else if (!e.has(cat.codeField)) items.push({ ok: false, text: `${label}: у «${cat.entity}» нет реквизита «${cat.codeField}» для поиска соответствий` });
    else items.push({ ok: true, text: `${label}: «${cat.entity}» найден` });
  }

  const wanted = new Set<string>(docKinds.map((k) => (k === 'inventory' ? 'writeoff' : k)));
  if (docKinds.includes('inventory') && c.profile.documents.surplus) wanted.add('surplus');
  for (const kind of ['receipt', 'writeoff', 'transfer', 'surplus'] as const) {
    if (!wanted.has(kind)) continue;
    const mapping = c.profile.documents[kind];
    if (!mapping) items.push({ ok: false, text: `${KIND_LABEL[kind]}: не настроено, в какой документ 1С выгружать` });
    else items.push(...checkMapping(md, KIND_LABEL[kind] as string, mapping));
  }
  if (!c.profile.organizationKey) items.push({ ok: false, text: 'Не указана организация (Ref_Key). Без неё 1С не проведёт документ' });
  return { ok: items.every((i) => i.ok), items };
}

// Справочники

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function searchCatalog(t: ExchangeTransport, c: Connection, entity: LinkEntity, q: string): Promise<RemoteItemDto[]> {
  const cat = c.profile.catalogs[entity];
  if (!cat) throw new OneCError('Справочник для этого вида объектов не настроен', false);
  const filter = q ? `&$filter=${enc(`substringof(${literal(q)},${cat.nameField}) or ${cat.codeField} eq ${literal(q)}`)}` : '';
  const res = await call(t, c, { method: 'GET', url: `${odataRoot(c)}/${cat.entity}?$format=json&$top=20&$select=${enc(`Ref_Key,${cat.codeField},${cat.nameField}`)}${filter}` });
  if (res.status !== 200) throw explain(res);
  const rows = json<{ value?: Record<string, unknown>[] }>(res).value ?? [];
  return rows.map((r) => ({ key: String(r.Ref_Key), code: r[cat.codeField] ? String(r[cat.codeField]) : null, name: String(r[cat.nameField] ?? '') }));
}

/** Точное соответствие по коду или артикулу. Нашлось ровно одно: возвращает его ключ. Нашлось несколько или ни одного: null, связать нужно вручную. */
export async function findByCode(t: ExchangeTransport, c: Connection, entity: LinkEntity, code: string): Promise<string | null> {
  const cat = c.profile.catalogs[entity];
  if (!cat) return null;
  const res = await call(t, c, { method: 'GET', url: `${odataRoot(c)}/${cat.entity}?$format=json&$top=2&$select=${enc('Ref_Key')}&$filter=${enc(`${cat.codeField} eq ${literal(code)}`)}` });
  if (res.status !== 200) throw explain(res);
  const rows = json<{ value?: { Ref_Key: string }[] }>(res).value ?? [];
  return rows.length === 1 ? (rows[0] as { Ref_Key: string }).Ref_Key : null;
}

// Документы

export interface Refs {
  product: Map<string, string>;
  supplier: Map<string, string>;
  location: Map<string, string>;
}

const money = (n: number) => Math.round(n * 100) / 100;

function localDateTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  return parts.replace(' ', 'T');
}

export type DocPlan =
  | { ok: true; mapping: OneCDocMapping; body: Record<string, unknown>; lines: number }
  | { ok: false; missing: { entity: LinkEntity; localId: string; name: string; code: string | null }[]; reason: string | null };

/** Собирает тело документа 1С. Если не хватает связей или шаблона, говорит, чего именно. */
export function planDocument(doc: CanonicalDoc, profile: OneCProfile, refs: Refs, tz: string): DocPlan {
  const useSurplus = doc.kind === 'inventory' && doc.lines.length === 0 && doc.surplus.length > 0;
  const mapping = doc.kind === 'receipt' ? profile.documents.receipt : doc.kind === 'transfer' ? profile.documents.transfer : useSurplus ? profile.documents.surplus : profile.documents.writeoff;
  if (!mapping) return { ok: false, missing: [], reason: `В настройке не указан документ 1С для этого вида (${doc.kind === 'receipt' ? 'приход' : doc.kind === 'transfer' ? 'перемещение' : useSurplus ? 'оприходование излишков' : 'списание'})` };
  const lines = useSurplus ? doc.surplus.map((l) => ({ ...l, expiresOn: null })) : doc.lines;
  if (lines.length === 0) return { ok: false, missing: [], reason: 'В документе нет строк для выгрузки' };

  const missing: { entity: LinkEntity; localId: string; name: string; code: string | null }[] = [];
  const need = (entity: LinkEntity, map: Map<string, string>, localId: string, name: string, code: string | null): string | null => {
    const key = map.get(localId);
    if (!key && !missing.some((m) => m.entity === entity && m.localId === localId)) missing.push({ entity, localId, name, code });
    return key ?? null;
  };

  const body: Record<string, unknown> = { [mapping.header.date]: localDateTime(doc.createdAt, tz) };
  if (mapping.header.organization && profile.organizationKey) body[mapping.header.organization] = profile.organizationKey;
  if (mapping.header.warehouse) body[mapping.header.warehouse] = need('location', refs.location, doc.location.id, doc.location.name, null);
  if (mapping.header.warehouseTo && doc.toLocation) body[mapping.header.warehouseTo] = need('location', refs.location, doc.toLocation.id, doc.toLocation.name, null);
  if (mapping.header.counterparty && doc.supplier) body[mapping.header.counterparty] = need('supplier', refs.supplier, doc.supplier.id, doc.supplier.name, doc.supplier.inn);
  if (mapping.header.comment) body[mapping.header.comment] = `Запас ${doc.number}${doc.comment ? `: ${doc.comment}` : ''}`.slice(0, 250);
  Object.assign(body, mapping.constants);

  // одинаковые продукты в разных партиях сворачиваем в одну строку: 1С строки по партиям не ведёт
  const rows = new Map<string, { quantity: number; amount: number; name: string; sku: string }>();
  for (const l of lines) {
    const row = rows.get(l.productId) ?? { quantity: 0, amount: 0, name: l.name, sku: l.sku };
    row.quantity += l.quantity;
    row.amount += l.quantity * l.unitCost;
    rows.set(l.productId, row);
  }
  const table: Record<string, unknown>[] = [];
  let n = 0;
  for (const [productId, r] of rows) {
    n += 1;
    const line: Record<string, unknown> = { LineNumber: String(n), [mapping.line.product]: need('product', refs.product, productId, r.name, r.sku), [mapping.line.quantity]: Math.round(r.quantity * 1000) / 1000 };
    const price = r.quantity > 0 ? money(r.amount / r.quantity) : 0;
    if (mapping.line.price) line[mapping.line.price] = price;
    if (mapping.line.sum) line[mapping.line.sum] = money(r.amount);
    table.push(line);
  }
  body[mapping.table] = table;
  if (profile.post) body.Posted = true;
  if (missing.length > 0) return { ok: false, missing, reason: null };
  return { ok: true, mapping, body, lines: table.length };
}

export interface SendResult {
  remoteKey: string;
  remoteNumber: string | null;
  updated: boolean;
}

/** Создаёт документ в 1С или, если он уже выгружался, обновляет тот же. Дубль не появляется. */
export async function sendDocument(t: ExchangeTransport, c: Connection, plan: Extract<DocPlan, { ok: true }>, existingKey: string | null): Promise<SendResult> {
  const root = `${odataRoot(c)}/${plan.mapping.entity}`;
  const body = JSON.stringify(plan.body);
  const res = existingKey
    ? await call(t, c, { method: 'PATCH', url: `${root}(guid'${existingKey}')?$format=json`, body })
    : await call(t, c, { method: 'POST', url: `${root}?$format=json`, body });
  if (res.status === 404 && existingKey) {
    // документ удалили в 1С: создаём заново, а связь обновит вызывающий
    const created = await call(t, c, { method: 'POST', url: `${root}?$format=json`, body });
    if (created.status !== 200 && created.status !== 201) throw explain(created);
    const p = json<{ Ref_Key?: string; Number?: string }>(created);
    if (!p.Ref_Key) throw new OneCError('1С создала документ, но не вернула его идентификатор', false, created.status);
    return { remoteKey: p.Ref_Key, remoteNumber: p.Number ?? null, updated: false };
  }
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) throw explain(res);
  if (existingKey) return { remoteKey: existingKey, remoteNumber: res.body ? (json<{ Number?: string }>(res).Number ?? null) : null, updated: true };
  const p = json<{ Ref_Key?: string; Number?: string }>(res);
  if (!p.Ref_Key) throw new OneCError('1С создала документ, но не вернула его идентификатор', false, res.status);
  return { remoteKey: p.Ref_Key, remoteNumber: p.Number ?? null, updated: false };
}
