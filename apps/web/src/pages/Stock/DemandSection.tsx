import { formatNumber, type DemandForecastDto, type StockRowDto } from '@zapas/shared';
import { useGet } from '../../api/hooks';
import { DemandChart } from '../../components/Charts/Charts';
import { Chip } from '../../components/Chip/Chip';
import styles from './StockPage.module.scss';

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
const FORECAST_DAYS = 14;

const percent = (fraction: number | null): string => (fraction === null ? '-' : `${(Math.round(fraction * 1000) / 10).toLocaleString('ru-RU')}%`);
const signed = (value: number): string => `${value > 0 ? '+' : ''}${value.toLocaleString('ru-RU')}%`;

/** Что именно модель нашла в продажах этой позиции. Показываются только подтверждённые историей закономерности. */
function findings(d: DemandForecastDto): string[] {
  const out: string[] = [];
  if (d.confirmed.weekday) {
    const peak = d.weekday.reduce((best, v, i) => (v > (d.weekday[best] ?? 0) ? i : best), 0);
    const low = d.weekday.reduce((best, v, i) => (v < (d.weekday[best] ?? Infinity) ? i : best), 0);
    out.push(`Больше всего берут в ${WEEKDAYS[peak]} (${signed(Math.round(((d.weekday[peak] ?? 1) - 1) * 100))} к среднему), меньше всего в ${WEEKDAYS[low]} (${signed(Math.round(((d.weekday[low] ?? 1) - 1) * 100))})`);
  }
  if (d.confirmed.holiday) out.push('Спрос в праздничные и выходные дни отличается от будней');
  if (d.tempPct !== null) out.push(`Рост температуры на 10 °C меняет спрос на ${signed(d.tempPct)}`);
  if (d.rainPct !== null) out.push(`В дождь спрос меняется на ${signed(d.rainPct)}`);
  if (d.promoUplift !== null) out.push(`Во время акции продаётся в ${formatNumber(d.promoUplift)} раза чаще`);
  return out;
}

export function DemandSection({ row }: { row: StockRowDto }) {
  const demand = useGet<DemandForecastDto>('/forecast/demand', { productId: row.productId, locationId: row.locationId, days: FORECAST_DAYS });
  const unit = row.unit === 'pcs' ? 'шт' : row.unit === 'kg' ? 'кг' : 'л';
  const d = demand.data;
  // прав на прогноз может не быть или позиции нет на точке: тогда раздел просто не показываем
  if (demand.isError) return null;

  const notes = d ? findings(d) : [];
  const next3 = d?.forecast.slice(0, 3) ?? [];

  return (
    <div className={styles.section}>
      <h3>Прогноз спроса на {FORECAST_DAYS} дней</h3>
      {!d ? (
        <p className="muted">Считаем…</p>
      ) : (
        <>
          <DemandChart history={d.history} forecast={d.forecast} unit={unit} />
          <ul className={styles.facts}>
            {notes.length === 0 ? <li className="muted">Устойчивых закономерностей кроме среднего расхода ({formatNumber(d.flatPerDay)} {unit} в сутки) пока не найдено.</li> : notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
          {next3.length > 0 && (
            <div className={styles.chips}>
              {next3.map((f) => (
                <Chip key={f.date} tone={f.tags.length > 0 ? 'amber' : 'neutral'} title={f.tags.join(', ')}>
                  {new Date(`${f.date}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' })}: {formatNumber(f.qty)} {unit}
                  {f.tags.length > 0 ? ` · ${f.tags[0]}` : ''}
                </Chip>
              ))}
            </div>
          )}
          {d.accuracy && d.accuracy.wapeModel !== null && d.accuracy.wapeFlat !== null && (
            <p className="muted">
              Проверка на последних {d.accuracy.days} сутках: ошибка модели {percent(d.accuracy.wapeModel)}, ошибка простого среднего {percent(d.accuracy.wapeFlat)}.
            </p>
          )}
          {d.observedDays < 14 && <p className="muted">Истории продаж мало ({d.observedDays} дн.), прогноз приблизительный.</p>}
          {!d.weather.hasCoordinates && <p className="muted">У точки не указаны координаты, поэтому погода в прогнозе не учитывается (Администрирование → Точки).</p>}
        </>
      )}
    </div>
  );
}
