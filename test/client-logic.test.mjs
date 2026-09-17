// 用假的 __ModuleLoader__ 装载 client.js,只测纯逻辑(不碰 React/DOM)
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

let captured = null;
const registered = [];
globalThis.window = { __ModuleLoader__: { load: (def) => { registered.push(def.id); if (captured === null) captured = def; else if (def.id === '@local/dsh-console-tap-ui') captured = def; } } };
const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
new Function('window', src)(globalThis.window);
assert.ok(captured, '未捕获到 load() 调用');
assert.equal(captured.id, '@local/dsh-console-tap-ui', '首选 id 必须是正式包名');
assert.ok(registered.includes('@local/dsh-console-tap'), '历史 id 也要注册(兼容旧行)');
console.log('注册的 id:', registered.join(', '));

const ReactStub = {
  createElement: () => ({}), Fragment: {}, useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {}, useRef: (v) => ({ current: v }),
};
const requireStub = (spec) => {
  if (spec === 'react') return ReactStub;
  if (spec === 'react-dom/client') return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
  throw new Error('unexpected require: ' + spec);
};
const mod = captured.factory(requireStub);
console.log('exports:', Object.keys(mod).join(','));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log('  [PASS] ' + name + (detail ? ' -> ' + detail : '')); } else { fail++; console.log('  [FAIL] ' + name + ' -> ' + detail); } };

console.log('== 终端写屏(CR 覆盖 / LF 换行) ==');
const s = mod.createFeed();
s.handle({ type: 'command-start', id: 'c1', command: 'gradle assembleRelease', tool: 'bash', sessionId: 'session-abc12345', at: Date.now() });
s.handle({ type: 'chunk', id: 'c1', stream: 'stdout', seq: 10, text: '> Task :app:clean\n> Task :app:preBuild\n' });
let rec = s.get('c1');
check('多行写入成 3 行(含结尾空行)', rec.screens.stdout.lines.length === 3, JSON.stringify(rec.screens.stdout.lines));
// 进度条重绘:同一行反复覆盖
s.handle({ type: 'chunk', id: 'c1', stream: 'stdout', seq: 40, text: '<==----> 10% EXECUTING [1s]' });
s.handle({ type: 'chunk', id: 'c1', stream: 'stdout', seq: 70, text: '\r<=====> 73% EXECUTING [1m 32s]' });
rec = s.get('c1');
check('CR 覆盖同一行(不新增行)', rec.screens.stdout.lines.length === 3, '行数=' + rec.screens.stdout.lines.length);
check('覆盖后是最后一次内容', rec.screens.stdout.lines[2].includes('73%'), rec.screens.stdout.lines[2]);
const st = mod.statusOf(rec.screens.stdout.lines);
check('状态行解析出真实百分比', st && st.percent === 73 && st.phase === 'EXECUTING' && st.elapsed === '1m 32s', JSON.stringify(st));

console.log('== ANSI 去除 ==');
s.handle({ type: 'chunk', id: 'c1', stream: 'stdout', seq: 90, text: '\n\u001b[1m> Task :app:compileReleaseKotlin\u001b[0m\n' });
check('ANSI 已剔除', s.get('c1').screens.stdout.lines.some((l) => l.includes('> Task :app:compileReleaseKotlin')) && !s.get('c1').screens.stdout.lines.some((l) => l.includes('\u001b')), '');

console.log('== stderr 分条流 + 结束 ==');
s.handle({ type: 'chunk', id: 'c1', stream: 'stderr', seq: 5, text: 'w: 有个警告\n' });
check('stderr 独立成屏', s.get('c1').screens.stderr.lines[0].includes('警告'), s.get('c1').screens.stderr.lines[0]);
s.handle({ type: 'command-end', id: 'c1', exitCode: 0, ms: 404000, bytes: { stdout: 90, stderr: 5 } });
check('结束状态入账', s.get('c1').endedAt !== null && s.get('c1').exitCode === 0 && s.get('c1').ms === 404000, '');

console.log('== 缺口标记 ==');
s.handle({ type: 'gap', id: 'c1', stream: 'stdout', fromByte: 100, toByte: 300, note: '已用 spill 文件补齐缺失字节' });
check('缺口写进画面并计数', s.get('c1').gaps.length === 1 && s.get('c1').screens.stdout.lines.join('\n').includes('缺口'), '');

console.log('== hello 恢复在跑命令列表 ==');
const s2 = mod.createFeed();
s2.handle({ type: 'hello', version: 1, live: [{ id: 'cX', command: 'sleep 5', tool: 'bash', sessionId: 'session-z', confidence: 'exact' }] });
check('hello 里的 live 命令进入列表', s2.list().length === 1 && s2.list()[0].command === 'sleep 5', JSON.stringify(s2.list().map((x) => x.command)));
s2.handle({ type: 'chunk', id: 'cX', stream: 'stdout', seq: 6, text: 'done\n' });
check('随后 chunk 正常追加', s2.get('cX').screens.stdout.lines.join('').includes('done'), '');

console.log('== 行数上限(防爆内存) ==');
const s3 = mod.createFeed();
s3.handle({ type: 'command-start', id: 'c9', command: 'yes' });
for (let i = 0; i < 4000; i += 1) s3.handle({ type: 'chunk', id: 'c9', stream: 'stdout', seq: i + 1, text: `line ${i}\n` });
check('行数被限制在 3000 以内', s3.get('c9').screens.stdout.lines.length <= 3001, '实际 ' + s3.get('c9').screens.stdout.lines.length);
check('保留的是最新的行', s3.get('c9').screens.stdout.lines.join('\n').includes('line 3999'), '');

console.log('\n结果: PASS=' + pass + ' FAIL=' + fail);
process.exit(fail > 0 ? 1 : 0);
