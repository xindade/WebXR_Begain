"""Local-only asset baking server: python tools/bake-server.py (open /tools/bake-depth-sprites.html)."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'depth-sprites'

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        name = self.path.removeprefix('/__bake/')
        if not self.path.startswith('/__bake/') or not re.fullmatch(r'(sprite-\d+-(albedo|depth)\.png|manifest\.json)', name):
            self.send_error(400); return
        # Only this local tool page may write; reject cross-origin browser requests.
        if self.headers.get('Origin') != 'http://127.0.0.1:8124':
            self.send_error(403); return
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 32 * 1024 * 1024:
            self.send_error(413); return
        OUTPUT.mkdir(parents=True, exist_ok=True)
        (OUTPUT / name).write_bytes(self.rfile.read(size))
        self.send_response(204); self.end_headers()

if __name__ == '__main__':
    print('Bake tool: http://127.0.0.1:8124/tools/bake-depth-sprites.html', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8124), Handler).serve_forever()
