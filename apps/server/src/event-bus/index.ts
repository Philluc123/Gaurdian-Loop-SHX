// A thin, typed wrapper around Node's EventEmitter. See ./README.md and
// docs/module-contracts.md section 1.
//
// Modules publish and subscribe here; they never import each other's internals.
// Publishing an event whose `type` isn't in GuardianEventMap is a compile error.

import { EventEmitter } from "node:events";
import type {
  GuardianEvent,
  GuardianEventMap,
  GuardianEventType,
} from "@guardian-loop/shared-types";

/** Unsubscribe function returned by every subscribe call. */
export type Unsubscribe = () => void;

const ALL = "__all__";

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Several modules legitimately listen to the same event (e.g. transcript is
    // consumed by the orchestrator, the dashboard fan-out and the event store).
    // The default cap of 10 would warn on that, so lift it.
    this.emitter.setMaxListeners(100);
  }

  /** Publish a fully-formed event. Delivery is synchronous. */
  publish(event: GuardianEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit(ALL, event);
  }

  /** Subscribe to one event type, with the payload inferred from the type. */
  subscribe<K extends GuardianEventType>(
    type: K,
    handler: (event: GuardianEventMap[K]) => void
  ): Unsubscribe {
    const wrapped = (event: GuardianEventMap[K]) => {
      // A throwing subscriber must not take down the call it's observing, nor
      // stop the remaining subscribers from seeing the event.
      try {
        handler(event);
      } catch (err) {
        console.error(`[event-bus] subscriber for "${type}" threw:`, err);
      }
    };
    this.emitter.on(type, wrapped);
    return () => this.emitter.off(type, wrapped);
  }

  /**
   * Subscribe to every event. Intended for the event store (§3.9) and for
   * debugging — prefer a specific type everywhere else.
   */
  subscribeAll(handler: (event: GuardianEvent) => void): Unsubscribe {
    const wrapped = (event: GuardianEvent) => {
      try {
        handler(event);
      } catch (err) {
        console.error("[event-bus] subscribeAll subscriber threw:", err);
      }
    };
    this.emitter.on(ALL, wrapped);
    return () => this.emitter.off(ALL, wrapped);
  }

  /** Test helper: drop every subscriber. */
  removeAllSubscribers(): void {
    this.emitter.removeAllListeners();
  }
}

/**
 * One bus per process. Per-call isolation is the orchestrator's job, not the
 * bus's — see ../orchestrator/README.md.
 */
export const bus = new EventBus();
