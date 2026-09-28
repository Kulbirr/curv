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
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="sc-builder-field">
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
