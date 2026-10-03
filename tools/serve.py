#!/usr/bin/env python3
"""
One preview server for the whole project: the playable game, the install page
and the APK itself, all on a single port (default 8080) bound to 0.0.0.0 so the
host's preview proxy can reach it.

    /                         the game (game/www/index.html)
    /assets/<file>            the loose .glb files the page falls back to
    /install                  phone-friendly download + install page
    /download/MannequinPlayground.apk
                              the signed APK, served as an Android package so
                              the browser downloads it instead of rendering it
    /apk                      alias of the APK

Usage: python3 tools/serve.py [--port 8080]
"""

import argparse
import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME = os.path.join(ROOT, "game", "www")
ASSETS = os.path.join(GAME, "assets")
APK = os.path.join(ROOT, "dist", "MannequinPlayground.apk")
INSTALL = os.path.join(ROOT, "dist", "index.html")

APK_NAME = "MannequinPlayground.apk"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=GAME, **kwargs)

    def log_message(self, fmt, *args):  # quieter logs, easier to read
        sys.stderr.write("  %s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # the preview is embedded in an iframe on the host
        self.send_header("X-Frame-Options", "ALLOWALL")
        super().end_headers()

    def _send_file(self, path, ctype, download_name=None):
        if not os.path.isfile(path):
            self.send_error(404, f"missing {path}")
            return
        data = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        route = self.path.split("?")[0]

        # the APK: served as a package so tapping the link downloads it
        if route in ("/download/" + APK_NAME, "/apk", "/download", "/" + APK_NAME):
            self._send_file(APK, "application/vnd.android.package-archive", APK_NAME)
            return

        # the install page
        if route in ("/install", "/download.html"):
            self._send_file(INSTALL, "text/html; charset=utf-8")
            return

        # the game's fallback model files
        if route.startswith("/assets/"):
            name = os.path.basename(route)
            ctype = "model/gltf-binary" if name.endswith(".glb") else "application/octet-stream"
            self._send_file(os.path.join(ASSETS, name), ctype)
            return

        if route in ("/", "/index.html"):
            self._send_file(os.path.join(GAME, "index.html"), "text/html; charset=utf-8")
            return

        super().do_GET()

    do_HEAD = do_GET


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    args = ap.parse_args()

    for path in (GAME, APK):
        if not os.path.exists(path):
            sys.exit(f"missing {path}\nbuild it first:  node game/build.mjs --inline && python3 tools/apk_build.py")

    size = os.path.getsize(APK) / 1024
    print(f"Mannequin Playground on http://0.0.0.0:{args.port}")
    print(f"  /                        the game")
    print(f"  /install                 install page")
    print(f"  /download/{APK_NAME}   {size:.0f} KB")
    with Server(("0.0.0.0", args.port), Handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
