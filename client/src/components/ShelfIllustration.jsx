// A simple warehouse-shelving drawing made of plain SVG shapes (no image files, no libraries).
// It is decoration only, so it is hidden from screen readers.
const BAY_X = [24, 176, 328];
const BAY_WIDTH = 128;
const SHELF_Y = [118, 190, 262];

// For each bay and each shelf: boxes as [x offset, width, height].
const BOXES = [
  [
    [[10, 34, 36], [50, 26, 26], [82, 36, 44]],
    [[10, 48, 28], [64, 28, 38], [98, 22, 22]],
    [[10, 30, 40], [46, 42, 28], [94, 26, 34]],
  ],
  [
    [[8, 40, 30], [54, 32, 42], [92, 28, 24]],
    [[10, 28, 36], [44, 46, 26], [98, 24, 40]],
    [[8, 52, 32], [66, 24, 24], [96, 26, 38]],
  ],
  [
    [[12, 30, 44], [48, 38, 28], [92, 30, 34]],
    [[8, 36, 24], [50, 30, 40], [86, 34, 30]],
    [[10, 44, 34], [60, 26, 42], [92, 28, 26]],
  ],
];

const FILL = 'rgba(255,255,255,0.09)';
const LINE = 'rgba(255,255,255,0.28)';

export default function ShelfIllustration() {
  return (
    <svg
      className="login__illustration"
      viewBox="0 0 480 290"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="0" y1="274" x2="480" y2="274" stroke={LINE} strokeWidth="2" />
      {BAY_X.map((bayX, bay) => (
        <g key={bayX}>
          <line x1={bayX} y1="56" x2={bayX} y2="274" stroke={LINE} strokeWidth="3" />
          <line x1={bayX + BAY_WIDTH} y1="56" x2={bayX + BAY_WIDTH} y2="274" stroke={LINE} strokeWidth="3" />
          {SHELF_Y.map((shelfY, shelf) => (
            <g key={shelfY}>
              <line x1={bayX} y1={shelfY} x2={bayX + BAY_WIDTH} y2={shelfY} stroke={LINE} strokeWidth="3" />
              {BOXES[bay][shelf].map(([dx, width, height]) => (
                <rect
                  key={dx}
                  x={bayX + dx}
                  y={shelfY - height - 1.5}
                  width={width}
                  height={height}
                  rx="2"
                  fill={FILL}
                  stroke={LINE}
                  strokeWidth="1.5"
                />
              ))}
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}
