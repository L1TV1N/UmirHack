import { describe, expect, it } from 'vitest';
import { createWebhookBody, importBody, updateWebhookBody, webhookUrl } from './integrations';

describe('webhookUrl', () => {
  it('принимает обычные адреса', () => {
    for (const v of ['https://example.ru/hook', 'http://10.0.0.5:8080/a?b=1', 'https://hooks.example.com']) {
      expect(webhookUrl.safeParse(v).success, v).toBe(true);
    }
  });
  it('отклоняет чужие схемы, логин в адресе, пробелы и фрагменты', () => {
    for (const v of ['ftp://example.ru/x', 'javascript:alert(1)', 'https://user:pass@example.ru/', 'https://example.ru/#frag', 'https://exa mple.ru/', 'example.ru/hook', 'https://', 'https://example.ru/‮a', 'file:///etc/passwd']) {
      expect(webhookUrl.safeParse(v).success, v).toBe(false);
    }
  });
});

describe('createWebhookBody', () => {
  const ok = { name: 'Доставка', url: 'https://example.ru/hook', events: ['stoplist.changed'] };
  it('нужны название, адрес и хотя бы одно событие', () => {
    expect(createWebhookBody.safeParse(ok).success).toBe(true);
    expect(createWebhookBody.safeParse({ ...ok, events: [] }).success).toBe(false);
    expect(createWebhookBody.safeParse({ ...ok, events: ['stoplist.changed', 'stoplist.changed'] }).success).toBe(false);
    expect(createWebhookBody.safeParse({ ...ok, events: ['ping'] }).success).toBe(false);
    expect(createWebhookBody.safeParse({ ...ok, name: '' }).success).toBe(false);
  });
  it('лишние поля не принимаются', () => {
    expect(createWebhookBody.safeParse({ ...ok, secret: 'x' }).success).toBe(false);
    expect(updateWebhookBody.safeParse({ failureStreak: 0 }).success).toBe(false);
  });
});

describe('importBody', () => {
  it('ограничивает размер файла', () => {
    expect(importBody.safeParse({ content: 'QQ==' }).success).toBe(true);
    expect(importBody.safeParse({ content: 'A'.repeat(3_000_000) }).success).toBe(false);
    expect(importBody.safeParse({ content: '' }).success).toBe(false);
  });
});
