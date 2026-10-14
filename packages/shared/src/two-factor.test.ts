import { describe, expect, it } from 'vitest';
import {
  formatRecoveryCode,
  looksLikeOneTimeCode,
  looksLikeRecoveryCode,
  normalizeSecondFactor,
  RECOVERY_ALPHABET,
  twoFactorStartBody,
  twoFactorVerifyBody,
} from './two-factor';

const id = '11111111-1111-4111-8111-111111111111';

describe('второй фактор: коды', () => {
  it('убирает пробелы, дефисы и регистр', () => {
    expect(normalizeSecondFactor(' 123 456 ')).toBe('123456');
    expect(normalizeSecondFactor('abcde-fghjk')).toBe('ABCDEFGHJK');
  });

  it('узнаёт код из Telegram и резервный код, остальное нет', () => {
    expect(looksLikeOneTimeCode('123456')).toBe(true);
    expect(looksLikeOneTimeCode('12345')).toBe(false);
    expect(looksLikeOneTimeCode('12345a')).toBe(false);
    expect(looksLikeRecoveryCode('ABCDEFGHJK')).toBe(true);
    // в алфавите нет похожих знаков
    expect([...'0O1I'].some((ch) => RECOVERY_ALPHABET.includes(ch))).toBe(false);
    expect(looksLikeRecoveryCode('ABCDEFGHJ0')).toBe(false);
    expect(looksLikeRecoveryCode('ABCDEFGHJ')).toBe(false);
  });

  it('резервный код показывается двумя группами', () => {
    expect(formatRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });
});

describe('второй фактор: тела запросов', () => {
  it('проверка кода требует идентификатор запроса и непустой короткий код', () => {
    expect(twoFactorVerifyBody.safeParse({ challengeId: id, code: ' 123456 ' }).data?.code).toBe('123456');
    expect(twoFactorVerifyBody.safeParse({ challengeId: 'не uuid', code: '123456' }).success).toBe(false);
    expect(twoFactorVerifyBody.safeParse({ challengeId: id, code: '' }).success).toBe(false);
    expect(twoFactorVerifyBody.safeParse({ challengeId: id, code: 'x'.repeat(25) }).success).toBe(false);
    expect(twoFactorVerifyBody.safeParse({ challengeId: id, code: '123456', lastUserId: 'x' }).success).toBe(false);
  });

  it('начало: только известные назначения', () => {
    expect(twoFactorStartBody.safeParse({ purpose: 'enable' }).success).toBe(true);
    expect(twoFactorStartBody.safeParse({ purpose: 'disable', password: 'x' }).success).toBe(true);
    expect(twoFactorStartBody.safeParse({ purpose: 'login' }).success).toBe(false);
  });
});
