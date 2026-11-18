
const { spawn } = require('node:child_process');
function run(cmd, args, ms) {
  return new Promise((res) => {
    let out = '', err = '';
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'] }); }
    catch (e) { return res({ cmd, code: 'spawn-fail', out: '', err: String(e.message) }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} res({ cmd, code: 'timeout', out, err }); }, ms);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); res({ cmd, code: 'error', out, err: String(e.message) }); });
    p.on('close', c => { clearTimeout(t); res({ cmd, code: c, out, err }); });
  });
}
(async () => {
  const dsh = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
  for (const [c, a, ms] of [
    ['/opt/homebrew/bin/opencode', ['run','--help'], 8000],
    ['/opt/homebrew/bin/opencode', ['--help'], 8000],
    [dsh, ['--help'], 6000],
  ]) {
    const r = await run(c, a, ms);
    console.log('=== ' + c.split('/').pop() + ' ' + a.join(' ') + ' => code ' + r.code);
    console.log((r.out || r.err).split('\n').slice(0, 30).join('\n'));
    console.log('');
  }
})();
