// Moves a server set up while the gateway was called the dashboard: renames its settings in .env
// and removes the old container, which holds the gateway's port. The data volume stays.
// Run once from the repository root: bun run server:migrate-to-gateway
const ENV_PATH = ".env";
const OLD_NAMES = /^(\s*)BELLACLAW_DASHBOARD_(PUBLIC_URL|SECRET|HOSTNAME|PORT|DB_PATH)=/gm;

const envFile = Bun.file(ENV_PATH);

if (await envFile.exists()) {
  const text = await envFile.text();
  const renamed = text.replace(OLD_NAMES, "$1BELLACLAW_GATEWAY_$2=");

  if (renamed === text) {
    console.log(".env: no BELLACLAW_DASHBOARD_* setting to rename");
  } else {
    await Bun.write(ENV_PATH, renamed);
    console.log(".env: BELLACLAW_DASHBOARD_* settings renamed to BELLACLAW_GATEWAY_*");
  }
} else {
  console.log("No .env in this directory: nothing to rename");
}

const removal = Bun.spawnSync(["podman", "rm", "-f", "--ignore", "bellaclaw-dashboard"], {
  stdout: "inherit",
  stderr: "inherit",
});

if (removal.exitCode !== 0) {
  process.exit(removal.exitCode);
}
