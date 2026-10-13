import { CornerDownLeft, Moon, Palette, Sparkles, Sun } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { HELP } from '../../help/content';
import { useTheme, type Theme } from '../../lib/theme';
import { useUiMode } from '../../lib/uiMode';
import { GROUPS } from '../Layout/AppLayout';
import styles from './CommandPalette.module.scss';

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ComponentType<{ size?: number }>;
  run: () => void;
}

const THEME_ICON: Record<Theme, ComponentType<{ size?: number }>> = { light: Sun, dark: Moon, colorful: Palette };
const THEME_LABEL: Record<Theme, string> = { light: 'Светлая тема', dark: 'Тёмная тема', colorful: 'Разноцветная тема' };

/** Быстрый переход по Ctrl+K: разделы системы, статьи руководства, смена темы и вида интерфейса. */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { setTheme } = useTheme();
  const { setMode } = useUiMode();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    const pages = GROUPS.flatMap((g) => g.items.filter((i) => !i.min || can(i.min)).map((i): Command => ({ id: `page:${i.to}`, group: 'Разделы', label: i.label, hint: g.title, icon: i.icon, run: go(i.to) })));
    const guide = HELP.map((s): Command => ({ id: `help:${s.id}`, group: 'Руководство', label: s.title, hint: `Руководство, ${s.group}`, icon: Sparkles, run: go(`/guide#${s.id}`) }));
    const themes = (['light', 'dark', 'colorful'] as Theme[]).map((t): Command => ({ id: `theme:${t}`, group: 'Оформление', label: THEME_LABEL[t], icon: THEME_ICON[t], run: () => { setTheme(t); onClose(); } }));
    const ui: Command = { id: 'ui:basic', group: 'Оформление', label: 'Вернуть обычный интерфейс', hint: 'Лёгкий вид', icon: Sparkles, run: () => { setMode('basic'); onClose(); } };
    return [...pages, ...guide, ...themes, ui];
  }, [can, navigate, onClose, setMode, setTheme]);

  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.filter((c) => c.group === 'Разделы' || c.group === 'Оформление');
    return commands.filter((c) => `${c.label} ${c.hint ?? ''} ${c.group}`.toLowerCase().includes(q)).slice(0, 30);
  }, [commands, query]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(found.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      found[cursor]?.run();
    }
  };

  return createPortal(
    <dialog ref={ref} className={styles.palette} aria-label="Быстрый переход" onClose={onClose} onCancel={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className={styles.box}>
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={found[cursor] ? `palette-${found[cursor]?.id}` : undefined}
          placeholder="Куда перейти или что сделать"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <ul id="palette-list" role="listbox" ref={list}>
          {found.length === 0 && <li className={styles.empty}>Ничего не нашлось</li>}
          {found.map((c, i) => (
            <li key={c.id} id={`palette-${c.id}`} role="option" aria-selected={i === cursor} className={i === cursor ? styles.active : undefined} onMouseMove={() => setCursor(i)} onClick={c.run}>
              <c.icon size={16} />
              <span>{c.label}</span>
              <small>{c.hint ?? c.group}</small>
              {i === cursor && <CornerDownLeft size={14} className={styles.enter} aria-hidden="true" />}
            </li>
          ))}
        </ul>
        <footer>
          <kbd>↑</kbd> <kbd>↓</kbd> выбор <kbd>Enter</kbd> открыть <kbd>Esc</kbd> закрыть
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
