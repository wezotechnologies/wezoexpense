"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  drainOutbox,
  getOutboxServerSnapshot,
  getOutboxSnapshot,
  subscribeOutbox,
} from "@/lib/offline-queue";
import { cx } from "@/components/ui/primitives";

/**
 * PWA runtime glue (spec 13):
 *  - registers the service worker,
 *  - shows an offline banner,
 *  - flushes the offline outbox when connectivity returns, and when the worker
 *    asks (background sync).
 *
 * Draining lives in the page rather than the worker so the two-step
 * upload-then-create flow exists in exactly one place.
 *
 * Both connectivity and the queue length are read with useSyncExternalStore —
 * they are external systems, so no effect has to seed them into state.
 */

function subscribeToConnectivity(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function PwaProvider() {
  const online = useSyncExternalStore(
    subscribeToConnectivity,
    () => navigator.onLine,
    () => true, // assume online while server-rendering
  );

  // The queue owns both its length and whether it is currently sending, so
  // neither needs to be mirrored into component state.
  const { count: queued, draining: syncing } = useSyncExternalStore(
    subscribeOutbox,
    getOutboxSnapshot,
    getOutboxServerSnapshot,
  );

  // Register the worker once.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((error) => console.warn("[pwa] service worker failed:", error));
  }, []);

  // Drain whenever we have a connection, and when the worker asks us to.
  // `drainOutbox` reports progress through the store rather than setState, so
  // there is no cascading render to worry about here.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "DRAIN_OUTBOX") void drainOutbox();
    };
    navigator.serviceWorker?.addEventListener("message", handleMessage);
    // Queued worker messages are not delivered to an addEventListener listener
    // until this is called, so a background-sync nudge that fired before this
    // effect ran would otherwise be dropped.
    navigator.serviceWorker?.startMessages();

    if (online) void drainOutbox();

    return () => {
      navigator.serviceWorker?.removeEventListener("message", handleMessage);
    };
  }, [online]);

  if (online && queued === 0) return null;

  return (
    <div
      role="status"
      className={cx(
        // The top inset is added to the padding rather than replacing it, so
        // the banner keeps its normal breathing room on devices with no notch,
        // where the inset resolves to 0.
        "sticky top-0 z-40 flex items-center justify-center gap-2 px-4 py-1.5 pt-[calc(0.375rem+env(safe-area-inset-top))] text-xs font-medium",
        online ? "bg-info/15 text-info" : "bg-pending/15 text-pending",
      )}
    >
      <span
        className={cx(
          "inline-block h-1.5 w-1.5 rounded-full",
          online ? "bg-info" : "bg-pending",
        )}
      />
      {!online
        ? queued > 0
          ? `Offline — ${queued} item${queued === 1 ? "" : "s"} queued on this device`
          : "Offline — you can still record transactions; they'll sync when you reconnect"
        : syncing
          ? `Syncing ${queued} queued item${queued === 1 ? "" : "s"}…`
          : `${queued} item${queued === 1 ? "" : "s"} waiting to sync`}
    </div>
  );
}
