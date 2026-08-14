import type { ReactNode } from 'react';
import { useEffect } from 'react';

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:opacity-90 border-transparent',
  default: 'bg-surface text-ink hover:bg-canvas border-line',
  ghost: 'bg-transparent text-muted hover:text-ink hover:bg-surface border-transparent',
  danger: 'bg-transparent text-red-600 hover:bg-red-500/10 border-line dark:text-red-400',
};

export function Button({
  children,
  variant = 'default',
  size = 'md',
  ...props
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const sizing = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';

  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-md border font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${BUTTON_STYLES[variant]} ${props.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-line bg-surface ${className}`}>{children}</div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'red' | 'amber' | 'blue' | 'purple';
}) {
  const tones = {
    neutral: 'bg-canvas text-muted border-line',
    green: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/25 dark:text-emerald-300',
    red: 'bg-red-500/10 text-red-700 border-red-500/25 dark:text-red-300',
    amber: 'bg-amber-500/10 text-amber-700 border-amber-500/25 dark:text-amber-300',
    blue: 'bg-blue-500/10 text-blue-700 border-blue-500/25 dark:text-blue-300',
    purple: 'bg-purple-500/10 text-purple-700 border-purple-500/25 dark:text-purple-300',
  };

  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Maps every run/step status to a consistent colour used across the app. */
export function statusTone(status: string): 'neutral' | 'green' | 'red' | 'amber' | 'blue' | 'purple' {
  switch (status) {
    case 'passed':
      return 'green';
    case 'failed':
      return 'red';
    case 'soft-failed':
      return 'amber';
    case 'healed':
      return 'purple';
    case 'running':
    case 'queued':
      return 'blue';
    default:
      return 'neutral';
  }
}

export function StatusIcon({ status }: { status: string }) {
  const map: Record<string, string> = {
    passed: '✓',
    failed: '✗',
    'soft-failed': '!',
    healed: '⤳',
    skipped: '·',
    running: '◐',
    queued: '◌',
    aborted: '■',
    pending: '·',
  };

  const colours: Record<string, string> = {
    passed: 'text-emerald-600 dark:text-emerald-400',
    failed: 'text-red-600 dark:text-red-400',
    'soft-failed': 'text-amber-600 dark:text-amber-400',
    healed: 'text-purple-600 dark:text-purple-400',
    running: 'text-blue-600 dark:text-blue-400 animate-pulse',
  };

  return (
    <span className={`inline-block w-4 text-center font-bold ${colours[status] ?? 'text-muted'}`}>
      {map[status] ?? '·'}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

const INPUT_CLASS =
  'w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-sm text-ink outline-none focus:border-brand';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${INPUT_CLASS} ${props.className ?? ''}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${INPUT_CLASS} font-mono ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${INPUT_CLASS} ${props.className ?? ''}`} />;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
      <Card className={`w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} shadow-xl`}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </Card>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="px-1 py-6 text-sm text-muted">{label}</p>;
}
