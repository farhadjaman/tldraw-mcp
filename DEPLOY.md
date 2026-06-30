# Deploying behind an existing nginx

This VM already runs nginx (TLS + reverse proxy) and other dockerized MCP servers.
We add tldraw as two containers bound to **loopback host ports**, and nginx proxies to
them. No Caddy, no extra public ports.

```
                          nginx (host, :443, your TLS)
   https://mcp.farhadjaman.com/tldraw-mcp ──► 127.0.0.1:3102  (tldraw MCP server, /mcp)
   https://mcp.farhadjaman.com/discord-mcp ─► 127.0.0.1:<discord port>/mcp
   https://tldraw.farhadjaman.com/ ─────────► 127.0.0.1:3100  (tldraw canvas, Next.js)
```

> **Why the canvas gets its own subdomain:** tldraw is an MCP server *and* a browser UI.
> The `/tldraw-mcp` path is just the MCP endpoint Claude talks to. The canvas (a Next.js
> app rooted at `/`) is served at `tldraw.farhadjaman.com`. Claude → MCP and you →
> canvas both reach the *same* server process internally, so they share one live board.

## 1. Pick free host ports

Run the checks (see README / chat) and confirm `3100` and `3102` are free, plus note
your discord container's host port. If either is taken, change the **host** side in
`docker-compose.yml` (e.g. `127.0.0.1:3110:3000`) and update nginx to match.

## 2. Bring up the containers

```bash
git clone <your-repo> tldraw-mcp
cd tldraw-mcp
docker compose up -d --build

# sanity check (loopback, before nginx):
curl http://127.0.0.1:3102/healthz          # {"ok":true}
curl -i http://127.0.0.1:3100 | head -n1     # 200 (canvas)
```

## 3. nginx — new site file

Create `/etc/nginx/sites-available/mcp-and-tldraw` with two `server` blocks listening
on **80** (certbot adds the TLS/443 parts in step 5). Discord is mapped here too, so the
old `discord-mcp.farhadjaman.com` block can be retired once verified.

```nginx
# ---- MCP aggregator: mcp.farhadjaman.com/{tldraw-mcp,discord-mcp} ----
server {
    listen 80;
    server_name mcp.farhadjaman.com;

    # tldraw MCP (Streamable HTTP, single endpoint) -> tldraw server's /mcp
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

    # discord MCP -> existing discord container at 8085/mcp
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

# ---- tldraw canvas UI: tldraw.farhadjaman.com ----
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

## 4. DNS

A-records → VM IP: `mcp.farhadjaman.com` and `tldraw.farhadjaman.com`.

## 5. Certs + reload

```bash
sudo certbot --nginx -d mcp.farhadjaman.com -d tldraw.farhadjaman.com
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Connect Claude

- Settings → Connectors → Add custom connector → `https://mcp.farhadjaman.com/tldraw-mcp`
- or: `claude mcp add --transport http tldraw https://mcp.farhadjaman.com/tldraw-mcp`

Open `https://tldraw.farhadjaman.com`, ask Claude to draw a shape, and it appears.

## Notes

- **No auth yet** — anyone with the `/tldraw-mcp` URL can draw. Add a token before
  sharing it widely.
- **Single instance** of the `server` container (in-memory event bus). Don't scale it.
- **Verify the endpoint without Claude:**
  ```bash
  curl -s -X POST https://mcp.farhadjaman.com/tldraw-mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
  ```
