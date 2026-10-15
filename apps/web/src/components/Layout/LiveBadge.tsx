import styles from './Layout.module.scss';

/** Тексты индикатора вынесены, чтобы подсказка не расходилась с тем, как данные обновляются на самом деле. */
export const LIVE_ON_HINT = 'Сервер сам сообщает об изменениях: остатки, стоп-лист и заказы обновляются сразу';
export const LIVE_OFF_HINT = 'Живое обновление не подключено. Данные перечитываются, когда вы возвращаетесь на вкладку или открываете страницу, не чаще раза в 15 секунд. Соединение восстанавливается само.';

/** Индикатор «Обновляется сразу» в шапке: зелёный, пока открыт поток обновлений с сервера. */
export function LiveBadge({ live }: { live: boolean }) {
  return (
    <span className={`${styles.live} ${live ? styles.liveOn : ''}`} title={live ? LIVE_ON_HINT : LIVE_OFF_HINT} role="status">
      <i aria-hidden="true" />
      {live ? 'Обновляется сразу' : 'Без живого обновления'}
    </span>
  );
}
