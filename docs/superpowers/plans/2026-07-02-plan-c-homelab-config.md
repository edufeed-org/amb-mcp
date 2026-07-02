# Plan C — homelab: Swap Consumers to Client-Credentials, Then Drop the Legacy Bearer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the Ansible-managed homelab so edufeed-app and nope-chatbot authenticate to amb-mcp via Keycloak client-credentials, then remove the shared static `LEGACY_BEARER_TOKEN` from the amb-mcp deployment once code + consumers are migrated.

**Architecture:** Today all three services share one vault secret (`vault_amb_mcp_bearer_token`): amb-mcp accepts it as `LEGACY_BEARER_TOKEN`, and both consumers send it as `AMB_MCP_BEARER_TOKEN`. This plan gives each consumer its own Keycloak service-account client secret (stored in the vault), rewrites the consumer env templates to the client-credentials variables the migrated apps now read, and finally strips `LEGACY_BEARER_TOKEN` from amb-mcp's compose file. Config-only; no role logic changes.

**Tech Stack:** Ansible, Jinja2 templates, ansible-vault, docker-compose.

## Global Constraints

- **Repo:** homelab, at `/home/laoc/coding/homelab`. This is a *different* git repo from amb-mcp — commit there, not in amb-mcp.
- **Sequencing (from the spec):** consumers migrate FIRST → verify live → drop the legacy bearer LAST. Concretely: Tasks 1-3 (consumer env + secrets) deploy while amb-mcp still accepts both credentials; Task 4 (remove `LEGACY_BEARER_TOKEN`) runs only after the amb-mcp code drop (separate plan `2026-07-02-plan-c-amb-mcp-drop-legacy-bearer.md`) is built and deployed. See `docs/superpowers/specs/2026-07-02-client-credentials-migration-design.md`.
- **Preconditions (verify, do not create here):** the Keycloak realm already defines service-account clients `edufeed-app` and `nope-chatbot` with client secrets and an `amb-mcp` audience mapper (tokens carry `aud: amb-mcp`, matching amb-mcp's `OAUTH_AUDIENCE`). Realm changes are out of scope for this plan.
- **Secrets:** the two client secrets live ONLY in `inventory/group_vars/all/vault.yml` (ansible-vault encrypted). Never write a secret into a plaintext template, playbook, commit message, or log. The token URL and client IDs are NOT secrets and may be inlined in templates.
- **Token endpoint (public constant):** `https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token`.
- **High blast radius:** every `ansible-playbook` run against real hosts is live and user-visible. Each deploy step below is GATED — run `--check --diff` yourself, then STOP and get explicit user confirmation before the real apply. Never apply without that confirmation.
- **Add, never revert:** if the working tree has unrelated uncommitted changes, leave them; stage only the files each task names.

---

### Task 1: Add per-consumer client secrets to the vault

**Files:**
- Modify (encrypted): `inventory/group_vars/all/vault.yml`

**Interfaces:**
- Produces: two new vault variables — `vault_edufeed_app_amb_mcp_client_secret` and `vault_nope_chatbot_amb_mcp_client_secret` — consumed by Tasks 2 and 3.

- [ ] **Step 1: Retrieve the two client secrets from Keycloak (user-driven)**

The secrets are the `edufeed-app` and `nope-chatbot` service-account client secrets from the `edufeed` realm (Keycloak Admin → Clients → *client* → Credentials). This step is the user's — the agent must NOT fetch or handle live secrets. Ask the user to have both values ready for the vault edit.

- [ ] **Step 2: Add the variables to the vault**

The vault is encrypted; edit it interactively (the agent cannot decrypt it). Have the user run:

```bash
cd /home/laoc/coding/homelab
ansible-vault edit inventory/group_vars/all/vault.yml
```

Add two entries (keeping the existing `vault_amb_mcp_bearer_token` untouched until Task 4):

```yaml
vault_edufeed_app_amb_mcp_client_secret: "<edufeed-app service-account secret>"
vault_nope_chatbot_amb_mcp_client_secret: "<nope-chatbot service-account secret>"
```

- [ ] **Step 3: Verify the variables decrypt and are visible to the inventory**

Run (prints only whether the keys exist, never the values):

```bash
ansible -i inventory localhost -m debug \
  -a "msg={{ (vault_edufeed_app_amb_mcp_client_secret is defined) and (vault_nope_chatbot_amb_mcp_client_secret is defined) }}" \
  --ask-vault-pass
```

Expected: `"msg": true`. If `false`, the keys were mis-typed in the vault.

- [ ] **Step 4: No git commit**

`vault.yml` changes are committed together with the templates that use them (Tasks 2-3) so the deploy is atomic. Nothing to commit in this task.

---

### Task 2: Migrate edufeed-app to client-credentials

**Files:**
- Modify: `playbooks/deploy_edufeed_app.yml` (three AMB MCP env blocks — around lines 257-258, 586-587, 1058-1059)

**Interfaces:**
- Consumes: `vault_edufeed_app_amb_mcp_client_secret` (Task 1).
- Produces: env vars `AMB_MCP_TOKEN_URL`, `AMB_MCP_CLIENT_ID`, `AMB_MCP_CLIENT_SECRET`, `AMB_MCP_SCOPE` for the edufeed-app container; matches the variables `src/lib/server/ambMcpToken.js` reads (see `2026-07-02-plan-c-edufeed-app-client-credentials.md`).

- [ ] **Step 1: Replace all three AMB MCP env blocks**

There are three identical blocks (the playbook renders env for multiple app instances). In each, replace:

```
      AMB_MCP_URL=https://mcp.amb.edufeed.org/mcp
      AMB_MCP_BEARER_TOKEN={{ vault_amb_mcp_bearer_token }}
```

with:

```
      AMB_MCP_URL=https://mcp.amb.edufeed.org/mcp
      AMB_MCP_TOKEN_URL=https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token
      AMB_MCP_CLIENT_ID=edufeed-app
      AMB_MCP_CLIENT_SECRET={{ vault_edufeed_app_amb_mcp_client_secret }}
      AMB_MCP_SCOPE=mcp:read mcp:extract
```

Confirm all three were changed:

Run: `grep -n "AMB_MCP_BEARER_TOKEN\|AMB_MCP_CLIENT_SECRET" playbooks/deploy_edufeed_app.yml`
Expected: three `AMB_MCP_CLIENT_SECRET` lines, zero `AMB_MCP_BEARER_TOKEN` lines.

Note: `AMB_MCP_URL` is kept (the app still needs the endpoint). The migrated app's token provider is what changes.

- [ ] **Step 2: Render-check the playbook (no apply)**

Run:

```bash
ansible-playbook -i inventory playbooks/deploy_edufeed_app.yml --check --diff --ask-vault-pass
```

Expected: the diff shows the new `AMB_MCP_TOKEN_URL`/`AMB_MCP_CLIENT_ID`/`AMB_MCP_CLIENT_SECRET`/`AMB_MCP_SCOPE` lines and the removal of `AMB_MCP_BEARER_TOKEN`, with the secret masked/rendered from the vault. No template errors (an undefined `vault_edufeed_app_amb_mcp_client_secret` would fail here → go back to Task 1).

- [ ] **Step 3: GATE — get user confirmation, then apply**

STOP. Present the `--check --diff` result to the user and get explicit confirmation before the live apply. On confirmation:

```bash
ansible-playbook -i inventory playbooks/deploy_edufeed_app.yml --ask-vault-pass
```

- [ ] **Step 4: Verify the live path**

After deploy, exercise edufeed-app's `/api/enrich` (the endpoint that calls amb-mcp's `extract_metadata`) against a real resource and confirm it succeeds — i.e. the app obtained a client-credentials token and amb-mcp honored the `mcp:extract` scope. A `502/ai_unavailable` envelope means the token flow failed; check the app logs (the token provider throws a descriptive error without logging the secret).

- [ ] **Step 5: Commit (with the vault change from Task 1)**

```bash
git add playbooks/deploy_edufeed_app.yml inventory/group_vars/all/vault.yml
git commit -m "feat(edufeed-app): authenticate to amb-mcp via Keycloak client-credentials"
```

---

### Task 3: Migrate nope-chatbot to client-credentials

**Files:**
- Modify: `roles/nope-chatbot/templates/env.j2` (lines 19-20)

**Interfaces:**
- Consumes: `vault_nope_chatbot_amb_mcp_client_secret` (Task 1).
- Produces: env vars `AMB_MCP_TOKEN_URL`, `AMB_MCP_CLIENT_ID`, `AMB_MCP_CLIENT_SECRET`, `AMB_MCP_SCOPE` for the chatbot container; the chatbot's `mcp-servers.json` `oauth` block resolves these via env substitution (see `2026-07-02-plan-c-chatbot-client-credentials.md`).

- [ ] **Step 1: Replace the AMB MCP env block**

In `roles/nope-chatbot/templates/env.j2`, replace:

```
AMB_MCP_URL=https://mcp.amb.edufeed.org/mcp
AMB_MCP_BEARER_TOKEN={{ vault_amb_mcp_bearer_token }}
```

with:

```
AMB_MCP_URL=https://mcp.amb.edufeed.org/mcp
AMB_MCP_TOKEN_URL=https://auth.edufeed.org/realms/edufeed/protocol/openid-connect/token
AMB_MCP_CLIENT_ID=nope-chatbot
AMB_MCP_CLIENT_SECRET={{ vault_nope_chatbot_amb_mcp_client_secret }}
AMB_MCP_SCOPE=mcp:read mcp:extract
```

Confirm:

Run: `grep -n "AMB_MCP_BEARER_TOKEN\|AMB_MCP_CLIENT_SECRET" roles/nope-chatbot/templates/env.j2`
Expected: one `AMB_MCP_CLIENT_SECRET` line, zero `AMB_MCP_BEARER_TOKEN` lines.

- [ ] **Step 2: Render-check the chatbot deploy (no apply)**

Run the chatbot's deploy playbook in check mode (substitute the actual playbook name if different from below):

```bash
ansible-playbook -i inventory playbooks/deploy_nope_chatbot.yml --check --diff --ask-vault-pass
```

Expected: the `env.j2` diff shows the four new client-credentials lines and the removal of `AMB_MCP_BEARER_TOKEN`, secret rendered from the vault, no template errors. (If the playbook filename differs, find it with `grep -rl nope-chatbot playbooks/`.)

- [ ] **Step 3: GATE — get user confirmation, then apply**

STOP. Present the diff and get explicit user confirmation before the live apply. On confirmation, run the same command without `--check`.

- [ ] **Step 4: Verify the live path**

After deploy, run a chatbot conversation that triggers an amb-mcp tool call (e.g. a search or an extract) and confirm the tool call succeeds — the registry obtained a client-credentials token and amb-mcp honored it. A `401`/"Unauthorized" in the chatbot logs on the amb server means the token flow failed.

- [ ] **Step 5: Commit**

```bash
git add roles/nope-chatbot/templates/env.j2
git commit -m "feat(nope-chatbot): authenticate to amb-mcp via Keycloak client-credentials"
```

---

### Task 4: Drop `LEGACY_BEARER_TOKEN` from the amb-mcp deployment (LAST)

**Files:**
- Modify: `roles/amb-mcp/templates/docker-compose.yml.j2` (lines 18-20)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This removes the last runtime use of `vault_amb_mcp_bearer_token`.

**Precondition:** run this ONLY after (a) both consumers are migrated + verified (Tasks 2-3) AND (b) the amb-mcp code that removes the legacy branch (`2026-07-02-plan-c-amb-mcp-drop-legacy-bearer.md`) is built and its image is deployed. If amb-mcp still runs the old image, leaving `LEGACY_BEARER_TOKEN` set is harmless; removing it early is also harmless (consumers no longer send it) — but do not do so until consumers are confirmed migrated, so a rollback path stays open.

- [ ] **Step 1: Remove the legacy env line and its comment**

In `roles/amb-mcp/templates/docker-compose.yml.j2`, delete lines 18-20:

```
      # Transitional: keep the old static bearer working while first-party
      # consumers migrate to client-credentials. Remove once migration done.
      - "LEGACY_BEARER_TOKEN={{ vault_amb_mcp_bearer_token }}"
```

Confirm:

Run: `grep -rn "LEGACY_BEARER_TOKEN\|vault_amb_mcp_bearer_token" roles/ playbooks/`
Expected: no matches (all three original references — compose, chatbot env, edufeed-app playbook — are now gone).

- [ ] **Step 2: Retire the now-unused vault secret (optional cleanup)**

`vault_amb_mcp_bearer_token` is no longer referenced anywhere. Have the user remove it from the vault to avoid a dangling stale secret:

```bash
ansible-vault edit inventory/group_vars/all/vault.yml
```

(Delete the `vault_amb_mcp_bearer_token:` line.) This is cleanup, not correctness — safe to defer.

- [ ] **Step 3: Render-check the amb-mcp deploy (no apply)**

Run the amb-mcp deploy playbook in check mode:

```bash
ansible-playbook -i inventory playbooks/deploy_amb_mcp.yml --check --diff --ask-vault-pass
```

(Substitute the real playbook name; find it with `grep -rl amb.mcp playbooks/` if needed.)
Expected: the compose diff shows the `LEGACY_BEARER_TOKEN` line removed; no template errors (a leftover reference to the removed vault var would fail here).

- [ ] **Step 4: GATE — get user confirmation, then apply**

STOP. Present the diff and get explicit user confirmation before the live apply. On confirmation, run the same command without `--check`.

- [ ] **Step 5: Verify amb-mcp still serves both anonymous reads and JWT extract**

After deploy:
- Anonymous read: a tokenless `/mcp` initialize + a read tool call still succeeds.
- JWT extract: a consumer (edufeed-app `/api/enrich` or the chatbot) still succeeds via its client-credentials token.
- Legacy token now rejected: a request bearing the old static secret now returns 401 (proves the legacy path is truly gone — expected end-state).

- [ ] **Step 6: Commit**

```bash
git add roles/amb-mcp/templates/docker-compose.yml.j2
git commit -m "chore(amb-mcp): drop LEGACY_BEARER_TOKEN after client-credentials migration"
```

---

## Self-Review

- **Spec coverage:** The spec's "homelab: env swap" maps to Tasks 1-3 (per-consumer secrets + client-credentials env), and the spec's "remove legacy LAST" ordering maps to Task 4 with an explicit precondition tying it to the amb-mcp code-drop plan. The zero-downtime sequencing (consumers first → verify → legacy last) is enforced by task order + the Task 4 precondition + the Global Constraints deploy gates.
- **Placeholder scan:** Exact files, line ranges, literal before/after blocks, and exact verification commands are given. The only non-literals are (a) the two secret *values*, which are intentionally user-supplied via `ansible-vault edit` (never in the plan), and (b) two deploy playbook filenames flagged with a `grep -rl` fallback to resolve them — a deliberate lookup, not a vague placeholder.
- **Type consistency:** The env var names produced here (`AMB_MCP_TOKEN_URL`, `AMB_MCP_CLIENT_ID`, `AMB_MCP_CLIENT_SECRET`, `AMB_MCP_SCOPE`) match exactly what the two consumer plans' token providers read. The vault var names (`vault_edufeed_app_amb_mcp_client_secret`, `vault_nope_chatbot_amb_mcp_client_secret`) are defined in Task 1 and referenced verbatim in Tasks 2-3. `vault_amb_mcp_bearer_token` is removed only in Task 4, after its last consumer reference is gone.
