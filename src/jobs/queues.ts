/**
 * BullMQ wiring. All decisions live in the pure modules; this file only connects them to Redis.
 * Not integration-tested yet (needs a real Redis): see README status.
 */
import { Queue, Worker, UnrecoverableError } from 'bullmq';
import type { ConnectionOptions, Job, JobsOptions } from 'bullmq';
import { idempotencyKey } from './idempotency.ts';
import { delayMs } from './backoff.ts';
import type { BackoffOpts } from './backoff.ts';
import { BackpressureError, classifyError, PermanentFailure, RetryableFailure } from './errors.ts';
import type { ErrorClass } from './errors.ts';
import { runIdempotent } from './runner.ts';
import type { ExternalAction, RunnerDeps } from './runner.ts';
import { triage } from './dlq.ts';
import type { DeadLetter } from './dlq.ts';
import type { BreakerRegistry } from './breaker.ts';

/** BullMQ queue names cannot contain ':'. */
export const QUEUES = { agent: 'nexus-agent', infra: 'nexus-infra', dlq: 'nexus-dlq' } as const;

export interface JobPayload { tenantId: string; runId: string; stepId: string; action: string; params: unknown }
export interface DeadJob { dead: DeadLetter; payload: JobPayload; decision: ReturnType<typeof triage> }

export interface Topology {
  agent: Queue<JobPayload>;
  infra: Queue<JobPayload>;
  dlq: Queue<DeadJob>;
  close(): Promise<void>;
}

export const RETRY_BACKOFF: BackoffOpts = { baseMs: 1_000, capMs: 5 * 60_000, maxRetryAfterMs: 5 * 60_000 };

export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'custom' },                       // delay computed by settings.backoffStrategy below
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function createTopology(connection: ConnectionOptions): Topology {
  const agent = new Queue<JobPayload>(QUEUES.agent, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
  const infra = new Queue<JobPayload>(QUEUES.infra, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
  const dlq = new Queue<DeadJob>(QUEUES.dlq, { connection });       // parking lot: no worker, triaged by the redriver
  return { agent, infra, dlq, close: async () => { await Promise.all([agent.close(), infra.close(), dlq.close()]); } };
}

/**
 * Producer-side admission control. When consumers fall behind, producers get an error they can act on
 * (pause the run, shed load) instead of silently growing latency and Redis memory without bound.
 * jobId = idempotency key, so a producer retry cannot enqueue a duplicate while the job still exists.
 */
export async function enqueue(q: Queue<JobPayload>, p: JobPayload, maxDepth = 1000): Promise<string> {
  const counts = await q.getJobCounts('waiting', 'delayed');
  if ((counts.waiting ?? 0) + (counts.delayed ?? 0) >= maxDepth) throw new BackpressureError(`queue ${q.name} at depth limit ${maxDepth}`);
  const jobId = idempotencyKey({ tenantId: p.tenantId, runId: p.runId, stepId: p.stepId, action: p.action, params: p.params });
  await q.add(p.action, p, { jobId });
  return jobId;
}

export interface InfraWorkerOpts {
  concurrency?: number;
  /** Provider API quota: at most `max` jobs started per `duration` ms across this worker. */
  limiter?: { max: number; duration: number };
  maxRedrives?: number;
}

function errorClassOf(err: Error): DeadLetter['errorClass'] {
  if (err instanceof PermanentFailure) return err.errorClass;
  if (err instanceof RetryableFailure) return err.errorClass;
  return classifyError(err).cls as ErrorClass;
}

const isFinal = (job: Job, err: Error): boolean =>
  err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);

export function startInfraWorker(
  connection: ConnectionOptions,
  topo: Topology,
  registry: Map<string, ExternalAction<any, any>>,
  deps: RunnerDeps,
  breakers: BreakerRegistry,
  opts: InfraWorkerOpts = {},
): Worker<JobPayload> {
  const worker = new Worker<JobPayload>(
    QUEUES.infra,
    async (job: Job<JobPayload>) => {
      const { tenantId, runId, stepId, action: name, params } = job.data;
      const action = registry.get(name);
      if (!action) throw new UnrecoverableError(`unknown action "${name}"`);

      const breaker = breakers.get(action.provider);
      if (!breaker.canPass()) {
        // Fail soft: this burns an attempt, but backoffStrategy honors retryAfterMs, and the DLQ redrives later.
        throw new RetryableFailure(`circuit open for ${action.provider}`, 'transient', breaker.retryInMs());
      }
      try {
        const out = await runIdempotent(action, params, { tenantId, runId, stepId }, deps);
        breaker.success();
        return out.result;
      } catch (e) {
        const cls = classifyError(e).cls;
        if (cls === 'transient' || cls === 'throttled' || cls === 'ambiguous') breaker.failure();
        if (e instanceof PermanentFailure) throw new UnrecoverableError(e.message);
        throw e;
      }
    },
    {
      connection,
      concurrency: opts.concurrency ?? 5,
      ...(opts.limiter ? { limiter: opts.limiter } : {}),
      settings: {
        backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) =>
          delayMs(attemptsMade, RETRY_BACKOFF, err instanceof RetryableFailure ? err.retryAfterMs : undefined),
      },
    },
  );

  worker.on('failed', (job: Job<JobPayload> | undefined, err: Error) => {
    if (!job || !isFinal(job, err)) return;
    const p = job.data;
    const key = idempotencyKey({ tenantId: p.tenantId, runId: p.runId, stepId: p.stepId, action: p.action, params: p.params });
    const action = registry.get(p.action);
    const dead: DeadLetter = {
      key, jobType: 'action', tenantId: p.tenantId, runId: p.runId, action: p.action, provider: action?.provider ?? 'unknown',
      errorClass: errorClassOf(err), attempts: job.attemptsMade, redrives: Number(key === job.id ? 0 : String(job.id).split('~r')[1] ?? 0),
      lastError: err.message, firstFailedAt: Date.now(),
    };
    const decision = triage(dead, {
      breakerRetryInMs: prov => breakers.get(prov).retryInMs(),
      maxRedrives: opts.maxRedrives ?? 3,
      backoff: { baseMs: 30_000, capMs: 3_600_000 },
    });
    void topo.dlq.add('dead', { dead, payload: p, decision }, { jobId: `dead_${job.id}`, removeOnComplete: false, removeOnFail: false });
  });

  return worker;
}

/** Redrive one triaged dead letter. A new jobId is required (the failed original still exists); ledger dedupe makes that safe. */
export async function redrive(topo: Topology, d: DeadJob): Promise<void> {
  if (d.decision.kind !== 'redrive') return;
  const jobId = `${d.dead.key}~r${d.dead.redrives + 1}`;
  await topo.infra.add(d.payload.action, d.payload, { jobId, delay: d.decision.delayMs });
}
