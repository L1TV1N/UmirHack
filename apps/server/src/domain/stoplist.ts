import {
  formatQty,
  fromMilli,
  type LocationKind,
  type LowPortionDto,
  type MissingIngredient,
  type StopReason,
  type Unit,
} from '@zapas/shared';

export interface StopProduct {
  id: string;
  name: string;
  unit: Unit;
  sellable: boolean;
  isActive: boolean;
}

export interface StopDish {
  id: string;
  name: string;
  isActive: boolean;
  items: { productId: string; qtyMilli: number }[];
}

export interface StopLocation {
  id: string;
  name: string;
  kind: LocationKind;
  isActive: boolean;
}

export interface StockPoint {
  onHandMilli: number;
  availableMilli: number;
}

export interface StopInput {
  locations: StopLocation[];
  products: ReadonlyMap<string, StopProduct>;
  dishes: StopDish[];
  /** Ключ productId|locationId. */
  stock: ReadonlyMap<string, StockPoint>;
  /** Позиции, которые когда-либо приходили на точку. */
  tracked: ReadonlySet<string>;
  lowPortionThreshold: number;
}

export interface AutoStop {
  entityType: 'product' | 'dish';
  entityId: string;
  name: string;
  locationId: string;
  locationName: string;
  reasons: StopReason[];
}

export const stockKey = (productId: string, locationId: string): string => `${productId}|${locationId}`;

export function portionsPossible(
  dish: Pick<StopDish, 'items'>,
  locationId: string,
  stock: ReadonlyMap<string, StockPoint>,
): number {
  let min = Infinity;
  for (const item of dish.items) {
    const have = stock.get(stockKey(item.productId, locationId))?.availableMilli ?? 0;
    min = Math.min(min, Math.floor(have / item.qtyMilli));
  }
  return Number.isFinite(min) ? min : 0;
}

export function evaluateAutoStops(input: StopInput): { stops: AutoStop[]; warnings: LowPortionDto[] } {
  const stops: AutoStop[] = [];
  const warnings: LowPortionDto[] = [];

  for (const location of input.locations) {
    if (!location.isActive) continue;

    for (const product of input.products.values()) {
      if (!product.isActive || !product.sellable) continue;
      const key = stockKey(product.id, location.id);
      if (!input.tracked.has(key)) continue;
      const point = input.stock.get(key);
      if ((point?.availableMilli ?? 0) > 0) continue;
      const allExpired = (point?.onHandMilli ?? 0) > 0;
      stops.push({
        entityType: 'product',
        entityId: product.id,
        name: product.name,
        locationId: location.id,
        locationName: location.name,
        reasons: [
          allExpired
            ? { code: 'all_expired', text: 'Весь остаток просрочен' }
            : { code: 'out_of_stock', text: 'Нет в наличии' },
        ],
      });
    }

    if (location.kind !== 'kitchen') continue;
    for (const dish of input.dishes) {
      if (!dish.isActive) continue;
      const served = dish.items.some((i) => input.tracked.has(stockKey(i.productId, location.id)));
      if (!served) continue;

      const missing: MissingIngredient[] = [];
      for (const item of dish.items) {
        const have = input.stock.get(stockKey(item.productId, location.id))?.availableMilli ?? 0;
        if (have >= item.qtyMilli) continue;
        const product = input.products.get(item.productId);
        if (!product) continue;
        missing.push({
          productId: product.id,
          name: product.name,
          unit: product.unit,
          required: fromMilli(item.qtyMilli),
          available: fromMilli(have),
        });
      }

      if (missing.length > 0) {
        const list = missing
          .map((m) => `${m.name} (нужно ${formatQty(m.required, m.unit)}, есть ${formatQty(m.available, m.unit)})`)
          .join(', ');
        stops.push({
          entityType: 'dish',
          entityId: dish.id,
          name: dish.name,
          locationId: location.id,
          locationName: location.name,
          reasons: [{ code: 'missing_ingredients', text: `Не хватает: ${list}`, missing }],
        });
        continue;
      }

      const portions = portionsPossible(dish, location.id, input.stock);
      if (portions > 0 && portions <= input.lowPortionThreshold) {
        warnings.push({
          dishId: dish.id,
          name: dish.name,
          locationId: location.id,
          locationName: location.name,
          portions,
        });
      }
    }
  }
  return { stops, warnings };
}
