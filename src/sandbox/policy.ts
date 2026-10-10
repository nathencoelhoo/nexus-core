export interface SandboxPolicy {
  image: string;
  runtime: 'runsc' | 'runc';
  /** Dev only. Production fails closed if the requested runtime is not registered. */
  allowRuncFallback: boolean;
  memoryBytes: number;
  cpus: number;
  pidsLimit: number;
  workspaceBytes: number;
  tmpBytes: number;
  user: string;
  ttlSeconds: number;
  defaultExecMs: number;
  maxExecMs: number;
  killGraceMs: number;
  floodBytes: number;
  headBytes: number;
  tailBytes: number;
  maxConcurrent: number;
  maxPerTenant: number;
  maxQueue: number;
}

export const DEFAULT_POLICY: SandboxPolicy = {
  image: 'nexus-sandbox:latest',
  runtime: 'runsc',
  allowRuncFallback: false,
  memoryBytes: 512 * 1024 * 1024,
  cpus: 0.5,
  pidsLimit: 128,
  workspaceBytes: 256 * 1024 * 1024,   // NOTE: tmpfs pages are charged to the container's
  tmpBytes: 64 * 1024 * 1024,          // memory cgroup, so 320 MiB of the 512 MiB is shared.
  user: '65534:65534',
  ttlSeconds: 1800,
  defaultExecMs: 60_000,
  maxExecMs: 300_000,
  killGraceMs: 5_000,
  floodBytes: 8 * 1024 * 1024,
  headBytes: 16 * 1024,
  tailBytes: 48 * 1024,
  maxConcurrent: 32,
  maxPerTenant: 4,
  maxQueue: 128,
};

/** Container create body (Docker Engine API). Every isolation parameter lives here, in one reviewable place. */
export function buildCreateBody(p: SandboxPolicy, labels: Record<string, string>): Record<string, unknown> {
  const owner = p.user.split(':');
  const tmpfsOwner = `uid=${owner[0] ?? '65534'},gid=${owner[1] ?? owner[0] ?? '65534'}`;
  return {
    Image: p.image,
    // PID 1 is a sleep that expires on its own: even if the orchestrator dies, the container does too.
    Cmd: ['sleep', String(p.ttlSeconds)],
    User: p.user,
    WorkingDir: '/workspace',
    Env: ['HOME=/workspace', 'CI=1', 'NO_COLOR=1'],
    Labels: labels,
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    NetworkDisabled: true,
    StopTimeout: 1,
    HostConfig: {
      Runtime: p.runtime,
      Privileged: false,
      NetworkMode: 'none',
      IpcMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: p.memoryBytes,
      MemorySwap: p.memoryBytes,                 // == Memory: swap disabled
      NanoCpus: Math.round(p.cpus * 1e9),
      PidsLimit: p.pidsLimit,                    // fork-bomb containment
      Init: true,                                // reap zombies
      AutoRemove: false,                         // we must read exit state before removal
      LogConfig: { Type: 'none' },               // output travels over exec streams; no host disk fill
      Ulimits: [
        { Name: 'core', Soft: 0, Hard: 0 },
        { Name: 'nofile', Soft: 1024, Hard: 1024 },
      ],
      Tmpfs: {
        '/workspace': `rw,nosuid,nodev,exec,size=${p.workspaceBytes},${tmpfsOwner},mode=0755`,
        '/tmp': `rw,nosuid,nodev,noexec,size=${p.tmpBytes},${tmpfsOwner},mode=1777`,
      },
    },
  };
}
