import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { containerExtractor } from "./container-extractor.ts";
import { extractBytes } from "./extractor.ts";

const image = process.env.TEST_LIBRARIAN_EXTRACTOR_IMAGE;
const qualified = image ? test : test.skip;
function pdf(pages = 1, extra = "", text = true): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: string[] = [];
  for (let i = 0; i < pages; i++) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    const stream = text ? "BT /F1 12 Tf 72 720 Td (Qualification PDF) Tj ET" : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R ${extra} >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  out += offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("");
  return Buffer.from(`${out}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
qualified(
  "real parsers accept four formats and deny PDF/page/text/signature limits",
  async () => {
    if (!image) throw new Error("fixture_image_required");
    const sandbox = containerExtractor(image);
    for (const mime of ["text/plain", "text/markdown", "text/html"]) {
      const input =
        mime === "text/html"
          ? '<p>hello</p><script>bad</script><iframe src="https://invalid.test">bad</iframe>'
          : "hello";
      expect(await extractBytes(Buffer.from(input), mime, sandbox)).toBe("hello");
    }
    expect(await extractBytes(pdf(), "application/pdf", sandbox)).toContain("Qualification PDF");
    expect(await extractBytes(pdf(100), "application/pdf", sandbox)).toContain("Qualification PDF");
    for (const bytes of [
      pdf(101),
      pdf(1, "", false),
      pdf(1, "/J#53 (bad)"),
      pdf(1, "/Encrypt null"),
      pdf(1, "/EmbeddedFile null"),
      Buffer.from("%PDF-1.7\nbad\n%%EOF"),
      Buffer.concat([pdf(), Buffer.from("ZIP")]),
    ]) {
      await expect(extractBytes(bytes, "application/pdf", sandbox)).rejects.toThrow();
    }
    await expect(extractBytes(Buffer.alloc(1048577, 97), "text/plain", sandbox)).rejects.toThrow();
    await expect(extractBytes(Buffer.from("hello"), "application/zip", sandbox)).rejects.toThrow();
    await expect(extractBytes(Buffer.from("hello"), "text/plain")).rejects.toThrow("unavailable");
    await expect(
      containerExtractor(`sha256:${"0".repeat(64)}`)({
        bytes: Buffer.from("hello"),
        mime: "text/plain",
        network: false,
        memoryBytes: 268435456,
        cpuSeconds: 10,
        maxPages: 100,
        maxOutputBytes: 1048576,
      }),
    ).rejects.toThrow();
  },
  120000,
);

qualified(
  "same launcher denies network/root writes, bounds memory/CPU/deadline/output and reaps jobs",
  async () => {
    const code = `import sys,socket,os,time,json,resource
mode=sys.stdin.read()
if mode=='probe':
 denied=[]
 for name,action in [('network',lambda:socket.create_connection(('1.1.1.1',443),1)),('root',lambda:open('/escape','w')),('host',lambda:open('/host/etc/passwd'))]:
  try: action()
  except OSError: denied.append(name)
 print(json.dumps([denied,os.getuid(),resource.getrlimit(resource.RLIMIT_CPU)[0],resource.getrlimit(resource.RLIMIT_NOFILE)[0]]))
elif mode=='memory': x=bytearray(400*1024*1024)
elif mode=='cpu':
 while True: pass
elif mode=='deadline': time.sleep(60)
elif mode=='output': sys.stdout.write('x'*1048577)
`;
    const tag = `librarian-probe-${crypto.randomUUID()}:local`;
    if (!image) throw new Error("fixture_image_required");
    spawnSync("docker", ["tag", image, `${tag}-base`]);
    const build = spawnSync("docker", ["build", "-q", "-t", tag, "-"], {
      input: `FROM ${tag}-base\nENTRYPOINT ${JSON.stringify(["python3", "-I", "-c", code])}\n`,
      encoding: "utf8",
    });
    if (build.status !== 0) throw new Error(build.stderr);
    const id = spawnSync("docker", ["image", "inspect", "--format={{.Id}}", tag], {
      encoding: "utf8",
    }).stdout.trim();
    try {
      const sandbox = containerExtractor(id);
      const run = (s: string) => extractBytes(Buffer.from(s), "text/plain", sandbox);
      expect(JSON.parse(await run("probe"))).toEqual([["network", "root", "host"], 65534, 10, 64]);
      for (const mode of ["memory", "cpu", "deadline", "output"]) await expect(run(mode)).rejects.toThrow();
      const remaining = spawnSync("docker", ["ps", "-aq", "--filter", `ancestor=${id}`], {
        encoding: "utf8",
      });
      expect(remaining.stdout.trim()).toBe("");
    } finally {
      spawnSync("docker", ["image", "rm", tag, `${tag}-base`]);
    }
  },
  120000,
);
