import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

/** The autofocus attribute only fires on page load; this also works for screens swapped in later. */
export function useAutoFocus<T extends HTMLElement>(enabled = true): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus();
  }, [enabled]);
  return ref;
}

type ButtonProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  block?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
};

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  class: cls,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, size === 'sm' && 'btn--sm', block && 'btn--block', cls]
    .filter(Boolean)
    .join(' ');
  return <button type={type} class={classes} {...rest} />;
}

interface FieldProps {
  label: string;
  value: string;
  onInput: (value: string) => void;
  type?: 'text' | 'password';
  hint?: string | undefined;
  error?: string | undefined;
  autoFocus?: boolean;
  autoComplete?: string;
  placeholder?: string;
  maxLength?: number;
  mono?: boolean;
}

export function TextField(props: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const ref = useAutoFocus<HTMLInputElement>(props.autoFocus ?? false);
  return (
    <div class="field">
      <label for={id}>{props.label}</label>
      <input
        ref={ref}
        id={id}
        class={`input${props.mono ? ' mono' : ''}`}
        type={props.type ?? 'text'}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        autoComplete={props.autoComplete ?? 'off'}
        spellcheck={false}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        aria-invalid={props.error ? 'true' : undefined}
        aria-describedby={props.error || props.hint ? hintId : undefined}
      />
      {props.error ? (
        <p id={hintId} class="error" role="alert">
          {props.error}
        </p>
      ) : props.hint ? (
        <p id={hintId} class="hint">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

export function PasswordField(props: Omit<FieldProps, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div class="stack" style={{ gap: '4px' }}>
      <TextField
        {...props}
        type={shown ? 'text' : 'password'}
        autoComplete={props.autoComplete ?? 'current-password'}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShown(!shown)}
        style={{ justifySelf: 'end' }}
      >
        {shown ? 'Hide' : 'Show'}
      </Button>
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger';
  children: ComponentChildren;
}) {
  return (
    <div
      class={`notice${tone !== 'info' ? ` notice--${tone}` : ''}`}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      {children}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ComponentChildren;
}) {
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

/** Copies text; returns a short status label for the button. */
export function useCopy(): [string | null, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
      return true;
    } catch {
      return false;
    }
  };
  return [copied, copy];
}
