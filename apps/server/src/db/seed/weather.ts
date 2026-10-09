import { addDays } from '@zapas/shared';

/**
 * Погода демо-стенда: правдоподобная для Ростова-на-Дону, но выдуманная и детерминированная. Одни и те же сутки дают
 * одну и ту же погоду, поэтому продажи в симуляции, сохранённая история и «прогноз» согласованы. В рабочей установке
 * погоду загружает Open-Meteo, этот файл нужен только демо-данным.
 */
export interface DemoWeather {
  tMax: number;
  tMin: number;
  precip: number;
}

/** Координаты Ростова-на-Дону: все демо-точки в одном городе. */
export const DEMO_COORDINATES = { latitude: 47.2357, longitude: 39.7015 };

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
const round1 = (v: number) => Math.round(v * 10) / 10;

export function demoWeather(date: string): DemoWeather {
  const n = dayNumber(date);
  const jan1 = dayNumber(`${date.slice(0, 4)}-01-01`);
  const seasonal = 15.5 + 15.5 * Math.cos((2 * Math.PI * (n - jan1 - 200)) / 365);
  const rand = mulberry32(n * 7919 + 13);
  const drift = 4.5 * Math.sin(n / 4.3) + 2.5 * Math.sin(n / 1.7 + 1);
  const tMax = round1(seasonal + drift + (rand() - 0.5) * 2);
  const rainy = rand() < 0.28;
  return { tMax, tMin: round1(tMax - 7 - rand() * 3), precip: rainy ? round1(1.5 + rand() * 10) : rand() < 0.1 ? 0.3 : 0 };
}

/** Насколько на каждый градус выше 20 меняется спрос на продукт в магазине. Холодное и свежее покупают в жару, тяжёлое в холод. */
export const WEATHER_SENSITIVITY: Record<string, number> = {
  water: 0.035,
  juice: 0.03,
  cucumber: 0.012,
  tomato: 0.01,
  yogurt: 0.01,
  potato: -0.008,
  chicken: -0.004,
};

/** Множитель спроса в магазине из-за погоды. Кухня и склад от погоды не зависят: блюда в меню те же. */
export function weatherMultiplier(productKey: string, locationKey: string, w: DemoWeather): number {
  if (locationKey === 'kit' || locationKey === 'wh') return 1;
  const temp = 1 + (WEATHER_SENSITIVITY[productKey] ?? 0) * (w.tMax - 20);
  const rain = w.precip >= 1 ? 0.94 : 1;
  return Math.min(1.5, Math.max(0.6, temp)) * rain;
}

/** Сутки с погодой для записи в базу: прошлое и прогноз вперёд. */
export function demoWeatherRange(today: string, pastDays: number, futureDays: number): { date: string; weather: DemoWeather; forecast: boolean }[] {
  const out: { date: string; weather: DemoWeather; forecast: boolean }[] = [];
  for (let i = -pastDays; i <= futureDays; i += 1) {
    const date = addDays(today, i);
    out.push({ date, weather: demoWeather(date), forecast: date >= today });
  }
  return out;
}
