import { useCallback, useEffect, useState } from 'react';

// Loads data once when the component appears, and again when reload() is called.
// Returns { state, data, setData, reload }: state is 'loading', 'ready' or 'error'. setData lets a page put the answer of
// a successful save in place of the loaded data. An older answer never replaces a newer one, and nothing is set after
// the component has gone. `loader` must be a stable function (defined outside the component, or wrapped in useCallback).
export default function useRemoteData(loader) {
  const [result, setResult] = useState({ state: 'loading', data: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setResult({ state: 'loading', data: null });
    loader({ signal: controller.signal })
      .then((data) => active && setResult({ state: 'ready', data }))
      .catch((err) => {
        if (active && err.name !== 'AbortError') setResult({ state: 'error', data: null });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [loader, attempt]);

  const setData = useCallback((data) => setResult({ state: 'ready', data }), []);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...result, setData, reload };
}
