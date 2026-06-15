import type { InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from 'react';

interface BaseInputProps {
  id?: string;
  label?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
}

interface TextInputProps extends BaseInputProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'label' | 'error' | 'hint' | 'required' | 'className'> {
  multiline?: false;
}

interface TextAreaProps extends BaseInputProps, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'label' | 'error' | 'hint' | 'required' | 'className'> {
  multiline: true;
}

type InputProps = TextInputProps | TextAreaProps;

const fieldClass =
  'w-full bg-surface border border-surface-border rounded px-3 py-2 text-white placeholder:text-muted focus:outline-none focus:border-brand focus-visible:ring-2 focus-visible:ring-brand-muted/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50';

/**
 * Shared text/textarea primitive with consistent styling, labels, hints, and
 * error messaging. File inputs keep their native styling but inherit focus
 * rings via a wrapper.
 */
export default function Input(props: InputProps) {
  const { label, error, hint, required, className = '', multiline, ...rest } = props;
  const describedBy = [
    hint ? `${rest.id}-hint` : '',
    error ? `${rest.id}-error` : '',
  ].filter(Boolean).join(' ') || undefined;
  const ariaProps = {
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': describedBy,
  };

  return (
    <div className={`space-y-1 ${className}`}>
      {label !== undefined && (
        <label htmlFor={rest.id} className="block text-sm font-medium text-muted-light">
          {label}
          {required && <span className="text-danger-muted ml-1">*</span>}
        </label>
      )}
      {multiline ? (
        <textarea className={`${fieldClass} resize-none`} {...ariaProps} {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} />
      ) : (
        <input className={fieldClass} {...ariaProps} {...(rest as InputHTMLAttributes<HTMLInputElement>)} />
      )}
      {hint && (
        <p id={`${rest.id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${rest.id}-error`} role="alert" className="text-sm text-danger-muted">
          {error}
        </p>
      )}
    </div>
  );
}
