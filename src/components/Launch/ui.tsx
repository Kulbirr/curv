import type { ReactNode } from 'react';

/**
 * Shared launch-form primitives, styled against the Curv spec classes in
 * src/styles/curv-spec.css. Plain inputs inside a Field pick up the spec's
 * input styling automatically.
 */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  const cls = ['sc-builder-field', className, error ? 'sc-field-invalid' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <label className={cls} aria-invalid={error ? true : undefined}>
      <span>{label}</span>
      {children}
      {hint && !error && <small>{hint}</small>}
      {error && <span className="sc-form-error">{error}</span>}
    </label>
  );
}

export function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="sc-form-error" role="alert">
      <ul>
        {errors.map((e, i) => (
          <li key={i}>⚠ {e}</li>
        ))}
      </ul>
    </div>
  );
}

/** On/off switch for launch-form options, styled against the spec classes. */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="sc-toggle"
      data-on={checked ? 'true' : 'false'}
    >
      <span className="sc-toggle-track" aria-hidden="true">
        <span className="sc-toggle-thumb" />
      </span>
      <span className="sc-toggle-text">
        <span className="sc-toggle-label">{label}</span>
        {hint && <small className="sc-toggle-hint">{hint}</small>}
      </span>
    </button>
  );
}
