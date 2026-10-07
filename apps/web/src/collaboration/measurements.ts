// Opt-in local diagnostics for reproducible browser measurement. Numeric samples
// only, no identities or source; bounded in memory, never sent over the network.
export type SampleName = "local_render_ms" | "durable_ack_ms" | "connect_sync_ms" | "local_retention_ms";
declare global { interface Window { cceMeasurements?: Partial<Record<SampleName, number[]>> } }
export function sample(name: SampleName, elapsed: number) {
  if (typeof window === "undefined" || !Number.isFinite(elapsed)) return;
  try {
    if (sessionStorage.getItem("cce-measure") !== "1") return;
    window.cceMeasurements ??= {};
    const samples = window.cceMeasurements;
    samples[name] ??= [];
    const values = samples[name]; values.push(elapsed); if (values.length > 2048) values.shift();
  } catch { /* Diagnostics must never affect editing when browser storage fails. */ }
}
