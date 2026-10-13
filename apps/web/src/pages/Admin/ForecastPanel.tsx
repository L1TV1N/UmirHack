import { calendarDayBody, type CalendarDayDto, type UpcomingOffDayDto, type WeatherRefreshDto, type WeatherStatusDto } from '@zapas/shared';
import { useState, type FormEvent } from 'react';
import { del, post, put } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Field, FieldRow, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDate, fmtDateTime } from '../../lib/format';

const FORECAST_KEYS = ['/forecast', '/calendar', '/analytics', '/stock'];

function WeatherBlock() {
  const toast = useToast();
  const status = useGet<WeatherStatusDto>('/forecast/weather');
  const refresh = useAction(() => post<WeatherRefreshDto>('/forecast/weather/refresh'), FORECAST_KEYS);
  const rows = status.data?.locations ?? [];

  const columns: Column<WeatherStatusDto['locations'][number]>[] = [
    { key: 'name', header: 'Точка', cell: (l) => <strong>{l.locationName}</strong> },
    {
      key: 'coords',
      header: 'Координаты',
      cell: (l) => (l.hasCoordinates ? <span className="mono">{l.latitude}, {l.longitude}</span> : <Chip tone="neutral">не заданы</Chip>),
    },
    { key: 'days', header: 'Суток погоды', align: 'right', cell: (l) => <span className="num">{l.days}</span> },
    { key: 'forecast', header: 'Из них прогноз', align: 'right', cell: (l) => <span className="num">{l.forecastDays}</span> },
    { key: 'fetched', header: 'Обновлено', cell: (l) => <span className="muted">{l.fetchedAt ? fmtDateTime(l.fetchedAt) : '-'}</span> },
  ];

  return (
    <Panel
      title="Погода"
      subtitle="Берётся из Open-Meteo по координатам точки и учитывается в прогнозе спроса. Координаты задаются в разделе «Точки»"
      actions={
        status.data?.provider ? (
          <Button
            size="sm"
            loading={refresh.isPending}
            onClick={() =>
              refresh.mutate(undefined, {
                onSuccess: (r) => toast.success(r.failed.length > 0 ? `Погода обновлена для ${r.locations} точек, не удалось: ${r.failed.length}` : `Погода обновлена: точек ${r.locations}, суток ${r.days}`),
                onError: (err) => toast.error(errorMessage(err)),
              })
            }
          >
            Обновить погоду
          </Button>
        ) : undefined
      }
    >
      {status.isError ? (
        <div style={{ padding: 16 }}>
          <ErrorNote error={status.error} onRetry={() => void status.refetch()} />
        </div>
      ) : (
        <>
          {status.data && !status.data.provider && <p className="muted" style={{ padding: '12px 18px', margin: 0 }}>Загрузка погоды отключена на сервере (WEATHER_ENABLED=false). Прогноз спроса работает без неё.</p>}
          <DataTable columns={columns} rows={status.isLoading ? undefined : rows} rowKey={(l) => l.locationId} loading={status.isLoading} caption="Погода по точкам" empty="Нет точек" />
        </>
      )}
    </Panel>
  );
}

function CalendarBlock() {
  const toast = useToast();
  const days = useGet<CalendarDayDto[]>('/calendar/days');
  const upcoming = useGet<UpcomingOffDayDto[]>('/calendar/upcoming', { days: 90 });
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<'off' | 'work'>('off');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: object) => put<CalendarDayDto[]>('/calendar/days', body), FORECAST_KEYS);
  const remove = useAction((d: string) => del<CalendarDayDto[]>(`/calendar/days/${d}`), FORECAST_KEYS);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = calendarDayBody.safeParse({ date, kind, note: note.trim() || undefined });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Проверьте данные');
    setError(null);
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('День сохранён');
        setDate('');
        setNote('');
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const manual = days.data?.filter((d) => d.source === 'manual') ?? [];
  const columns: Column<CalendarDayDto>[] = [
    { key: 'date', header: 'Дата', cell: (d) => <strong>{fmtDate(d.date)}</strong> },
    { key: 'kind', header: 'Что', cell: (d) => <Chip tone={d.kind === 'off' ? 'warn' : 'info'}>{d.kind === 'off' ? 'Нерабочий день' : 'Рабочий день'}</Chip> },
    { key: 'note', header: 'Примечание', cell: (d) => <span className="muted">{d.note ?? ''}</span> },
    {
      key: 'x',
      header: '',
      align: 'right',
      cell: (d) => (
        <Button size="sm" loading={remove.isPending && remove.variables === d.date} onClick={() => remove.mutate(d.date, { onError: (err) => toast.error(errorMessage(err)) })}>
          Убрать
        </Button>
      ),
    },
  ];

  return (
    <Panel title="Производственный календарь" subtitle="Праздники и переносы выходных заложены в приложение. Здесь можно добавить свой нерабочий день или рабочую субботу" padded>
      {upcoming.data && upcoming.data.length > 0 && (
        <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
          Ближайшие нерабочие дни: {upcoming.data.slice(0, 5).map((d) => `${fmtDate(d.date)} (${d.name})`).join(', ')}
        </p>
      )}
      <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
        <FieldRow cols={3}>
          <Field label="Дата" required>{(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Что это" required>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'off' | 'work')}>
                <option value="off">Нерабочий день</option>
                <option value="work">Рабочий день (например, суббота)</option>
              </Select>
            )}
          </Field>
          <Field label="Примечание">{(p) => <Input {...p} value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} />}</Field>
        </FieldRow>
        {error && <ErrorNote message={error} />}
        <div>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Добавить день
          </Button>
        </div>
      </form>
      {manual.length > 0 && (
        <div style={{ marginTop: 16, border: '1px solid var(--line)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <DataTable dense columns={columns} rows={manual} rowKey={(d) => d.date} caption="Добавленные дни" />
        </div>
      )}
    </Panel>
  );
}

export function ForecastPanel() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <WeatherBlock />
      <CalendarBlock />
    </div>
  );
}
