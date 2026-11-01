import { useEffect, useRef } from 'react';
import Sidebar from '../components/Sidebar.jsx';
import TopBar from '../components/TopBar.jsx';
import useSectionRoute from '../hooks/useSectionRoute.js';
import ActivityPage from './ActivityPage.jsx';
import CustomersPage from './CustomersPage.jsx';
import DashboardPage from './DashboardPage.jsx';
import InventoryPage from './InventoryPage.jsx';
import OrdersPage from './OrdersPage.jsx';
import SettingsPage from './SettingsPage.jsx';

// The signed-in layout. The section comes from the URL (/, /inventory, /orders, /customers, /activity, /settings), so a refresh keeps the page.

export default function DashboardShell() {
  const [section, setSection] = useSectionRoute();
  const mainRef = useRef(null);
  const firstRender = useRef(true);

  // After switching section, move keyboard focus to the new page heading.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.querySelector('h1')?.focus();
  }, [section]);

  return (
    <div className="shell">
      <Sidebar current={section} onNavigate={setSection} />
      <div className="workspace">
        <TopBar />
        <main className="content" ref={mainRef}>
          {section === 'inventory' ? (
            <InventoryPage />
          ) : section === 'orders' ? (
            <OrdersPage />
          ) : section === 'customers' ? (
            <CustomersPage />
          ) : section === 'activity' ? (
            <ActivityPage onNavigate={setSection} />
          ) : section === 'settings' ? (
            <SettingsPage />
          ) : (
            <DashboardPage onNavigate={setSection} />
          )}
        </main>
      </div>
    </div>
  );
}
