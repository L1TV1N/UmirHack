import { ASSISTANT_QUESTION_MAX, askBody, type AssistantAnswerDto, type AssistantStatusDto } from '@zapas/shared';
import { Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Input } from '../../components/Controls/Controls';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { errorMessage } from '../../lib/errors';
import styles from './AssistantPage.module.scss';

interface Turn {
  id: number;
  question: string;
  answer?: AssistantAnswerDto;
  error?: string;
}

let turnSeq = 0;

export function AnswerCard({ answer, onAsk }: { answer: AssistantAnswerDto; onAsk: (q: string) => void }) {
  return (
    <div className={styles.answer}>
      <header>
        <strong>{answer.title}</strong>
        {answer.planner !== 'none' && (
          <Chip tone="neutral" title={answer.planner === 'model' ? 'Вопрос разобрала модель GigaChat, ответ собран из данных системы' : 'Вопрос разобран по ключевым словам, ответ собран из данных системы'}>
            {answer.planner === 'model' ? 'GigaChat выбрал запрос' : 'По ключевым словам'}
          </Chip>
        )}
      </header>
      {answer.lines.length > 0 && (
        <ul>
          {answer.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {answer.link && (
        <Link className={styles.link} to={answer.link.path}>
          {answer.link.label}
        </Link>
      )}
      {answer.suggestions.length > 0 && (
        <div className={styles.suggest}>
          {answer.suggestions.map((s) => (
            <button key={s} type="button" onClick={() => onAsk(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Помощник: вопрос своими словами. Он только читает данные и отвечает тем, что нашёл в системе. */
export default function AssistantPage() {
  const scope = useScope();
  const status = useGet<AssistantStatusDto>('/assistant/status', undefined, { staleTime: 5 * 60_000 });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const run = useAction((body: object) => post<AssistantAnswerDto>('/assistant/ask', body));

  useEffect(() => {
    document.title = 'Помощник - Запас';
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [turns]);

  const send = (question: string) => {
    const parsed = askBody.safeParse({ question, ...(scope.locationId ? { locationId: scope.locationId } : {}) });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Проверьте вопрос');
      return;
    }
    setError(null);
    const id = (turnSeq += 1);
    setTurns((t) => [...t, { id, question: parsed.data.question }]);
    setText('');
    run.mutate(parsed.data, {
      onSuccess: (answer) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, answer } : x))),
      onError: (err) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: errorMessage(err) } : x))),
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(text);
  };

  return (
    <>
      <PageHeader title="Помощник" subtitle="Спросите своими словами про остатки, сроки, стоп-лист, горячие блюда и заказы. Помощник только читает данные: ничего не списывает и не меняет." />
      <Panel padded title={scope.selected ? `Вопросы про «${scope.selected.name}»` : 'Вопросы'}>
        <div className={styles.thread} aria-live="polite">
          {turns.length === 0 && (
            <div className={styles.empty}>
              <p>Например:</p>
              <div className={styles.suggest}>
                {(status.data?.examples ?? []).map((q) => (
                  <button key={q} type="button" onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className={styles.turn}>
              <p className={styles.question}>{t.question}</p>
              {t.answer ? (
                <AnswerCard answer={t.answer} onAsk={send} />
              ) : t.error ? (
                <p className={styles.fail} role="alert">
                  {t.error}
                </p>
              ) : (
                <p className={styles.wait}>Ищу в данных...</p>
              )}
            </div>
          ))}
          <div ref={end} />
        </div>
        <form className={styles.form} onSubmit={submit}>
          <Input value={text} maxLength={ASSISTANT_QUESTION_MAX} onChange={(e) => setText(e.target.value)} placeholder="Что в стоп-листе? Сколько осталось молока?" aria-label="Вопрос помощнику" />
          <Button variant="primary" type="submit" icon={<Send size={15} />} loading={run.isPending}>
            Спросить
          </Button>
        </form>
        {error && (
          <p className={styles.fail} role="alert">
            {error}
          </p>
        )}
      </Panel>
    </>
  );
}
