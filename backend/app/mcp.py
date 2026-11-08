"""MCP server for AI agents: stateless Streamable HTTP at POST /mcp, JSON responses, no sessions/SSE.

Enabled only when SCORE_STUDIO_MCP_TOKEN (16+ characters) is set; agents send `Authorization: Bearer <token>`.
Tools only, every call validated, no secrets in results.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import io
import ipaddress
import json
import os
import re
import socket
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from . import VERSION, llm, perf, service, store, worker
from .service import ServiceError

VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
STATUSES = ["queued", "transcribing", "analysing", "engraving", "ready", "error"]
SETTLED = {"ready", "error"}
MAX_BODY = 160 * 1024 * 1024             # base64 audio uploads
MAX_UPLOAD = 100 * 1024 * 1024
PREFIX = "scorestudio_"
IMPORT_DIR = Path(os.environ.get("SCORE_STUDIO_IMPORT") or (store.DATA / "import"))
EXPORT_DIR = Path(os.environ.get("SCORE_STUDIO_EXPORT") or (store.DATA / "exports"))


def token() -> str:
    t = os.environ.get("SCORE_STUDIO_MCP_TOKEN", "").strip()
    if len(t) < 16 or "CHANGE-ME" in t.upper():       # the compose placeholder never enables MCP
        return ""
    return t


# URL uploads reach LAN hosts only when explicitly allowed; loopback, link-local (cloud metadata),
# multicast and reserved ranges are always refused.
ALLOW_PRIVATE_URLS = os.environ.get("SCORE_STUDIO_MCP_ALLOW_PRIVATE_URLS", "") == "1"


# ----------------------------------------------------------------------------- schema helpers
def s(max_len=500, min_len=1, desc=None):
    d = {"type": "string", "minLength": min_len, "maxLength": max_len}
    return dict(d, description=desc) if desc else d


def i(lo, hi, desc=None):
    d = {"type": "integer", "minimum": lo, "maximum": hi}
    return dict(d, description=desc) if desc else d


def e(values, desc=None):
    d = {"type": "string", "enum": values}
    return dict(d, description=desc) if desc else d


def b(desc=None):
    return {"type": "boolean", "description": desc} if desc else {"type": "boolean"}


def arr(items, max_items, min_items=1, desc=None):
    d = {"type": "array", "items": items, "minItems": min_items, "maxItems": max_items}
    return dict(d, description=desc) if desc else d


def validate(schema: dict, value, label="arguments"):
    if "anyOf" in schema:
        for sub in schema["anyOf"]:
            try:
                validate(sub, value, label)
                return
            except ValueError:
                pass
        raise ValueError(f"Invalid {label}.")
    t = schema.get("type")
    if t is None:
        return
    ok = {"string": isinstance(value, str), "boolean": isinstance(value, bool),
          "integer": isinstance(value, int) and not isinstance(value, bool),
          "number": isinstance(value, (int, float)) and not isinstance(value, bool),
          "array": isinstance(value, list), "object": isinstance(value, dict)}[t]
    if not ok:
        raise ValueError(f"{label} must be {t}.")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"Unsupported {label}.")
    for key, actual, bad in (("minimum", value, lambda a, x: a < x), ("maximum", value, lambda a, x: a > x),
                             ("minLength", value, lambda a, x: len(a) < x), ("maxLength", value, lambda a, x: len(a) > x),
                             ("minItems", value, lambda a, x: len(a) < x), ("maxItems", value, lambda a, x: len(a) > x)):
        if key in schema and bad(actual, schema[key]):
            raise ValueError(f"{label} violates {key} {schema[key]}.")
    if t == "array" and "items" in schema:
        for k, item in enumerate(value):
            validate(schema["items"], item, f"{label}[{k}]")
    if t == "object" and "properties" in schema:
        for key in schema.get("required", []):
            if key not in value:
                raise ValueError(f"{label}.{key} is required.")
        for key, item in value.items():
            if key not in schema["properties"]:
                if schema.get("additionalProperties") is False:
                    raise ValueError(f"Unknown {label}.{key}.")
            else:
                validate(schema["properties"][key], item, f"{label}.{key}")


TOOLS: list[dict] = []
CALLS: dict = {}


def tool(name, title, description, properties=None, required=(), read_only=False, destructive=False, open_world=False):
    def deco(fn):
        full = PREFIX + name
        TOOLS.append(dict(name=full, title=title, description=description,
                          inputSchema=dict(type="object", properties=properties or {}, required=list(required),
                                           additionalProperties=False),
                          annotations=dict(readOnlyHint=read_only, destructiveHint=destructive,
                                           idempotentHint=read_only, openWorldHint=open_world)))
        CALLS[full] = fn
        return fn
    return deco


def summary(p: store.Project) -> dict:
    d = p.public()
    return {k: d[k] for k in ("id", "title", "source", "status", "created", "bars", "version", "error", "instruments", "parts")} | \
        dict(progress=(d.get("progress") or {}).get("fraction"), message=(d.get("progress") or {}).get("message"))


def doc_summary(d: dict) -> dict:
    return dict(id=d["id"], title=d["title"], version=d["version"], bars=d["meta"]["bars"],
                notes=sum(1 for n in d["notes"] if not n["deleted"]), meter=d["meta"].get("meter"),
                tempo=d["meta"].get("tempo"), history=d["history"], settings=d["settings"],
                open_review=sum(1 for r in d.get("review", []) if r.get("resolved") is None))


def _safe_rel(root: Path, rel: str) -> Path:
    if not isinstance(rel, str) or rel.startswith(("/", "\\")) or ".." in re.split(r"[\\/]", rel) or re.search(r"[\0\r\n]", rel) \
            or re.match(r"^[A-Za-z]:", rel):
        raise ValueError("Use a relative path without '..'.")
    base = root.resolve()
    target = (base / rel).resolve()
    if target != base and base not in target.parents:
        raise ValueError("Path is outside the folder.")
    return target


AUDIO_MIDI = sorted(store.AUDIO_EXT | store.MIDI_EXT)
SETTINGS_PROPS = dict(
    max_voices=i(1, 4, "Voices per staff, default 3."), hand_span=i(7, 24, "Comfortable hand span in semitones, default 14."),
    auto_keys=b("Detect key signatures."), auto_spelling=b("Choose note spellings from context."),
    auto_runs=b("Simplify fast ornamental runs."), show_pedal=b(), show_dynamics=b(), show_tempo=b())


# ----------------------------------------------------------------------------- tools
@tool("status", "Status", "Show whether Score Studio is ready: version, compute device, transcription queue, "
      "performance limits, whether the DeepSeek assistant is configured, and the import/export folders. Call this first.",
      read_only=True)
def t_status(_):
    counts = {k: 0 for k in STATUSES}
    for p in store.all_projects():
        st = p.meta()["status"]
        counts[st] = counts.get(st, 0) + 1
    eff = perf.resolve()
    return dict(version=VERSION, projects=counts, running=worker.current(), queued=worker.queued(),
                performance=dict(perf.settings(), cores=eff["cores"], threads=eff["threads"]),
                assistant_configured=llm.public_settings()["configured"],
                import_folder=str(IMPORT_DIR) if IMPORT_DIR.is_dir() else None,
                export_folder=str(EXPORT_DIR),
                formats=AUDIO_MIDI)


@tool("list_projects", "List projects", "List projects, newest first. Filter by status or a title substring.",
      dict(status=e(STATUSES), query=s(200, 0), limit=i(1, 200, "Default 50.")), read_only=True)
def t_list(a):
    q = a.get("query", "").lower()
    out = [summary(p) for p in store.all_projects()
           if (not a.get("status") or p.meta()["status"] == a["status"]) and q in p.meta()["title"].lower()]
    return dict(projects=out[:a.get("limit", 50)], total=len(out))


@tool("get_project", "Get project", "Status, progress and error of one project.", dict(id=s(32)), ["id"], read_only=True)
def t_get(a):
    return summary(service.project(a["id"]))


@tool("list_import_files", "List import files", "List audio/MIDI files in the shared import folder (see status), "
      "to pass as import_path to create_project.", dict(path=s(1000, 0, "Sub-folder, empty for the root.")), read_only=True)
def t_list_import(a):
    if not IMPORT_DIR.is_dir():
        raise ValueError("No import folder is mounted (SCORE_STUDIO_IMPORT).")
    folder = _safe_rel(IMPORT_DIR, a.get("path", ""))
    if not folder.is_dir():
        raise ValueError("Folder not found.")
    files, folders = [], []
    for entry in sorted(folder.iterdir(), key=lambda x: x.name.lower()):
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            folders.append(entry.name)
        elif entry.suffix.lower() in AUDIO_MIDI:
            files.append(dict(path=entry.relative_to(IMPORT_DIR.resolve()).as_posix(), size=entry.stat().st_size))
    return dict(path=a.get("path", ""), folders=folders[:200], files=files[:500])


def _check_destination(url: str):
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("url must be http(s).")
    try:
        infos = socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise ValueError(f"Cannot resolve {u.hostname}.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if getattr(ip, "ipv4_mapped", None):
            ip = ip.ipv4_mapped
        if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise ValueError("That address is not allowed.")
        if ip.is_private and not ALLOW_PRIVATE_URLS:
            raise ValueError("LAN addresses are refused; use import_path, or set SCORE_STUDIO_MCP_ALLOW_PRIVATE_URLS=1.")


def _download(url: str) -> tuple[str, io.BytesIO]:
    buf = io.BytesIO()
    with httpx.Client(follow_redirects=False, timeout=60) as client:
        for _hop in range(6):                         # check every redirect target, not just the first URL
            _check_destination(url)
            with client.stream("GET", url) as r:
                if r.is_redirect:
                    url = str(r.url.join(r.headers.get("location", "")))
                    continue
                if r.status_code >= 400:
                    raise ValueError(f"Download failed: HTTP {r.status_code}.")
                for chunk in r.iter_bytes():
                    buf.write(chunk)
                    if buf.tell() > MAX_UPLOAD:
                        raise ValueError("File is larger than 100 MB.")
                name = unquote(Path(urlparse(str(r.url)).path).name) or "download"
                m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)', r.headers.get("content-disposition", ""))
                if m:
                    name = Path(unquote(m.group(1))).name
                buf.seek(0)
                return name, buf
    raise ValueError("Too many redirects.")


@tool("create_project", "Transcribe a file", "Upload audio (mp3, wav, flac, m4a, ogg) or MIDI and start transcribing it "
      "into an editable score. Give exactly one of import_path, url or file_base64 (with filename). Returns the project id; "
      "then call wait_for_project. Audio takes minutes on a CPU.",
      dict(import_path=s(1000, 1, "File path relative to the import folder (see list_import_files)."),
           url=s(4000, 1, "http(s) link to an audio or MIDI file (max 100 MB)."),
           file_base64=s(MAX_BODY, 1, "File content, base64 encoded (max 100 MB decoded)."),
           filename=s(255, 1, "Original file name with extension; required with file_base64."),
           title=s(200, 1, "Project title; default: the file name."),
           instruments=e(["piano", "multi"], "'piano' (default): one piano part (Transkun). 'multi' (experimental): one "
                         "score part per instrument, detected by YourMT3+ (audio) or taken from the MIDI tracks."),
           model=s(40, 1, "YourMT3+ checkpoint key for instruments='multi' audio (see GET /api/health multi.models).")),
      open_world=True)
def t_create(a):
    given = [k for k in ("import_path", "url", "file_base64") if k in a]
    if len(given) != 1:
        raise ValueError("Give exactly one of import_path, url or file_base64.")
    instruments = a.get("instruments") or "piano"

    def new(name, stream):
        from . import models
        models.require_ready()
        model = service.check_mode(instruments, a.get("model"), name.lower().endswith((".mid", ".midi")))
        return store.create(name, stream, a.get("title"), instruments, model)
    if "import_path" in a:
        if not IMPORT_DIR.is_dir():
            raise ValueError("No import folder is mounted (SCORE_STUDIO_IMPORT).")
        f = _safe_rel(IMPORT_DIR, a["import_path"])
        if not f.is_file():
            raise ValueError("File not found in the import folder.")
        if f.stat().st_size > MAX_UPLOAD:
            raise ValueError("File is larger than 100 MB.")
        with f.open("rb") as fh:
            p = new(f.name, fh)
    elif "url" in a:
        name, buf = _download(a["url"])
        p = new(name, buf)
    else:
        if "filename" not in a:
            raise ValueError("filename is required with file_base64.")
        try:
            raw = base64.b64decode(a["file_base64"], validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("file_base64 is not valid base64.")
        if len(raw) > MAX_UPLOAD:
            raise ValueError("File is larger than 100 MB.")
        p = new(Path(a["filename"]).name, io.BytesIO(raw))
    worker.submit(p.id)
    return summary(p)


@tool("wait_for_project", "Wait for transcription", "Wait until projects are ready or failed. If timedOut is true they are "
      "still processing: call it again.",
      dict(ids=arr(s(32), 20), timeoutSeconds={"type": "number", "minimum": 0, "maximum": 110, "description": "Default 60."}),
      ["ids"], read_only=True)
async def t_wait(a):
    ids = a["ids"]
    for pid in ids:
        service.project(pid)
    deadline = time.monotonic() + a.get("timeoutSeconds", 60)
    while True:
        ps = [store.get(pid) for pid in ids]
        done = all(p is None or p.meta()["status"] in SETTLED for p in ps)
        if done or time.monotonic() >= deadline:
            return dict(settled=done, timedOut=not done,
                        projects=[summary(p) if p else dict(id=pid, status="deleted") for pid, p in zip(ids, ps)])
        await asyncio.sleep(1.0)


def _bars(d: dict, bars) -> list[int]:
    if not d["measures"]:
        return []
    first = d["measures"][0]["number"]
    if bars:
        a, z = sorted(bars)
    else:
        a, z = first, first + 7
    if z - a > 31:
        raise ValueError("Read at most 32 bars per call.")
    idx = [m["index"] for m in d["measures"] if a <= m["number"] <= z]
    if not idx:
        raise ValueError(f"No bars in that range; bars run {first}..{d['measures'][-1]['number']}.")
    return idx


@tool("read_score", "Read score", "Read a ready score as compact text, up to 32 bars per call. Each bar lists RH/LH voices "
      "with events `[id name, ...]@beat~dur` (beats and durations in quarter notes; g = grace). The ids are the note ids "
      "used by edit_score. Also returns the engraver's open review questions for those bars.",
      dict(id=s(32), bars=arr(i(-10, 100000), 2, 2, "First and last bar number, e.g. [1, 16]. Default: first 8 bars.")),
      ["id"], read_only=True)
def t_read(a):
    p = service.ready(a["id"])
    d = service.doc(p)
    idx = _bars(d, a.get("bars"))
    nums = [d["measures"][k]["number"] for k in idx]
    review = [dict(id=r["id"], bars=r.get("measures"), question=r.get("question"), options=r.get("options"))
              for r in d.get("review", []) if r.get("resolved") is None and r.get("measures")
              and r["measures"][0] <= nums[-1] and r["measures"][1] >= nums[0]]
    return dict(summary=doc_summary(d), bars=[nums[0], nums[-1]], view=llm.score_view(d, idx), review=review[:20])


EDIT_HELP = ('Ops (JSON objects): {"op":"set_staff","ids":[..],"staff":1|2}, {"op":"set_voice","ids":[..],"voice":1-4}, '
             '{"op":"set_duration","ids":[..],"dur":Q}, {"op":"shift","ids":[..],"delta":Q}, '
             '{"op":"transpose","ids":[..],"semitones":K}, {"op":"respell","ids":[..],"prefer":"sharp"|"flat"|"auto"}, '
             '{"op":"set_grace","ids":[..],"grace":bool}, {"op":"merge_chord","ids":[..]}, {"op":"delete","ids":[..]}, '
             '{"op":"add_note","pitch":MIDI,"on":Q,"dur":Q,"staff":1|2,"voice":1-4}, '
             '{"op":"set_key","measure":INDEX,"fifths":-7..7} (INDEX = bar number minus the offset read_score states), {"op":"restore","ids":[..]}, {"op":"reset","ids":[..]}, {"op":"resolve_review","review_id":ID,"option":INDEX} (answers a read_score review question). '
             'Q = quarter notes; on = absolute position from the start (read_score gives each bar\'s start).')


@tool("edit_score", "Edit score", "Apply edits to a ready score as ONE undoable step (validated by engraving first; "
      "nothing changes if any op fails). " + EDIT_HELP,
      dict(id=s(32), ops=arr({"type": "object"}, 500), label=s(120, 1, "Short description for the history.")),
      ["id", "ops"])
def t_edit(a):
    return doc_summary(service.edit(service.ready(a["id"]), a["ops"], a.get("label")))


@tool("history", "Undo / redo / history", "list the edit history, or undo / redo one step.",
      dict(id=s(32), action=e(["list", "undo", "redo"])), ["id", "action"])
def t_history(a):
    p = service.ready(a["id"])
    if a["action"] == "list":
        return dict(history=[{k: v for k, v in h.items() if k != "ops"} for h in service.history(p)][-100:])
    return doc_summary(service.move(p, -1 if a["action"] == "undo" else 1))


@tool("update_settings", "Engraving settings", "Change a score's engraving settings (re-engraves the score).",
      dict(id=s(32), settings=dict(type="object", properties=SETTINGS_PROPS, additionalProperties=False, minProperties=1)),
      ["id", "settings"])
def t_settings(a):
    return doc_summary(service.update_settings(service.ready(a["id"]), a["settings"]))


@tool("export_score", "Export score", "Export the current score as MusicXML or MIDI. save=true (default) writes it to the "
      "export folder; inline=true also returns the content (MusicXML as text, MIDI as base64), "
      "max 2 MB.",
      dict(id=s(32), format=e(["musicxml", "midi"]), save=b(), inline=b()), ["id", "format"])
def t_export(a):
    p = service.ready(a["id"])
    if a["format"] == "musicxml":
        data, ext = service.xml(p).encode("utf-8"), "musicxml"
    else:
        data, ext = service.score_midi_bytes(service.doc(p)), "mid"
    out = dict(id=p.id, format=a["format"], bytes=len(data))
    if a.get("save", True):
        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^\w\- ]+", "_", p.meta()["title"]).strip() or "score"
        f = EXPORT_DIR / f"{name} [{p.id}].{ext}"
        # New regular file + atomic rename: never writes through a symlink planted in the shared folder.
        fd, tmp = tempfile.mkstemp(dir=EXPORT_DIR, prefix=".export-", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            os.chmod(tmp, 0o644)
            os.replace(tmp, f)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        out["saved_to"] = str(f)
    if a.get("inline"):
        if len(data) > 2 * 1024 * 1024:
            raise ValueError("Too large to return inline; use save.")
        out["content"] = data.decode("utf-8") if ext == "musicxml" else base64.b64encode(data).decode()
    return out


@tool("rename_project", "Rename project", "Change a project's title.", dict(id=s(32), title=s(200)), ["id", "title"])
def t_rename(a):
    return summary(service.rename(service.project(a["id"]), a["title"]))


@tool("set_score_header", "Set score title block",
      "Edit the title block engraved on page 1 and written to MusicXML exports. Only the given fields change. "
      "Empty title = the project title. Sizes are percent of normal text (100 = 12 pt).",
      dict(id=s(32), title=s(200, 0), subtitle=s(300, 0), composer=s(200, 0),
           title_size=dict(type="integer", minimum=40, maximum=600),
           subtitle_size=dict(type="integer", minimum=40, maximum=600),
           composer_size=dict(type="integer", minimum=40, maximum=600),
           show=dict(type="boolean", description="Show the title block.")), ["id"])
def t_header(a):
    p = service.set_header(service.project(a["id"]), {k: v for k, v in a.items() if k != "id"})
    return summary(p) | dict(header=p.meta()["header"])


@tool("retry_project", "Retry transcription", "Transcribe a project again from its source file (e.g. after an error). "
      "Edit history is kept.", dict(id=s(32)), ["id"])
def t_retry(a):
    p = service.project(a["id"])
    service.retry(p)
    return summary(p)


@tool("delete_project", "Delete project", "Delete a project, its source file and its edit history. Cannot be undone.",
      dict(id=s(32)), ["id"], destructive=True)
def t_delete(a):
    service.delete(service.project(a["id"]))
    return dict(deleted=True, id=a["id"])


@tool("get_performance", "Performance limits", "Show CPU limits (preset, cores, threads, priority), what the container "
      "allows, and current CPU use of the backend and the running transcription.", read_only=True)
def t_perf(_):
    st = perf.status()
    return dict(settings=st["settings"], effective=st["effective"], system=st["system"],
                usage=dict(server_cpu=st["usage"]["server_cpu"], job=st["usage"]["job"]))


@tool("set_performance", "Set performance limits", "Limit how much of the host the transcriber uses. Presets: eco (~1/4 of "
      "the cores, background priority), balanced (~1/2, low priority), full (all cores, normal), or custom with "
      "explicit cores. Cores apply to a running transcription immediately.",
      dict(preset=e(list(perf.PRESETS)), cores=arr(i(0, 1023), 1024, 1, "custom only: core numbers (see get_performance)."),
           priority=e(list(perf.PRIORITIES))))
def t_set_perf(a):
    if not a:
        raise ValueError("Give at least one setting.")
    eff = perf.save(perf.validate(a))
    return dict(settings=perf.settings(), effective=eff)


INSTRUCTIONS = ("Score Studio turns piano audio or MIDI into an editable score. Flow: status -> create_project "
                "(import_path from list_import_files, url, or file_base64) -> wait_for_project (repeat while timedOut) -> "
                "read_score (32 bars max per call) -> edit_score (one undoable step) -> export_score. history undoes. "
                "Use get_performance / set_performance to limit CPU use on the host.")


# ----------------------------------------------------------------------------- transport
def _redact(value) -> str:
    text = json.dumps(value, ensure_ascii=False, default=str)
    for secret in (token(), llm.settings().get("api_key")):
        if secret:
            text = text.replace(secret, "[redacted]")
    return text


def _send(status: int, value) -> Response:
    return Response(_redact(value), status_code=status, media_type="application/json",
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


def _err(status, rid, code, message):
    return _send(status, dict(jsonrpc="2.0", id=rid, error=dict(code=code, message=message)))


async def handle(request: Request) -> Response:
    tok = token()
    bearer = re.match(r"^Bearer (.+)$", request.headers.get("authorization", ""), re.I)
    given = bearer.group(1).strip() if bearer else ""
    if not tok or not hmac.compare_digest(hashlib.sha256(tok.encode()).digest(), hashlib.sha256(given.encode()).digest()):
        return JSONResponse({"error": "Authentication required." if tok else "MCP is disabled: set SCORE_STUDIO_MCP_TOKEN."},
                            status_code=401, headers={"WWW-Authenticate": 'Bearer realm="Score Studio MCP"'})
    origin = request.headers.get("origin")
    if origin:
        if urlparse(origin).netloc != request.headers.get("host"):
            return JSONResponse({"error": "Origin is not allowed."}, status_code=403)
    if request.method != "POST":
        return JSONResponse({"error": "Use POST."}, status_code=405, headers={"Allow": "POST"})
    pv = request.headers.get("mcp-protocol-version")
    if pv and pv not in VERSIONS:
        return _err(400, None, -32600, "Unsupported MCP protocol version.")
    raw = bytearray()
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_BODY:
            return _err(413, None, -32600, "JSON body is too large.")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return _err(400, None, -32700, "Invalid JSON.")
    if not isinstance(body, dict) or body.get("jsonrpc") != "2.0" or not isinstance(body.get("method"), str) \
            or ("id" in body and body["id"] is not None and (isinstance(body["id"], bool) or not isinstance(body["id"], (str, int, float)))):
        return _err(200, None, -32600, "Invalid request.")
    if "id" not in body:
        return Response(status_code=202)
    rid, method = body["id"], body["method"]
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    reply = lambda result: _send(200, dict(jsonrpc="2.0", id=rid, result=result))  # noqa: E731
    if method == "initialize":
        want = params.get("protocolVersion")
        return reply(dict(protocolVersion=want if want in VERSIONS else VERSIONS[0],
                          capabilities=dict(tools=dict(listChanged=False)),
                          serverInfo=dict(name="score-studio", title="Score Studio", version=VERSION),
                          instructions=INSTRUCTIONS))
    if method == "ping":
        return reply({})
    if method == "tools/list":
        return reply(dict(tools=TOOLS))
    if method != "tools/call":
        return _err(200, rid, -32601, "Unknown method.")
    name = params.get("name")
    fn = CALLS.get(name) if isinstance(name, str) else None
    if fn is None:
        return _err(200, rid, -32602, "Unknown tool.")
    args = params.get("arguments") if params.get("arguments") is not None else {}
    if not isinstance(args, dict):
        return _err(200, rid, -32602, "arguments must be an object.")
    schema = next(t["inputSchema"] for t in TOOLS if t["name"] == name)
    try:
        validate(schema, args)
        if asyncio.iscoroutinefunction(fn):
            result = await fn(args)
        else:
            result = await run_in_threadpool(fn, args)
        return reply(dict(content=[dict(type="text", text=_redact(result))], structuredContent=json.loads(_redact(result)),
                          isError=False))
    except (ValueError, ServiceError, OSError, httpx.HTTPError) as exc:
        return reply(dict(content=[dict(type="text", text=_redact(str(exc)))], isError=True))
    except Exception as exc:          # report, keep serving
        return reply(dict(content=[dict(type="text", text=_redact(f"{type(exc).__name__}: {exc}"))], isError=True))
