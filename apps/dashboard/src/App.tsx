import { CallHistory } from "./components/CallHistory";
import { LiveCall } from "./components/LiveCall";
import { useAlertNotifications, type AlertPermission } from "./notifications";
import { Link, useRoute } from "./router";
import { useDashboard, type ConnectionStatus, type Subscription } from "./ws-client";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  open: "Connected",
  reconnecting: "Reconnecting…",
};

export function App() {
  const route = useRoute();
  // App-level, not per page, so the guardian is notified on every route.
  const alerts = useAlertNotifications();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Guardian Loop
        </Link>
        <nav>
          <AlertToggle permission={alerts.permission} onEnable={alerts.request} />
          <Link to="/" className={route.name === "live" ? "nav active" : "nav"}>
            Live
          </Link>
          <Link to="/history" className={route.name === "history" ? "nav active" : "nav"}>
            History
          </Link>
        </nav>
      </header>
      <main>
        {route.name === "live" ? <LivePage subscription={route.callId} /> : <CallHistory selected={route.callId} />}
      </main>
    </div>
  );
}

/**
 * Browser notifications need a one-time permission, which browsers only let a
 * click ask for. A denied permission can't be re-prompted from the page, so that
 * state says where to fix it instead of showing a button that does nothing.
 */
function AlertToggle({ permission, onEnable }: { permission: AlertPermission; onEnable: () => void }) {
  if (permission === "unsupported") return null;
  if (permission === "granted") {
    return (
      <span className="alert-toggle alert-toggle-on" title="Scam alerts will appear as notifications">
        🔔 Alerts on
      </span>
    );
  }
  if (permission === "denied") {
    return (
      <span className="alert-toggle alert-toggle-denied" title="Allow notifications for this site in the browser's site settings">
        🔕 Alerts blocked
      </span>
    );
  }
  return (
    <button type="button" className="btn btn-primary alert-toggle" onClick={onEnable}>
      🔔 Enable alerts
    </button>
  );
}

function LivePage({ subscription }: { subscription: Subscription }) {
  const { state, status, ackAlert } = useDashboard(subscription);
  return (
    <>
      <p className={`conn conn-${status}`} role="status">
        <span className="conn-dot" aria-hidden="true" /> {STATUS_TEXT[status]}
        {subscription === "latest" ? " · following the latest call" : ""}
      </p>
      {/* Keyed by call so per-call UI state (acks, scroll) resets when "latest" moves on. */}
      <LiveCall key={state.call?.callId ?? "none"} call={state.call} following={subscription === "latest"} onAck={ackAlert} />
    </>
  );
}
