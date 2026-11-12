"""Build the zip you upload to the Chrome Web Store (or Edge Add-ons): dist/lectern-<version>.zip

    python3 scripts/package.py

Only the files the extension needs go in; tests, docs and tooling stay out.
"""
import json, os, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INCLUDE = ["manifest.json", "LICENSE", "src", "icons", "fonts"]

version = json.load(open(os.path.join(ROOT, "manifest.json")))["version"]
os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
out = os.path.join(ROOT, "dist", f"lectern-{version}.zip")

count = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if os.path.isfile(path):
            z.write(path, item)
            count += 1
            continue
        for folder, dirs, files in os.walk(path):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for name in sorted(files):
                if name.startswith(".") or name.endswith(".map"):
                    continue
                full = os.path.join(folder, name)
                z.write(full, os.path.relpath(full, ROOT))
                count += 1

print(f"{os.path.relpath(out, ROOT)}: {count} files, {os.path.getsize(out) // 1024} KB")
if not count:
    sys.exit(1)
