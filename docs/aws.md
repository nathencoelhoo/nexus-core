# AWS EC2 adapter

Scope: `RunInstances` as an idempotent action, with lookup, compensation (terminate) and inventory for the orphan reconciler. Nothing else (no VPC, IAM, volumes, spot, waiters).

## How idempotency works for EC2

| Mechanism | Role |
|---|---|
| `ClientToken = ledger key` | **Primary.** EC2 itself dedupes a repeated launch. The key is 64 hex characters, exactly EC2's limit |
| Tag `nexus-token = ledger key`, set atomically at launch | **Secondary.** `lookup` finds the instance after a crash by tag |
| Tag `nexus-managed = true` | Lets the reconciler enumerate everything this system owns |

Three EC2 behaviors drive the design (from AWS's documentation; the unit tests encode them in a fake, and only the opt-in live test checks the real service):
1. **Same token, same parameters** returns the original instance. This is what makes a retry after an ambiguous failure safe even when `DescribeInstances` cannot see the instance yet.
2. **Same token, different parameters** fails with `IdempotentParameterMismatch`. Because parameters are part of the ledger key this should be impossible, so it is mapped to a *permanent* failure whose message says "key-derivation bug".
3. **A token whose instance was terminated** returns that terminated instance. The adapter treats a dead instance as a permanent failure, never as a success to adopt.

`DescribeInstances` is eventually consistent, so `lookup` may legitimately return nothing right after a launch. That is fine: the runner then calls `execute` again with the same token and EC2 dedupes it. `lookup` is a fast path, the token is the guarantee.

## Safety defaults

- **Cost guard:** `ec2RunInstanceAction(api, { allowedInstanceTypes })` rejects any other instance type *before* calling AWS. A system that lets a model choose parameters needs this.
- Parameter validation (AMI id and instance type shape) before any call.
- IMDSv2 required; `InstanceInitiatedShutdownBehavior: terminate`, so an instance that shuts itself down stops costing money.
- The SDK is created with `maxAttempts: 1`: this system's runner, ledger and circuit breaker own retries. A hidden SDK retry would be invisible to all three.
- Compensation is idempotent: terminating an instance that no longer exists is success.

## Error mapping (`mapAwsError`, applied in the action, not the SDK wrapper)

| AWS error | Becomes | Retry class |
|---|---|---|
| `RequestLimitExceeded`, `Throttling*` | HTTP 429 | throttled (backoff) |
| `UnauthorizedOperation`, `AuthFailure`, `InvalidClientTokenId`, expired credentials | 403 | auth (no retries; DLQ escalates to a human) |
| `InstanceLimitExceeded`, `VcpuLimitExceeded` | 403 | auth (a human must raise the quota) |
| `IdempotentParameterMismatch` | 400 | permanent |
| `Invalid*`, `MissingParameter`, `ValidationError` | 400 | permanent |
| `InsufficientInstanceCapacity`, `InternalError`, `ServiceUnavailable` | 503 | ambiguous (resolved by token or lookup) |
| timeouts, socket errors | unchanged | ambiguous |

## Testing tiers

| Tier | What it proves | What it cannot prove |
|---|---|---|
| Unit (`test/aws-ec2.test.ts`, 12 tests) | The adapter, runner, ledger and reconciler behave correctly against a fake that encodes the documented token semantics | That the fake matches real EC2 |
| Emulator (`npm run test:aws-emulator`, CI job `aws-emulator`, 5 tests, passing) | The real AWS SDK wire contract: tags, ClientToken, filters, terminate, pagination, the real `InvalidInstanceID.NotFound` error shape, and the crash-recovery path through tag lookup | ClientToken enforcement: CI shows `moto` does **not** dedupe a repeated token (observed), so this tier cannot test the guarantee |
| Live (`npm run test:aws-live`, **opt-in, never in CI**, 4 tests) | EC2 returns the same instance for a repeated token; a mismatch is rejected; the terminated-token behavior; the tag-lookup consistency lag | Nothing else; it has **not been run yet** |

### Running the live test

Use a sandbox AWS account. It launches `t3.nano` instances (about $0.005 per hour each; the tests live for minutes) and terminates every instance it launched in an `after` hook.
```bash
NEXUS_AWS_LIVE=1 AWS_REGION=us-east-1 NEXUS_AWS_AMI=ami-xxxxxxxx npm run test:aws-live
```
If a run is killed halfway, terminate any instance tagged `nexus-itest=1`. Minimal IAM policy for the test principal:
```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Action": ["ec2:RunInstances", "ec2:CreateTags", "ec2:DescribeInstances", "ec2:TerminateInstances"], "Resource": "*" }] }
```
Scope `Resource` down (by region, tag condition, instance type) for anything beyond a throwaway account.

## Known gaps

- Only EC2 `RunInstances`. No waiter for `running`, no security group or subnet lifecycle, no spot, no multi-region.
- Terminating an instance does not remove extra EBS volumes created without `DeleteOnTermination`.
- The live test has not been run, so EC2's token behavior above rests on AWS's documentation.
