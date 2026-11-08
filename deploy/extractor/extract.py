"""Single bounded inert extraction, stdin bytes -> UTF-8 stdout. No host mounts."""
import sys, subprocess, tempfile, re
from html.parser import HTMLParser
MAX = 1048576
class Inert(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.parts = []
        self.size = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'iframe', 'object', 'template', 'noscript'): self.depth += 1
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'iframe', 'object', 'template', 'noscript'): self.depth = max(0, self.depth - 1)
    def handle_data(self, text):
        if not self.depth:
            self.size += len(text.encode('utf-8')) + 1
            if self.size > MAX: raise ValueError()
            self.parts.append(text)
def main():
    data = sys.stdin.buffer.read(10485761)
    if not data or len(data) > 10485760: raise ValueError()
    mime = sys.argv[1]
    if mime == 'application/pdf':
        if not data.startswith(b'%PDF-') or not data.rstrip().endswith(b'%%EOF'): raise ValueError()
        # Decode PDF name escapes before checking active features (e.g. /J#53).
        names = re.sub(rb'#([0-9a-fA-F]{2})', lambda m: bytes([int(m[1], 16)]), data)
        if re.search(rb'/(Encrypt|JavaScript|JS|Launch|EmbeddedFile|Filespec|OpenAction|AA|AcroForm|RichMedia|XFA)\b', names): raise ValueError()
        with tempfile.TemporaryDirectory(dir='/tmp') as d:
            path = d + '/source.pdf'
            with open(path, 'wb') as f: f.write(data)
            result = subprocess.run(['pdfinfo', path], capture_output=True, check=True)
            if result.stderr: raise ValueError()
            info = result.stdout
            pages = re.search(rb'^Pages:\s+(\d+)', info, re.M)
            if not pages or not 1 <= int(pages[1]) <= 100 or not re.search(rb'^Encrypted:\s+no', info, re.M): raise ValueError()
            out = d + '/out.txt'
            result = subprocess.run(['pdftotext', '-enc', 'UTF-8', path, out], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            if result.stderr: raise ValueError()
            with open(out, 'rb') as f: text = f.read(MAX + 1).decode('utf-8', 'strict')
    elif mime in ('text/plain', 'text/markdown', 'text/html'):
        text = data.decode('utf-8', 'strict')
        if mime == 'text/html':
            parser = Inert(); parser.feed(text); parser.close(); text = '\n'.join(parser.parts)
    else: raise ValueError()
    if not text.strip() or '\0' in text or len(text.encode('utf-8')) > MAX: raise ValueError()
    sys.stdout.buffer.write(text.encode('utf-8'))
try: main()
except Exception: sys.exit(1)
