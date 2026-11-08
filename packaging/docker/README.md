# Score Studio on a NAS (Docker)

Files in `release/score-studio-{{version}}/`: `score-studio-{{version}}-docker-amd64.tar.gz` (the image, linux/amd64, CPU-only, includes YourMT3+)
and `docker-compose.yml`.

## Install (UGREEN DXP4800 Plus)

1. Copy the release folder to the NAS, e.g. `/volume1/docker/score-studio/`.
2. Load the image, either with **UGREEN Docker → Image → Add → Import from local**, or over SSH:

   ```bash
   docker load -i score-studio-{{version}}-docker-amd64.tar.gz
   ```

3. Edit `docker-compose.yml`: set `SCORE_STUDIO_MCP_TOKEN` (leave it empty to keep MCP off), and `PUID`/`PGID`
   if your NAS user isn't 1000/1000 (`id <user>` over SSH).
4. Create the project with **UGREEN Docker → Project → Create** using this folder, or over SSH:

   ```bash
   docker compose up -d
   ```

5. Open `http://NAS-IP:19287`.

The DuET model is baked into the image, so the container needs no internet access for transcription.
Only the DeepSeek assistant and MCP `url` uploads go online.

## Ports

Only **19287** is published (web UI, REST API and MCP on one port). It doesn't collide with Metalrc (8190),
the Playwright gateway (18790, 16790) or common NAS services. To change it, edit both sides of the port mapping
and set `PORT` to the container side.

## Performance

Open **Settings** (bottom left of the sidebar) › **Performance**.

| Preset | Cores used (6-thread DXP4800 Plus) | Priority |
|---|---|---|
| Eco | 2 (cores 4–5) | Background (nice 19) |
| Balanced (Docker default) | 3 (cores 3–5) | Low (nice 10) |
| Full | all 6 | Normal |
| Custom | the cores you click | your choice |

- Cores apply immediately, including to a transcription that's already running. The highest-numbered cores are used
  first, because core 0 usually handles the OS and interrupts.
- Priority decides who goes first when the NAS is busy. Background means other apps run first.
  Lowering priority applies at once. Raising it applies from the next transcription, because Linux doesn't let
  an unprivileged process raise its own priority.
- Threads per transcription equal the number of cores, capped by any Docker `cpus:` limit.
- Each transcription runs in its own process, which ends when the job is done, so its RAM is returned to the NAS.
  A long audio file uses about 2–3 GB while it's transcribing. MIDI files need much less.
- For hard limits, uncomment `cpus`, `cpuset` or `mem_limit` in `docker-compose.yml`. The dialog shows the container
  cap and stays within it.

On a NAS CPU, MIDI takes about 1–3 minutes. Audio takes several minutes per minute of music.

## Multiple instruments (beta)

After you drop a file, choose **Piano** or **Multiple instruments**. Multiple instruments uses YourMT3+ (baked into
this image, checkpoint *YPTF+Multi (PS)*) and writes one part per instrument, e.g. Violin above a Piano grand staff.
On a NAS CPU it is slow: expect roughly 5–10 minutes per minute of music, and about 3–4 GB of RAM while it runs.
MIDI files with several tracks can also be transcribed as multiple instruments (one part per track instrument).

## Storage

**Settings › Storage** shows one bar of the disk (projects, models, the app, everything else, free space), lists the
models with a short description of each (built into the image here), and deletes projects in bulk (select several,
or clear all).

## MCP (Hermes Agent)

Setting `SCORE_STUDIO_MCP_TOKEN` (16+ characters, e.g. `openssl rand -base64 32`) turns on stateless
Streamable HTTP MCP at `POST /mcp`. Agents send `Authorization: Bearer <token>`. Never expose `/mcp` to the internet.

| From | URL |
|---|---|
| Hermes / other containers on the NAS (default bridge) | `http://172.17.0.1:19287/mcp` |
| A shared Docker network (see compose comments) | `http://score-studio:19287/mcp` |
| Your LAN | `http://NAS-IP:19287/mcp` |

In `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  score_studio:
    url: "http://172.17.0.1:19287/mcp"
    headers:
      Authorization: "Bearer YOUR_TOKEN"
```

Then run `/reload-mcp` in Hermes. Check that Hermes can reach it:

```bash
docker exec <hermes-container> curl -s http://172.17.0.1:19287/healthz
```

It should print `{"ok":true}`. If it times out, use the NAS LAN IP instead, and allow TCP 19287 in the UGREEN firewall.

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
| `export_score` | MusicXML or MIDI to `/exports` (shared folder) and/or inline. |
| `set_score_header` | Title, subtitle, composer and their text sizes on page 1 / in exports. |
| `rename_project`, `retry_project`, `delete_project` | Housekeeping. |
| `get_performance`, `set_performance` | Read or change the CPU limits. |

Typical flow: `create_project` → `wait_for_project` → `read_score` → `edit_score` → `export_score`.

For agents that share files: mount a folder Hermes can write to at `/import`, and `./exports` to a folder Hermes can
read. If Hermes runs as another user, set `PUID`/`PGID` to match.

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
| `SCORE_STUDIO_ALLOWED_HOSTS` | unset | Extra hostnames the app answers to, e.g. a reverse-proxy domain. IPs, single-label names (`score-studio`, the NAS name) and LAN suffixes such as `.local`/`.lan` always work. `*` turns the check off. |

## Updating

Load the new tarball, change `image:` to the new tag, then:

```bash
docker compose up -d --force-recreate
```

Projects in `./data` are kept. Unfinished transcriptions restart automatically.

## Building the image yourself

```bash
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --build-arg WITH_MT3=1 -t score-studio:{{version}} --load .
docker save score-studio:{{version}} | gzip > score-studio-{{version}}-docker-amd64.tar.gz
```

## Licence note

DuET's model weights are CC BY-NC 4.0: personal and non-commercial use only.
