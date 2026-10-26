/** Compile the visible panel and framework dependencies into local MV3 assets. */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const extensionDirectory = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("manifest.json", import.meta.url), "utf8"));
const OUTPUT_FILE = "dist/panel.js";
const NOTICE_FILE = "dist/THIRD_PARTY_NOTICES.txt";
const LICENSE_NAMES = /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i;
const VENDORED_LICENSES = Object.freeze({
  "@cfworker/json-schema@4.1.1": "licenses/cfworker-json-schema-4.1.1-LICENSE.txt",
  "js-tiktoken@1.0.21": "licenses/js-tiktoken-1.0.21-LICENSE.txt",
});

async function thirdPartyNotices(inputs) {
  const directories = new Set();
  for (const input of inputs) {
    const segments = input.split("/");
    const index = segments.lastIndexOf("node_modules");
    if (index >= 0) {
      const packageLength = segments[index + 1].startsWith("@") ? 2 : 1;
      directories.add(segments.slice(0, index + 1 + packageLength).join("/"));
    }
  }
  const sections = ["Ollama Copilot bundled third-party notices", "Generated from the locked packages included in this panel bundle."];
  for (const directory of [...directories].sort()) {
    const packageUrl = new URL(`${directory}/`, import.meta.url);
    const metadata = JSON.parse(await readFile(new URL("package.json", packageUrl), "utf8"));
    const identity = `${metadata.name}@${metadata.version}`;
    const names = (await readdir(packageUrl)).filter(name => LICENSE_NAMES.test(name)).sort();
    const files = names.map(name => ({ label: `${directory}/${name}`, url: new URL(name, packageUrl) }));
    if (!files.length && VENDORED_LICENSES[identity]) {
      const fallback = VENDORED_LICENSES[identity];
      files.push({ label: fallback, url: new URL(fallback, import.meta.url) });
    }
    if (!files.length) throw new Error(`The bundled package ${identity} has no available license notice.`);
    sections.push("", "=".repeat(72), identity, `Declared license: ${String(metadata.license || "See included notice")}`);
    for (const file of files) {
      const contents = await readFile(file.url, "utf8");
      if (!contents.trim()) throw new Error(`The license notice for ${identity} is empty.`);
      sections.push("", `Notice source: ${file.label}`, contents);
    }
  }
  return `${sections.join("\n")}\n`;
}

/** Test entries use the same compiler settings and return an unwritten asset. */
export async function buildPanelBundle({ contents } = {}) {
  if (contents !== undefined && typeof contents !== "string") throw new TypeError("A fixture entry must contain JavaScript text.");
  const result = await build({
    absWorkingDir: extensionDirectory,
    ...(contents === undefined ? { entryPoints: ["panel.mjs"] } : {
      stdin: { contents, resolveDir: extensionDirectory, sourcefile: "panel.fixture.mjs", loader: "js" },
    }),
    outfile: OUTPUT_FILE,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: `chrome${manifest.minimum_chrome_version}`,
    legalComments: "eof",
    metafile: true,
    write: false,
  });
  const outputs = Object.values(result.metafile.outputs);
  if (outputs.some(output => output.imports.some(item => item.external))) {
    throw new Error("The panel bundle must not depend on external runtime imports.");
  }
  const inputs = Object.keys(result.metafile.inputs);
  if (!inputs.some(input => input.includes("@langchain/langgraph/")) || !inputs.some(input => input.includes("@langchain/core/"))) {
    throw new Error("The packaged panel must contain the installed LangGraph and LangChain runtime.");
  }
  if (contents === undefined) {
    const notices = await thirdPartyNotices(inputs);
    const artifact = result.outputFiles.find(output => output.path.endsWith("panel.js"));
    if (result.outputFiles.length !== 1 || !artifact) throw new Error("The panel compiler returned an unexpected asset inventory.");
    await mkdir(new URL("dist/", import.meta.url), { recursive: true });
    await writeFile(new URL(OUTPUT_FILE, import.meta.url), artifact.contents);
    await writeFile(new URL(NOTICE_FILE, import.meta.url), notices, "utf8");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildPanelBundle();
  const bytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
  console.info(`Built local LangGraph/LangChain panel (${bytes} bytes) and third-party notices.`);
}
