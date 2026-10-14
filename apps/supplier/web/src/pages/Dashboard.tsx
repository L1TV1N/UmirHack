import { Link } from 'react-router';
import { STAGE_LABELS, type DashboardDto, type Stage } from '../../../src/types';
import { fmtDate, money, useLoad } from '../api';
import { useSession } from '../App';
import { Loading, StatusBadge } from './ui';

const STAGES: Stage[] = ['new', 'work', 'shipped', 'closed'];

export function Dashboard() {
  const { account } = useSession();
  const { data, error, loading } = useLoad<DashboardDto>('/dashboard');
  return (
    <>
      <h1 className="h1">Сводка</h1>
      <p className="muted lead">{account.company}, ИНН {account.inn}</p>
      <Loading error={error} loading={loading && !data}>
        {data && (
          <>
            <div className="stats">
              {STAGES.map((s) => (
                <Link key={s} to={`/orders?stage=${s}`} className={`stat stat-${s}`}>
                  <span className="stat-label">{STAGE_LABELS[s]}</span>
                  <b>{data.counts[s]}</b>
                </Link>
              ))}
            </div>
            <div className="cards">
              <div className="card">
                <span className="stat-label">Ждёт отгрузки</span>
                <b className="big">{money(data.awaitingSum)}</b>
                <small className="muted">по новым и подтверждённым заказам</small>
              </div>
              <div className="card">
                <span className="stat-label">Заказано в этом месяце</span>
                <b className="big">{money(data.monthSum)}</b>
                <small className="muted">без отказов и отмен</small>
              </div>
              <div className="card">
                <span className="stat-label">Покупателей</span>
                <b className="big">{data.buyers}</b>
                <small className="muted">уже присылали заказы</small>
              </div>
            </div>
            <section className="panel">
              <header>
                <h2>Последние заказы</h2>
                <Link to="/orders">Все заказы</Link>
              </header>
              {data.recent.length === 0 ? (
                <p className="empty">Заказов пока нет. Как только покупатель отправит заказ на ваш ИНН, он появится здесь.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Номер</th>
                      <th>Покупатель</th>
                      <th>Получен</th>
                      <th className="num">Сумма</th>
                      <th>Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link to={`/orders/${o.id}`}>{o.number}</Link> {o.isNew && <span className="dot" title="Не просмотрен" />}
                        </td>
                        <td>
                          {o.buyerOrg}
                          <small className="muted block">{o.buyerLocation}</small>
                        </td>
                        <td>{fmtDate(o.receivedAt)}</td>
                        <td className="num">{money(o.total)}</td>
                        <td>
                          <StatusBadge status={o.status} label={o.statusLabel} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </Loading>
    </>
  );
}
