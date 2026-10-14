import type { BuyerDto } from '../../../src/types';
import { fmtDate, money, useLoad } from '../api';
import { Loading } from './ui';

export function Buyers() {
  const { data, error, loading } = useLoad<BuyerDto[]>('/buyers');
  return (
    <>
      <h1 className="h1">Покупатели</h1>
      <p className="muted lead">Организации и точки, которые заказывают у вас.</p>
      <Loading error={error} loading={loading && !data}>
        {data && data.length === 0 && <p className="empty panel">Покупателей пока нет: они появятся, когда пришлют первый заказ.</p>}
        {data?.map((b) => (
          <section className="panel" key={b.organization}>
            <header>
              <h2>{b.organization}</h2>
              <span className="muted">
                {b.orders} зак., {money(b.sum)}
              </span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>Точка</th>
                  <th>Адрес</th>
                  <th className="num">Заказов</th>
                  <th className="num">Сумма</th>
                  <th>Последний</th>
                </tr>
              </thead>
              <tbody>
                {b.locations.map((l) => (
                  <tr key={l.name}>
                    <td>{l.name}</td>
                    <td>{l.address ?? '-'}</td>
                    <td className="num">{l.orders}</td>
                    <td className="num">{money(l.sum)}</td>
                    <td>{fmtDate(l.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </Loading>
    </>
  );
}
