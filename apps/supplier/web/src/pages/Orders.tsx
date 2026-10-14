import { Link, useSearchParams } from 'react-router';
import { STAGE_LABELS, type OrderRowDto, type Stage } from '../../../src/types';
import { fmtDate, money, useLoad } from '../api';
import { Loading, StatusBadge } from './ui';

const TABS: (Stage | 'all')[] = ['new', 'work', 'shipped', 'closed', 'all'];

export function Orders() {
  const [params, setParams] = useSearchParams();
  const stage = (TABS as string[]).includes(params.get('stage') ?? '') ? (params.get('stage') as Stage | 'all') : 'new';
  const { data, error, loading } = useLoad<OrderRowDto[]>(`/orders?stage=${stage}`);
  return (
    <>
      <h1 className="h1">Заказы</h1>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={t === stage} className={t === stage ? 'on' : ''} onClick={() => setParams({ stage: t })}>
            {t === 'all' ? 'Все' : STAGE_LABELS[t]}
          </button>
        ))}
      </div>
      <Loading error={error} loading={loading && !data}>
        {data && (
          <section className="panel">
            {data.length === 0 ? (
              <p className="empty">{stage === 'new' ? 'Новых заказов нет.' : 'Здесь пока пусто.'}</p>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Номер</th>
                      <th>Покупатель и точка</th>
                      <th>Получен</th>
                      <th>Нужно к</th>
                      <th className="num">Позиций</th>
                      <th className="num">Сумма</th>
                      <th>Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((o) => (
                      <tr key={o.id} className={o.isNew ? 'unread' : ''}>
                        <td>
                          <Link to={`/orders/${o.id}`}>{o.number}</Link>
                        </td>
                        <td>
                          {o.buyerOrg}
                          <small className="muted block">{o.buyerLocation}</small>
                        </td>
                        <td>{fmtDate(o.receivedAt)}</td>
                        <td>{fmtDate(o.deliveryOn ?? o.expectedOn)}</td>
                        <td className="num">{o.lines}</td>
                        <td className="num">{money(o.total)}</td>
                        <td>
                          <StatusBadge status={o.status} label={o.statusLabel} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </Loading>
    </>
  );
}
