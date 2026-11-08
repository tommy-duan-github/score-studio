"""Score Studio HTTP API (see docs/API.md)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import mimetypes
import os
import re
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import VERSION, engine, llm, mcp, models, multi, perf, service, store, worker
from .service import ServiceError

app = FastAPI(title="Score Studio", version=VERSION)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])
PASSWORD = os.environ.get("SCORE_STUDIO_PASSWORD", "")
OPEN_PATHS = {"/healthz", "/mcp"}           # /mcp has its own bearer token
# DNS-rebinding guard: a public domain that an attacker points at this server must not reach the API.
# IP addresses, single-label names (container names, host names) and LAN suffixes are accepted;
# add reverse-proxy domains to SCORE_STUDIO_ALLOWED_HOSTS (comma separated, "*" disables the check).
ALLOWED_HOSTS = {h.strip().lower() for h in os.environ.get("SCORE_STUDIO_ALLOWED_HOSTS", "").split(",") if h.strip()}
LAN_SUFFIXES = (".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa", ".localhost", ".intranet", ".corp")


def host_allowed(host: str | None) -> bool:
    if "*" in ALLOWED_HOSTS:
        return True
    if not host:
        return False
    host = host.strip().lower()
    name = host[1:host.index("]")] if host.startswith("[") and "]" in host else host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    if name in ALLOWED_HOSTS or host in ALLOWED_HOSTS:
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    return "." not in name or name.endswith(LAN_SUFFIXES)


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if path != "/healthz" and not host_allowed(request.headers.get("host")):
        return JSONResponse({"detail": "Host not allowed; add it to SCORE_STUDIO_ALLOWED_HOSTS"}, status_code=421)
    if PASSWORD and path not in OPEN_PATHS:
        m = re.match(r"^Basic (.+)$", request.headers.get("authorization", ""), re.I)
        try:
            pw = base64.b64decode(m.group(1)).decode("utf-8").split(":", 1)[1] if m else ""
        except (ValueError, IndexError):
            pw = ""
        if not hmac.compare_digest(hashlib.sha256(pw.encode()).digest(), hashlib.sha256(PASSWORD.encode()).digest()):
            return Response("Authentication required", status_code=401,
                            headers={"WWW-Authenticate": 'Basic realm="Score Studio", charset="UTF-8"'})
    # Cross-site requests must not change anything (uploads are "simple" requests that skip CORS preflight).
    if request.method not in ("GET", "HEAD", "OPTIONS") and path.startswith("/api/"):
        origin = request.headers.get("origin")
        if origin:
            dev = origin in ("http://localhost:5173", "http://127.0.0.1:5173")
            if urlparse(origin).netloc != request.headers.get("host") and not dev:
                return JSONResponse({"detail": "Cross-origin request refused"}, status_code=403)
    return await call_next(request)


@app.exception_handler(ServiceError)
async def _service_error(request, exc: ServiceError):
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


@app.on_event("startup")
def _startup():
    worker.start()


@app.on_event("shutdown")
def _shutdown():
    worker.shutdown()


# ----------------------------------------------------------------------------- health / config
@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/health")
def health():
    try:
        import torch
        cuda = bool(torch.cuda.is_available())
    except Exception:
        cuda = False
    return dict(ok=True, version=VERSION, cuda=cuda, llm=llm.public_settings(), docker=perf.in_docker(),
                mcp=bool(mcp.token()), desktop=bool(os.environ.get("SCORE_STUDIO_DESKTOP")),
                models_ready=models.ready(),
                multi=dict(available=multi.available(), default=multi.default_model(),
                           models=[dict(key=k, label=multi.MODELS[k]) for k in multi.installed_models()]))


@app.get("/api/config/llm")
def get_llm():
    return llm.public_settings()


@app.put("/api/config/llm")
async def put_llm(request: Request):
    body = await request.json()
    llm.save_settings(api_key=body.get("api_key"), model=body.get("model"), base_url=body.get("base_url"))
    return llm.public_settings()


@app.get("/api/performance")
def get_performance():
    return perf.status()


@app.put("/api/performance")
async def put_performance(request: Request):
    try:
        s = perf.validate(await request.json())
    except ValueError as e:
        raise HTTPException(422, str(e))
    await run_in_threadpool(perf.save, s)
    return perf.status()


# ----------------------------------------------------------------------------- MCP
app.add_api_route("/mcp", mcp.handle, methods=["GET", "POST", "DELETE"], include_in_schema=False)


# ----------------------------------------------------------------------------- projects
@app.get("/api/instruments")
def instruments():
    """Instrument catalog for renaming / re-instrumenting parts (GM program, clef, single or grand staff)."""
    return multi.catalog()


@app.get("/api/projects")
def list_projects():
    out = []
    for p in store.all_projects():
        d = p.public()
        out.append({k: d[k] for k in ("id", "title", "created", "source", "status", "bars", "progress", "instruments", "parts")})
    return out


@app.post("/api/projects", status_code=201)
async def create_project(file: UploadFile = File(...), title: str | None = Form(None),
                         instruments: str = Form("piano"), model: str | None = Form(None)):
    try:
        models.require_ready()
        model = service.check_mode(instruments, model, (file.filename or "").lower().endswith((".mid", ".midi")))
        p = await run_in_threadpool(store.create, file.filename or "upload", file.file, title, instruments, model)
    except models.ModelsMissing as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    worker.submit(p.id)
    return dict(id=p.id, status="queued")


@app.post("/api/projects/delete")
async def delete_projects(request: Request):
    """Batch delete: {"ids": [...]} or {"all": true}."""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "JSON object expected")
    if body.get("all") is True:
        targets = store.all_projects()
    elif isinstance(body.get("ids"), list) and all(isinstance(i, str) for i in body["ids"]):
        targets = [p for p in (store.get(i) for i in body["ids"]) if p is not None]
    else:
        raise HTTPException(422, 'ids (list) or "all": true required')
    for p in targets:
        await run_in_threadpool(service.delete, p)
    return dict(deleted=len(targets))


# ----------------------------------------------------------------------------- models & storage
@app.get("/api/models")
def get_models():
    return models.status()


@app.post("/api/models/download", status_code=202)
async def download_models(request: Request):
    body = await request.json()
    keys = body.get("keys") if isinstance(body, dict) else None
    if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
        raise HTTPException(422, "keys (list of model keys) required")
    try:
        return models.download(keys)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/api/models/{key}/remove")
def remove_model(key: str):
    try:
        return models.remove(key)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.get("/api/storage")
async def get_storage():
    return await run_in_threadpool(models.storage)


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return service.project(pid).public()


@app.patch("/api/projects/{pid}")
async def patch_project(pid: str, request: Request):
    p = service.project(pid)
    body = await request.json()
    if not isinstance(body, dict) or not ({"title", "header", "parts"} & body.keys()):
        raise HTTPException(422, "title, header or parts required")
    fields = {k: body[k] for k in ("title", "header", "parts") if k in body}
    return service.update_project(p, **fields).public()


@app.delete("/api/projects/{pid}", status_code=204)
def delete_project(pid: str):
    service.delete(service.project(pid))
    return Response(status_code=204)


@app.post("/api/projects/{pid}/retry")
async def retry(pid: str, request: Request):
    """Transcribe again; an optional JSON body {"instruments": "piano"|"multi", "model": key} switches the mode."""
    p = service.project(pid)
    body = {}
    if (await request.body()).strip():
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(422, "JSON object expected")
    service.retry(p, body.get("instruments"), body.get("model"))
    return p.public()


# ----------------------------------------------------------------------------- score
@app.get("/api/projects/{pid}/doc")
async def get_doc(pid: str):
    return await run_in_threadpool(service.doc, service.ready(pid))


@app.get("/api/projects/{pid}/score.musicxml")
async def get_xml(pid: str):
    p = service.ready(pid)
    text = await run_in_threadpool(service.xml, p)
    return Response(text, media_type="application/vnd.recordare.musicxml+xml",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/projects/{pid}/score.mid")
async def get_score_mid(pid: str):
    doc = await run_in_threadpool(service.doc, service.ready(pid))
    return Response(service.score_midi_bytes(doc), media_type="audio/midi", headers={"Cache-Control": "no-store"})


@app.get("/api/projects/{pid}/performance.mid")
def get_perf_mid(pid: str):
    p = service.project(pid)
    if not p.performance.is_file():
        raise HTTPException(404, "No performance MIDI yet")
    return FileResponse(p.performance, media_type="audio/midi")


@app.api_route("/api/projects/{pid}/audio", methods=["GET", "HEAD"])
def get_audio(pid: str):
    p = service.project(pid)
    if p.meta()["source"] != "audio":
        raise HTTPException(404, "This project has no audio")
    src = p.source
    media = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4",
             ".ogg": "audio/ogg"}.get(src.suffix.lower(), "application/octet-stream")
    return FileResponse(src, media_type=media)


def safe_name(title: str) -> str:
    return re.sub(r'[^\w\- ]+', '_', title).strip() or "score"


@app.get("/api/projects/{pid}/export/{name}")
async def export(pid: str, name: str):
    p = service.ready(pid)
    title = safe_name(p.meta()["title"])
    if name == "score.musicxml":
        text = await run_in_threadpool(service.xml, p)
        return Response(text, media_type="application/vnd.recordare.musicxml+xml",
                        headers={"Content-Disposition": f'attachment; filename="{title}.musicxml"'})
    if name == "score.mid":
        doc = await run_in_threadpool(service.doc, p)
        return Response(service.score_midi_bytes(doc), media_type="audio/midi",
                        headers={"Content-Disposition": f'attachment; filename="{title}.mid"'})
    if name == "audio":
        if p.meta()["source"] != "audio":
            raise HTTPException(404, "This project has no audio")
        src = p.source
        return FileResponse(src, media_type=mimetypes.guess_type(src.name)[0] or "application/octet-stream",
                            filename=f"{title}{src.suffix.lower()}")
    raise HTTPException(404, "Unknown export")


# ----------------------------------------------------------------------------- settings & edits
@app.put("/api/projects/{pid}/settings")
async def put_settings(pid: str, request: Request):
    p = service.ready(pid)
    body = await request.json()
    return await run_in_threadpool(service.update_settings, p, body)


@app.post("/api/projects/{pid}/edits")
async def post_edits(pid: str, request: Request):
    p = service.ready(pid)
    body = await request.json()
    return await run_in_threadpool(service.edit, p, body.get("ops"), body.get("label"))


@app.post("/api/projects/{pid}/undo")
async def undo(pid: str):
    return await run_in_threadpool(service.move, service.ready(pid), -1)


@app.post("/api/projects/{pid}/redo")
async def redo(pid: str):
    return await run_in_threadpool(service.move, service.ready(pid), +1)


@app.get("/api/projects/{pid}/history")
def history(pid: str):
    return service.history(service.project(pid))


# ----------------------------------------------------------------------------- assistant
@app.post("/api/projects/{pid}/assistant")
async def assistant(pid: str, request: Request):
    p = service.ready(pid)
    body = await request.json()
    msg = str(body.get("message", "")).strip()
    if not msg:
        raise HTTPException(422, "message required")
    if not llm.settings()["api_key"]:
        raise HTTPException(503, "No DeepSeek API key configured")
    res = await run_in_threadpool(engine.render, p)
    doc = engine.public_doc(p, res)
    try:
        return await run_in_threadpool(llm.ask, doc, res.doc.get("_review_raw"), p.edit_state(), msg,
                                       body.get("note_ids"), body.get("measures"), body.get("history"))
    except PermissionError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(502, f"Assistant failed: {e}")


# ----------------------------------------------------------------------------- web app
WEB = store.ROOT / "web" / "dist"
mimetypes.add_type("application/manifest+json", ".webmanifest")


@app.exception_handler(500)
async def _err(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=500)


class WebFiles(StaticFiles):
    """The built UI. index.html (and other unhashed files) must be revalidated on every load, or a browser keeps
    showing the previous version's UI after an upgrade; Vite's hashed /assets/* never change, so cache them."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            hashed = path.replace("\\", "/").startswith("assets/")   # normpath gives backslashes on Windows
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if hashed else "no-cache"
        return response


if WEB.is_dir():
    app.mount("/", WebFiles(directory=WEB, html=True), name="web")
