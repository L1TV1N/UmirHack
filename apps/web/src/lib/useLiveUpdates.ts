import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { STOCK_PREFIXES } from '../api/hooks';
import { connectLive } from '../api/live';

/** Что перечитывается, когда сервер сообщил об изменениях. */
const LIVE_PREFIXES = [...STOCK_PREFIXES, '/orders'];
/** Несколько сигналов подряд обновляют данные один раз. */
const REFRESH_DELAY_MS = 250;

/** Подписывает интерфейс на изменения данных: остатки, стоп-лист, рекомендации обновляются без перезагрузки страницы. */
export function useLiveUpdates(): { live: boolean } {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && LIVE_PREFIXES.some((p) => (q.queryKey[0] as string).startsWith(p)) });
      }, REFRESH_DELAY_MS);
    };
    const stop = connectLive({ onChange: refresh, onState: setLive });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [qc]);

  return { live };
}
