import { completeInn, type LocationKind, type Role, type Unit } from '@zapas/shared';

export interface LocationSpec {
  key: string;
  code: string;
  name: string;
  kind: LocationKind;
  address: string;
}

export const LOCATIONS: LocationSpec[] = [
  { key: 'wh', code: 'SKL-ROV', name: 'Склад Ростов', kind: 'warehouse', address: 'Ростов-на-Дону, ул. Малиновского, 25' },
  { key: 'kit', code: 'KIT-NAB', name: 'Кухня «Набережная»', kind: 'kitchen', address: 'Ростов-на-Дону, ул. Береговая, 12' },
  { key: 'shopC', code: 'MAG-CEN', name: 'Магазин «Центр»', kind: 'shop', address: 'Ростов-на-Дону, ул. Большая Садовая, 64' },
  { key: 'shopN', code: 'MAG-SEV', name: 'Магазин «Северный»', kind: 'shop', address: 'Ростов-на-Дону, пр. Королёва, 18' },
];

// ИНН демо-поставщиков настоящие по контрольным цифрам, но выдуманные. Почта в зарезервированной зоне .example: письмо никуда не уйдёт
export const SUPPLIERS = [
  { name: 'Молочный комбинат «Донской»', phone: '+7 863 200-11-22', inn: completeInn('616301234'), email: 'zakaz@donskoy-moloko.example', leadTimeDays: 1, minOrderSum: 3000, autoOrder: true },
  { name: 'Агрофирма «Зерновая»', phone: '+7 863 210-34-56', inn: completeInn('616302345'), email: 'orders@zernovaya.example', leadTimeDays: 3, minOrderSum: 5000, autoOrder: false },
  { name: 'Мясокомбинат «Азовский»', phone: '+7 863 255-90-14', inn: completeInn('616103456'), email: 'zakaz@azovskiy-meat.example', leadTimeDays: 1, minOrderSum: 8000, autoOrder: true },
  { name: 'ТД «Свежий урожай»', phone: '+7 863 240-77-08', inn: completeInn('616404567'), email: 'sale@svezhiy-urozhay.example', leadTimeDays: 2, minOrderSum: 2000, autoOrder: false },
  { name: 'Хлебозавод №4', phone: '+7 863 221-45-60', inn: completeInn('616505678'), email: 'zakaz@hleb4.example', leadTimeDays: 1, minOrderSum: 1500, autoOrder: false },
  { name: 'Рыбный двор', phone: '+7 863 266-18-33', inn: completeInn('616606789'), email: null as string | null, leadTimeDays: 2, minOrderSum: 0, autoOrder: false },
];

/** Кратность заказа демо-продукта: яйца коробками по 30, штучное по 10, весовое по 5 кг, жидкое ящиком по 6 л. */
export const packFor = (p: Pick<ProductSpec, 'key' | 'unit'>): number => (p.key.startsWith('egg') ? 30 : p.unit === 'pcs' ? 10 : p.unit === 'kg' ? 5 : 6);

export interface ProductSpec {
  key: string;
  sku: string;
  name: string;
  category: string;
  unit: Unit;
  cost: number;
  price: number;
  shelf: number;
  sellable: boolean;
  supplier: number;
}

const p = (
  key: string,
  sku: string,
  name: string,
  category: string,
  unit: Unit,
  cost: number,
  price: number,
  shelf: number,
  supplier: number,
  sellable = true,
): ProductSpec => ({ key, sku, name, category, unit, cost, price, shelf, sellable, supplier });

/** Категории животного происхождения: к партии нужен ВСД из «Меркурия». */
export const VSD_CATEGORIES = new Set(['Молочные продукты', 'Яйцо', 'Мясо и птица', 'Рыба']);
/** Маркируется молочная продукция и питьевая вода. */
export const isMarked = (p: Pick<ProductSpec, 'category' | 'key'>): boolean => p.category === 'Молочные продукты' || p.key === 'water';

export const PRODUCTS: ProductSpec[] = [
  p('milk', 'MLK-001', 'Молоко 3,2% пастеризованное', 'Молочные продукты', 'l', 62, 94.9, 7, 0),
  p('kefir', 'MLK-002', 'Кефир 2,5%', 'Молочные продукты', 'l', 58, 89.9, 10, 0),
  p('sour', 'MLK-003', 'Сметана 20%', 'Молочные продукты', 'kg', 210, 319, 14, 0),
  p('curd', 'MLK-004', 'Творог 5%', 'Молочные продукты', 'kg', 290, 429, 10, 0),
  p('cheese', 'MLK-005', 'Сыр Российский', 'Молочные продукты', 'kg', 520, 779, 60, 0),
  p('cream', 'MLK-006', 'Сливки 10%', 'Молочные продукты', 'l', 190, 289, 14, 0),
  p('yogurt', 'MLK-007', 'Йогурт натуральный 3,5%', 'Молочные продукты', 'kg', 170, 259, 14, 0),
  p('butter', 'MLK-008', 'Масло сливочное 82,5%', 'Молочные продукты', 'kg', 640, 949, 60, 0),
  p('eggs', 'EGG-001', 'Яйцо куриное С1', 'Яйцо', 'pcs', 9.2, 14.9, 30, 1),
  p('chicken', 'MEA-001', 'Филе куриное охлаждённое', 'Мясо и птица', 'kg', 310, 459, 5, 2),
  p('beef', 'MEA-002', 'Говядина охлаждённая, лопатка', 'Мясо и птица', 'kg', 590, 849, 5, 2),
  p('sausage', 'MEA-003', 'Колбаса варёная «Докторская»', 'Мясо и птица', 'kg', 330, 489, 20, 2),
  p('salmon', 'FIS-001', 'Сёмга охлаждённая, стейк', 'Рыба', 'kg', 1180, 1690, 4, 5),
  p('tomato', 'VEG-001', 'Помидоры грунтовые', 'Овощи и зелень', 'kg', 120, 199, 8, 3),
  p('cucumber', 'VEG-002', 'Огурцы гладкие', 'Овощи и зелень', 'kg', 95, 159, 8, 3),
  p('potato', 'VEG-003', 'Картофель мытый', 'Овощи и зелень', 'kg', 38, 69, 60, 3),
  p('onion', 'VEG-004', 'Лук репчатый', 'Овощи и зелень', 'kg', 28, 49, 60, 3),
  p('carrot', 'VEG-005', 'Морковь', 'Овощи и зелень', 'kg', 32, 59, 40, 3),
  p('cabbage', 'VEG-006', 'Капуста белокочанная', 'Овощи и зелень', 'kg', 24, 45, 30, 3),
  p('beet', 'VEG-007', 'Свёкла', 'Овощи и зелень', 'kg', 30, 55, 40, 3),
  p('greens', 'VEG-008', 'Зелень (укроп, петрушка)', 'Овощи и зелень', 'kg', 420, 0, 5, 3, false),
  p('bread', 'BAK-001', 'Хлеб пшеничный формовой', 'Хлеб и выпечка', 'pcs', 31, 54, 3, 4),
  p('loaf', 'BAK-002', 'Батон нарезной', 'Хлеб и выпечка', 'pcs', 26, 46, 3, 4),
  p('bun', 'BAK-003', 'Булочка с маком', 'Хлеб и выпечка', 'pcs', 17, 35, 2, 4),
  p('flour', 'GRO-001', 'Мука пшеничная высший сорт', 'Бакалея', 'kg', 42, 0, 365, 1, false),
  p('sugar', 'GRO-002', 'Сахар-песок', 'Бакалея', 'kg', 58, 0, 730, 1, false),
  p('rice', 'GRO-003', 'Рис круглозёрный', 'Бакалея', 'kg', 95, 149, 540, 1),
  p('buckwheat', 'GRO-004', 'Крупа гречневая', 'Бакалея', 'kg', 110, 169, 540, 1),
  p('pasta', 'GRO-005', 'Макароны твёрдых сортов', 'Бакалея', 'kg', 88, 139, 540, 1),
  p('oats', 'GRO-006', 'Хлопья овсяные', 'Бакалея', 'kg', 76, 119, 270, 1),
  p('oil', 'GRO-007', 'Масло подсолнечное рафинированное', 'Бакалея', 'l', 118, 0, 365, 1, false),
  p('juice', 'DRK-001', 'Сок яблочный осветлённый', 'Напитки', 'l', 88, 149, 270, 1),
  p('water', 'DRK-002', 'Вода питьевая негазированная 0,5 л', 'Напитки', 'pcs', 17, 39, 365, 1),
];

export interface DishSpec {
  name: string;
  price: number;
  perDay: number;
  items: [string, number][];
}

export const DISHES: DishSpec[] = [
  { name: 'Борщ с говядиной', price: 290, perDay: 26, items: [['beef', 0.12], ['potato', 0.1], ['carrot', 0.03], ['onion', 0.03], ['cabbage', 0.1], ['beet', 0.08], ['sour', 0.02], ['greens', 0.005]] },
  { name: 'Блины со сметаной', price: 210, perDay: 18, items: [['flour', 0.08], ['milk', 0.15], ['eggs', 1], ['sour', 0.03], ['sugar', 0.01], ['oil', 0.01]] },
  { name: 'Омлет с сыром', price: 240, perDay: 22, items: [['eggs', 3], ['milk', 0.05], ['cheese', 0.03], ['butter', 0.01]] },
  { name: 'Каша овсяная на молоке', price: 170, perDay: 16, items: [['oats', 0.06], ['milk', 0.2], ['butter', 0.01], ['sugar', 0.01]] },
  { name: 'Куриное филе с гречкой', price: 420, perDay: 24, items: [['chicken', 0.18], ['buckwheat', 0.08], ['butter', 0.01]] },
  { name: 'Салат «Греческий»', price: 330, perDay: 17, items: [['tomato', 0.1], ['cucumber', 0.1], ['cheese', 0.05], ['oil', 0.02], ['onion', 0.02]] },
  { name: 'Паста с сёмгой в сливках', price: 590, perDay: 12, items: [['pasta', 0.1], ['salmon', 0.12], ['cream', 0.08], ['cheese', 0.02]] },
  { name: 'Сырники со сметаной', price: 260, perDay: 15, items: [['curd', 0.15], ['eggs', 1], ['flour', 0.03], ['sugar', 0.02], ['sour', 0.03]] },
];

/** Сколько продукта в день уходит на розничной точке. Ключи точек см. LOCATIONS. */
export const RETAIL_DEMAND: Record<string, Record<string, number>> = {
  shopC: { milk: 38, kefir: 22, sour: 5.5, curd: 6, cheese: 4, yogurt: 7, butter: 3.2, eggs: 140, sausage: 5, bread: 55, loaf: 60, bun: 40, juice: 14, water: 90, rice: 4, buckwheat: 5, pasta: 4, tomato: 12, cucumber: 12, potato: 18, onion: 7, carrot: 6, chicken: 11 },
  shopN: { milk: 26, kefir: 14, sour: 3.6, curd: 4.2, cheese: 2.6, yogurt: 4.5, butter: 2, eggs: 90, sausage: 3.4, bread: 38, loaf: 41, bun: 24, juice: 9, water: 62, rice: 2.8, buckwheat: 3.4, pasta: 3, tomato: 8, cucumber: 8, potato: 12, onion: 4.5, carrot: 4, chicken: 7 },
};

/** Суточный расход продуктов на кухне по рецептурам и средним продажам блюд. */
export function kitchenDemandPerDay(): Map<string, number> {
  const demand = new Map<string, number>();
  for (const dish of DISHES) {
    for (const [product, qty] of dish.items) demand.set(product, (demand.get(product) ?? 0) + qty * dish.perDay);
  }
  return demand;
}

/** Сухие продукты кухня берёт со склада, остальное привозят поставщики напрямую. */
export const VIA_WAREHOUSE = new Set(['flour', 'sugar', 'oil', 'oats', 'pasta', 'buckwheat']);

export interface UserSpec {
  email: string;
  fullName: string;
  role: Role;
  password: string;
  locations: string[];
}

// Учётные записи демо-стенда, пароли указаны в README
export const USERS: UserSpec[] = [
  { email: 'admin@zapas.local', fullName: 'Орлов Дмитрий Сергеевич', role: 'admin', password: 'Бирюза-Орион-41-кедр', locations: [] },
  { email: 'manager@zapas.local', fullName: 'Белова Ирина Викторовна', role: 'manager', password: 'Лазурь-Тропа-58-мост', locations: [] },
  { email: 'keeper@zapas.local', fullName: 'Козлов Андрей Николаевич', role: 'storekeeper', password: 'Янтарь-Река-23-сосна', locations: ['wh', 'shopC'] },
  { email: 'viewer@zapas.local', fullName: 'Громова Елена Павловна', role: 'viewer', password: 'Сирень-Холм-67-ручей', locations: ['shopC', 'shopN'] },
];
