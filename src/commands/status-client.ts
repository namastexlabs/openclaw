import { loadConfig, resolveConfigPath, resolveGatewayPort, resolveStateDir } from "../config/config.js";

export type StatusClientOptions = {
  json?: boolean;
};

type GatewayTargetSummary = {
  mode: "local" | "remote";
  url: string;
  tls: boolean;
  authMode: "token" | "password" | "none";
};

type StatusClientSummary = {
  configPath: string;
  stateDir: string;
  gateway: GatewayTargetSummary;
};

function resolveAuthMode(cfg: ReturnType<typeof loadConfig>): GatewayTargetSummary["authMode"] {
  const mode = cfg.gateway?.auth?.mode;
  if (mode === "token" || mode === "password") {
    return mode;
  }
  if (cfg.gateway?.auth?.token) {
    return "token";
  }
  if (cfg.gateway?.auth?.password) {
    return "password";
  }
  return "none";
}

function buildSummary(): StatusClientSummary {
  const cfg = loadConfig();
  const configPath = resolveConfigPath();
  const stateDir = resolveStateDir();
  const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
  const tls = Boolean(cfg.gateway?.tls?.enabled);
  const port = resolveGatewayPort(cfg);
  const fallbackUrl = `${tls ? "wss" : "ws"}://127.0.0.1:${port}`;
  const remoteUrl = cfg.gateway?.remote?.url?.trim() || "";

  const gateway: GatewayTargetSummary = {
    mode,
    url: mode === "remote" ? remoteUrl || fallbackUrl : fallbackUrl,
    tls,
    authMode: resolveAuthMode(cfg),
  };

  return { configPath, stateDir, gateway };
}

export async function statusClientCommand(opts: StatusClientOptions = {}): Promise<void> {
  const summary = buildSummary();
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("OpenClaw status (client build)");
  console.log(`Config: ${summary.configPath}`);
  console.log(`State:  ${summary.stateDir}`);
  console.log(`Gateway mode: ${summary.gateway.mode}`);
  console.log(`Gateway target: ${summary.gateway.url}`);
  console.log(`Gateway TLS: ${summary.gateway.tls ? "enabled" : "disabled"}`);
  console.log(`Gateway auth: ${summary.gateway.authMode}`);
}
