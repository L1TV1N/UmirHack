import { changePasswordBody } from '@zapas/shared';
import { useState, type FormEvent } from 'react';
import { ApiError, post } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../Button/Button';
import { Field, Input } from '../Controls/Controls';
import { Dialog } from '../Dialog/Dialog';
import { useToast } from '../Toast/Toast';

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { logout } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setErrors({});
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = changePasswordBody.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) {
      const out: Record<string, string> = {};
      for (const issue of parsed.error.issues) out[issue.path.join('.')] ??= issue.message;
      setErrors(out);
      return;
    }
    setBusy(true);
    try {
      await post('/auth/change-password', parsed.data);
      toast.success('Пароль изменён. Войдите снова.');
      reset();
      onClose();
      await logout();
    } catch (err) {
      if (err instanceof ApiError) setErrors({ ...err.fieldErrors(), ...(Object.keys(err.fieldErrors()).length ? {} : { currentPassword: err.message }) });
      else toast.error('Не удалось сменить пароль');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Смена пароля"
      subtitle="После смены все устройства потребуют войти заново"
      width={440}
      footer={
        <>
          <Button onClick={close}>Отмена</Button>
          <Button variant="primary" type="submit" form="change-password" loading={busy}>
            Сменить пароль
          </Button>
        </>
      }
    >
      <form id="change-password" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Текущий пароль" error={errors.currentPassword} required>
          {(p) => <Input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field label="Новый пароль" hint="Не короче 10 символов. Лучше фраза из нескольких слов." error={errors.newPassword} required>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
