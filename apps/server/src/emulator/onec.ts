import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { OneCDocMapping, OneCProfile } from '@zapas/shared';
import type { ExchangeRequest, ExchangeResponse, ExchangeTransport } from '../modules/exchange/transport';

/**
 * Имитация сервера 1С со стандартным интерфейсом OData. Описание интерфейса строится из профиля, поэтому подходит
 * под любую настройку: принимает и обновляет документы, ищет в справочниках, проверяет логин и отказывает в неизвестных реквизитах.
 * Нужна для тестов и для показа обмена без настоящей 1С.
 */
export interface MockRow {
  Ref_Key: string;
  Code: string;
  Description: string;
  [field: string]: unknown;
}

export interface MockDocument {
  Ref_Key: string;
  Number: string;
  [field: string]: unknown;
}

const json = (status: number, body: unknown): ExchangeResponse => ({ status, body: JSON.stringify(body) });
const odataError = (status: number, text: string): ExchangeResponse => json(status, { 'odata.error': { code: String(status), message: { lang: 'ru', value: text } } });

function typeBlock(name: string, props: [string, string][]): string {
  return `<EntityType Name="${name}"><Key><PropertyRef Name="Ref_Key"/></Key>${props.map(([n, t]) => `<Property Name="${n}" Type="${t}"/>`).join('')}</EntityType>`;
}

function docProps(m: OneCDocMapping): { entity: [string, string][]; row: [string, string][]; rowName: string } {
  const h = m.header;
  const refs = [h.organization, h.warehouse, h.warehouseTo, h.counterparty].filter((x): x is string => Boolean(x));
  const rowName = `${m.entity}_${m.table}_RowType`;
  return {
    rowName,
    entity: [['Ref_Key', 'Edm.Guid'], ['Number', 'Edm.String'], [h.date, 'Edm.DateTime'], ['Posted', 'Edm.Boolean'], ...refs.map((r): [string, string] => [r, 'Edm.Guid']), ...(h.comment ? [[h.comment, 'Edm.String'] as [string, string]] : []), ...Object.keys(m.constants).map((k): [string, string] => [k, 'Edm.String']), [m.table, `Collection(StandardODATA.${rowName})`]],
    row: [['LineNumber', 'Edm.String'], [m.line.product, 'Edm.Guid'], [m.line.quantity, 'Edm.Double'], ...(m.line.price ? [[m.line.price, 'Edm.Double'] as [string, string]] : []), ...(m.line.sum ? [[m.line.sum, 'Edm.Double'] as [string, string]] : [])],
  };
}

export function buildMetadata(profile: OneCProfile): string {
  const parts: string[] = [];
  for (const cat of Object.values(profile.catalogs)) {
    if (!cat) continue;
    parts.push(typeBlock(cat.entity, [['Ref_Key', 'Edm.Guid'], ['Code', 'Edm.String'], [cat.nameField, 'Edm.String'], [cat.codeField, 'Edm.String']]));
  }
  for (const m of Object.values(profile.documents)) {
    if (!m) continue;
    const p = docProps(m);
    parts.push(typeBlock(m.entity, p.entity));
    parts.push(`<ComplexType Name="${p.rowName}">${p.row.map(([n, t]) => `<Property Name="${n}" Type="${t}"/>`).join('')}</ComplexType>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices><Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">${parts.join('')}</Schema></edmx:DataServices></edmx:Edmx>`;
}

export class MockOneC implements ExchangeTransport {
  readonly requests: { method: string; path: string }[] = [];
  readonly documents = new Map<string, Map<string, MockDocument>>();
  readonly catalogs = new Map<string, MockRow[]>();
  /** Сервер недоступен: запросы заканчиваются сетевой ошибкой. */
  down = false;
  /** Ближайшие запросы отвечают этим кодом. */
  failNext = 0;
  failStatus = 500;
  private counter = 0;

  constructor(
    private readonly profile: OneCProfile,
    private readonly auth: { user: string; password: string } | null = { user: 'zapas', password: 'secret' },
  ) {
    for (const cat of Object.values(profile.catalogs)) if (cat) this.catalogs.set(cat.entity, []);
  }

  /** Добавляет элемент справочника и возвращает его ключ. */
  addCatalogItem(entity: string, code: string, name: string): string {
    const rows = this.catalogs.get(entity);
    if (!rows) throw new Error(`В имитации нет справочника ${entity}`);
    const row: MockRow = { Ref_Key: randomUUID(), Code: code, Description: name };
    for (const cat of Object.values(this.profile.catalogs)) if (cat?.entity === entity) {
      row[cat.codeField] = code;
      row[cat.nameField] = name;
    }
    rows.push(row);
    return row.Ref_Key;
  }

  all(entity: string): MockDocument[] {
    return [...(this.documents.get(entity)?.values() ?? [])];
  }

  async request(req: ExchangeRequest): Promise<ExchangeResponse> {
    if (this.down) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    return this.handle(req);
  }

  handle(req: ExchangeRequest): ExchangeResponse {
    const url = new URL(req.url);
    const root = this.profile.odataPath.replace(/\/+$/, '');
    const path = decodeURIComponent(url.pathname);
    this.requests.push({ method: req.method, path });
    if (this.auth) {
      const header = req.headers.authorization ?? '';
      const expected = `Basic ${Buffer.from(`${this.auth.user}:${this.auth.password}`, 'utf8').toString('base64')}`;
      if (header !== expected) return { status: 401, body: '' };
    }
    if (this.failNext > 0) {
      this.failNext -= 1;
      return odataError(this.failStatus, 'Временная ошибка сервера');
    }
    if (!path.startsWith(`${root}/`)) return odataError(404, 'Не найдено');
    const rest = path.slice(root.length + 1);
    if (rest === '$metadata') return { status: 200, body: buildMetadata(this.profile) };

    const m = /^([^(]+)(?:\(guid'([0-9a-f-]+)'\))?$/i.exec(rest);
    if (!m) return odataError(404, 'Не найдено');
    const entity = m[1] as string;
    const key = m[2];

    const catalog = this.catalogs.get(entity);
    if (catalog && req.method === 'GET') {
      const filter = url.searchParams.get('$filter');
      const top = Number(url.searchParams.get('$top') ?? 100);
      const rows = filter ? catalog.filter((r) => this.matches(r, filter)) : catalog;
      return json(200, { value: rows.slice(0, top) });
    }

    const mapping = Object.values(this.profile.documents).find((d) => d?.entity === entity);
    if (!mapping) return odataError(404, `Объект «${entity}» не опубликован в стандартном интерфейсе OData`);
    const store = this.documents.get(entity) ?? new Map<string, MockDocument>();
    this.documents.set(entity, store);

    if (req.method === 'GET') return json(200, { value: [...store.values()] });
    if (req.method === 'POST' || req.method === 'PATCH') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      } catch {
        return odataError(400, 'Некорректный JSON');
      }
      const known = new Set(docProps(mapping).entity.map(([n]) => n));
      for (const field of Object.keys(body)) if (!known.has(field)) return odataError(400, `Поле объекта не найдено: ${field}`);
      const rowFields = new Set(docProps(mapping).row.map(([n]) => n));
      const table = body[mapping.table];
      if (Array.isArray(table)) {
        for (const row of table as Record<string, unknown>[]) for (const f of Object.keys(row)) if (!rowFields.has(f)) return odataError(400, `Поле табличной части не найдено: ${f}`);
      }
      if (req.method === 'POST') {
        this.counter += 1;
        const doc: MockDocument = { ...body, Ref_Key: randomUUID(), Number: `${String(this.counter).padStart(8, '0')}` };
        store.set(doc.Ref_Key, doc);
        return json(201, doc);
      }
      const current = key ? store.get(key) : undefined;
      if (!current) return odataError(404, 'Документ не найден');
      const next: MockDocument = { ...current, ...body, Ref_Key: current.Ref_Key, Number: current.Number };
      store.set(current.Ref_Key, next);
      return json(200, next);
    }
    return odataError(405, 'Метод не поддерживается');
  }

  private matches(row: MockRow, filter: string): boolean {
    const terms = filter.split(/\s+or\s+/i);
    return terms.some((t) => {
      const sub = /^substringof\('((?:[^']|'')*)',\s*([^)]+)\)$/i.exec(t.trim());
      if (sub) return String(row[(sub[2] as string).trim()] ?? '').toLowerCase().includes((sub[1] as string).replace(/''/g, "'").toLowerCase());
      const eq = /^([^\s]+)\s+eq\s+'((?:[^']|'')*)'$/i.exec(t.trim());
      if (eq) return String(row[eq[1] as string] ?? '') === (eq[2] as string).replace(/''/g, "'");
      return false;
    });
  }

  /** Поднимает имитацию как настоящий HTTP-сервер: для проверки обмена через сеть и для показа. */
  listen(port: number, host = '127.0.0.1'): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (this.down) return req.socket.destroy();
        const out = this.handle({ method: (req.method ?? 'GET') as 'GET', url: `http://${req.headers.host}${req.url ?? ''}`, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(out.status, { 'content-type': out.body.startsWith('<') ? 'application/xml' : 'application/json' });
        res.end(out.body);
      });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }
}
