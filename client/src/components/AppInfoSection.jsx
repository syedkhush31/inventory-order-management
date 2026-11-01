// Settings > Application information. Everything shown is what the server reported: nothing is made up here. A version
// the server could not read is shown as "Not available" instead of a guess.
const ENVIRONMENT_LABELS = { development: 'Development', production: 'Production' };

function Item({ label, children }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

// app: { name, serverVersion, clientVersion, environment } from GET /api/settings.
export default function AppInfoSection({ app }) {
  const environment = text(app.environment);
  return (
    <section className="panel product-form" aria-labelledby="app-info-heading">
      <h2 className="panel__header" id="app-info-heading">
        Application information
      </h2>
      <div className="panel__body">
        <dl className="settings-summary">
          <Item label="Application">{text(app.name) ?? <span className="cell--none">Not available</span>}</Item>
          <Item label="Client version">{text(app.clientVersion) ?? <span className="cell--none">Not available</span>}</Item>
          <Item label="Server version">{text(app.serverVersion) ?? <span className="cell--none">Not available</span>}</Item>
          <Item label="Environment">
            {environment ? ENVIRONMENT_LABELS[environment] ?? environment : <span className="cell--none">Not available</span>}
          </Item>
        </dl>
      </div>
    </section>
  );
}
