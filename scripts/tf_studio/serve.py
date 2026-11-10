"""TF Studio local server: serves the tool and gives it read/write access to the game folder.

usage: python serve.py [GAME_DIR] [PORT]
GAME_DIR defaults to two folders up from this file (the "Fresh Build" folder). Binds to 127.0.0.1 only.

API (all paths are relative to GAME_DIR, matched case-insensitively like Windows does):
  GET  /api/list?dir=REL          -> {"dirs": [...], "files": [{"name", "size"}]}
  GET  /api/find?ext=.GHG,.GSC    -> ["REL/PATH", ...] every file with one of these extensions
  GET  /api/file?path=REL         -> raw bytes
  POST /api/save?path=REL         -> writes the body; the first save of a file keeps the original as REL.studio.bak
"""
import json, os, shutil, sys, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '..'))
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
SKIP_DIRS = {'__pycache__', '.git', 'tf_studio', 'PS3 assets'}
# PS3 level folders copied into GAME\PS3 assets\LEVELS (view-only in the tool) appear as LEVELS/PS3_<name>
PS3_LEVELS = os.path.join(GAME, 'PS3 assets', 'LEVELS')
PS3_PREFIX = 'PS3_'


def ps3_levels():
    return sorted(e.name for e in os.scandir(PS3_LEVELS) if e.is_dir()) if os.path.isdir(PS3_LEVELS) else []


def resolve(rel, must_exist=True):
    """Map a relative path onto GAME, case-insensitively. Refuses anything outside GAME.
    LEVELS/PS3_<name>/... maps to PS3 assets/LEVELS/<name>/..."""
    cur = GAME
    parts = [p for p in rel.replace('\\', '/').split('/') if p not in ('', '.')]
    if len(parts) >= 2 and parts[0].lower() == 'levels' and parts[1].upper().startswith(PS3_PREFIX) \
            and parts[1][len(PS3_PREFIX):].lower() in (n.lower() for n in ps3_levels()):
        cur = PS3_LEVELS
        parts = [parts[1][len(PS3_PREFIX):]] + parts[2:]
    for i, part in enumerate(parts):
        if part == '..':
            raise PermissionError(rel)
        nxt = os.path.join(cur, part)
        if not os.path.exists(nxt) and os.path.isdir(cur):
            hit = [x for x in os.listdir(cur) if x.lower() == part.lower()]
            if hit:
                nxt = os.path.join(cur, hit[0])
            elif must_exist or i < len(parts) - 1:
                raise FileNotFoundError(rel)
        cur = nxt
    full = os.path.abspath(cur)
    if os.path.commonpath([full, GAME]) != GAME:
        raise PermissionError(rel)
    return full


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def log_message(self, fmt, *args):
        if '/api/' not in str(args[0] if args else ''):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == '/api/list':
                d = resolve(q.get('dir', [''])[0])
                dirs, files = [], []
                for e in sorted(os.scandir(d), key=lambda e: e.name.lower()):
                    if e.is_dir():
                        if e.name not in SKIP_DIRS: dirs.append(e.name)
                    else:
                        files.append(dict(name=e.name, size=e.stat().st_size))
                if os.path.normcase(d) == os.path.normcase(os.path.join(GAME, 'LEVELS')):
                    dirs += [PS3_PREFIX + n for n in ps3_levels()]
                return self.send_json(dict(dirs=dirs, files=files))
            if u.path == '/api/find':
                exts = tuple(x.lower() for x in q.get('ext', [''])[0].split(',') if x)
                out = []
                for root, ds, fs in os.walk(GAME):
                    ds[:] = sorted(x for x in ds if x not in SKIP_DIRS)
                    for f in sorted(fs):
                        if f.lower().endswith(exts):
                            out.append(os.path.relpath(os.path.join(root, f), GAME).replace('\\', '/'))
                return self.send_json(out)
            if u.path == '/api/file':
                p = resolve(q['path'][0])
                data = open(p, 'rb').read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if u.path == '/api/info':
                return self.send_json(dict(game=GAME))
        except FileNotFoundError as e:
            return self.send_json(dict(error='not found: %s' % e), 404)
        except PermissionError as e:
            return self.send_json(dict(error='outside the game folder: %s' % e), 403)
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path != '/api/save':
            return self.send_json(dict(error='unknown'), 404)
        try:
            p = resolve(q['path'][0], must_exist=False)
            n = int(self.headers.get('Content-Length', 0))
            data = self.rfile.read(n)
            backup = None
            if os.path.exists(p) and not os.path.exists(p + '.studio.bak'):
                backup = p + '.studio.bak'
                shutil.copy2(p, backup)
            tmp = p + '.studio.tmp'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, p)
            return self.send_json(dict(ok=True, bytes=len(data),
                                       backup=os.path.relpath(backup, GAME) if backup else None))
        except Exception as e:
            return self.send_json(dict(error=str(e)), 500)


if __name__ == '__main__':
    import mimetypes
    mimetypes.add_type('text/javascript', '.js')
    print('TF Studio')
    print('  game folder:', GAME)
    print('  open        http://127.0.0.1:%d/' % PORT)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
