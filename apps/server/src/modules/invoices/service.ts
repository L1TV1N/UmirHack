import {
  canonicalBarcode,
  convertInvoiceUnit,
  type InvoiceCandidateDto,
  type InvoiceDto,
  type InvoiceLineDto,
  type InvoiceSource,
  type Unit,
  DEFAULT_ORG_ID,
} from '@zapas/shared';
import type { Deps } from '../../lib/context';
import { itemKey, normalizeName, normalizeSupplierName, similarity } from './match';
import type { RawInvoice } from './raw';

interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  unit: Unit;
  barcode: string | null;
  cost: number;
  shelfLifeDays: number | null;
  norm: string;
}

/** Выше этого сходства название считаем тем же продуктом, но просим человека подтвердить. */
const SIMILAR_AUTO = 0.82;
/** Ниже этого сходства продукт даже не предлагаем. */
const SIMILAR_HINT = 0.5;

async function resolveSupplier(deps: Deps, orgId: string, raw: RawInvoice): Promise<InvoiceDto['supplier']> {
  if (!raw.supplier) return null;
  const { name, inn } = raw.supplier;
  if (inn) {
    const byInn = await deps.db.selectFrom('suppliers').select(['id']).where('org_id', '=', orgId).where('inn', '=', inn).executeTakeFirst();
    if (byInn) return { name, inn, supplierId: byInn.id, how: 'inn' };
  }
  // справочник поставщиков невелик, поэтому сравниваем названия без «ООО» и кавычек в памяти
  const wanted = normalizeSupplierName(name);
  const all = await deps.db.selectFrom('suppliers').select(['id', 'name']).where('org_id', '=', orgId).where('is_active', '=', true).execute();
  const byName = wanted ? all.find((s) => normalizeSupplierName(s.name) === wanted) : undefined;
  return { name, inn, supplierId: byName?.id ?? null, how: byName ? 'name' : null };
}

async function loadCatalog(deps: Deps, orgId: string): Promise<CatalogProduct[]> {
  const rows = await deps.db
    .selectFrom('products')
    .select(['id', 'sku', 'name', 'unit', 'barcode', 'cost', 'shelf_life_days'])
    .where('org_id', '=', orgId)
    .where('is_active', '=', true)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    barcode: r.barcode,
    cost: Number(r.cost),
    shelfLifeDays: r.shelf_life_days,
    norm: normalizeName(r.name),
  }));
}

/** Накладная, готовая к показу: поставщик найден, строки сопоставлены с продуктами, повтор отмечен. */
export async function buildInvoice(deps: Deps, raw: RawInvoice, source: InvoiceSource, orgId: string = DEFAULT_ORG_ID): Promise<InvoiceDto> {
  const supplier = await resolveSupplier(deps, orgId, raw);
  const catalog = await loadCatalog(deps, orgId);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const byBarcode = new Map<string, CatalogProduct>();
  for (const p of catalog) {
    const key = p.barcode ? canonicalBarcode(p.barcode) : null;
    if (key && !byBarcode.has(key)) byBarcode.set(key, p);
  }
  const byNorm = new Map<string, CatalogProduct>();
  for (const p of catalog) if (!byNorm.has(p.norm)) byNorm.set(p.norm, p);

  const mapped = new Map<string, string>();
  if (supplier?.supplierId) {
    const rows = await deps.db.selectFrom('supplier_item_map').select(['item_key', 'product_id']).where('supplier_id', '=', supplier.supplierId).execute();
    for (const r of rows) mapped.set(r.item_key, r.product_id);
  }

  const warnings = [...raw.warnings];
  let unmatched = 0;
  let mismatched = 0;

  const lines: InvoiceLineDto[] = raw.lines.map((line, index) => {
    const key = itemKey(line.name, line.code);
    let product: CatalogProduct | undefined;
    let how: InvoiceLineDto['match'] extends infer M ? (M extends { how: infer H } ? H : never) : never = 'name';

    const gtinKey = line.gtin ? canonicalBarcode(line.gtin) : null;
    if (gtinKey && byBarcode.has(gtinKey)) {
      product = byBarcode.get(gtinKey);
      how = 'barcode';
    }
    if (!product) {
      const id = mapped.get(key) ?? mapped.get(`name:${normalizeName(line.name).slice(0, 190)}`);
      const hit = id ? byId.get(id) : undefined;
      if (hit) {
        product = hit;
        how = 'mapping';
      }
    }
    if (!product) {
      const exact = byNorm.get(normalizeName(line.name));
      if (exact) {
        product = exact;
        how = 'name';
      }
    }

    const scored: InvoiceCandidateDto[] = catalog
      .map((p) => ({ productId: p.id, name: p.name, unit: p.unit, cost: p.cost, shelfLifeDays: p.shelfLifeDays, score: Math.round(similarity(line.name, p.name) * 100) / 100 }))
      .filter((c) => c.score >= SIMILAR_HINT)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    if (!product && scored[0] && scored[0].score >= SIMILAR_AUTO) {
      product = byId.get(scored[0].productId);
      how = 'similar';
    }

    const converted = product ? convertInvoiceUnit(line.quantity, line.price, line.unit, product.unit) : null;
    const unitMismatch = Boolean(product) && converted === null;
    if (!product) unmatched += 1;
    if (unitMismatch) mismatched += 1;

    return {
      key,
      index,
      name: line.name,
      code: line.code,
      gtin: line.gtin,
      unit: line.unit,
      quantity: line.quantity,
      price: line.price,
      expiresOn: line.expiresOn,
      batch: line.batch,
      vsd: line.vsd,
      marks: line.marks,
      converted,
      unitMismatch,
      match: product ? { product: { id: product.id, name: product.name, unit: product.unit, sku: product.sku, cost: product.cost, shelfLifeDays: product.shelfLifeDays }, how } : null,
      candidates: scored.filter((c) => c.productId !== product?.id).slice(0, 3),
    };
  });

  if (!supplier) warnings.push('В документе не указан поставщик');
  else if (!supplier.supplierId) warnings.push(`Поставщика «${supplier.name}» нет в справочнике: приход будет без поставщика, пока менеджер его не заведёт`);
  if (unmatched > 0) warnings.push(`Не нашлось продуктов для строк: ${unmatched}. Выберите их вручную, выбор запомнится для следующих накладных`);
  if (mismatched > 0) warnings.push(`Единицы не сходятся с карточкой продукта в строках: ${mismatched}. Проверьте количество`);

  let alreadyReceived: InvoiceDto['alreadyReceived'] = null;
  if (supplier?.supplierId && raw.number) {
    const row = await deps.db
      .selectFrom('batches as b')
      .leftJoin('documents as d', 'd.id', 'b.origin_document_id')
      .select(['d.number as documentNumber', 'b.received_on as receivedOn'])
      .where('b.supplier_id', '=', supplier.supplierId)
      .where('b.document_no', '=', raw.number)
      .orderBy('b.received_on', 'desc')
      .executeTakeFirst();
    if (row) alreadyReceived = { documentNumber: row.documentNumber ?? '', receivedOn: row.receivedOn };
  }
  if (alreadyReceived) warnings.unshift(`Накладная №${raw.number} от этого поставщика уже оприходована (${alreadyReceived.documentNumber}). Проверьте, что это не повтор`);

  return { source, number: raw.number, date: raw.date, supplier, total: raw.total, lines, warnings, alreadyReceived };
}
