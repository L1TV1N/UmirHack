import { CircleHelp } from 'lucide-react';
import { useState } from 'react';
import { Link, useInRouterContext, useLocation } from 'react-router';
import { sectionForPath, type HelpSection } from '../../help/content';
import { Dialog } from '../Dialog/Dialog';
import styles from './Help.module.scss';

/** Окно с пояснением раздела и ссылкой на соответствующее место руководства. */
export function HelpDialog({ section, open, onClose }: { section: HelpSection; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={section.title} subtitle="Справка по разделу" width={560}>
      <div className={styles.body}>
        <p className={styles.what}>{section.popup.what}</p>
        <h3>Как пользоваться</h3>
        <ol>
          {section.popup.how.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <Link className={styles.more} to={`/guide#${section.id}`} onClick={onClose}>
          Подробнее в руководстве
        </Link>
      </div>
    </Dialog>
  );
}

function Inner() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const section = sectionForPath(pathname);
  if (!section) return null;
  return (
    <>
      <button type="button" className={styles.button} onClick={() => setOpen(true)} aria-label={`Справка: ${section.title}`} title="Что это и как пользоваться">
        <CircleHelp size={18} aria-hidden="true" />
      </button>
      <HelpDialog section={section} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Круглая кнопка «?» рядом с заголовком страницы. Вне маршрутизатора (в тестах отдельных панелей) ничего не рисует. */
export function HelpButton() {
  return useInRouterContext() ? <Inner /> : null;
}
