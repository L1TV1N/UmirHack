import {
  createProductBody,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  updateProductBody,
  type ImportPreviewDto,
  type ImportRowDto,
  type Unit,
} from '@zapas/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types';

export class ImportFormatError extends Error {}

const MAX_CELL = 1000;
const MAX_COLUMNS = 60;
const PREVIEW_ROWS = 300;
/** Пока категорию ещё не создали, проверяем строку с этим идентификатором: настоящий подставится при записи. */
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

export type Field = 'sku' | 'barcode' | 'name' | 'category' | 'unit' | 'price' | 'cost' | 'minStock' | 'shelfLifeDays' | 'requiresMarking' | 'requiresVsd';

const FIELD_LABELS: Record<Field, string> = {
  sku: 'Артикул',
  barcode: 'Штрихкод',
  name: 'Название',
  category: 'Категория',
  unit: 'Единица',
  price: 'Цена',
  cost: 'Себестоимость',
  minStock: 'Минимум',
  shelfLifeDays: 'Срок годности',
  requiresMarking: 'Маркировка',
  requiresVsd: 'ВСД',
};

// Названия колонок в выгрузках iiko, 1С и Excel. Сравниваются без регистра, пробелов и знаков препинания
const ALIASES: Record<Field, string[]> = {
  sku: ['артикул', 'код', 'кодтовара', 'кодноменклатуры', 'номенклатурныйкод', 'sku', 'code', 'article', 'vendorcode'],
  barcode: ['штрихкод', 'штрихкоды', 'штрихкодосновной', 'шк', 'barcode', 'ean', 'gtin'],
  name: ['наименование', 'название', 'товар', 'номенклатура', 'полноенаименование', 'name', 'title'],
  category: ['категория', 'группа', 'группатоваров', 'родитель', 'товарнаягруппа', 'category', 'group'],
  unit: ['единица', 'едизм', 'единицаизмерения', 'базоваяединица', 'базоваяединицаизмерения', 'ед', 'unit'],
  price: ['цена', 'ценапродажи', 'ценазапродажу', 'розничнаяцена', 'ценарозничная', 'price'],
  cost: ['себестоимость', 'закупочнаяцена', 'ценазакупки', 'ценапокупки', 'cost'],
  minStock: ['минимум', 'минимальныйостаток', 'миностаток', 'неснижаемыйостаток', 'minstock'],
  shelfLifeDays: ['срокгодности', 'срокгодностидн', 'срокгодностисутки', 'срокхранения', 'срокхранениядн', 'shelflife', 'shelflifedays'],
  requiresMarking: ['маркировка', 'маркируется', 'честныйзнак', 'подлежитмаркировке'],
  requiresVsd: ['всд', 'меркурий', 'ветеринарныйдокумент', 'требуетсявсд'],
};

const normalizeHeader = (h: string) => h.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
const ALIAS_TO_FIELD = new Map<string, Field>(
  (Object.entries(ALIASES) as [Field, string[]][]).flatMap(([field, names]) => names.map((n) => [n, field] as const)),
);

export function decodeCsv(bytes: Buffer): { text: string; encoding: 'utf-8' | 'windows-1251' } {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1251').decode(body), encoding: 'windows-1251' };
  }
}

export function detectDelimiter(text: string): ';' | ',' | '\t' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let quoted = false;
  const counts: Record<string, number> = { ';': 0, ',': 0, '\t': 0 };
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const best = ([';', ',', '\t'] as const).reduce((a, b) => ((counts[b] ?? 0) > (counts[a] ?? 0) ? b : a), ';' as ';' | ',' | '\t');
  return best;
}

/** Разбор CSV по RFC 4180: кавычки, удвоенные кавычки, переводы строк внутри ячейки. Пустые строки пропускаются. */
export function parseCsv(text: string, delimiter: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let record = 1;
  const endCell = () => {
    if (cell.length > MAX_CELL) throw new ImportFormatError(`В строке ${record} ячейка длиннее ${MAX_CELL} знаков`);
    cells.push(cell);
    cell = '';
    if (cells.length > MAX_COLUMNS) throw new ImportFormatError(`Больше ${MAX_COLUMNS} колонок: это не похоже на выгрузку номенклатуры`);
  };
  const endRow = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) {
      if (rows.length > MAX_IMPORT_ROWS) throw new ImportFormatError(`Больше ${MAX_IMPORT_ROWS} строк: разбейте файл на части`);
      rows.push({ line: record, cells });
    }
    cells = [];
    record += 1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] !== '\n') endRow();
    } else cell += ch;
  }
  if (quoted) throw new ImportFormatError('В файле незакрытая кавычка');
  if (cell !== '' || cells.length > 0) endRow();
  return rows;
}

const UNIT_ALIASES: Record<string, Unit> = {
  кг: 'kg', килограмм: 'kg', килограмма: 'kg', kg: 'kg', kgs: 'kg',
  л: 'l', литр: 'l', литра: 'l', литры: 'l', l: 'l', lt: 'l', ltr: 'l',
  шт: 'pcs', штука: 'pcs', штуки: 'pcs', штук: 'pcs', ед: 'pcs', единица: 'pcs', pcs: 'pcs', pc: 'pcs', piece: 'pcs', pieces: 'pcs',
};

function parseUnit(raw: string): Unit | null {
  return UNIT_ALIASES[raw.toLowerCase().replace(/[\s.]/g, '')] ?? null;
}

const TRUE_WORDS = new Set(['да', 'yes', 'y', 'true', '1', '+', 'x', 'х', 'истина']);
const FALSE_WORDS = new Set(['нет', 'no', 'n', 'false', '0', '-', 'ложь']);

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v) || v === '') return false;
  return null;
}

function parseNumber(raw: string): number | null {
  const v = raw.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const roundKopeks = (n: number) => Math.round(n * 100) / 100;
const roundMilli = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(n).replace('.', ',');

interface ProductRow {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category_id: string;
  unit: Unit;
  price: string;
  cost: string;
  min_stock: string;
  shelf_life_days: number | null;
  requires_vsd: boolean;
  requires_marking: boolean;
}

export interface PlannedCreate {
  sku: string;
  barcode?: string;
  name: string;
  categoryName: string;
  unit: Unit;
  price: number;
  cost: number;
  minStock: number;
  shelfLifeDays?: number;
  requiresVsd: boolean;
  requiresMarking: boolean;
}

export interface PlannedUpdate {
  id: string;
  /** Поля, которые нужно записать. Категория названием: идентификатор подставляется при записи. */
  patch: {
    name?: string;
    barcode?: string | null;
    categoryName?: string;
    price?: number;
    cost?: number;
    minStock?: number;
    shelfLifeDays?: number | null;
    requiresVsd?: boolean;
    requiresMarking?: boolean;
  };
}

export interface ImportPlan {
  preview: ImportPreviewDto;
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  /** Названия категорий, которые нужно создать. */
  newCategories: string[];
}

type Reader = Pick<Kysely<Database>, 'selectFrom'>;

export async function planImport(db: Reader, bytes: Buffer, createCategories: boolean): Promise<ImportPlan> {
  if (bytes.length === 0) throw new ImportFormatError('Файл пустой');
  if (bytes.length > MAX_IMPORT_BYTES) throw new ImportFormatError('Файл больше 2 МБ');
  const { text, encoding } = decodeCsv(bytes);
  const delimiter = detectDelimiter(text);
  const records = parseCsv(text, delimiter);
  const header = records[0];
  if (!header) throw new ImportFormatError('В файле нет строк');

  const index = new Map<Field, number>();
  const columns = header.cells.map((h, i) => {
    const field = ALIAS_TO_FIELD.get(normalizeHeader(h)) ?? null;
    if (field && !index.has(field)) index.set(field, i);
    return { header: h.trim().slice(0, 80), field: field && index.get(field) === i ? field : null };
  });
  if (!index.has('sku')) throw new ImportFormatError('Не нашли колонку с артикулом. Назовите её «Артикул» или «Код»');
  const body = records.slice(1);
  if (body.length === 0) throw new ImportFormatError('В файле только заголовок');

  const get = (cells: string[], field: Field): string | undefined => {
    const i = index.get(field);
    if (i === undefined) return undefined;
    return (cells[i] ?? '').trim();
  };

  const skus = [...new Set(body.map((r) => (get(r.cells, 'sku') ?? '').toLowerCase()).filter(Boolean))];
  const barcodes = [...new Set(body.map((r) => firstBarcode(get(r.cells, 'barcode') ?? '')).filter((b): b is string => Boolean(b)))];

  const columnsSelected = ['id', 'sku', 'barcode', 'name', 'category_id', 'unit', 'price', 'cost', 'min_stock', 'shelf_life_days', 'requires_vsd', 'requires_marking'] as const;
  const bySku = new Map<string, ProductRow>();
  for (let from = 0; from < skus.length; from += 1000) {
    const rows = await db
      .selectFrom('products')
      .select(columnsSelected)
      .where((eb) => eb(eb.fn('lower', ['sku']), 'in', skus.slice(from, from + 1000)))
      .execute();
    for (const r of rows) bySku.set(r.sku.toLowerCase(), r);
  }
  const byBarcode = new Map<string, { id: string; sku: string; name: string }>();
  for (let from = 0; from < barcodes.length; from += 1000) {
    const rows = await db.selectFrom('products').select(['id', 'sku', 'name', 'barcode']).where('barcode', 'in', barcodes.slice(from, from + 1000)).execute();
    for (const r of rows) if (r.barcode) byBarcode.set(r.barcode, r);
  }
  const categories = await db.selectFrom('categories').select(['id', 'name']).execute();
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

  const newCategories = new Map<string, string>();
  const rowsOut: ImportRowDto[] = [];
  const creates: PlannedCreate[] = [];
  const updates: PlannedUpdate[] = [];
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();

  for (const { line, cells } of body) {
    const messages: string[] = [];
    const errors: string[] = [];
    const changes: string[] = [];
    const sku = get(cells, 'sku') ?? '';
    const nameRaw = get(cells, 'name');
    const out: ImportRowDto = { line, action: 'error', sku: sku || null, name: nameRaw || null, changes, messages };
    const fail = (message: string) => {
      errors.push(message);
    };

    if (!sku) fail('Не указан артикул');
    const skuKey = sku.toLowerCase();
    if (sku && seenSku.has(skuKey)) fail(`Артикул повторяется: уже есть в строке ${seenSku.get(skuKey)}`);
    else if (sku) seenSku.set(skuKey, line);

    const existing = sku ? bySku.get(skuKey) : undefined;

    // штрихкод: в выгрузках иногда несколько через запятую или точку с запятой, берём первый подходящий
    let barcode: string | null | undefined;
    const barcodeRaw = get(cells, 'barcode');
    if (barcodeRaw) {
      const first = firstBarcode(barcodeRaw);
      if (!first) messages.push(`Штрихкод «${barcodeRaw.slice(0, 30)}» не подходит (нужно 8–14 цифр), он пропущен`);
      else {
        barcode = first;
        const owner = byBarcode.get(first);
        if (owner && owner.id !== existing?.id) fail(`Штрихкод ${first} уже у продукта «${owner.name}» (артикул ${owner.sku})`);
        if (seenBarcode.has(first)) fail(`Штрихкод ${first} повторяется: уже есть в строке ${seenBarcode.get(first)}`);
        else seenBarcode.set(first, line);
      }
    }

    const priceRaw = get(cells, 'price');
    const costRaw = get(cells, 'cost');
    const price = priceRaw ? parseNumber(priceRaw) : undefined;
    const cost = costRaw ? parseNumber(costRaw) : undefined;
    if (priceRaw && price === null) fail(`Цена «${priceRaw.slice(0, 30)}» не число`);
    if (costRaw && cost === null) fail(`Себестоимость «${costRaw.slice(0, 30)}» не число`);
    if (price !== undefined && price !== null && roundKopeks(price) !== price) messages.push('Цена округлена до копеек');
    if (cost !== undefined && cost !== null && roundKopeks(cost) !== cost) messages.push('Себестоимость округлена до копеек');

    const minRaw = get(cells, 'minStock');
    const minStock = minRaw ? parseNumber(minRaw) : undefined;
    if (minRaw && minStock === null) fail(`Минимум «${minRaw.slice(0, 30)}» не число`);

    const shelfRaw = get(cells, 'shelfLifeDays');
    const shelfNumber = shelfRaw ? parseNumber(shelfRaw) : undefined;
    if (shelfRaw && (shelfNumber === null || !Number.isInteger(shelfNumber))) fail(`Срок годности «${shelfRaw.slice(0, 30)}» нужно указать целым числом суток`);

    const unitRaw = get(cells, 'unit');
    const unit = unitRaw ? parseUnit(unitRaw) : undefined;
    if (unitRaw && unit === null) {
      if (existing) messages.push(`Единица «${unitRaw.slice(0, 20)}» не распознана, у существующего продукта она не меняется`);
      else fail(`Единица «${unitRaw.slice(0, 20)}» не распознана: нужны кг, л или шт`);
    } else if (unit && existing && unit !== existing.unit) {
      messages.push(`Единица не меняется (в базе ${existing.unit === 'kg' ? 'кг' : existing.unit === 'l' ? 'л' : 'шт'})`);
    }

    const flag = (field: 'requiresMarking' | 'requiresVsd'): boolean | undefined => {
      const raw = get(cells, field);
      if (raw === undefined || raw === '') return undefined;
      const v = parseBool(raw);
      if (v === null) {
        fail(`${FIELD_LABELS[field]}: «${raw.slice(0, 20)}» не понятно, нужно да или нет`);
        return undefined;
      }
      return v;
    };
    const requiresMarking = flag('requiresMarking');
    const requiresVsd = flag('requiresVsd');

    const categoryRaw = get(cells, 'category');
    let categoryName: string | undefined;
    if (categoryRaw) {
      const known = categoryByName.get(categoryRaw.toLowerCase());
      if (known) categoryName = known.name;
      else if (createCategories) {
        categoryName = newCategories.get(categoryRaw.toLowerCase()) ?? categoryRaw;
        newCategories.set(categoryRaw.toLowerCase(), categoryName);
        messages.push(`Категория «${categoryRaw.slice(0, 40)}» будет создана`);
      } else fail(`Категории «${categoryRaw.slice(0, 40)}» нет. Создайте её или включите создание категорий`);
    }

    if (errors.length > 0) {
      out.messages = [...errors, ...messages];
      rowsOut.push(out);
      continue;
    }

    if (!existing) {
      if (!nameRaw) fail('Не указано название');
      if (!categoryName) fail('Не указана категория');
      if (!unit) fail('Не указана единица (кг, л или шт)');
      const candidate = {
        sku,
        ...(barcode ? { barcode } : {}),
        name: nameRaw ?? '',
        categoryId: PLACEHOLDER_ID,
        unit: unit ?? 'kg',
        minStock: minStock ?? 0,
        ...(shelfNumber !== undefined && shelfNumber !== null ? { shelfLifeDays: shelfNumber } : {}),
        price: price === undefined || price === null ? 0 : roundKopeks(price),
        cost: cost === undefined || cost === null ? 0 : roundKopeks(cost),
        requiresVsd: requiresVsd ?? false,
        requiresMarking: requiresMarking ?? false,
      };
      if (price === undefined) messages.push('Цена не указана: будет 0 ₽, исправьте в карточке');
      const parsed = createProductBody.safeParse(candidate);
      if (!parsed.success) for (const issue of parsed.error.issues) fail(`${FIELD_LABELS[(issue.path[0] as Field) ?? 'name'] ?? String(issue.path[0])}: ${issue.message}`);
      if (errors.length > 0 || !parsed.success) {
        out.messages = [...errors, ...messages];
        rowsOut.push(out);
        continue;
      }
      out.action = 'create';
      out.changes = ['новый продукт'];
      out.messages = messages;
      creates.push({
        sku: parsed.data.sku,
        ...(parsed.data.barcode ? { barcode: parsed.data.barcode } : {}),
        name: parsed.data.name,
        categoryName: categoryName as string,
        unit: parsed.data.unit,
        price: parsed.data.price,
        cost: parsed.data.cost,
        minStock: roundMilli(parsed.data.minStock),
        ...(parsed.data.shelfLifeDays ? { shelfLifeDays: parsed.data.shelfLifeDays } : {}),
        requiresVsd: parsed.data.requiresVsd,
        requiresMarking: parsed.data.requiresMarking,
      });
      rowsOut.push(out);
      continue;
    }

    // существующий продукт: меняем только то, что есть в файле и отличается от базы
    out.name = out.name ?? existing.name;
    const patch: PlannedUpdate['patch'] = {};
    if (nameRaw && nameRaw !== existing.name) {
      patch.name = nameRaw;
      changes.push(`название: «${existing.name}» → «${nameRaw}»`);
    }
    if (barcode && barcode !== existing.barcode) {
      patch.barcode = barcode;
      changes.push(`штрихкод: ${existing.barcode ?? 'нет'} → ${barcode}`);
    }
    if (categoryName && categoryName.toLowerCase() !== (categoryNameById.get(existing.category_id) ?? '').toLowerCase()) {
      patch.categoryName = categoryName;
      changes.push(`категория: ${categoryNameById.get(existing.category_id) ?? '-'} → ${categoryName}`);
    }
    if (price !== undefined && price !== null && roundKopeks(price) !== Number(existing.price)) {
      patch.price = roundKopeks(price);
      changes.push(`цена: ${fmt(Number(existing.price))} → ${fmt(roundKopeks(price))}`);
    }
    if (cost !== undefined && cost !== null && roundKopeks(cost) !== Number(existing.cost)) {
      patch.cost = roundKopeks(cost);
      changes.push(`себестоимость: ${fmt(Number(existing.cost))} → ${fmt(roundKopeks(cost))}`);
    }
    if (minStock !== undefined && minStock !== null && roundMilli(minStock) !== Number(existing.min_stock)) {
      patch.minStock = roundMilli(minStock);
      changes.push(`минимум: ${fmt(Number(existing.min_stock))} → ${fmt(roundMilli(minStock))}`);
    }
    if (shelfNumber !== undefined && shelfNumber !== null && shelfNumber !== existing.shelf_life_days) {
      patch.shelfLifeDays = shelfNumber;
      changes.push(`срок годности: ${existing.shelf_life_days ?? 'нет'} → ${shelfNumber}`);
    }
    if (requiresVsd !== undefined && requiresVsd !== existing.requires_vsd) {
      patch.requiresVsd = requiresVsd;
      changes.push(`ВСД: ${existing.requires_vsd ? 'да' : 'нет'} → ${requiresVsd ? 'да' : 'нет'}`);
    }
    if (requiresMarking !== undefined && requiresMarking !== existing.requires_marking) {
      patch.requiresMarking = requiresMarking;
      changes.push(`маркировка: ${existing.requires_marking ? 'да' : 'нет'} → ${requiresMarking ? 'да' : 'нет'}`);
    }

    const { categoryName: patchedCategory, ...fields } = patch;
    const check = updateProductBody.safeParse({ ...fields, ...(patchedCategory ? { categoryId: PLACEHOLDER_ID } : {}) });
    if (!check.success) {
      for (const issue of check.error.issues) fail(`${FIELD_LABELS[(issue.path[0] as Field) ?? 'name'] ?? String(issue.path[0])}: ${issue.message}`);
      out.messages = [...errors, ...messages];
      out.changes = [];
      rowsOut.push(out);
      continue;
    }
    out.messages = messages;
    if (changes.length === 0) {
      out.action = 'skip';
      rowsOut.push(out);
      continue;
    }
    out.action = 'update';
    updates.push({ id: existing.id, patch });
    rowsOut.push(out);
  }

  const count = (a: ImportRowDto['action']) => rowsOut.filter((r) => r.action === a).length;
  const ordered = [...rowsOut.filter((r) => r.action === 'error'), ...rowsOut.filter((r) => r.action !== 'error')].slice(0, PREVIEW_ROWS);
  return {
    preview: {
      encoding,
      delimiter,
      columns,
      total: rowsOut.length,
      create: count('create'),
      update: count('update'),
      skip: count('skip'),
      errors: count('error'),
      newCategories: [...newCategories.values()],
      rows: ordered,
    },
    creates,
    updates,
    newCategories: [...newCategories.values()],
  };
}

function firstBarcode(raw: string): string | null {
  for (const part of raw.split(/[;,\s]+/)) {
    const digits = part.replace(/[- ]/g, '');
    if (/^\d{8,14}$/.test(digits)) return digits;
  }
  return null;
}
