// Chooses what to show based on the session status. Only a server-verified session reaches the dashboard.
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardShell from './pages/DashboardShell.jsx';
import Icon from './components/Icon.jsx';

function CheckingScreen() {
  return (
    <div className="status-screen" role="status">
      <div className="spinner" aria-hidden="true" />
      <p className="status-screen__text">Checking your session…</p>
    </div>
  );
}

function UnreachableScreen({ onRetry }) {
  return (
    <div className="status-screen">
      <div className="status-screen__card" role="alert">
        <Icon name="alert" size={28} />
        <h1 className="page-title">Cannot reach the server</h1>
        <p className="status-screen__text">
          We could not verify your session. Check that the server is running and your connection is working.
        </p>
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

function Screens() {
  const { status, checkSession } = useAuth();

  if (status === 'checking') return <CheckingScreen />;
  if (status === 'unreachable') return <UnreachableScreen onRetry={checkSession} />;
  if (status === 'authenticated') return <DashboardShell />;
  return <LoginPage />;
}

export default function App() {
  return (
    <AuthProvider>
      <Screens />
    </AuthProvider>
  );
}
