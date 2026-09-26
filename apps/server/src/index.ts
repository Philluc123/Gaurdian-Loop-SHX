// Composition root. Wires every module's event bus subscriptions together and
// starts the HTTP/WebSocket server. Keep this file thin — it should only import
// and connect modules, never contain module logic itself.
//
// See ../README.md and docs/module-contracts.md section 1 for the wiring diagram.

// TODO: import and register call-ingestion, stt-adapters, orchestrator,
// rules-classifier, llm-classifier, score-engine, alerts, event-store.
