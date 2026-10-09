import { daysWord, formatMoneyWhole } from '@zapas/shared';
import type { Deps } from '../../lib/context';
import { getDashboard, getRecommendations } from '../analytics/service';
import type { Principal } from '../../lib/context';
import { locationFilter } from '../../lib/scope';
import { traceabilitySummary } from '../traceability/service';
import { escapeHtml } from './notifier';

/** Служебный принципал: сводка строится по всем точкам. */
export const SYSTEM: Principal = { kind: 'user', id: 'system', email: 'system', fullName: 'Система', role: 'admin', locationIds: 'all' };

/** Сводка по тем точкам, что видны principal (по умолчанию система видит все). Можно сузить до одной точки. */
export async function buildDigest(deps: Deps, principal: Principal = SYSTEM, locationId?: string): Promise<string> {
  const scope = locationFilter(principal, locationId);
  const dash = await getDashboard(deps, principal, locationId);
  const recs = (await getRecommendations(deps, principal, locationId)).items;
  const k = dash.kpis;

  const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: deps.config.businessTz }).format(deps.clock());
  const lines = [`<b>Сводка на ${date}</b>`];
  lines.push(
    k.expiredBatches > 0
      ? `Просрочено: ${k.expiredBatches} парт. на ${formatMoneyWhole(k.expiredValue)}`
      : 'Просроченных партий нет',
  );
  lines.push(
    k.expiringSoonBatches > 0
      ? `Истекает в ближайшие дни: ${k.expiringSoonBatches} парт. на ${formatMoneyWhole(k.expiringSoonValue)}`
      : 'Скоро истекающих партий нет',
  );
  lines.push(`В стоп-листе: ${k.stopListCount}, ниже минимума: ${k.lowStockCount}`);
  lines.push(`Под угрозой: ${formatMoneyWhole(k.atRiskValue)}`);
  const trace = await traceabilitySummary(deps, scope);
  if (trace.vsdPending > 0) {
    lines.push(trace.vsdOverdue > 0 ? `ВСД ждут погашения: ${trace.vsdPending}, просрочено: ${trace.vsdOverdue}` : `ВСД ждут погашения: ${trace.vsdPending}`);
  }

  const orders = await deps.db
    .selectFrom('purchase_orders')
    .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
    .where('status', 'in', ['draft', 'sent', 'partial'])
    .$if(scope !== null, (qb) => qb.where('location_id', 'in', scope?.length ? scope : ['00000000-0000-0000-0000-000000000000']))
    .groupBy('status')
    .execute();
  if (orders.length > 0) {
    const count = (statuses: string[]) => orders.filter((o) => statuses.includes(o.status)).reduce((s, o) => s + Number(o.n), 0);
    const parts = [count(['draft']) > 0 ? `черновиков ${count(['draft'])}` : null, count(['sent', 'partial']) > 0 ? `ждём поставку ${count(['sent', 'partial'])}` : null].filter(Boolean);
    lines.push(`Заказы поставщикам: ${parts.join(', ')}`);
  }

  const top = recs.filter((r) => r.type !== 'reorder').slice(0, 3);
  if (top.length > 0) {
    lines.push('', '<b>Что сделать в первую очередь</b>');
    for (const r of top) {
      const when = r.daysLeft !== null ? `, ${r.daysLeft < 0 ? 'просрочено' : `осталось ${daysWord(r.daysLeft)}`}` : '';
      lines.push(`• ${escapeHtml(r.productName)} (${escapeHtml(r.locationName)}): ${escapeHtml(r.headline)}${when}`);
    }
  }
  return lines.join('\n');
}

export async function sendDigest(deps: Deps): Promise<void> {
  await deps.notifier.send(await buildDigest(deps));
}

