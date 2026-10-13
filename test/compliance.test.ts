import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StreamScrubber, ScrubTransform, scrubText } from '../src/compliance/scrubber.ts';
import { luhn, shannonEntropy } from '../src/compliance/detectors.ts';
import { assemblePrompt } from '../src/context.ts';
import { normalizeMessage } from '../src/fingerprint.ts';
import { FakeDocker } from './helpers/fakeDocker.ts';
import { DockerClient } from '../src/sandbox/client.ts';
import { Sandbox } from '../src/sandbox/sandbox.ts';
import { DEFAULT_POLICY } from '../src/sandbox/policy.ts';

// Fake credentials are assembled at runtime so this file never contains a literal token that
// GitHub secret scanning (push protection) would block.
const j = (...p: string[]) => p.join('');
const FAKE = {
  awsId: j('AKI', 'A', 'IOSFODNN7EXAMPLE'),
  awsSecret: j('wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYEXAMPLEKEY'),
  gh: j('gh', 'p_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'),
  stripe: j('sk', '_live_', 'a1B2c3D4e5F6g7H8i9J0kLmN'),
  slack: j('xo', 'xb-', '123456789012-abcdefghijklmnop'),
  anthropic: j('sk-', 'ant-', 'api03-Zk3Qm9Xv2Lp7Rt5Yw8Nb4Hc6Jd1Fg0Sa9'),
  openai: j('sk', '-proj-', 'q8Zr2LmX9vKt4WpB7nYc3HdJ6fGs1AaEu5Rx0QoI'),
  google: j('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  jwt: j('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
  email: j('jane.doe', '@', 'corp.io'),
  phoneIntl: '+1 (415) 555-0132',
  phoneUs: '415-555-0132',
  card: '4111 1111 1111 1111',
  ssn: '123-45-6789',
  address: '1600 Pennsylvania Avenue, Suite 2',
  bearerTok: j('abcDEF', '123456789', 'xyzABC'),
  dbPw: j('s3cr3t', 'Passw0rd'),
};
const BEARER = j('Bear', 'er ', FAKE.bearerTok);
const BEGIN = j('-----BEGIN ', 'RSA PRIVATE KEY', '-----');
const END = j('-----END ', 'RSA PRIVATE KEY', '-----');
const KEYBODY = Array.from({ length: 5 }, (_, i) => j('QUJD', 'REVG').repeat(8) + i).join('\n');

const salt = Buffer.from('test-salt-0123456789abcdef0123456789');
const opts = { salt };
const scrub = (s: string) => scrubText(s, opts) as string;
const run = (chunks: Array<Buffer | string>, o = opts) => {
  const s = new StreamScrubber(o);
  let out = '';
  for (const c of chunks) out += s.write(c);
  return out + s.flush();
};
const bytesIn = (buf: Buffer, size: number) => {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
};

// ---- detectors: true positives ------------------------------------------------------------
test('secrets are redacted, with a stable kind and tag', () => {
  const cases: Array<[string, string, string]> = [
    ['aws_access_key_id', `id=${FAKE.awsId} ok`, FAKE.awsId],
    ['aws_secret_access_key', `AWS_SECRET_ACCESS_KEY = "${FAKE.awsSecret}"`, FAKE.awsSecret],
    ['github_token', `push with ${FAKE.gh}`, FAKE.gh],
    ['stripe_key', `STRIPE=${FAKE.stripe}`, FAKE.stripe],
    ['slack_token', `hook ${FAKE.slack}`, FAKE.slack],
    ['anthropic_key', `key ${FAKE.anthropic}`, FAKE.anthropic],
    ['openai_style_key', `key ${FAKE.openai}`, FAKE.openai],
    ['google_api_key', `?key=${FAKE.google}`, FAKE.google],
    ['jwt', `token ${FAKE.jwt}`, FAKE.jwt],
    ['auth_header', `Authorization: ${BEARER}`, FAKE.bearerTok],
    ['url_credentials', j('postgres:', '//admin:', FAKE.dbPw, '@db.internal:5432/app'), FAKE.dbPw],
    ['secret_assignment', 'DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['secret_assignment', '{"apiKey": "AbCdEfGh12345678"}', 'AbCdEfGh12345678'],
  ];
  for (const [kind, input, secret] of cases) {
    const out = scrub(input);
    assert.ok(!out.includes(secret), `${kind}: secret leaked: ${out}`);
    assert.match(out, new RegExp(`\\[REDACTED:${kind}:[0-9a-f]{8}\\]`), `${kind}: ${out}`);
  }
});

test('PII is redacted', () => {
  const cases: Array<[string, string, string]> = [
    ['email', `contact ${FAKE.email} please`, FAKE.email],
    ['phone', `call ${FAKE.phoneIntl} now`, FAKE.phoneIntl],
    ['phone', `call ${FAKE.phoneUs} now`, FAKE.phoneUs],
    ['credit_card', `card ${FAKE.card} exp`, FAKE.card],
    ['ssn', `ssn ${FAKE.ssn}.`, FAKE.ssn],
    ['street_address', `ship to ${FAKE.address} today`, '1600 Pennsylvania'],
  ];
  for (const [kind, input, secret] of cases) {
    const out = scrub(input);
    assert.ok(!out.includes(secret), `${kind} leaked: ${out}`);
    assert.match(out, new RegExp(`\\[REDACTED:${kind}:`), `${kind}: ${out}`);
  }
});

// ---- detectors: false-positive guards ----------------------------------------------------
test('ordinary build output is left alone', () => {
  const clean = [
    'version 1.2.3 built at 2026-10-12 10:30:00',
    'epoch 1760268000 and 1760268000123',
    'listening on 192.168.100.100:8080',
    'id 550e8400-e29b-41d4-a716-446655440000',
    'commit da39a3ee5e6b4b0d3255bfef95601890afd80709',
    'token: string',
    'password: Password',
    'secret_key = process.env.SECRET_KEY',
    'const password = getPassword()',
    'git clone git@github.com:org/repo.git',
    'mail user@example.com',
    'src/app.ts:12:5 - error TS2322: Type string is not assignable',
    'risk-management-process-for-the-whole-production-pipeline-run',
    'card 4111 1111 1111 1112',   // fails Luhn
    'ssn-like 000-12-3456 and 666-12-3456',
  ];
  for (const line of clean) assert.equal(scrub(line), line, line);
  assert.ok(luhn('4111111111111111') && !luhn('4111111111111112'));
  assert.ok(shannonEntropy('aaaa') < shannonEntropy('aB3dE6gH9jK2'));
});

// ---- the core guarantee: chunking can never hide a secret --------------------------------
const DOC = [
  `INFO start héllo 😀 wörld`,
  `using ${FAKE.awsId} and ${FAKE.gh}`,
  `AWS_SECRET_ACCESS_KEY=${FAKE.awsSecret}`,
  `contact ${FAKE.email} or ${FAKE.phoneIntl}, card ${FAKE.card}`,
  `ship ${FAKE.address}`,
  `Authorization: ${BEARER}`,
  BEGIN, KEYBODY, END,
  `after key ${FAKE.jwt} done`,
  `last line without newline ${FAKE.stripe}`,
].join('\n');
const LEAKS = [FAKE.awsId, FAKE.gh, FAKE.awsSecret, FAKE.email, FAKE.phoneIntl, FAKE.card, '1600 Pennsylvania',
  FAKE.bearerTok, FAKE.jwt, FAKE.stripe, KEYBODY.split('\n')[2]!];

test('output is identical for EVERY two-way split, including inside multi-byte characters', () => {
  const buf = Buffer.from(DOC, 'utf8');
  const reference = run([buf]);
  for (const leak of LEAKS) assert.ok(!reference.includes(leak), `reference leaked ${leak}`);
  assert.match(reference, /héllo 😀 wörld/);
  assert.equal((reference.match(/\[REDACTED:private_key:/g) ?? []).length, 1);
  for (let cut = 1; cut < buf.length; cut++) {
    assert.equal(run([buf.subarray(0, cut), buf.subarray(cut)]), reference, `split at byte ${cut}`);
  }
});

test('output is identical for byte-at-a-time and random chunking', () => {
  const buf = Buffer.from(DOC, 'utf8');
  const reference = run([buf]);
  assert.equal(run(bytesIn(buf, 1)), reference);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 50; t++) {
    const chunks: Buffer[] = []; let i = 0;
    while (i < buf.length) { const n = 1 + Math.floor(rnd() * 40); chunks.push(buf.subarray(i, i + n)); i += n; }
    assert.equal(run(chunks), reference, `random chunking #${t}`);
  }
});

test('a 300 KB single line (force-emit path) is redacted identically for any chunking', () => {
  const secrets = [FAKE.gh, FAKE.jwt, `password=${'Zk3Qm9Xv2Lp7'}`, FAKE.email, FAKE.awsId];
  const filler = 'lorem ipsum dolor sit amet ';
  const parts: string[] = [];
  let pos = 0;
  const at = [10_000, 56_900, 57_300, 65_000, 130_000, 200_000, 290_000];
  at.forEach((p, i) => { parts.push(filler.repeat(Math.ceil((p - pos) / filler.length))); pos = p; parts.push(` ${secrets[i % secrets.length]} `); pos += 100; });
  parts.push(filler.repeat(200));
  const doc = parts.join('');
  const buf = Buffer.from(doc);
  const reference = run([buf]);
  for (const s of secrets) assert.ok(!reference.includes(s.replace('password=', '')), `leaked ${s}`);
  for (const size of [1, 13, 4096, 70_000]) assert.equal(run(bytesIn(buf, size)), reference, `chunk size ${size}`);
});

// ---- private keys -------------------------------------------------------------------------
test('multi-line private key: body dropped, one placeholder, surrounding text kept', () => {
  const out = run([`before\n${BEGIN}\n${KEYBODY}\n${END}\nafter\n`]);
  assert.equal(out.split('\n')[0], 'before');
  assert.match(out, /\[REDACTED:private_key:[0-9a-f]{8}\]\nafter\n$/);
  assert.ok(!out.includes('QUJD'));
});

test('unterminated private key block fails closed at flush', () => {
  const out = run([`start\n${BEGIN}\n${KEYBODY}\n`]);
  assert.ok(!out.includes('QUJD'));
  assert.match(out, /\[REDACTED:private_key:/);
});

test('single-line (escaped newline) private key is redacted inline', () => {
  const body = j('QUJD', 'REVG').repeat(8);
  const line = `{"key":"${BEGIN}\\n${body}\\n${END}","ok":true}`;
  const out = scrub(line);
  assert.ok(!out.includes(body));
  assert.match(out, /^\{"key":"\[REDACTED:private_key:[0-9a-f]{8}\]","ok":true\}$/);
});

// ---- placeholders, salts, counters -------------------------------------------------------
test('placeholder tag is deterministic per salt, correlates repeats, and does not reveal the value', () => {
  const a = scrub(`x ${FAKE.gh} y ${FAKE.gh} z`);
  const tags = [...a.matchAll(/github_token:([0-9a-f]{8})/g)].map(m => m[1]);
  assert.equal(tags.length, 2);
  assert.equal(tags[0], tags[1]);
  assert.notEqual(scrubText(`x ${FAKE.gh}`, { salt: Buffer.from('another-salt') }), scrub(`x ${FAKE.gh}`));
  assert.ok(!a.includes('aB3dE6'));
});

test('redaction counters and callbacks', () => {
  const events: string[] = [];
  const s = new StreamScrubber({ salt, onRedaction: e => events.push(`${e.kind}:${e.name}`) });
  s.write(`${FAKE.gh} ${FAKE.email}\n`); s.flush();
  assert.deepEqual(s.counts, { github_token: 1, email: 1 });
  assert.deepEqual(events.sort(), ['pii:email', 'secret:github_token']);
});

test('already-redacted text is not redacted again', () => {
  const once = scrub(`password=${FAKE.awsSecret}`);
  assert.equal(scrub(once), once);
});

// ---- robustness ---------------------------------------------------------------------------
test('adversarial 1 MB inputs finish quickly (no catastrophic backtracking)', () => {
  const MB = 1_000_000;
  const inputs = ['a'.repeat(MB), '1-'.repeat(MB / 2), 'a@'.repeat(MB / 2), '1 '.repeat(MB / 2), 'token'.repeat(MB / 5),
    'AKIA'.repeat(MB / 4), 'A1 '.repeat(MB / 3), `${'x'.repeat(100)}://${'u'.repeat(60)}:`.repeat(MB / 170)];
  const t0 = performance.now();
  for (const inp of inputs) run([inp]);
  const ms = performance.now() - t0;
  assert.ok(ms < 20_000, `took ${Math.round(ms)}ms`);
});

test('ScrubTransform works in a stream pipeline', async () => {
  const chunks = bytesIn(Buffer.from(DOC), 17);
  const got: string[] = [];
  const t = new ScrubTransform(opts);
  await pipeline(Readable.from(chunks), t, async function (src) { for await (const c of src) got.push(String(c)); });
  assert.equal(got.join(''), run([Buffer.from(DOC)]));
});

// ---- boundaries: scrub BEFORE truncate, fingerprints, sandbox ---------------------------
test('assemblePrompt scrubs before truncating', () => {
  const t = { pinned: 'task', working: `code\n${FAKE.gh}\n` + 'filler\n'.repeat(2000), failure: `err ${FAKE.email}`, ledger: `#1 ${FAKE.awsId}` };
  const refs = { pinned: 'b:1', working: 'b:2', failure: 'b:3', ledger: 'b:4' };
  const plain = assemblePrompt(t, 2000, refs);
  const safe = assemblePrompt(t, 2000, refs, scrub);
  assert.ok(plain.prompt.includes(FAKE.email));
  for (const leak of [FAKE.gh, FAKE.email, FAKE.awsId]) assert.ok(!safe.prompt.includes(leak), leak);
  assert.notEqual(plain.promptSha, safe.promptSha);
});

test('failures that differ only in a redacted value share one fingerprint', () => {
  const a = normalizeMessage('auth failed for [REDACTED:github_token:aaaaaaaa] at /x/y.ts:1:2');
  const b = normalizeMessage('auth failed for [REDACTED:github_token:bbbbbbbb] at /q/y.ts:9:9');
  assert.equal(a, b);
});

let fake: FakeDocker; let client: DockerClient;
before(async () => { fake = await FakeDocker.start(); client = new DockerClient(fake.socketPath, 5000); });
after(async () => { await fake.stop(); });

test('sandbox exec: secrets split across frames never reach the result or onFrame; tail is flushed', async () => {
  const sb = await Sandbox.create(client, { ...DEFAULT_POLICY, killGraceMs: 50 }, { tenantId: 't1', runId: 'r1' });
  const gh = FAKE.gh;
  fake.script = {
    frames: [[1, `deploy with ${gh.slice(0, 20)}`], [1, `${gh.slice(20)} done\n`], [2, `warn ${FAKE.email.slice(0, 5)}`], [2, `${FAKE.email.slice(5)}\n`],
      [1, `last ${FAKE.awsId} no newline`]],
    exitCode: 0, chunkSize: 9,
  };
  const seen: string[] = [];
  const r = await sb.exec({ argv: ['deploy'], scrub: () => new StreamScrubber(opts), onFrame: f => { seen.push(f.data.toString()); } });
  for (const leak of [gh, FAKE.email, FAKE.awsId, gh.slice(0, 20)]) {
    assert.ok(!r.stdout.text.includes(leak) && !r.stderr.text.includes(leak), `result leaked ${leak}`);
    assert.ok(!seen.join('').includes(leak), `onFrame leaked ${leak}`);
  }
  assert.match(r.stdout.text, /deploy with \[REDACTED:github_token:[0-9a-f]{8}\] done\nlast \[REDACTED:aws_access_key_id:/);
  assert.match(r.stderr.text, /warn \[REDACTED:email:/);
  assert.equal(r.exitCode, 0);
});
