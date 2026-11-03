// Run every five minutes using your host's scheduler. Never pass secrets in URLs.
const task = process.argv[2] ?? "snapshots";
if (!["snapshots", "identities"].includes(task))
  throw Error("Unknown maintenance task.");
const origin = new URL(process.env.APP_ORIGIN ?? "");
if (
  origin.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
)
  throw Error("Use HTTPS for maintenance jobs.");
if (
  !process.env.KIELI_SNAPSHOT_JOB_TOKEN ||
  process.env.KIELI_SNAPSHOT_JOB_TOKEN.length < 32
)
  throw Error("Set KIELI_SNAPSHOT_JOB_TOKEN to the server job secret.");
const response = await fetch(new URL(`/tasks/${task}`, origin), {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.KIELI_SNAPSHOT_JOB_TOKEN}` },
  redirect: "error",
  signal: AbortSignal.timeout(35000),
});
if (!response.ok) throw Error(`Maintenance job failed (${response.status}).`);
const result = await response.json();
console.log(JSON.stringify(result));
if (result.status === "partial-failure") process.exitCode = 1;
