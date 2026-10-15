import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AssistantAnswerDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();

vi.mock('../../api/client', () => ({ post: (...a: unknown[]) => post(...a), ApiError: class ApiError extends Error {} }));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ locationId: '33333333-3333-4333-8333-333333333333', selected: { name: 'Кухня «Набережная»' } }) }));
vi.mock('../../api/hooks', () => ({
  useGet: () => ({ data: { model: true, examples: ['Что в стоп-листе?', 'Сколько осталось молока?'] } }),
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));

import AssistantPage from './AssistantPage';

const answer = (over: Partial<AssistantAnswerDto> = {}): AssistantAnswerDto => ({
  question: 'Что в стоп-листе?',
  intent: 'stop_list',
  planner: 'model',
  title: 'В стоп-листе 2 позиции',
  lines: ['Борщ: Не хватает: Свёкла', 'Паста: Нет в наличии'],
  link: { path: '/stop-list', label: 'Открыть стоп-лист' },
  suggestions: ['Что скоро закончится?'],
  ...over,
});

const show = () =>
  render(
    <MemoryRouter>
      <AssistantPage />
    </MemoryRouter>,
  );
const field = () => screen.getByLabelText('Вопрос помощнику') as HTMLInputElement;

beforeEach(() => post.mockReset());
afterEach(cleanup);

describe('страница помощника', () => {
  it('показывает примеры из статуса, без надписи о том, кто разбирает вопросы', () => {
    show();
    expect(screen.queryByText('Разбирает GigaChat')).toBeNull();
    expect(screen.getByRole('button', { name: 'Сколько осталось молока?' })).toBeTruthy();
  });

  it('отправляет вопрос с выбранной точкой и показывает ответ со ссылкой и подсказками', async () => {
    post.mockResolvedValue(answer());
    show();
    fireEvent.change(field(), { target: { value: '  Что в стоп-листе?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/assistant/ask', { question: 'Что в стоп-листе?', locationId: '33333333-3333-4333-8333-333333333333' }));
    expect(await screen.findByText('В стоп-листе 2 позиции')).toBeTruthy();
    expect(screen.getByText('Борщ: Не хватает: Свёкла')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Открыть стоп-лист' }).getAttribute('href')).toBe('/stop-list');
    expect(screen.getByText('GigaChat выбрал запрос')).toBeTruthy();
    expect(field().value).toBe('');
  });

  it('нажатие на подсказку задаёт этот вопрос', async () => {
    post.mockResolvedValue(answer({ planner: 'rules', title: 'Скоро закончатся: 1' }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Что в стоп-листе?' }));
    await waitFor(() => expect(post.mock.calls[0]?.[1]).toMatchObject({ question: 'Что в стоп-листе?' }));
    expect(await screen.findByText('По ключевым словам')).toBeTruthy();
  });

  it('слишком короткий и слишком длинный вопрос не уходят на сервер', () => {
    show();
    fireEvent.change(field(), { target: { value: 'я' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(screen.getByRole('alert').textContent).toMatch(/подробнее/);
    expect(post).not.toHaveBeenCalled();
  });

  it('ошибка сервера показывается рядом с вопросом, остальные вопросы остаются', async () => {
    post.mockRejectedValueOnce(new Error('Сервис недоступен')).mockResolvedValueOnce(answer({ title: 'Всё хорошо' }));
    show();
    fireEvent.change(field(), { target: { value: 'Что просрочено?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.change(field(), { target: { value: 'Дай сводку' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByText('Всё хорошо')).toBeTruthy();
    expect(screen.getByText('Что просрочено?')).toBeTruthy();
  });

  it('непонятый вопрос не помечается как разобранный', async () => {
    post.mockResolvedValue(answer({ intent: null, planner: 'none', title: 'Не понял вопрос', lines: [], link: null, suggestions: ['Что в стоп-листе?'] }));
    show();
    fireEvent.change(field(), { target: { value: 'расскажи анекдот' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByText('Не понял вопрос')).toBeTruthy();
    expect(screen.queryByText('GigaChat выбрал запрос')).toBeNull();
    expect(screen.queryByText('По ключевым словам')).toBeNull();
  });
});
