import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createReporter, parseArgs } from "../cli/keylo.mjs";
function terminal({
  tty = true,
  columns = 80,
  env = {} as Record<string, string | undefined>,
  plain = false,
  noColor = false,
} = {}) {
  let output = "",
    errors = "";
  const reporter = createReporter({
    stdout: {
      isTTY: tty,
      columns,
      write: (text) => {
        output += text;
      },
    },
    stderr: {
      write: (text) => {
        errors += text;
      },
    },
    env,
    plain,
    noColor,
  });
  return { reporter, output: () => output, errors: () => errors };
}
test("interactive terminals get a character and readable stages while pipes/CI keep stable plain results", () => {
  const interactive = terminal();
  interactive.reporter.banner();
  interactive.reporter.context("website", "pull");
  interactive.reporter.step("Fetching translations…");
  interactive.reporter.success("Pulled 2 languages from website:");
  interactive.reporter.file("/tmp/fr.json");
  interactive.reporter.finish();
  assert.match(interactive.output(), /\(o  o\)---\+/);
  assert.match(interactive.output(), /Fetching translations/);
  assert.match(interactive.output(), /\u001b\[/);
  for (const options of [
    { tty: false },
    { env: { CI: "true" } },
    { env: { TERM: "dumb" } },
    { plain: true },
  ]) {
    const plain = terminal(options);
    plain.reporter.banner();
    plain.reporter.context("website", "pull");
    plain.reporter.step("Fetching translations…");
    plain.reporter.success("Pulled 2 languages from website:");
    plain.reporter.file("/tmp/fr.json");
    plain.reporter.finish();
    assert.equal(
      plain.output(),
      "Pulled 2 languages from website:\n  /tmp/fr.json\n",
    );
  }
});
test("NO_COLOR and --no-color retain readable interactive output without ANSI; narrow terminals omit the art", () => {
  for (const options of [{ env: { NO_COLOR: "" } }, { noColor: true }]) {
    const term = terminal(options);
    term.reporter.banner();
    term.reporter.step("Reading source files…");
    assert.match(term.output(), /\(o  o\)---\+/);
    assert.doesNotMatch(term.output(), /\u001b/);
  }
  const narrow = terminal({ columns: 40 });
  narrow.reporter.banner();
  assert.doesNotMatch(narrow.output(), /\(o  o\)/);
  assert.match(narrow.output(), /keylo/);
  const options = parseArgs([
    "pull",
    "--url",
    "https://copy.example.com",
    "--project",
    "web",
    "--plain",
    "--no-color",
  ]);
  assert.ok("plain" in options);
  assert.equal(options.plain, true);
  assert.equal(options["no-color"], true);
});
test("displayed paths and errors cannot inject terminal commands, new lines or known credentials", () => {
  const term = terminal({
    env: { KEYLO_TOKEN: "private-token", KEYLO_SYNC_TOKEN: "private-sync" },
  });
  term.reporter.file("/tmp/\u001b[2Jfile\nname\u202e.json");
  term.reporter.failure(
    new Error("private-token private-sync\r\n\u001b[31mfailed"),
  );
  assert.doesNotMatch(term.output(), /\u001b\[2J|\u202e|file\nname/);
  assert.doesNotMatch(term.errors(), /private-token|private-sync|\r/);
  assert.match(term.errors(), /\[redacted\]/);
  assert.equal(term.errors().split("\n").length, 2);
  const escapedSecret = terminal({
    env: { KEYLO_TOKEN: "secret\u001b[31mvalue" },
  });
  escapedSecret.reporter.failure(new Error("secret\u001b[31mvalue"));
  assert.doesNotMatch(escapedSecret.errors(), /secretvalue/);
  assert.match(escapedSecret.errors(), /\[redacted\]/);
});
test("help works even with a broken config and real command failures retain nonzero exit codes without secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keylo-cli-presentation-")),
    cli = resolve("cli/keylo.mjs");
  try {
    await writeFile(
      join(directory, ".keylo.json"),
      "not valid JSON private-token",
    );
    const help = spawnSync(process.execPath, [cli, "--help"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Commands:/);
    assert.doesNotMatch(help.stdout, /private-token|\u001b/);
    await rm(join(directory, ".keylo.json"));
    const failed = spawnSync(
      process.execPath,
      [
        cli,
        "push",
        "--url",
        "https://copy.example.com",
        "--project",
        "web",
        "--source",
        "private-token",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, KEYLO_SYNC_TOKEN: "private-token", CI: "true" },
      },
    );
    assert.equal(failed.status, 1);
    assert.doesNotMatch(failed.stderr, /private-token|\u001b/);
    assert.match(failed.stderr, /\[redacted\]/);
    assert.equal(failed.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
