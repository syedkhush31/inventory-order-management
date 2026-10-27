// A label + input + hint + error message, wired together so screen readers announce them properly.
// hint: optional help text under the input.
// requiredMark: show a "*" after the label (the login form leaves this off).
export default function FormField({ id, label, error, hint, requiredMark, inputRef, ...inputProps }) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {requiredMark ? (
          <span className="field__required" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      <input
        id={id}
        ref={inputRef}
        className="field__input"
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={describedBy}
        aria-required={requiredMark ? 'true' : undefined}
        {...inputProps}
      />
      {hint ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
