import { formatMoneyWhole, formatNumber, type DemandDayDto, type ExpiryBucketDto, type WriteoffTrendPoint } from '@zapas/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtShortDate } from '../../lib/format';
import styles from './Charts.module.scss';

export interface Kpi {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: 'danger' | 'warn';
}

export function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <dl className={styles.kpis}>
      {items.map((k) => (
        <div key={k.label} className={`${styles.kpi} ${k.tone ? styles[k.tone] : ''}`}>
          <dt>{k.label}</dt>
          <dd>
            <span className={styles.value}>{k.value}</span>
            {k.hint && <span className={styles.hint}>{k.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const BUCKET_COLOR: Record<ExpiryBucketDto['key'], string> = {
  expired: 'var(--danger-600)',
  d0_1: 'var(--warn-600)',
  d2_3: 'var(--amber-500)',
  d4_7: 'var(--brand-300)',
  d8_14: 'var(--brand-400)',
  d15_plus: 'var(--brand-600)',
};

export function ExpiryBars({ buckets }: { buckets: ExpiryBucketDto[] }) {
  const max = Math.max(...buckets.map((b) => b.value), 1);
  return (
    <ul className={styles.bars} aria-label="Стоимость остатков по срокам годности">
      {buckets.map((b) => (
        <li key={b.key} className={styles.barRow}>
          <span className={styles.barLabel}>{b.label}</span>
          <span className={styles.track}>
            <span className={styles.fill} style={{ width: `${(b.value / max) * 100}%`, background: BUCKET_COLOR[b.key], opacity: b.value > 0 ? 1 : 0 }} />
          </span>
          <span className={styles.barValue}>
            {formatMoneyWhole(b.value)}
            <small>{b.batches} парт.</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const n = value / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const H = 190;
const PAD = { l: 50, r: 6, t: 8, b: 24 };
const DEFAULT_WIDTH = 720;

/** Ширина контейнера в пикселях: график рисуется в натуральную величину, и подписи не уменьшаются на телефоне. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => setWidth(Math.max(260, Math.round(el.clientWidth)));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function TrendChart({ points }: { points: WriteoffTrendPoint[] }) {
  const [box, W] = useWidth();
  const totals = points.map((p) => p.expired + p.spoiled + p.other);
  const top = niceMax(Math.max(...totals, 1));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const slot = innerW / points.length;
  const barW = Math.max(4, slot * 0.66);
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;
  const empty = totals.every((t) => t === 0);
  const grid = empty ? [0] : [0, top / 2, top];

  return (
    <div ref={box}>
      <svg className={styles.chart} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Списания за 30 дней по причинам">
        {grid.map((g) => (
          <g key={g}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" strokeWidth="1" />
            <text className={styles.axis} x={PAD.l - 8} y={y(g) + 4} textAnchor="end">
              {g === 0 ? '0' : formatMoneyWhole(g)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = PAD.l + i * slot + (slot - barW) / 2;
          const parts: [number, string][] = [
            [p.expired, 'var(--danger-600)'],
            [p.spoiled, 'var(--warn-600)'],
            [p.other, 'var(--ink-400)'],
          ];
          let acc = 0;
          return (
            <g key={p.date}>
              <title>{`${fmtShortDate(p.date)}: ${formatMoneyWhole(p.expired + p.spoiled + p.other)}`}</title>
              <rect x={PAD.l + i * slot} y={PAD.t} width={slot} height={innerH} fill="transparent" />
              {parts.map(([value, color]) => {
                if (value <= 0) return null;
                const h = (value / top) * innerH;
                const top0 = y(acc + value);
                acc += value;
                return <rect key={color} x={x} y={top0} width={barW} height={Math.max(h, 1)} fill={color} rx="1" />;
              })}
            </g>
          );
        })}
        {[0, Math.floor(points.length / 2), points.length - 1].map((i) => (
          <text key={i} className={styles.axis} x={PAD.l + i * slot + slot / 2} y={H - 6} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
            {points[i] ? fmtShortDate(points[i].date) : ''}
          </text>
        ))}
        {empty && (
          <text className={styles.axis} x={W / 2} y={H / 2} textAnchor="middle">
            За 30 дней списаний не было
          </text>
        )}
      </svg>
      <div className={styles.legend}>
        <span>
          <i style={{ background: 'var(--danger-600)' }} />
          Истёк срок
        </span>
        <span>
          <i style={{ background: 'var(--warn-600)' }} />
          Порча и бой
        </span>
        <span>
          <i style={{ background: 'var(--ink-400)' }} />
          Прочее
        </span>
      </div>
    </div>
  );
}

export function SalesHistory({ history, velocity, unit }: { history: { date: string; qty: number }[]; velocity: number; unit: string }) {
  const [box, W] = useWidth();
  const top = niceMax(Math.max(...history.map((h) => h.qty), velocity, 0.001));
  const innerW = W - PAD.l - PAD.r;
  const innerH = 150 - PAD.t - PAD.b;
  const slot = innerW / history.length;
  const barW = Math.max(3, slot * 0.64);
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;
  return (
    <div ref={box}>
      <svg className={styles.chart} width={W} height={150} viewBox={`0 0 ${W} 150`} role="img" aria-label={`Расход по дням, около ${formatNumber(velocity)} ${unit} в сутки`}>
        {[0, top].map((g) => (
          <g key={g}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
            <text className={styles.axis} x={PAD.l - 8} y={y(g) + 4} textAnchor="end">
              {formatNumber(g)}
            </text>
          </g>
        ))}
        {history.map((h, i) => (
          <g key={h.date}>
            <title>{`${fmtShortDate(h.date)}: ${formatNumber(h.qty)} ${unit}`}</title>
            <rect x={PAD.l + i * slot + (slot - barW) / 2} y={y(h.qty)} width={barW} height={Math.max(innerH - (y(h.qty) - PAD.t), h.qty > 0 ? 1 : 0)} fill="var(--brand-300)" rx="1" />
          </g>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(velocity)} y2={y(velocity)} stroke="var(--brand-800)" strokeDasharray="4 3" strokeWidth="1.5" />
        <text className={styles.axis} x={W - PAD.r} y={y(velocity) - 5} textAnchor="end" style={{ fill: 'var(--brand-800)', fontWeight: 700 }}>
          расчётный расход
        </text>
        <text className={styles.axis} x={PAD.l} y={146} textAnchor="start">
          {history[0] ? fmtShortDate(history[0].date) : ''}
        </text>
        <text className={styles.axis} x={W - PAD.r} y={146} textAnchor="end">
          {history.at(-1) ? fmtShortDate(history.at(-1)!.date) : ''}
        </text>
      </svg>
    </div>
  );
}

const DEMAND_H = 200;

/**
 * Факт за последние недели и прогноз спроса на ближайшие дни. У прогноза показан диапазон, в котором спрос окажется
 * в большинстве случаев; дни с праздником, акцией или осадками помечены точкой под осью.
 */
export function DemandChart({ history, forecast, unit }: { history: { date: string; qty: number; fitted: number }[]; forecast: DemandDayDto[]; unit: string }) {
  const [box, W] = useWidth();
  const all = history.length + forecast.length;
  const top = niceMax(Math.max(...history.map((h) => Math.max(h.qty, h.fitted)), ...forecast.map((f) => f.high), 0.001));
  const innerW = W - PAD.l - PAD.r;
  const innerH = DEMAND_H - PAD.t - PAD.b - 10;
  const slot = innerW / Math.max(all, 1);
  const barW = Math.max(3, slot * 0.6);
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;
  const cx = (i: number) => PAD.l + i * slot + slot / 2;
  const fitted = history.map((h, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${y(h.fitted).toFixed(1)}`).join(' ');
  const mark = (tags: string[]) => tags.some((t) => t.startsWith('праздник') || t === 'акция' || t === 'дождь');

  return (
    <div ref={box}>
      <svg className={styles.chart} width={W} height={DEMAND_H} viewBox={`0 0 ${W} ${DEMAND_H}`} role="img" aria-label={`Расход по дням и прогноз спроса, ${unit}`}>
        {[0, top / 2, top].map((g) => (
          <g key={g}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
            <text className={styles.axis} x={PAD.l - 8} y={y(g) + 4} textAnchor="end">
              {formatNumber(g)}
            </text>
          </g>
        ))}
        {history.map((h, i) => (
          <g key={h.date}>
            <title>{`${fmtShortDate(h.date)}: продано ${formatNumber(h.qty)} ${unit}, по модели ${formatNumber(h.fitted)}`}</title>
            <rect x={cx(i) - barW / 2} y={y(h.qty)} width={barW} height={Math.max(innerH - (y(h.qty) - PAD.t), h.qty > 0 ? 1 : 0)} fill="var(--brand-300)" rx="1" />
          </g>
        ))}
        {history.length > 1 && <path d={fitted} fill="none" stroke="var(--brand-800)" strokeWidth="1.5" strokeDasharray="4 3" />}
        <line x1={PAD.l + history.length * slot} x2={PAD.l + history.length * slot} y1={PAD.t} y2={PAD.t + innerH} stroke="var(--ink-400)" strokeDasharray="2 3" />
        {forecast.map((f, i) => {
          const x = cx(history.length + i);
          return (
            <g key={f.date}>
              <title>{`${fmtShortDate(f.date)}: ожидается ${formatNumber(f.qty)} ${unit} (от ${formatNumber(f.low)} до ${formatNumber(f.high)})${f.tags.length ? `. ${f.tags.join(', ')}` : ''}`}</title>
              <rect x={x - barW / 2} y={y(f.high)} width={barW} height={Math.max(y(f.low) - y(f.high), 1)} fill="var(--brand-100)" />
              <rect x={x - barW / 2} y={y(f.qty) - 1.5} width={barW} height={3} fill="var(--brand-600)" rx="1" />
              {mark(f.tags) && <circle cx={x} cy={DEMAND_H - 16} r="2.5" fill="var(--warn-600)" />}
            </g>
          );
        })}
        <text className={styles.axis} x={PAD.l} y={DEMAND_H - 4} textAnchor="start">
          {history[0] ? fmtShortDate(history[0].date) : ''}
        </text>
        <text className={styles.axis} x={PAD.l + history.length * slot + 4} y={PAD.t + 10} textAnchor="start" style={{ fill: 'var(--ink-500)' }}>
          прогноз →
        </text>
        <text className={styles.axis} x={W - PAD.r} y={DEMAND_H - 4} textAnchor="end">
          {forecast.at(-1) ? fmtShortDate(forecast.at(-1)!.date) : ''}
        </text>
      </svg>
      <div className={styles.legend}>
        <span>
          <i style={{ background: 'var(--brand-300)' }} />
          Продано
        </span>
        <span>
          <i style={{ background: 'var(--brand-600)' }} />
          Прогноз
        </span>
        <span>
          <i style={{ background: 'var(--brand-100)', outline: '1px solid var(--brand-200)' }} />
          Обычный диапазон
        </span>
        <span>
          <i style={{ background: 'var(--warn-600)', borderRadius: '50%' }} />
          Праздник, акция или дождь
        </span>
      </div>
    </div>
  );
}
