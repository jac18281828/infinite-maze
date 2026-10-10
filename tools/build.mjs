// Builds infinite-maze.html: every module reachable from src/game/main.mjs,
// each wrapped in its own function scope, inlined into src/shell.html.
//
//   node tools/build.mjs           write infinite-maze.html
//   node tools/build.mjs --check   exit 1 when the file on disk is stale
//
// Supported module syntax: `import { a, b as c } from './x.mjs';` and
// `export` before function, class, const or let declarations.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src/game/main.mjs');
const SHELL = join(ROOT, 'src/shell.html');
export const OUT = join(ROOT, 'infinite-maze.html');

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT = /^export\s+(?:async\s+)?(function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

function parse(file) {
  const src = readFileSync(file, 'utf8');
  const imports = [];
  for (const m of src.matchAll(IMPORT)) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [name, alias] = s.split(/\s+as\s+/);
      return { name: name.trim(), alias: (alias || name).trim() };
    });
    imports.push({ names, path: resolve(dirname(file), m[2]) });
  }
  const exports = [...src.matchAll(EXPORT)].map((m) => m[2]);
  if (/^\s*(import|export)\b/m.test(src.replace(IMPORT, '').replace(EXPORT, '$1 $2'))) {
    throw new Error(`${relative(ROOT, file)}: unsupported import or export form`);
  }
  const body = src.replace(IMPORT, '').replace(/^export\s+/gm, '');
  return { file, imports, exports, body };
}

/** Modules in dependency order, entry last. */
function collect(entry) {
  const order = [], seen = new Map();
  const visit = (file, stack) => {
    if (stack.includes(file)) throw new Error(`import cycle: ${[...stack, file].map((f) => relative(ROOT, f)).join(' -> ')}`);
    if (seen.has(file)) return;
    const mod = parse(file);
    for (const imp of mod.imports) visit(imp.path, [...stack, file]);
    seen.set(file, mod);
    order.push(mod);
  };
  visit(entry, []);
  return order;
}

export function build() {
  const mods = collect(ENTRY);
  const id = new Map(mods.map((m, i) => [m.file, `__m${i}`]));
  const parts = mods.map((m) => {
    const head = m.imports.map((imp) => {
      const binds = imp.names.map((n) => (n.name === n.alias ? n.name : `${n.name}: ${n.alias}`)).join(', ');
      return `const { ${binds} } = ${id.get(imp.path)};`;
    }).join('\n');
    return `// ${relative(ROOT, m.file)}\nconst ${id.get(m.file)} = (() => {\n${head}\n${m.body.trim()}\nreturn { ${m.exports.join(', ')} };\n})();`;
  });
  const bundle = `(() => {\n'use strict';\n${parts.join('\n\n')}\n})();`;
  const shell = readFileSync(SHELL, 'utf8');
  if (!shell.includes('/*BUNDLE*/')) throw new Error('src/shell.html lacks the /*BUNDLE*/ marker');
  return shell.replace('/*BUNDLE*/', () => bundle);
}

function main(argv) {
  const html = build();
  if (argv.includes('--check')) {
    const disk = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
    if (disk !== html) {
      console.error('infinite-maze.html is stale: run node tools/build.mjs');
      return 1;
    }
    console.log('infinite-maze.html is current');
    return 0;
  }
  writeFileSync(OUT, html);
  console.log(`wrote ${relative(ROOT, OUT)} (${html.length} bytes)`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
