import { formatNumber, type AccuracyDto } from '@zapas/shared';
import { useState } from 'react';
import { useGet } from '../../api/hooks';
import { KpiStrip } from '../../components/Charts/Charts';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { Segmented } from '../../components/Tabs/Tabs';

type Row = AccuracyDto['rows'][number];

const percent = (fraction: number | null): string => (fraction === null ? '-' : `${(Math.round(fraction * 1000) / 10).toLocaleString('ru-RU')}%`);
const bias = (fraction: number | null): string => (fraction === null ? '-' : `${fraction > 0 ? 'завышает' : fraction < 0 ? 'занижает' : 'без смещения'} на ${percent(Math.abs(fraction))}`);

/** Проверка прогноза на прошлом: что модель с учётом дня недели, праздников, погоды и акций дала бы вместо простого среднего. */
export function AccuracyPanel({ locationId }: { locationId: string | undefined }) {
  const [days, setDays] = useState<7 | 14 | 28>(14);
  const query = useGet<AccuracyDto>('/forecast/accuracy', { locationId, days });
  const d = query.data;

  const columns: Column<Row>[] = [
    { key: 'name', header: 'Позиция', cell: (r) => <strong>{r.productName}</strong> },
    { key: 'place', header: 'Точка', cell: (r) => <span className="muted">{r.locationName}</span> },
    { key: 'volume', header: 'Продано', align: 'right', cell: (r) => <span className="num">{formatNumber(r.volume)}</span> },
    { key: 'flat', header: 'Ошибка среднего', align: 'right', cell: (r) => <span className="num">{percent(r.wapeFlat)}</span> },
    { key: 'model', header: 'Ошибка модели', align: 'right', cell: (r) => <span className="num">{percent(r.wapeModel)}</span> },
  ];

  return (
    <Panel
      title="Точность прогноза"
      subtitle="Модель прогнозирует каждые сутки без знания факта и сравнивается с продажами. Ошибка это сумма отклонений к сумме продаж"
      actions={
        <Segmented<'7' | '14' | '28'>
          label="Период проверки"
          value={String(days) as '7' | '14' | '28'}
          onChange={(v) => setDays(Number(v) as 7 | 14 | 28)}
          items={[
            { value: '7', label: '7 дней' },
            { value: '14', label: '14 дней' },
            { value: '28', label: '28 дней' },
          ]}
        />
      }
    >
      {query.isLoading && <Loading />}
      {query.isError && (
        <div style={{ padding: 16 }}>
          <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
        </div>
      )}
      {d && d.series === 0 && <p className="muted" style={{ padding: '14px 18px', margin: 0 }}>Для проверки пока мало продаж: нужно хотя бы две недели истории по позиции.</p>}
      {d && d.series > 0 && (
        <>
          <KpiStrip
            items={[
              { label: 'Ошибка модели', value: percent(d.wapeModel), hint: bias(d.biasModel) },
              { label: 'Ошибка среднего', value: percent(d.wapeFlat), hint: 'как считали раньше' },
              {
                label: 'Точнее на',
                value: d.improvementPct === null ? '-' : `${formatNumber(d.improvementPct)}%`,
                hint: `проверено позиций: ${d.series}`,
                ...(d.improvementPct !== null && d.improvementPct > 0 ? {} : { tone: 'warn' as const }),
              },
              { label: 'С погодой', value: String(d.weatherSeries), hint: 'позиций, где найдена связь' },
            ]}
          />
          <DataTable dense columns={columns} rows={d.rows} rowKey={(r) => `${r.productId}|${r.locationId}`} caption="Самые продаваемые позиции" />
        </>
      )}
    </Panel>
  );
}
