import { z } from 'zod';
import { hasForbiddenChars } from './schemas';

export const ASSISTANT_QUESTION_MAX = 300;

export const askBody = z.strictObject({
  question: z
    .string()
    .trim()
    .min(2, 'Задайте вопрос подробнее')
    .max(ASSISTANT_QUESTION_MAX, `Вопрос не длиннее ${ASSISTANT_QUESTION_MAX} знаков`)
    .refine((v) => !hasForbiddenChars(v.replace(/\n/g, ' ')), 'Недопустимые символы'),
  /** Если задана, вопрос относится к этой точке, иначе ко всем доступным. */
  locationId: z.uuid().optional(),
});
export type AskBody = z.infer<typeof askBody>;

/** Кто разобрал вопрос: модель, простые правила или никто (вопрос не понят). */
export type AssistantPlanner = 'model' | 'rules' | 'none';

export interface AssistantAnswerDto {
  question: string;
  /** Какой готовый запрос к данным выполнен. null: вопрос не понят. */
  intent: string | null;
  planner: AssistantPlanner;
  title: string;
  /** Строки собраны из данных системы, модель текст ответа не пишет. */
  lines: string[];
  link: { path: string; label: string } | null;
  /** Что можно спросить дальше. */
  suggestions: string[];
}

export interface AssistantStatusDto {
  /** Вопросы разбирает GigaChat. Без него работают простые правила по ключевым словам. */
  model: boolean;
  examples: string[];
}
