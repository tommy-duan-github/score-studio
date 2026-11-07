"""Render a MusicXML file to an HTML page of SVGs using Verovio (for quick visual inspection)."""
import sys, pathlib, verovio
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
pages = int(sys.argv[3]) if len(sys.argv) > 3 else 999
tk = verovio.toolkit()
tk.setOptions({"pageWidth": 2100, "pageHeight": 2970, "scale": 40, "adjustPageHeight": True, "breaks": "auto"})
tk.loadFile(str(src))
n = min(tk.getPageCount(), pages)
svgs = "".join(f'<div class="pg"><div class="lbl">page {i}</div>{tk.renderToSVG(i)}</div>' for i in range(1, n + 1))
out.write_text(f"<!doctype html><meta charset=utf-8><title>{src.name}</title><style>body{{background:#eee;font-family:sans-serif}}.pg{{background:#fff;margin:12px auto;max-width:1100px;padding:8px}}.lbl{{color:#888}}svg{{width:100%;height:auto}}</style>{svgs}", encoding="utf-8")
print(f"rendered {n}/{tk.getPageCount()} pages -> {out}")
