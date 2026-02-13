#!/usr/bin/env node
import process from "node:process";
import { Command } from "commander";
import { registerGatewayCliClient } from "./cli/gateway-cli/register-client.js";
import { registerNodeCliClient } from "./cli/node-cli/register-client.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { statusClientCommand } from "./commands/status-client.js";
import { loadDotEnv } from "./infra/dotenv.js";
import { normalizeEnv } from "./infra/env.js";
import { formatUncaughtError } from "./infra/errors.js";
import { ensureOpenClawCliOnPath } from "./infra/path-env.js";
import { assertSupportedRuntime } from "./infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "./infra/unhandled-rejections.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import { enableConsoleCapture } from "./logging.js";
import { formatDocsLink } from "./terminal/links.js";
import { colorize, isRich, theme } from "./terminal/theme.js";
import { VERSION } from "./version.js";
import "./config/config.js";

process.title = "openclaw";
installProcessWarningFilter();
loadDotEnv({ quiet: true });
normalizeEnv();
ensureOpenClawCliOnPath();
enableConsoleCapture();
assertSupportedRuntime();

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

const parsed = parseCliProfileArgs(process.argv);
if (!parsed.ok) {
  const parseError = parsed.error;
  console.error(`[openclaw] ${parseError}`);
  process.exit(2);
}

const selectedProfile = parsed.profile;
if (selectedProfile) {
  applyCliProfileEnv({ profile: selectedProfile });
  process.argv = parsed.argv;
}

const program = new Command();
program
  .name("openclaw")
  .description("OpenClaw client CLI (node + gateway RPC)")
  .version(VERSION)
  .option(
    "--profile <name>",
    "Use a named profile (isolates OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH under ~/.openclaw-<name>)",
  )
  .option(
    "--dev",
    "Dev profile: isolate state under ~/.openclaw-dev and default gateway port 19001",
    false,
  )
  .option("--no-color", "Disable ANSI colors", false)
  .showHelpAfterError(true);

program.configureHelp({
  sortSubcommands: true,
  sortOptions: true,
  optionTerm: (option) => theme.option(option.flags),
  subcommandTerm: (cmd) => theme.command(cmd.name()),
});

program.configureOutput({
  writeOut: (str) => {
    const colored = str
      .replace(/^Usage:/gm, theme.heading("Usage:"))
      .replace(/^Options:/gm, theme.heading("Options:"))
      .replace(/^Commands:/gm, theme.heading("Commands:"));
    process.stdout.write(colored);
  },
  writeErr: (str) => process.stderr.write(str),
  outputError: (str, write) => write(theme.error(str)),
});

registerNodeCliClient(program);
registerGatewayCliClient(program);

program
  .command("status")
  .description("Show local config + gateway target summary")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    await statusClientCommand({ json: Boolean(opts.json) });
  });

program.addHelpText(
  "afterAll",
  () =>
    `\n${theme.muted("Docs:")} ${formatDocsLink("/cli", "docs.openclaw.ai/cli")}\n${theme.muted("Client build includes:")} node, gateway call/status/probe, status`,
);

installUnhandledRejectionHandler();
process.on("uncaughtException", (error) => {
  console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
  process.exit(1);
});

await program.parseAsync(process.argv).catch((err) => {
  const rich = isRich();
  console.error(colorize(rich, theme.error, `[openclaw] CLI failed: ${formatUncaughtError(err)}`));
  process.exit(1);
});
