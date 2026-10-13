import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { TeamMark } from './TeamMark';
import styles from './TeamBanner.module.scss';

export const TEAM_NAME = 'CyberPink228';

interface Message {
  title: string;
  text: string;
}

/** Страницы, на которых всплывает баннер, и что он говорит. На остальных страницах баннера нет, чтобы не мешать работе. */
export const BANNERS: Record<string, Message> = {
  '/': { title: TEAM_NAME, text: 'Мы сделали «Запас» на UmirHack III для кейса «Флагман». Следим, чтобы продукты не пропадали.' },
  '/hot-dishes': { title: TEAM_NAME, text: 'Этот список считаем мы: что скоро истечёт, из чего можно приготовить и сколько порций надо продать.' },
  '/recommendations': { title: TEAM_NAME, text: 'Прогноз проверяем на прошлых днях и сравниваем с обычным средним. Цифры выше.' },
  '/suppliers': { title: TEAM_NAME, text: 'Оценка поставщика складывается из полноты, сроков, свежести и потерь. Формула в «Как считается».' },
  '/guide': { title: TEAM_NAME, text: 'Руководство писали мы. Нашли пробел или неточность, скажите нам на защите.' },
};

const DELAY_MS = 1600;
const storeKey = (path: string) => `zapas.banner.${path}`;

function dismissed(path: string): boolean {
  try {
    return sessionStorage.getItem(storeKey(path)) === '1';
  } catch {
    return false;
  }
}

/** Всплывающая карточка про команду: появляется через полторы секунды после открытия страницы и закрывается крестиком. */
export function TeamBanner() {
  const { pathname } = useLocation();
  const message = BANNERS[pathname];
  const [shownFor, setShownFor] = useState<string | null>(null);

  useEffect(() => {
    setShownFor(null);
    if (!message || dismissed(pathname)) return;
    const timer = window.setTimeout(() => setShownFor(pathname), DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pathname, message]);

  if (!message || shownFor !== pathname) return null;

  const close = () => {
    try {
      sessionStorage.setItem(storeKey(pathname), '1');
    } catch {
      /* без хранилища баннер вернётся при следующем заходе на страницу */
    }
    setShownFor(null);
  };

  return (
    <aside className={styles.banner} role="status" aria-live="polite" aria-label={`Сообщение от команды ${TEAM_NAME}`}>
      <TeamMark size={36} />
      <div className={styles.body}>
        <strong>{message.title}</strong>
        <p>{message.text}</p>
      </div>
      <button type="button" className={styles.close} onClick={close} aria-label="Закрыть сообщение">
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
