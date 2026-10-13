import { ArrowLeft, ArrowRight, ArrowUp, ChevronDown, Link2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Dialog } from '../../components/Dialog/Dialog';
import { Input } from '../../components/Controls/Controls';
import { PageHeader } from '../../components/Panel/Panel';
import { GUIDE_GROUPS, HELP, type Block, type HelpSection } from '../../help/content';
import { SHOTS } from '../../help/shots';
import styles from './Guide.module.scss';

/** Снимок экрана с пронумерованными красными кружками и подписями к ним. Щелчок открывает его крупно в окне. */
function Shot({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const shot = SHOTS[id];
  if (!shot) return null;
  const src = `/help-img/${shot.id}.jpg`;
  return (
    <figure className={styles.shot}>
      <button type="button" className={styles.shotButton} onClick={() => onOpen(id)} aria-label={`${shot.alt}: открыть снимок крупно`}>
        <img src={src} alt={shot.alt} width={shot.width} height={shot.height} loading="lazy" decoding="async" />
      </button>
      <figcaption>
        <strong>{shot.alt}</strong>
        <ol>
          {shot.marks.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

function Blocks({ blocks, onOpen }: { blocks: Block[]; onOpen: (id: string) => void }) {
  return (
    <>
      {blocks.map((b, i) => {
        if ('h' in b) return <h3 key={i}>{b.h}</h3>;
        if ('p' in b) return <p key={i}>{b.p}</p>;
        if ('ul' in b) return <ul key={i}>{b.ul.map((x) => <li key={x}>{x}</li>)}</ul>;
        if ('ol' in b) return <ol key={i}>{b.ol.map((x) => <li key={x}>{x}</li>)}</ol>;
        if ('shots' in b) return <div key={i} className={styles.shots}>{b.shots.map((id) => <Shot key={id} id={id} onOpen={onOpen} />)}</div>;
        return <p key={i} className={styles.note}>{b.note}</p>;
      })}
    </>
  );
}

const blockText = (b: Block): string[] =>
  'h' in b ? [b.h] : 'p' in b ? [b.p] : 'ul' in b ? b.ul : 'ol' in b ? b.ol : 'note' in b ? [b.note] : b.shots.flatMap((id) => (SHOTS[id] ? [SHOTS[id].alt, ...SHOTS[id].marks] : []));

const text = (s: HelpSection): string => [s.title, s.popup.what, ...s.popup.how, ...s.guide.flatMap(blockText)].join(' ').toLowerCase();

/** Какой раздел сейчас на экране: ближайший заголовок, прошедший верхнюю четверть окна. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join('|');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || ids.length === 0) return;
    const seen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target.id);
          else seen.delete(e.target.id);
        }
        const first = ids.find((id) => seen.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '-70px 0px -65% 0px' },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // список разделов меняется только вместе с ключом
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
}

function useScrollState() {
  const [state, setState] = useState({ progress: 0, top: false });
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      setState({ progress: max > 0 ? Math.min(1, window.scrollY / max) : 0, top: window.scrollY > 700 });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return state;
}

export default function GuidePage() {
  const { hash } = useLocation();
  const [query, setQuery] = useState('');
  const [tocOpen, setTocOpen] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Руководство - Запас';
  }, []);

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    el?.scrollIntoView({ block: 'start' });
  }, [hash]);

  // «/» переводит в поиск, как на привычных сайтах документации
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      e.preventDefault();
      setTocOpen(true);
      search.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? HELP.filter((s) => text(s).includes(q)) : HELP), [q]);
  const active = useActiveSection(useMemo(() => visible.map((s) => s.id), [visible]));
  const { progress, top } = useScrollState();

  const copyLink = async (id: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/guide#${id}`);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1600);
    } catch {
      /* без доступа к буферу ссылку можно взять из адресной строки */
    }
  };

  const zoomShot = zoom ? SHOTS[zoom] : undefined;

  return (
    <>
      <div className={styles.progress} aria-hidden="true">
        <i style={{ transform: `scaleX(${progress})` }} />
      </div>
      <PageHeader title="Руководство пользователя" subtitle="Как пользоваться системой и как устроены расчёты. У каждого раздела есть кнопка «?» рядом с заголовком, она открывает краткую справку со ссылкой сюда." />
      <button type="button" className={styles.tocToggle} aria-expanded={tocOpen} onClick={() => setTocOpen((v) => !v)}>
        Содержание
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div className={styles.layout}>
        <nav className={`${styles.toc} ${tocOpen ? styles.tocOpen : ''}`} aria-label="Содержание">
          <div className={styles.search}>
            <Input ref={search} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти в руководстве" aria-label="Поиск по руководству" />
            {query && (
              <button type="button" className={styles.clear} onClick={() => setQuery('')} aria-label="Очистить поиск">
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={styles.count} aria-live="polite">
            {q ? `Найдено разделов: ${visible.length}` : `Разделов: ${HELP.length}. Клавиша «/» ставит курсор в поиск`}
          </div>
          {GUIDE_GROUPS.map((g) => {
            const items = visible.filter((s) => s.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g}>
                <div className={styles.group}>{g}</div>
                <ul>
                  {items.map((s) => (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        className={active === s.id ? styles.current : undefined}
                        aria-current={active === s.id ? 'location' : undefined}
                        onClick={() => {
                          document.getElementById(s.id)?.scrollIntoView();
                          setTocOpen(false);
                        }}
                      >
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className={styles.content}>
          {visible.length === 0 && <p className="muted">Ничего не нашлось. Попробуйте другое слово.</p>}
          {visible.map((s, i) => {
            const prev = visible[i - 1];
            const next = visible[i + 1];
            return (
              <section key={s.id} id={s.id} className={styles.section}>
                <div className={styles.heading}>
                  <h2>{s.title}</h2>
                  <button type="button" className={styles.anchor} onClick={() => void copyLink(s.id)} aria-label={`Скопировать ссылку на раздел «${s.title}»`} title="Скопировать ссылку на раздел">
                    <Link2 size={15} aria-hidden="true" />
                    {copied === s.id && <span>Ссылка скопирована</span>}
                  </button>
                </div>
                <p className={styles.lead}>{s.popup.what}</p>
                <Blocks blocks={s.guide} onOpen={setZoom} />
                {s.path && (
                  <p>
                    <Link to={s.path}>Открыть раздел</Link>
                  </p>
                )}
                {(prev || next) && (
                  <div className={styles.pager}>
                    {prev ? (
                      <a href={`#${prev.id}`} onClick={() => document.getElementById(prev.id)?.scrollIntoView()}>
                        <ArrowLeft size={14} aria-hidden="true" />
                        {prev.title}
                      </a>
                    ) : (
                      <span />
                    )}
                    {next && (
                      <a href={`#${next.id}`} onClick={() => document.getElementById(next.id)?.scrollIntoView()}>
                        {next.title}
                        <ArrowRight size={14} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      {top && (
        <button type="button" className={styles.up} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Наверх">
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      )}
      <Dialog open={zoomShot !== undefined} onClose={() => setZoom(null)} title={zoomShot?.alt ?? 'Снимок'} subtitle="Номера на снимке совпадают с подписями под ним" width={1180}>
        {zoomShot && (
          <div className={styles.zoom}>
            <img src={`/help-img/${zoomShot.id}.jpg`} alt={zoomShot.alt} />
            <ol>
              {zoomShot.marks.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ol>
          </div>
        )}
      </Dialog>
    </>
  );
}
