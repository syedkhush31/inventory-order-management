// A small coloured label. Tones: success (green), danger (red), neutral (grey).
export default function StatusBadge({ tone = 'neutral', children }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
