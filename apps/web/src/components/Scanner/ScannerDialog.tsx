import { Flashlight, Keyboard } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { beep } from '../../lib/feedback';
import { Button } from '../Button/Button';
import { Input } from '../Controls/Controls';
import { Dialog } from '../Dialog/Dialog';
import { createDecoder, type Decoder } from './decoder';
import styles from './Scanner.module.scss';

export interface ScanFeedback {
  ok: boolean;
  message: string;
  /** Закрыть окно после этого кода (например, чтобы ввести вес вручную). */
  close?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Что сделать с кодом. Ответ показывается под камерой. */
  onCode: (raw: string) => Promise<ScanFeedback> | ScanFeedback;
  title?: string;
  hint?: string;
}

interface LogLine extends ScanFeedback {
  id: number;
}

// Код считается один раз, пока он в кадре. Снова его считаем, когда он пропадал из кадра хотя бы на столько
const CODE_GONE_MS = 700;
const FRAME_PAUSE_MS = 140;
// ввод со сканера-«клавиатуры»: символы идут подряд с паузой меньше этой
const WEDGE_GAP_MS = 80;

function cameraProblem(): string | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return window.isSecureContext
      ? 'Этот браузер не умеет работать с камерой.'
      : 'Камера работает только на защищённом адресе (https) или на localhost. Можно ввести код вручную или отсканировать USB-сканером.';
  }
  return null;
}

function describeError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Доступ к камере закрыт. Разрешите его для этого сайта в настройках браузера.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена.';
  if (name === 'NotReadableError') return 'Камеру занимает другое приложение.';
  return 'Не удалось включить камеру.';
}

export function ScannerDialog({ open, onClose, onCode, title = 'Сканирование', hint }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const [state, setState] = useState<'starting' | 'live' | 'error'>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [manual, setManual] = useState(false);
  const [text, setText] = useState('');
  const [torch, setTorch] = useState<{ available: boolean; on: boolean }>({ available: false, on: false });
  const track = useRef<MediaStreamTrack | null>(null);
  const seq = useRef(0);
  const busy = useRef(false);
  const last = useRef({ raw: '', seenAt: 0 });

  const handle = async (raw: string, from: 'camera' | 'manual' | 'wedge') => {
    const value = raw.trim();
    if (!value || busy.current) return;
    const now = Date.now();
    // Камера видит один и тот же код в каждом кадре, пока его держат перед ней: это один скан, а не десять.
    // Ручной ввод и сканер-«клавиатура» присылают код по одному разу на каждую единицу товара, их не режем
    if (from === 'camera') {
      const same = value === last.current.raw && now - last.current.seenAt < CODE_GONE_MS;
      last.current = { raw: value, seenAt: now };
      if (same) return;
    }
    busy.current = true;
    try {
      const feedback = await onCodeRef.current(value);
      beep(feedback.ok);
      seq.current += 1;
      setLog((list) => [{ ...feedback, id: seq.current }, ...list].slice(0, 6));
      if (feedback.close) closeRef.current();
    } catch {
      beep(false);
      seq.current += 1;
      setLog((list) => [{ id: seq.current, ok: false, message: 'Не удалось обработать код' }, ...list].slice(0, 6));
    } finally {
      busy.current = false;
    }
  };
  const handleRef = useRef(handle);
  handleRef.current = handle;

  // камера и распознавание, пока окно открыто
  useEffect(() => {
    if (!open) return;
    setLog([]);
    setManual(false);
    setText('');
    setState('starting');
    setProblem(null);
    const unsupported = cameraProblem();
    if (unsupported) {
      setState('error');
      setProblem(unsupported);
      setManual(true);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let decoder: Decoder | null = null;
    let timer = 0;

    const loop = async () => {
      const el = video.current;
      if (cancelled || !el || !decoder) return;
      if (el.readyState >= 2 && !busy.current) {
        try {
          const raw = await decoder.decode(el);
          if (raw && !cancelled) await handleRef.current(raw, 'camera');
        } catch {
          // кадр не разобрался, берём следующий
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void loop(), FRAME_PAUSE_MS);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        await el.play();
        const t = stream.getVideoTracks()[0] ?? null;
        track.current = t;
        const caps = (t?.getCapabilities?.() ?? {}) as { torch?: boolean };
        setTorch({ available: Boolean(caps.torch), on: false });
        decoder = await createDecoder();
        if (cancelled) return;
        setState('live');
        void loop();
      } catch (err) {
        if (cancelled) return;
        setState('error');
        setProblem(describeError(err));
        setManual(true);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      decoder?.dispose();
      stream?.getTracks().forEach((t) => t.stop());
      track.current = null;
      if (video.current) video.current.srcObject = null;
    };
  }, [open]);

  // сканер-«клавиатура» (USB или Bluetooth): быстрые символы и Enter, когда фокус не в поле ввода
  useEffect(() => {
    if (!open) return;
    let buffer = '';
    let lastAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const now = Date.now();
      if (now - lastAt > WEDGE_GAP_MS) buffer = '';
      lastAt = now;
      if (e.key === 'Enter') {
        if (buffer.length >= 6) {
          e.preventDefault();
          void handleRef.current(buffer, 'wedge');
        }
        buffer = '';
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        buffer += e.key;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const toggleTorch = async () => {
    const next = !torch.on;
    try {
      await track.current?.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch({ available: true, on: next });
    } catch {
      setTorch({ available: false, on: false });
    }
  };

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    // окно лежит в дереве формы прихода: её обработчик отправки сюда не относится
    e.stopPropagation();
    void handle(text, 'manual');
    setText('');
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} subtitle={hint ?? 'Наведите камеру на штрихкод или код «Честного знака»'} width={520} footer={<Button onClick={onClose}>Готово</Button>}>
      <div className={styles.stack}>
        {state !== 'error' && (
          <div className={styles.viewport}>
            <video ref={video} className={styles.video} muted playsInline aria-label="Изображение с камеры" />
            <div className={styles.frame} aria-hidden="true" />
            {state === 'starting' && <div className={styles.overlay}>Включаем камеру…</div>}
          </div>
        )}
        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}

        <div className={styles.tools}>
          {torch.available && (
            <Button size="sm" icon={<Flashlight size={15} />} onClick={() => void toggleTorch()} aria-pressed={torch.on}>
              {torch.on ? 'Выключить фонарик' : 'Фонарик'}
            </Button>
          )}
          {!manual && (
            <Button size="sm" icon={<Keyboard size={15} />} onClick={() => setManual(true)}>
              Ввести код вручную
            </Button>
          )}
        </div>

        {manual && (
          <form className={styles.manual} onSubmit={submitManual}>
            <Input value={text} onChange={(e) => setText(e.target.value)} inputMode="text" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Цифры штрихкода или код целиком" aria-label="Код вручную" data-autofocus="" />
            <Button type="submit" variant="primary" disabled={!text.trim()}>
              Добавить
            </Button>
          </form>
        )}

        <ul className={styles.log} aria-live="polite" aria-label="Результаты сканирования">
          {log.length === 0 && <li className={styles.empty}>Пока ничего не отсканировано. USB-сканер тоже работает: просто сканируйте.</li>}
          {log.map((line, i) => (
            <li key={line.id} className={`${line.ok ? styles.ok : styles.bad} ${i === 0 ? styles.latest : ''}`}>
              {line.message}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
