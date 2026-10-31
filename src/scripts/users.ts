import { parseArgs } from "node:util";
import { localAuth } from "../server/local-auth";

const command = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: { email: { type: "string" }, name: { type: "string" } },
});
if (
  !values.email ||
  !["bootstrap", "recover"].includes(command ?? "") ||
  (command === "bootstrap" && !values.name)
) {
  console.error(
    'Usage: npm run users:bootstrap -- --email admin@example.com --name "Workspace admin"\n       npm run users:recover -- --email admin@example.com',
  );
  process.exitCode = 1;
} else {
  try {
    const auth = await localAuth();
    const result =
      command === "bootstrap"
        ? await auth.bootstrap({ email: values.email, name: values.name })
        : await auth.recover(values.email);
    console.log(
      `One-time link for ${result.user.email}\nExpires: ${result.expiresAt}\n\n${result.url}\n\nTreat this URL as a credential. Share it privately with the intended administrator. No password was set by this command.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unable to initialize user.",
    );
    process.exitCode = 1;
  }
}
