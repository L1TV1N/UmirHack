import { STATUS_TONES } from '../../../src/types';

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <span className={`badge ${STATUS_TONES[status] ?? 'muted'}`}>{label}</span>;
}

export function Loading({ error, loading, children }: { error: string | null; loading: boolean; children?: React.ReactNode }) {
  if (error) return <div className="alert" role="alert">{error}</div>;
  if (loading) return <p className="muted">Загрузка…</p>;
  return <>{children}</>;
}
