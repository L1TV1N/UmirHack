import { z } from 'zod';

// Вход администратора с подтверждением кодом из Telegram

export const TWO_FACTOR_CODE_LENGTH = 6;
export const TWO_FACTOR_TTL_SECONDS = 300;
export const TWO_FACTOR_MAX_ATTEMPTS = 5;
export const TWO_FACTOR_RESEND_SECONDS = 30;
export const TWO_FACTOR_MAX_SENDS = 3;
export const RECOVERY_CODE_COUNT = 8;
/** Без похожих знаков (0 и O, 1 и I): код переписывают с бумаги. */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_LENGTH = 10;

/** Код вводят руками: пробелы, дефисы и регистр не должны мешать. */
export function normalizeSecondFactor(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

export const looksLikeOneTimeCode = (value: string): boolean => /^\d{6}$/.test(value);
export const looksLikeRecoveryCode = (value: string): boolean =>
  value.length === RECOVERY_CODE_LENGTH && [...value].every((ch) => RECOVERY_ALPHABET.includes(ch));

/** Резервный код для показа: две группы по пять знаков. */
export const formatRecoveryCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`;

const challengeId = z.uuid();
const code = z.string().trim().min(1).max(24);

export const twoFactorVerifyBody = z.strictObject({ challengeId, code });
export type TwoFactorVerifyBody = z.infer<typeof twoFactorVerifyBody>;

export const twoFactorResendBody = z.strictObject({ challengeId });
export type TwoFactorResendBody = z.infer<typeof twoFactorResendBody>;

export const TWO_FACTOR_PURPOSES = ['enable', 'disable', 'recovery'] as const;
export type TwoFactorPurpose = (typeof TWO_FACTOR_PURPOSES)[number];

/** Начало включения, выключения или выпуска новых резервных кодов. Выключение и выпуск требуют пароль. */
export const twoFactorStartBody = z.strictObject({
  purpose: z.enum(TWO_FACTOR_PURPOSES),
  password: z.string().max(200).optional(),
});
export type TwoFactorStartBody = z.infer<typeof twoFactorStartBody>;

/** Вход не завершён: нужен код из Telegram или резервный код. */
export interface TwoFactorChallengeDto {
  twoFactorRequired: true;
  challengeId: string;
  /** Код ушёл в чат. Если нет, остаётся резервный код. */
  delivered: boolean;
  expiresIn: number;
  resendAfter: number;
}

export interface TwoFactorStatusDto {
  /** Роль позволяет включить защиту (сейчас это администратор). */
  eligible: boolean;
  /** Бот Telegram настроен на сервере. */
  botConfigured: boolean;
  telegramLinked: boolean;
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export interface TwoFactorStartDto {
  challengeId: string;
  /** Код ушёл в чат. Если нет, подтвердить выключение можно резервным кодом. */
  delivered: boolean;
  expiresIn: number;
  resendAfter: number;
}

export interface TwoFactorConfirmDto {
  enabled: boolean;
  /** Новые резервные коды: показываются один раз. */
  recoveryCodes: string[] | null;
}
