import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';

/**
 * Integration tests need real services and are skipped unless explicitly enabled, so that running them locally
 * can never touch a database or Redis by accident (several tests flush Redis and drop tables).
 */
export const ENABLED = process.env.NEXUS_ITEST === '1';
export const DOCKER_ENABLED = process.env.NEXUS_DOCKER_ITEST === '1';

export const uuid = (): string => randomUUID();
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function itest(name: string, fn: () => Promise<void> | void, enabled: boolean = ENABLED): void {
  test(name, { skip: enabled ? false : 'integration test: set NEXUS_ITEST=1 and provide DATABASE_URL / REDIS_URL' }, fn);
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, what = 'condition'): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await sleep(50);
  }
}

export function databaseUrl(): string {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error('DATABASE_URL is required');
  return u;
}
export function redisUrl(): string {
  const u = process.env.REDIS_URL;
  if (!u) throw new Error('REDIS_URL is required');
  return u;
}
export function redisOpts(): { host: string; port: number } {
  const u = new URL(redisUrl());
  return { host: u.hostname, port: Number(u.port || 6379) };
}

/** Superuser pool: creates schema. Superusers bypass row-level security, so never use it to test RLS. */
export const adminPool = (max = 30): Pool => new pg.Pool({ connectionString: databaseUrl(), max });

const ROLE = 'nexus_app';

/** A non-superuser, non-owner role: the only kind of connection on which RLS and GRANTs actually apply. */
export async function appPool(admin: Pool, max = 20): Promise<Pool> {
  await admin.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}'; END IF; END $$;`);
  const u = new URL(databaseUrl());
  u.username = ROLE;
  u.password = ROLE;
  return new pg.Pool({ connectionString: u.toString(), max });
}
