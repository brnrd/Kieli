# Standalone Node.js installation

Kieli can run on a Linux host without Docker, AWS or an identity provider. Use Node.js 24.2+ and an HTTPS reverse proxy. SQLite is the default local database; DynamoDB remains available through the normal storage configuration.

## Build and configure

From the intended checkout, using dependencies installed for the host's OS/architecture:

```sh
npm ci
npm run check
npm test
npm run build
```

Place the built checkout under `/opt/kieli` (or adapt the example service), including `dist/`, `node_modules/`, `package.json` and the source/operator scripts needed by the bootstrap/recovery CLI. Keep the development dependencies needed to run those operator scripts, or provide them in a separate trusted operator checkout. Keep application files read-only to the service account. Create a dedicated unprivileged `kieli` system user/group. The [systemd unit](../infra/standalone/kieli.service) assumes Node is at `/usr/bin/node`; change it to the actual Node 24 executable if necessary.

Copy the [environment example](../infra/standalone/kieli.env.example) to `/etc/kieli.env`, set your exact public HTTPS origin and protect the file with root ownership and mode `0600`. Install the service unit under `/etc/systemd/system/`. Its `StateDirectory=kieli` creates `/var/lib/kieli` owned by the service user for SQLite; `ProtectSystem=strict` leaves application files read-only. Do not use the real database for test fixtures.

Configure the reverse proxy to forward the public HTTPS host to `127.0.0.1:8080`, including the correct original Host header. Keep the application loopback-bound. Kieli uses the configured exact `APP_ORIGIN`; do not replace origin validation with a permissive wildcard. Configure proxy request/time limits for imports, exports and MCP. TLS certificates and proxy setup are host-specific and are not provisioned by the example.

## Initialize and start

For local accounts, initialize the first administrator with the existing [bootstrap command](built-in-accounts.md#first-administrator), using the **same** origin, storage and database path as the service. Run bootstrap as the `kieli` user after creating its state directory with appropriate ownership. The operator's command environment must include the deployment values; the service's `EnvironmentFile` is not automatically loaded into an unrelated shell. Do not pass passwords on the command line. Follow the one-time activation link privately.

Then enable/start the unit:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now kieli
sudo systemctl status kieli
```

These commands are installation instructions, not commands run during repository verification. Without systemd, run `node dist/server/entry.mjs` under your host's process supervisor with the same environment. A `.env` file is not automatically loaded by that direct command: explicitly configure the supervisor environment or use Node's `--env-file` option.

OIDC and SAML use their existing configuration instead of local bootstrap; see [OIDC](okta.md) and [SAML](saml.md). Production rejects demo mode. No built-in automatic translation service is introduced.

## Maintain and upgrade

Schedule [snapshots](project-history.md) and optional [identity reconciliation](sso-lifecycle.md) every five minutes with the same protected maintenance token and external origin. Each task uses the existing authenticated maintenance endpoint. AWS installs configure their scheduler automatically; standalone hosts must configure theirs.

Use `journalctl -u kieli` for service logs and configure host log retention, monitoring and regular SQLite-consistent backups. Test restoration and account recovery. Keep the database outside the code/release directory, stop/restart the service for an upgrade and retain the previous application release for rollback. Rebuild dependencies on the deployment platform when native modules or Node versions change.

The example unit and documentation are not a tested host deployment: no users, proxy settings, real data or host services were created or modified during development. Run auth/role, import/export, MCP, snapshot and restore checks on the actual host before opening team access.

Service isolation settings follow the [systemd execution reference](https://freedesktop.org/software/systemd/man/latest/systemd.exec.html). Validate the unit on Linux with `systemd-analyze verify infra/standalone/kieli.service` after adapting executable paths.
