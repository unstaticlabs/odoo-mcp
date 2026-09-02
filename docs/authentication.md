# Authentication and credential operations

The MCP supports direct request credentials, environment credentials for stdio, and OAuth enrollment for hosted clients. All three require an active governed Odoo Agent and resolve to the same `OdooPrincipal` and capability registry. Human API keys are rejected.

Odoo remains authoritative for identity, ACLs, record rules, field access, company scope, public methods, workflow state, and irreversible-action policy. The MCP never treats tool visibility or model output as permission.

## Configured targets

Every submitted public origin/database must match an operator-configured target. The target maps the public canonical origin used in record links to a private origin used for VPS-local traffic.

Single target:

```dotenv
ODOO_PUBLIC_ORIGIN=https://odoo.example.com
ODOO_INTERNAL_ORIGIN=http://odoo:8069
ODOO_DATABASE=production
```

Multiple targets:

```dotenv
ODOO_TARGETS_JSON=[{"id":"primary","publicOrigin":"https://odoo.example.com","internalOrigin":"http://odoo:8069","databases":["production"]}]
```

Public origins must be HTTPS. Loopback HTTP can be enabled only for development with `MCP_ALLOW_LOCAL_HTTP_ODOO=true`. Internal origins may use HTTP on the trusted Compose network. Credentials, paths, queries, and fragments are rejected, and redirects are never followed.

## Direct HTTP

Send all three headers on each MCP request:

```text
X-Odoo-Url: https://odoo.example.com
X-Odoo-Database: production
X-Odoo-Api-Key: <key>
```

Do not put the Odoo key in `Authorization`; that header is reserved for MCP OAuth. Direct keys are request-local and are not persisted by the MCP.

Create the Agent and its credential in Odoo **My Agents**. The key authenticates
the Agent, not its owner. Odoo continuously intersects the Agent's delegated
access with the owner's current authority and the platform safety policy.

## stdio

Set `ODOO_URL`, `ODOO_DATABASE`, and `ODOO_API_KEY` in the local client process. `ODOO_URL` and the database must still match configured targets. The stdio transport exposes the default profile.

## OAuth enrollment

Enable the Better Auth provider and mounted SQLite vault:

```dotenv
MCP_OAUTH_ENABLED=true
MCP_OAUTH_DATABASE=/data/oauth.sqlite
BETTER_AUTH_SECRET_FILE=/run/secrets/better_auth_secret
MCP_CREDENTIAL_ENCRYPTION_KEY_FILE=/run/secrets/credential_encryption_key
MCP_OAUTH_TRUSTED_ORIGINS=https://chatgpt.com,https://claude.ai
```

The vault parent directory must be private to the service identity. Startup
enforces mode `0700` on that directory and mode `0600` on the SQLite database,
WAL, and shared-memory files, and fails closed if those modes cannot be verified.

Generate independent secrets:

```bash
openssl rand -base64 48 > secrets/better_auth_secret
printf 'base64:' > secrets/credential_encryption_key
openssl rand -base64 32 >> secrets/credential_encryption_key
chmod 600 secrets/better_auth_secret secrets/credential_encryption_key
```

The credential-encryption value must decode to exactly 32 bytes. Enrollment:

1. receives the configured Odoo URL/database/key tuple;
2. validates the target mapping;
3. calls `usl.agent.current_identity` and requires an active Agent credential;
4. encrypts the API key with AES-256-GCM;
5. stores the enrollment in the SQLite volume;
6. continues the authorization-code/PKCE flow.

Default access-token life is one hour. Rotating refresh tokens last 180 days. An enrollment has a hard one-year ceiling and must then reconnect. `/oauth/revoke` removes the enrollment and associated access, refresh, and consent grants. Tokens fail immediately after the enrollment is removed or its configured target disappears.

Run schema initialization/migrations before rollout:

```bash
npm run build
npm run oauth:migrate
```

Create a consistent SQLite backup to a new absolute path:

```bash
npm run oauth:backup -- /backups/odoo-mcp-oauth-2026-08-30.sqlite
```

The backup command creates or repairs the destination with mode `0600`. Keep
the containing backup directory restricted and owned by the backup service
identity.

Back up the secret files separately. Restoring the database without the same credential-encryption key makes enrolled API keys unreadable. Changing the Better Auth secret invalidates existing token material.

No grants from the previous deployment architecture are imported. Each hosted client reconnects once after migration. The human authorizes the hosted client, while the enrolled Agent performs the Odoo work and owns its audit trail.

## Operational handling

- Use a dedicated governed Agent with the minimum appropriate application access and companies.
- Grant broad read/write access only when the workflow requires it; irreversible authority is a separate Odoo permission.
- Rotate safely with **Create replacement**, reconnect the enrollment, confirm the new key's last use, then revoke the old key.
- Do not log or pass secret values through shell history, issue descriptions, evaluation fixtures, or MCP arguments.
- Return `401` for invalid/missing MCP authentication and let Odoo return record/method permission failures through structured tool errors.
