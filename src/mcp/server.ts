/**
 * MCP server exposing the sandbox to the agent. One process per (tenant, run), launched by the
 * orchestrator over stdio. Tenant and run identity come from the environment the orchestrator
 * set: the model can never supply or override them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DockerClient } from '../sandbox/client.ts';
import { SandboxManager } from '../sandbox/manager.ts';
import { DEFAULT_POLICY } from '../sandbox/policy.ts';
import type { SandboxPolicy } from '../sandbox/policy.ts';
import { StreamScrubber, randomSalt } from '../compliance/scrubber.ts';

const tenantId = process.env.NEXUS_TENANT_ID;
const runId = process.env.NEXUS_RUN_ID;
if (!tenantId || !runId) {
  console.error('NEXUS_TENANT_ID and NEXUS_RUN_ID are required');
  process.exit(2);
}
const ident = { tenantId, runId };
// Per-process salt: placeholder tags correlate repeated values within this run only.
const salt = randomSalt();

const policy: SandboxPolicy = {
  ...DEFAULT_POLICY,
  image: process.env.NEXUS_IMAGE ?? DEFAULT_POLICY.image,
  runtime: process.env.NEXUS_RUNTIME === 'runc' ? 'runc' : 'runsc',
  allowRuncFallback: process.env.NEXUS_ALLOW_RUNC_FALLBACK === '1',
};
const manager = new SandboxManager(new DockerClient(process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'), policy);

const text = (v: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }],
  ...(isError ? { isError: true } : {}),
});
const fail = (e: unknown) => text(e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e), true);

const server = new McpServer({ name: 'nexus-sandbox', version: '0.1.0' });

server.tool(
  'sandbox_write_files',
  'Write files into /workspace of the sandbox. Paths are relative; no traversal.',
  { files: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean().optional() })).max(500) },
  async ({ files }) => {
    try {
      const sb = await manager.getOrCreate(ident);
      const r = await sb.writeFiles(files.map(f => ({ path: f.path, content: f.content, mode: f.executable ? 0o755 : 0o644 })));
      return text(r);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  'sandbox_exec',
  'Run a command (argv array, no shell) in the sandbox. No network. Output is head+tail truncated.',
  {
    argv: z.array(z.string()).min(1).max(64),
    timeout_ms: z.number().int().min(100).max(300_000).optional(),
    cwd: z.string().optional(),
  },
  async ({ argv, timeout_ms, cwd }) => {
    try {
      const sb = await manager.getOrCreate(ident);
      const r = await sb.exec({ argv, timeoutMs: timeout_ms, cwd, scrub: () => new StreamScrubber({ salt }) });
      return text({
        exit_code: r.exitCode, termination: r.termination, duration_ms: r.durationMs,
        stdout: r.stdout.text, stderr: r.stderr.text,
        stdout_dropped_bytes: r.stdout.droppedBytes, stderr_dropped_bytes: r.stderr.droppedBytes,
        daemon_errors: r.daemonErrors,
      });
    } catch (e) { return fail(e); }
  },
);

server.tool('sandbox_reset', 'Destroy the sandbox; the next call creates a fresh one.', {}, async () => {
  try { await manager.destroy(ident); return text({ ok: true }); } catch (e) { return fail(e); }
});

const shutdown = async () => { await manager.closeAll().catch(() => undefined); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
