import { useEffect, useRef, useState } from 'react';
import Sidebar from '../components/Sidebar.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import TopBar from '../components/TopBar.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { APP_NAME } from '../config/brand.js';
import InventoryPage from './InventoryPage.jsx';

// The signed-in layout. The section is kept in memory (no router yet), so a refresh returns to Dashboard.
// The dashboard deliberately shows no business numbers: none exist yet.
const MODULES = [
  { name: 'Inventory', built: true },
  { name: 'Orders', built: false },
  { name: 'Customers', built: false },
  { name: 'Activity', built: false },
  { name: 'Settings', built: false },
];

function DashboardHome() {
  const { admin } = useAuth();

  return (
    <>
      <h1 className="page-title" tabIndex={-1}>
        Dashboard
      </h1>
      <p className="page-subtitle">Welcome to {APP_NAME}.</p>

      <section className="panel" aria-labelledby="session-heading">
        <h2 className="panel__header" id="session-heading">
          Your session
        </h2>
        <div className="panel__body">
          <p>
            You are signed in as <strong>{admin.email}</strong>.
          </p>
          <p className="panel__muted">Sessions last one hour. After that you will be asked to sign in again.</p>
        </div>
      </section>

      <section className="panel" aria-labelledby="modules-heading">
        <h2 className="panel__header" id="modules-heading">
          Modules
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Module</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {MODULES.map((module) => (
                <tr key={module.name}>
                  <td>{module.name}</td>
                  <td>
                    <StatusBadge tone={module.built ? 'success' : 'neutral'}>
                      {module.built ? 'Available' : 'Not built yet'}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default function DashboardShell() {
  const [section, setSection] = useState('dashboard');
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
          {section === 'inventory' ? <InventoryPage /> : <DashboardHome />}
        </main>
      </div>
    </div>
  );
}
