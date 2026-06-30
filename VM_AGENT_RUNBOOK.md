# VM Agent Runbook — Deploy tldraw-mcp

You are a Claude Code agent running **on the VM** (`hermes-agent-01`, Ubuntu, user
`farhad`, has `sudo`). Your job: deploy this project and wire it into the existing
nginx so Claude can reach it at `https://mcp.farhadjaman.com/tldraw-mcp` and the canvas
at `https://tldraw.farhadjaman.com`.

Work top to bottom. Each step has a **verify** gate — do not proceed until it passes.
If a verify fails, stop and report; do not improvise around it.

---

## 0. Mission & architecture

Two Docker containers, bound to **loopback only**, fronted by the VM's existing nginx
(which already does TLS via certbot):

```
nginx (:443)
  mcp.farhadjaman.com/tldraw-mcp  -> 127.0.0.1:3102/mcp   (tldraw MCP server)
  mcp.farhadjaman.com/discord-mcp -> 127.0.0.1:8085/mcp   (EXISTING discord container)
  tldraw.farhadjaman.com/         -> 127.0.0.1:3100       (tldraw canvas, Next.js)
```

The tldraw MCP server and the canvas talk through an **in-memory event bus inside one
process**, so the `server` container must run as exactly **one** instance. The canvas's
`/api/*` routes reach the server over the internal compose network (`BRIDGE_URL`), not
through nginx.

## 1. HARD CONSTRAINTS — do not violate

- **Do NOT disturb the running containers** `discord-mcp` (127.0.0.1:8085) or
  `vertex-proxy`/litellm (0.0.0.0:4000). Never `docker stop`/`rm`/`restart` them, never
  reuse their ports.
- **Do NOT remove or edit the existing `discord-mcp.farhadjaman.com` nginx block** until
  Step 7 proves the new `/discord-mcp` path works. It is the fallback.
- **Do NOT open new public ports.** Only nginx (80/443) faces the internet. Our
  containers bind `127.0.0.1` only.
- **Never run `systemctl restart nginx` after only editing config without `nginx -t`
  first.** Always `sudo nginx -t` then `sudo systemctl reload nginx` (reload, not
  restart).
- **No secrets in git.** Never commit a `.env`. There is no auth yet by design.
- If anything is ambiguous or a verify fails twice, **stop and report** — don't keep
  retrying the same action.

## 2. Preconditions — verify the environment

```bash
docker --version && docker compose version
nginx -v
which certbot
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

**Verify:** docker + compose + nginx + certbot all present; `discord-mcp` (8085) and the
litellm proxy (4000) are running. If not, stop and report.

## 3. Get the code

The repo is `git@github.com:farhadjaman/tldraw-mcp.git`.

```bash
cd ~
# Try SSH; if the VM has no key with repo access, use HTTPS with a token instead.
git clone git@github.com:farhadjaman/tldraw-mcp.git tldraw-mcp || \
git clone https://github.com/farhadjaman/tldraw-mcp.git tldraw-mcp
cd ~/tldraw-mcp
```

**Verify:** `ls docker-compose.yml server/Dockerfile Dockerfile.web` all exist.

## 4. Confirm the chosen host ports are free

We use `127.0.0.1:3100` (canvas) and `127.0.0.1:3102` (server).

```bash
for p in 3100 3102; do
  sudo ss -tlnp "( sport = :$p )" | grep -q LISTEN && echo "port $p = IN USE" || echo "port $p = free"
done
```

**Verify:** both report `free`. If one is taken, change the **host** side in
`docker-compose.yml` (e.g. `127.0.0.1:3110:3000`) and remember the new number for the
nginx step.

## 5. Build & start the containers

```bash
cd ~/tldraw-mcp
docker compose up -d --build
docker compose ps
```

> The web image runs `next build` (tldraw is large). If the build is killed/OOMs on a
> small VM, add swap and retry:
> `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`

**Verify (on loopback, before nginx):**

```bash
curl -s http://127.0.0.1:3102/healthz                  # -> {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100   # -> 200
```

Both must pass. If `web` isn't 200, check `docker compose logs web`.

## 6. nginx — add the new site

Create `/etc/nginx/sites-available/mcp-and-tldraw` with the content below. (If you
changed host ports in Step 4, update `3102`/`3100` here to match.)

```nginx
# ---- MCP aggregator ----
server {
    listen 80;
    server_name mcp.farhadjaman.com;

    location = /tldraw-mcp {
        proxy_pass http://127.0.0.1:3102/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location = /discord-mcp {
        proxy_pass http://127.0.0.1:8085/mcp;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# ---- tldraw canvas UI ----
server {
    listen 80;
    server_name tldraw.farhadjaman.com;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;        # tldraw canvas uses SSE on /api/events
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mcp-and-tldraw /etc/nginx/sites-enabled/
sudo nginx -t
```

**Verify:** `nginx -t` reports `syntax is ok` / `test is successful`. Do **not** reload
yet if it failed — fix and re-test. On success:

```bash
sudo systemctl reload nginx
```

## 7. DNS gate — required before certbot

certbot will fail unless both names already resolve to this VM's public IP.

```bash
MYIP=$(curl -s ifconfig.me); echo "VM public IP: $MYIP"
for h in mcp.farhadjaman.com tldraw.farhadjaman.com; do
  echo -n "$h -> "; dig +short "$h" | tail -1
done
```

**Verify:** both names resolve to `$MYIP`. If not, **stop and tell the user to add the
A-records** (`mcp` and `tldraw` → this IP) at their DNS provider, then resume here.

## 8. Issue TLS certificates

```bash
sudo certbot --nginx -d mcp.farhadjaman.com -d tldraw.farhadjaman.com --non-interactive --agree-tos -m jamanfarhad1@gmail.com
sudo nginx -t && sudo systemctl reload nginx
```

**Verify:** certbot reports success and adds `listen 443 ssl` to both server blocks.

## 9. End-to-end verification (through HTTPS)

```bash
# tldraw MCP handshake
curl -s -X POST https://mcp.farhadjaman.com/tldraw-mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# discord MCP handshake via the NEW path
curl -s -X POST https://mcp.farhadjaman.com/discord-mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# canvas
curl -s -o /dev/null -w '%{http_code}\n' https://tldraw.farhadjaman.com
```

**Verify:**
- tldraw → JSON with `"serverInfo":{"name":"TldrawServer"...}`
- discord → JSON `result` with its `serverInfo`
- canvas → `200`

If the **discord** handshake fails (some MCP servers use a second message path that an
exact-match location can't carry), do NOT delete the old discord block. Report it — the
fix is to switch `/discord-mcp` to a stripped prefix, which changes its connector URL.
**tldraw is independent and should still pass.**

## 10. Report back

Summarize to the user:
- Container status (`docker compose ps`)
- The three verify results from Step 9
- The connector URLs: `https://mcp.farhadjaman.com/tldraw-mcp`,
  `https://mcp.farhadjaman.com/discord-mcp`, canvas `https://tldraw.farhadjaman.com`
- Whether the old `discord-mcp.farhadjaman.com` block can now be retired (only if Step 9
  discord check passed) — **ask before removing it.**

Do NOT add the connectors in Claude yourself; the user does that in the Claude UI.

---

## Troubleshooting

- **`web` build OOM/killed:** add swap (see Step 5) and `docker compose up -d --build` again.
- **`/healthz` not responding:** `docker compose logs server | tail -50`. Expect
  `HTTP Server running on port 3002`.
- **Canvas loads but shapes never appear / snapshot times out:** confirm only ONE
  `server` container is running (`docker compose ps`); the in-memory bus breaks with
  duplicates. The server auto-claims its port, so a second copy elsewhere would have
  stepped on it.
- **502 from nginx:** the upstream port in the nginx block doesn't match the published
  host port in `docker-compose.yml`. Reconcile them.
- **certbot fails:** almost always DNS not yet propagated (Step 7) or ports 80/443
  blocked by the cloud firewall/security group.

## Rollback

```bash
cd ~/tldraw-mcp && docker compose down
sudo rm -f /etc/nginx/sites-enabled/mcp-and-tldraw
sudo nginx -t && sudo systemctl reload nginx
```
This removes only the tldraw stack and its nginx site; discord and litellm are untouched.

## Updating later

```bash
cd ~/tldraw-mcp && git pull && docker compose up -d --build
```
