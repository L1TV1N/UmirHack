import { Download } from 'lucide-react';
import { useState } from 'react';
import { downloadFile, type Query } from '../../api/client';
import { errorMessage } from '../../lib/errors';
import { Button } from '../Button/Button';
import { useToast } from '../Toast/Toast';

/** Кнопка выгрузки отчёта в CSV: скачивает файл с сервера, ошибку показывает сообщением. */
export function ExportButton({ path, query, filename, label = 'Скачать CSV' }: { path: string; query?: Query; filename: string; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await downloadFile(path, query, filename);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size="sm" icon={<Download size={14} />} loading={busy} onClick={() => void run()} title="Выгрузка в CSV для Excel">
      {label}
    </Button>
  );
}
