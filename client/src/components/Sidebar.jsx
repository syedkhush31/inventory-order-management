import Icon from './Icon.jsx';
import { APP_NAME, APP_TAGLINE } from '../config/brand.js';

// Dashboard, Inventory and Customers exist so far. The other sections are shown greyed out and cannot be clicked,
// so nothing pretends to work before it is built.
const ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', available: true },
  { key: 'inventory', label: 'Inventory', icon: 'inventory', available: true },
  { key: 'orders', label: 'Orders', icon: 'orders', available: false },
  { key: 'customers', label: 'Customers', icon: 'customers', available: true },
  { key: 'activity', label: 'Activity', icon: 'activity', available: false },
  { key: 'settings', label: 'Settings', icon: 'settings', available: false },
];

// current: the key of the section being shown. onNavigate(key) switches section.
export default function Sidebar({ current, onNavigate }) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="sidebar__brand-name">{APP_NAME}</div>
        <div className="sidebar__brand-tagline">{APP_TAGLINE}</div>
      </div>
      <nav aria-label="Main">
        <ul className="sidebar__nav">
          {ITEMS.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className="sidebar__item"
                aria-current={item.key === current ? 'page' : undefined}
                disabled={!item.available}
                onClick={() => onNavigate(item.key)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.available ? null : <span className="sidebar__soon">Soon</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
