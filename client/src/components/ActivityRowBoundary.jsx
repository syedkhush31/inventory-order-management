// Keeps one malformed activity event from taking the whole Activity page down. It wraps the contents of a single row:
// if drawing that row (or opening its details) throws, only that row is replaced by a short notice, and every other
// row, the filters and the pagination keep working. It is deliberately small and used only on this page; it is not an
// application-wide error handler.
//
// It does not log the event: an event can hold names, so nothing from it is written to the console by this component.
// (React itself still reports a caught render error in development.)
import { Component } from 'react';
import StatusBadge from './StatusBadge.jsx';

export default class ActivityRowBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  // A reload brings fresh event objects. Try drawing the row again instead of staying failed for good.
  componentDidUpdate(previous) {
    if (this.state.failed && previous.event !== this.props.event) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;

    const { event } = this.props;
    const code = event && typeof event.type === 'string' ? event.type.slice(0, 60) : '';
    return (
      <>
        <span className="activity-item__dot" aria-hidden="true" />
        <div className="activity-item__main">
          <div className="activity-item__top">
            <StatusBadge tone="neutral">Event</StatusBadge>
            <span className="activity-item__summary">This event could not be displayed.</span>
          </div>
          {code ? <p className="activity-item__meta">Event type: {code}</p> : null}
        </div>
      </>
    );
  }
}
