#!/usr/bin/env python3
"""HTTP server with COOP/COEP headers for SharedArrayBuffer support."""
import http.server
import socketserver
import os

class COOPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required for SharedArrayBuffer / AudioWorklet
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

if __name__ == "__main__":
    os.chdir("/Volumes/X9Lap/cydrumsClaude")
    PORT = 8080
    with socketserver.TCPServer(("", PORT), COOPHandler) as httpd:
        print(f"Serving at http://localhost:{PORT} with COOP/COEP headers")
        httpd.serve_forever()