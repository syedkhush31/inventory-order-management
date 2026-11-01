// Settings: the signed-in administrator's profile and password, the low-stock threshold, and application information.
// The account and the settings are loaded separately, so a problem with one still leaves the other sections usable.
// Everything comes from the server; nothing is saved until the server says so.
import { getAccount } from '../api/account.js';
import { getSettings } from '../api/settings.js';
import AppInfoSection from '../components/AppInfoSection.jsx';
import Icon from '../components/Icon.jsx';
import PasswordSection from '../components/PasswordSection.jsx';
import PreferencesSection from '../components/PreferencesSection.jsx';
import ProfileSection from '../components/ProfileSection.jsx';
import useRemoteData from '../hooks/useRemoteData.js';

function LoadingPanel({ title, what }) {
  return (
    <section className="panel" aria-label={title}>
      <h2 className="panel__header">{title}</h2>
      <div className="panel__state" role="status">
        <div className="spinner" aria-hidden="true" />
        <p>Loading {what}…</p>
      </div>
    </section>
  );
}

function ErrorPanel({ title, message, onRetry }) {
  return (
    <section className="panel" aria-label={title}>
      <h2 className="panel__header">{title}</h2>
      <div className="panel__state" role="alert">
        <Icon name="alert" size={24} />
        <p>{message}</p>
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const account = useRemoteData(getAccount);
  const settings = useRemoteData(getSettings);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title" tabIndex={-1}>
            Settings
          </h1>
          <p className="page-subtitle">Your profile, your password and how ShelfSync counts low stock.</p>
        </div>
      </div>

      {account.state === 'loading' ? (
        <LoadingPanel title="Profile" what="your profile" />
      ) : account.state === 'error' ? (
        <ErrorPanel title="Profile" message="Your profile could not be loaded." onRetry={account.reload} />
      ) : (
        <ProfileSection account={account.data} onSaved={account.setData} />
      )}

      {/* Changing the password needs nothing from the server first, so it is always available. */}
      <PasswordSection />

      {settings.state === 'loading' ? (
        <>
          <LoadingPanel title="Inventory preferences" what="your preferences" />
          <LoadingPanel title="Application information" what="application information" />
        </>
      ) : settings.state === 'error' ? (
        <>
          <ErrorPanel title="Inventory preferences" message="Your preferences could not be loaded." onRetry={settings.reload} />
          <ErrorPanel title="Application information" message="Application information could not be loaded." onRetry={settings.reload} />
        </>
      ) : (
        <>
          <PreferencesSection
            settings={settings.data.settings}
            onSaved={(saved) => settings.setData({ ...settings.data, settings: saved })}
          />
          <AppInfoSection app={settings.data.app} />
        </>
      )}
    </>
  );
}
