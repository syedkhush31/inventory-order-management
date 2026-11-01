// The expanded facts of one activity event. Everything here is read from the event the server sent: nothing is
// looked up, calculated or guessed in the browser. Where the log deliberately does not keep something (the text of a
// changed SKU or name, a customer's contact details), it says so instead of leaving a gap.
import { formatDateTime, formatPrice, formatQuantity } from '../utils/format.js';
import { actorName, fieldLabel, signed, statusName } from '../utils/activityUtils.js';

function Fact({ label, children }) {
  return (
    <div className="activity-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function OrderDetails({ event, onNavigate }) {
  const { details, entity, type } = event;
  const movements = details.stockMovements ?? [];
  const touchesStock = type === 'ORDER_CONFIRMED' || type === 'ORDER_CANCELLED';
  return (
    <>
      <dl className="activity-facts">
        <Fact label="Order">{entity.label}</Fact>
        <Fact label="Customer">{details.customerName}</Fact>
        <Fact label="Status change">
          {details.fromStatus ? `${statusName(details.fromStatus)} → ${statusName(details.toStatus)}` : `Created as ${statusName(details.toStatus)}`}
        </Fact>
        <Fact label="Order total">{formatPrice(details.totalAmount)}</Fact>
      </dl>

      {movements.length > 0 ? (
        <div className="table-wrap activity-movements">
          <table className="table">
            <caption className="activity-caption">
              {type === 'ORDER_CONFIRMED' ? 'Stock deducted by this confirmation' : 'Stock put back by this cancellation'}
            </caption>
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Product</th>
                <th scope="col" className="cell--numeric">
                  Stock change
                </th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={`${movement.productId}-${movement.quantityDelta}`}>
                  <td>{movement.sku}</td>
                  <td>{movement.productName}</td>
                  <td className="cell--numeric">{signed(movement.quantityDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : touchesStock ? (
        <p className="panel__muted">No stock movement is recorded for this event.</p>
      ) : null}

      <div className="activity-actions">
        <button type="button" className="btn btn--secondary btn--small" onClick={() => onNavigate('orders', `?order=${entity.id}`)}>
          Open order #{entity.id}
        </button>
      </div>
    </>
  );
}

function StockDetails({ event, onNavigate }) {
  const { details } = event;
  return (
    <>
      <dl className="activity-facts">
        <Fact label="Product">
          {details.sku} — {details.productName}
        </Fact>
        <Fact label="Stock change">{signed(details.quantityDelta)}</Fact>
        <Fact label="Reason">{details.reason}</Fact>
      </dl>
      <div className="activity-actions">
        <button type="button" className="btn btn--secondary btn--small" onClick={() => onNavigate('inventory')}>
          Open Inventory
        </button>
      </div>
    </>
  );
}

function ChangedFields({ fields }) {
  return (
    <ul className="activity-chips" aria-label="Fields changed">
      {fields.map((field) => (
        <li key={field}>{fieldLabel(field)}</li>
      ))}
    </ul>
  );
}

function AuditDetails({ event, onNavigate }) {
  const { type, details, entity } = event;
  const fields = details?.changedFields ?? [];
  const price = details?.changes?.price;

  return (
    <>
      <dl className="activity-facts">
        <Fact label={entity.type === 'settings' ? 'Area' : entity.type === 'account' ? 'Account' : entity.type === 'customer' ? 'Customer' : 'Product'}>
          {entity.label}
        </Fact>
        {type === 'PRODUCT_CREATED' && details?.price ? <Fact label="Price when created">{formatPrice(details.price)}</Fact> : null}
        {fields.length > 0 ? (
          <Fact label="Changed">
            <ChangedFields fields={fields} />
          </Fact>
        ) : null}
        {price ? (
          <Fact label="Price">
            {formatPrice(price.from)} → {formatPrice(price.to)}
          </Fact>
        ) : null}
        {type === 'SETTINGS_UPDATED' && details ? (
          <Fact label="Low-stock threshold">
            {formatQuantity(details.from)} → {formatQuantity(details.to)}
          </Fact>
        ) : null}
      </dl>

      {fields.includes('sku') || fields.includes('name') ? (
        <p className="panel__muted">The activity log records that the SKU or name changed, but not the old or new text.</p>
      ) : null}
      {entity.type === 'customer' ? (
        <p className="panel__muted">Customer details are never copied into the activity log.</p>
      ) : null}
      {type === 'PRODUCT_CREATED' ? (
        <p className="panel__muted">The product&apos;s SKU and name are shown as they are now.</p>
      ) : null}

      {entity.type === 'product' || entity.type === 'customer' ? (
        <div className="activity-actions">
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={() => onNavigate(entity.type === 'product' ? 'inventory' : 'customers')}
          >
            {entity.type === 'product' ? 'Open Inventory' : 'Open Customers'}
          </button>
        </div>
      ) : null}
    </>
  );
}

// event: one item from GET /api/activity. onNavigate(section, search?) switches section.
export default function ActivityDetails({ event, onNavigate }) {
  const group = event.type.startsWith('ORDER_') ? 'order' : event.type === 'STOCK_ADJUSTED' ? 'stock' : 'audit';
  return (
    <div className="activity-details">
      {group === 'order' && event.details ? <OrderDetails event={event} onNavigate={onNavigate} /> : null}
      {group === 'stock' && event.details ? <StockDetails event={event} onNavigate={onNavigate} /> : null}
      {group === 'audit' ? <AuditDetails event={event} onNavigate={onNavigate} /> : null}
      <p className="activity-footnote">
        Recorded {formatDateTime(event.occurredAt)} by {actorName(event.actor)}
        {event.actor?.displayName ? ` (${event.actor.email})` : ''}.
      </p>
    </div>
  );
}
