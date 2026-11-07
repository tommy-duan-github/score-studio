# Score Studio in Docker

The image is CPU-only (linux/amd64). PyTorch, DuET (code and weights) and Transkun are downloaded while it builds,
so the running container needs no internet access for transcription. Only the DeepSeek assistant and MCP `url`
uploads go online.

## Run

```bash
docker compose up -d --build
```

Open `http://localhost:19287` (or `http://<host-ip>:19287` from another machine). Before starting, you can edit
`docker-compose.yml` to set `PUID`/`PGID` (owner of `./data` and `./exports`), a password, or an MCP token.

Without compose:

```bash
docker build -t score-studio:1.1.0 .
docker run -d --name score-studio -p 19287:19287 -v ./data:/data -v ./exports:/exports score-studio:1.1.0
```

To use another port, change the host side of the mapping (`8080:19287`), or set `PORT` and map both sides.

## Performance

Click **Performance** at the bottom of the sidebar.

| Preset | Cores used | Priority |
|---|---|---|
| Eco | about 1/4 of the cores | Background (nice 19) |
| Balanced (Docker default) | about 1/2 of the cores | Low (nice 10) |
| Full | all cores | Normal |
| Custom | the cores you click | your choice |

- Cores apply immediately, including to a transcription that's already running. The highest-numbered cores are used
  first, because core 0 usually handles the OS and interrupts.
- Lowering priority applies at once. Raising it applies from the next transcription, because Linux doesn't let
  an unprivileged process raise its own priority.
- Threads per transcription equal the number of cores, capped by any Docker `cpus:` limit.
- Each transcription runs in its own process, which ends when the job is done, so its RAM is returned.
  A long audio file uses about 2–3 GB while it's transcribing. MIDI files need much less.
- For hard limits, uncomment `cpus` or `mem_limit` in `docker-compose.yml`. The dialog shows the container cap and
  stays within it.

On a typical CPU, MIDI takes about 1–3 minutes. Audio takes several minutes per minute of music.

## MCP (AI agents)

Setting `SCORE_STUDIO_MCP_TOKEN` (16+ characters, e.g. `openssl rand -base64 32`) turns on stateless
Streamable HTTP MCP at `POST /mcp`. Agents send `Authorization: Bearer <token>`. Never expose `/mcp` to the internet.

| From | URL |
|---|---|
| The same machine | `http://localhost:19287/mcp` |
| Other containers (default bridge) | `http://172.17.0.1:19287/mcp` |
| A shared Docker network | `http://score-studio:19287/mcp` |
| Your LAN | `http://<host-ip>:19287/mcp` |

Example MCP client entry:

```yaml
mcp_servers:
  score_studio:
    url: "http://localhost:19287/mcp"
    headers:
      Authorization: "Bearer YOUR_TOKEN"
```

`curl -s http://localhost:19287/healthz` should print `{"ok":true}`.

**Tools** (all prefixed `scorestudio_`):

| Tool | Purpose |
|---|---|
| `status` | Version, queue, performance limits, import/export folders. Call first. |
| `list_projects`, `get_project` | Browse projects and their progress. |
| `list_import_files` | Files in the optional `/import` mount. |
| `create_project` | Transcribe from `import_path`, a `url`, or `file_base64` + `filename`. |
| `wait_for_project` | Wait up to 110 s; call again while `timedOut` is true. |
| `read_score` | Up to 32 bars as compact text with note ids, plus the engraver's open review questions. |
| `edit_score` | Edit ops (voice, hand, duration, pitch, spelling, delete, add, key, review answers) as one undoable step. |
| `history` | List, undo, redo. |
| `update_settings` | Engraving settings (voices 1–4, hand span, automatic keys/spelling/runs, markings). |
| `export_score` | MusicXML or MIDI to `/exports` and/or inline. |
| `set_score_header` | Title, subtitle, composer and their text sizes on page 1 / in exports. |
| `rename_project`, `retry_project`, `delete_project` | Housekeeping. |
| `get_performance`, `set_performance` | Read or change the CPU limits. |

Typical flow: `create_project` → `wait_for_project` → `read_score` → `edit_score` → `export_score`.

For agents that share files: mount a folder the agent can write to at `/import`, and `./exports` to a folder it can
read. If the agent runs as another user, set `PUID`/`PGID` to match.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `19287` | Listening port inside the container. |
| `PUID` / `PGID` | `1000` | User the app runs as; owns `/data` and `/exports`. |
| `SCORE_STUDIO_PERF_PRESET` | `balanced` | Preset used until one is chosen in the app. |
| `SCORE_STUDIO_MCP_TOKEN` | unset | Turns on MCP (16+ characters). |
| `SCORE_STUDIO_PASSWORD` | unset | Basic auth for the web UI and REST API (any username). MCP uses its token. |
| `DEEPSEEK_API_KEY` | unset | Assistant key; alternatively enter it in the app. |
| `SCORE_STUDIO_IMPORT` / `SCORE_STUDIO_EXPORT` | `/import` / `/exports` | MCP file folders. |
| `SCORE_STUDIO_MCP_ALLOW_PRIVATE_URLS` | unset | `1` lets MCP `url` uploads fetch from LAN addresses (loopback and link-local stay blocked). |
| `SCORE_STUDIO_ALLOWED_HOSTS` | unset | Extra hostnames the app answers to, e.g. a reverse-proxy domain. IPs, single-label names (`score-studio`, the host name) and LAN suffixes such as `.local`/`.lan` always work. `*` turns the check off. |

## Updating

```bash
git pull
docker compose up -d --build --force-recreate
```

Projects in `./data` are kept. Unfinished transcriptions restart automatically.

## Licence note

DuET's model weights are CC BY-NC 4.0: personal and non-commercial use only.
