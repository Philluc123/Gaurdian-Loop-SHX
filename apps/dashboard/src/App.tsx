import { CallHistory } from "./components/CallHistory";
import { LiveCall } from "./components/LiveCall";
import { Link, useRoute } from "./router";
import { useDashboard, type ConnectionStatus, type Subscription } from "./ws-client";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  open: "Connected",
  reconnecting: "Reconnecting…",
};

export function App() {
  const route = useRoute();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Guardian Loop
        </Link>
        <nav>
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
