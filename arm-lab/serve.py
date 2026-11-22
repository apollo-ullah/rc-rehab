"""Run with python3 serve.py, then open http://127.0.0.1:8741."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import ProxyHandler, build_opener
import re

class Lab(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)

    def do_GET(self):
        if self.path != '/device/sample':
            return super().do_GET()
        try:
            with build_opener(ProxyHandler({})).open('http://192.168.4.1/sample', timeout=0.8) as response:
                data = response.read(32).strip()
            if not re.fullmatch(rb'[0-9]{1,4}', data) or int(data) > 4095:
                raise ValueError('invalid sample')
        except (OSError, ValueError):
            self.send_error(503, 'Join Forearm-EMG Wi-Fi and check board power')
            return
        self.send_response(200)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if self.path != '/device/sample':
            super().log_message(fmt, *args)

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8741), Lab).serve_forever()
