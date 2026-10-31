// Run every five minutes using your host's scheduler. Never pass secrets in URLs.
const origin = new URL(process.env.APP_ORIGIN ?? "");
if (
  origin.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
)
  throw Error("Use HTTPS for snapshot jobs.");
if (
  !process.env.KEYLO_SNAPSHOT_JOB_TOKEN ||
  process.env.KEYLO_SNAPSHOT_JOB_TOKEN.length < 32
)
  throw Error("Set KEYLO_SNAPSHOT_JOB_TOKEN to the server job secret.");
const response = await fetch(new URL("/tasks/snapshots", origin), {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.KEYLO_SNAPSHOT_JOB_TOKEN}` },
  redirect: "error",
  signal: AbortSignal.timeout(35000),
});
if (!response.ok) throw Error(`Snapshot job failed (${response.status}).`);
const result = await response.json();
console.log(JSON.stringify(result));
if (result.status === "partial-failure") process.exitCode = 1;
