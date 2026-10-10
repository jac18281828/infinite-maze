// Entry for `node --test test/`: node 26 resolves the directory argument to
// this file as a module path. It loads every *.test.mjs beside it.
const { readdirSync } = require('node:fs');

for (const name of readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(`./${name}`);
}
