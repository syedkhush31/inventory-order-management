import { useCallback, useEffect, useState } from 'react';

// Maps the sections that exist to their URLs, using the browser History API (no router library).
// Only the path is used; search and filters are not stored in the URL.
export const SECTION_PATHS = {
  dashboard: '/',
  inventory: '/inventory',
  orders: '/orders',
  customers: '/customers',
  activity: '/activity',
  settings: '/settings',
};

// Returns the section key for a path, or null if the path is not a known page.
export function sectionFromPath(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return Object.keys(SECTION_PATHS).find((key) => SECTION_PATHS[key] === path) ?? null;
}

// Keeps the current section in sync with the address bar: a refresh or a pasted link opens the right page,
// the back and forward buttons work, and an unknown path is replaced by the Dashboard.
// This only chooses which page to show; the server still checks the session on every request.
export default function useSectionRoute() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const section = sectionFromPath(pathname);

  useEffect(() => {
    if (section === null) {
      window.history.replaceState(null, '', SECTION_PATHS.dashboard);
      setPathname(SECTION_PATHS.dashboard);
    }
  }, [section]);

  // search: an optional query string such as "?order=7", used to open a page with something selected.
  const navigate = useCallback((key, search = '') => {
    const target = SECTION_PATHS[key];
    if (target === undefined) return;
    const destination = `${target}${search}`;
    if (window.location.pathname + window.location.search !== destination) window.history.pushState(null, '', destination);
    setPathname(target);
  }, []);

  return [section ?? 'dashboard', navigate];
}
