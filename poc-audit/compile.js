// Compiles the audited contracts straight out of the repository tree.
// Nothing in packages/contracts is modified; only import paths are normalised
// because solc-js does not support remappings.
const solc = require('solc');
const fs = require('fs'), path = require('path');

const ROOT = __dirname;
const REPO = path.join(ROOT, '..', 'packages', 'contracts');   // repo contracts root
const SRC = path.join(REPO, 'contracts');
const key = (abs) => (abs.startsWith(SRC) ? 'contracts/' + path.relative(SRC, abs).split(path.sep).join('/')
                                          : path.relative(ROOT, abs).split(path.sep).join('/'));

function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    if (f === 'WETH9.sol' || f.startsWith('test-')) continue;   // 0.4.x pragma / tests only
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.sol')) out.push(p);
  }
  return out;
}

const extras = ['MockERC20.sol', 'Mocks2.sol', 'Probe.sol']
  .map(f => path.join(ROOT, f)).filter(fs.existsSync);
const queue = [...walk(SRC), ...extras];

const sources = {}, seen = new Set();
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) {
    const p = path.join(REPO, 'node_modules', spec);
    if (fs.existsSync(p)) return p;
    const q = path.join(ROOT, 'node_modules', spec);
    if (fs.existsSync(q)) return q;
    const r = path.join(SRC, spec.replace(/^contracts\//, ''));
    if (fs.existsSync(r) && fs.statSync(r).isFile()) return r;
  }
  const cands = [path.join(path.dirname(fromFile), spec),
                 path.join(SRC, spec.replace(/^contracts\//, '')),
                 path.join(REPO, 'node_modules', spec),
                 path.join(ROOT, 'node_modules', spec)];
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  throw new Error('cannot resolve ' + spec + ' from ' + fromFile);
}

while (queue.length) {
  const f = queue.shift(), k = key(f);
  if (seen.has(k)) continue;
  seen.add(k);
  const src = fs.readFileSync(f, 'utf8')
    .replace(/(import\s+(?:\{[^}]*\}\s+from\s+)?["'])([^"']+)(["'])/g, (m, a, spec, c) => {
      const t = resolveImport(f, spec);
      if (!seen.has(key(t)) && !queue.some(q => key(q) === key(t))) queue.push(t);
      return a + key(t) + c;
    });
  sources[k] = { content: src };
}

const input = { language: 'Solidity', sources,
  settings: { optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter(e => e.severity === 'error');
for (const e of errs.slice(0, 5)) console.log('ERR', e.formattedMessage.split('\n').slice(0, 3).join(' | '));
if (errs.length) process.exit(1);

fs.rmSync(path.join(ROOT, 'build'), { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
let n = 0;
for (const [file, cs] of Object.entries(out.contracts)) for (const [name, c] of Object.entries(cs)) {
  if (!c.evm.bytecode.object && !c.evm.deployedBytecode.object) continue;
  fs.writeFileSync(path.join(ROOT, 'build', `${name}.json`),
    JSON.stringify({ file, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployed: '0x' + c.evm.deployedBytecode.object }));
  n++;
}
console.log('compiled sources:', Object.keys(sources).length, 'contracts:', n);
