import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import styles from './Button.module.scss';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid';

interface Common {
  variant?: Variant;
  size?: 'md' | 'sm';
  icon?: ReactNode;
  loading?: boolean;
}

function cls(variant: Variant, size: 'md' | 'sm', extra?: string): string {
  return [styles.btn, styles[variant], size === 'sm' ? styles.sm : '', extra ?? ''].filter(Boolean).join(' ');
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} type={type} className={cls(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

/** Обычная ссылка, оформленная как кнопка: для адресов вне приложения, открывается в новой вкладке. */
export function ExternalButton({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className,
  ...rest
}: Omit<Common, 'loading'> & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a target="_blank" rel="noopener noreferrer" {...rest} className={cls(variant, size, className)}>
      {icon}
      {children}
    </a>
  );
}

export function LinkButton({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className,
  ...rest
}: Omit<Common, 'loading'> & LinkProps) {
  return (
    <Link {...rest} className={cls(variant, size, className)}>
      {icon}
      {children}
    </Link>
  );
}
