# Sandbox design (Section 2)

## Threat model
The attacker is the LLM (or content it was prompted with). It can emit arbitrary argv, file contents and
paths, and can try to exhaust CPU, memory, PIDs, disk and output volume. Goal: no host access, no
cross-tenant access, bounded resource use, deterministic cleanup.

## Layers
| Layer | Mechanism | Where |
|---|---|---|
| Kernel boundary | gVisor (`runsc`): a user-space kernel intercepts syscalls, so a kernel exploit hits the Sentry, not the host | `policy.ts` `Runtime` |
| Fail closed | If `runsc` is not registered the manager refuses to start; `NEXUS_ALLOW_RUNC_FALLBACK=1` is dev-only and logs a warning | `manager.ts` |
| Privilege | `CapDrop: ALL`, `no-new-privileges`, non-root `65534:65534`, `Privileged: false` | `policy.ts` |
| Filesystem | Read-only rootfs; writable tmpfs at `/workspace` (exec) and `/tmp` (noexec); no host binds | `policy.ts` |
| Network | `NetworkMode: none`, `IpcMode: none` | `policy.ts` |
| Resources | 0.5 vCPU (`NanoCpus`), 512 MiB with swap disabled, `PidsLimit` 128, core dumps off | `policy.ts` |
| Output | Frames are demuxed and captured head+tail in O(1) memory; a flood past `floodBytes` kills the sandbox | `capture.ts`, `sandbox.ts` |
| Time | `timeout -k` inside the container, plus a host-side timer that kills the container | `sandbox.ts` |
| Inputs | argv array to `execve` (no shell string built on the host), path/cwd/env validation, tar path validation | `sandbox.ts`, `tar.ts` |
| Identity | Tenant and run id come from the orchestrator's environment, never from model-supplied tool arguments | `mcp/server.ts` |
| Cleanup | PID 1 is `sleep <ttl>` so containers expire on their own; label-based reaper sweeps leftovers | `policy.ts`, `manager.ts` |

## Decisions and trade-offs
- **gVisor vs runc.** gVisor adds syscall overhead and has compatibility gaps for exotic syscalls, but removes the shared-kernel escape path. Fallback to runc exists only for local development.
- **One container per run, exec per step.** Build caches and generated files survive between Compile, Test and Patch. Cost: a timed-out step kills the container, so the workspace must be rebuilt from the event log (the tree root in Section 1 makes this reproducible).
- **No network.** Strongest containment, but `npm install` cannot run inside the sandbox. Dependencies must be baked into the image or injected through the archive upload. A restricted egress proxy is the next step if needed. This is a security vs developer-speed trade-off.
- **`/tmp` is `noexec`, `/workspace` is not.** Compiled test binaries must run from `/workspace`. Tools that exec from `/tmp` (some native build steps) will fail.
- **tmpfs counts against the memory cgroup.** `/workspace` (256 MiB) plus `/tmp` (64 MiB) share the 512 MiB limit, so a full tmpfs can trigger an OOM kill. Exit code 137 without a timeout is reported as `signal_or_oom`.
- **Exec cannot be killed through the API.** Disconnecting a client does not stop the process, so floods and hard timeouts kill the whole container.
- **Uploading files.** The Docker archive API (`docker cp`) is unusable here: it operates on the container's rootfs from the host, is refused with `400 container rootfs is marked read-only` when the rootfs is read-only, and cannot see a tmpfs mounted over `/workspace`. (My first version used it and a real daemon rejected it.) Files are instead streamed to `tar -x` running inside the container over exec stdin, so they land in the real tmpfs, owned by the sandbox user. Cost: the image must contain GNU `tar`.
- **Backpressure.** `onFrame` is awaited per frame, so a slow consumer stalls the socket read. The semaphore sheds load with `QueueFull` instead of queueing without bound.

## Host setup (gVisor)
```bash
# install runsc per https://gvisor.dev/docs/user_guide/install/
sudo runsc install            # registers the runtime in /etc/docker/daemon.json
sudo systemctl restart docker
docker run --rm --runtime=runsc hello-world
docker build -t nexus-sandbox:latest -f docker/sandbox.Dockerfile .
```

## Run the MCP server
```bash
NEXUS_TENANT_ID=<tenant> NEXUS_RUN_ID=<run> npm run start:mcp
# dev without gVisor: add NEXUS_ALLOW_RUNC_FALLBACK=1
```

## Known gaps
- Not yet run against a real Docker daemon or real gVisor. Tests use an in-process fake daemon that implements the 101-hijack exec path.
- `src/mcp/server.ts` follows the MCP TypeScript SDK 1.x `server.tool` API but has not been exercised end to end.
- No seccomp profile tuning beyond Docker's default (gVisor enforces its own syscall surface).
- No per-exec cgroup accounting; limits are per container.
