"""End-to-end API checks against a running backend (python tools/api_test.py <project_id>)."""
import sys, json, collections
import httpx

B = "http://127.0.0.1:8000/api"
pid = sys.argv[1]
c = httpx.Client(timeout=120)


def ok(r):
    if r.status_code >= 400:
        raise SystemExit(f"{r.request.method} {r.request.url} -> {r.status_code} {r.text[:300]}")
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r


doc = ok(c.get(f"{B}/projects/{pid}/doc"))
print("doc: version", doc["version"], "bars", doc["meta"]["bars"], "notes", len(doc["notes"]), "review", len(doc["review"]))
print("voices:", collections.Counter((n["staff"], n["voice"]) for n in doc["notes"]))
xml = ok(c.get(f"{B}/projects/{pid}/score.musicxml")).text
ids = {n["id"] for n in doc["notes"] if not n["deleted"]}
import re
xml_ids = {int(m) for m in re.findall(r'<note id="n(\d+)(?:-t\d+)?"', xml)}
print("ids in xml match doc:", xml_ids == ids, len(xml_ids), len(ids))

bar5 = [n for n in doc["notes"] if n["measure"] == 4 and n["staff"] == 1 and not n["grace"]]
tgt = bar5[:2]
print("target notes:", [(n["id"], n["name"], n["voice"]) for n in tgt])

# pin to voice 3, move one to LH, respell, delete, undo, redo
d = ok(c.post(f"{B}/projects/{pid}/edits", json={"ops": [{"op": "set_voice", "ids": [tgt[0]["id"]], "voice": 3}], "label": "voice 3"}))
n0 = next(n for n in d["notes"] if n["id"] == tgt[0]["id"])
print("after set_voice 3:", n0["voice"], n0["edited"], "version", d["version"])
d = ok(c.post(f"{B}/projects/{pid}/edits", json={"ops": [{"op": "set_staff", "ids": [tgt[1]["id"]], "staff": 2}]}))
n1 = next(n for n in d["notes"] if n["id"] == tgt[1]["id"])
print("after set_staff 2:", n1["staff"])
d = ok(c.post(f"{B}/projects/{pid}/edits", json={"ops": [{"op": "respell", "ids": [tgt[1]["id"]], "prefer": "flat"}]}))
print("after respell flat:", next(n for n in d["notes"] if n["id"] == tgt[1]["id"])["name"])
d = ok(c.post(f"{B}/projects/{pid}/edits", json={"ops": [{"op": "delete", "ids": [tgt[0]["id"]]}]}))
print("after delete:", next(n for n in d["notes"] if n["id"] == tgt[0]["id"])["deleted"])
d = ok(c.post(f"{B}/projects/{pid}/edits", json={"ops": [{"op": "add_note", "pitch": 72, "on": 16, "dur": 1, "staff": 1, "voice": 4}]}))
added = [n for n in d["notes"] if n["added"]]
print("added:", [(n["id"], n["name"], n["voice"], n["on"]) for n in added])
d = ok(c.post(f"{B}/projects/{pid}/undo"))
print("undo -> added count", sum(n["added"] for n in d["notes"]), "history", d["history"])
d = ok(c.post(f"{B}/projects/{pid}/redo"))
print("redo -> added count", sum(n["added"] for n in d["notes"]))
r = c.post(f"{B}/projects/{pid}/edits", json={"ops": [{"op": "set_voice", "ids": [999999], "voice": 2}]})
print("invalid op ->", r.status_code, r.text[:80])
if d["review"]:
    it = next((x for x in d["review"] if any(o["index"] > 0 and o["supported"] for o in x["options"])), None)
    if it:
        k = next(o["index"] for o in it["options"] if o["index"] > 0 and o["supported"])
        d = ok(c.post(f"{B}/projects/{pid}/edits", json={"ops": [{"op": "resolve_review", "review_id": it["id"], "option": k}]}))
        print("resolved review", it["id"], "->", next(x for x in d["review"] if x["id"] == it["id"])["resolved"] if any(x["id"] == it["id"] for x in d["review"]) else "(item gone)")
for v in (1, 4):
    d = ok(c.put(f"{B}/projects/{pid}/settings", json={"max_voices": v}))
    print(f"max_voices={v}:", collections.Counter((n["staff"], n["voice"]) for n in d["notes"] if not n["deleted"]))
d = ok(c.put(f"{B}/projects/{pid}/settings", json={"max_voices": 3}))
mid = c.get(f"{B}/projects/{pid}/score.mid"); print("score.mid bytes", len(mid.content))
# restore to the original state
while d["history"]["can_undo"]:
    d = ok(c.post(f"{B}/projects/{pid}/undo"))
print("back to original, version", d["version"])
