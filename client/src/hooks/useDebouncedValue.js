import { useEffect, useState } from 'react';

// Returns `value`, but only after it has stopped changing for `delayMs`.
// Used so the search box does not call the server on every keystroke.
export function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
