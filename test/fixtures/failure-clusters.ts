import type { LabeledText } from '../../src/cache/eval.ts';

/**
 * Real TypeScript diagnostics, grouped the way the cache sees them: within one (tool, error code) gate, which messages
 * share a FIX? The embedder's job is to separate fix classes that the exact-match gates cannot.
 */
const g = (group: string, cluster: string, texts: string[]): LabeledText[] => texts.map(text => ({ group, cluster, text }));

export const FAILURE_CLUSTERS: LabeledText[] = [
  // TS2322: three different fixes behind one error code
  ...g('tsc:TS2322', 'nullable', [
    "Type 'string | undefined' is not assignable to type 'string'. Type 'undefined' is not assignable to type 'string'.",
    "Type 'number | null' is not assignable to type 'number'. Type 'null' is not assignable to type 'number'.",
    "Type 'User | undefined' is not assignable to type 'User'. Type 'undefined' is not assignable to type 'User'.",
    "Type 'Date | null' is not assignable to type 'Date'. Type 'null' is not assignable to type 'Date'.",
  ]),
  ...g('tsc:TS2322', 'missing-property', [
    "Type '{ id: number; }' is not assignable to type 'User'. Property 'name' is missing in type '{ id: number; }' but required in type 'User'.",
    "Type '{ name: string; }' is not assignable to type 'Order'. Property 'total' is missing in type '{ name: string; }' but required in type 'Order'.",
    "Type '{}' is not assignable to type 'Config'. Property 'port' is missing in type '{}' but required in type 'Config'.",
    "Type '{ host: string; }' is not assignable to type 'Options'. Property 'timeout' is missing in type '{ host: string; }' but required in type 'Options'.",
  ]),
  ...g('tsc:TS2322', 'primitive-mismatch', [
    "Type 'string' is not assignable to type 'number'.",
    "Type 'number' is not assignable to type 'string'.",
    "Type 'boolean' is not assignable to type 'string'.",
    "Type 'string' is not assignable to type 'boolean'.",
  ]),
  // TS2345: the same three situations, as function arguments
  ...g('tsc:TS2345', 'nullable', [
    "Argument of type 'string | undefined' is not assignable to parameter of type 'string'. Type 'undefined' is not assignable to type 'string'.",
    "Argument of type 'number | null' is not assignable to parameter of type 'number'. Type 'null' is not assignable to type 'number'.",
    "Argument of type 'User | undefined' is not assignable to parameter of type 'User'. Type 'undefined' is not assignable to type 'User'.",
    "Argument of type 'Date | null' is not assignable to parameter of type 'Date'. Type 'null' is not assignable to type 'Date'.",
  ]),
  ...g('tsc:TS2345', 'primitive-mismatch', [
    "Argument of type 'string' is not assignable to parameter of type 'number'.",
    "Argument of type 'number' is not assignable to parameter of type 'string'.",
    "Argument of type 'boolean' is not assignable to parameter of type 'string'.",
    "Argument of type 'string' is not assignable to parameter of type 'boolean'.",
  ]),
  ...g('tsc:TS2345', 'missing-property', [
    "Argument of type '{ id: number; }' is not assignable to parameter of type 'User'. Property 'name' is missing in type '{ id: number; }' but required in type 'User'.",
    "Argument of type '{ name: string; }' is not assignable to parameter of type 'Order'. Property 'total' is missing in type '{ name: string; }' but required in type 'Order'.",
    "Argument of type '{}' is not assignable to parameter of type 'Config'. Property 'port' is missing in type '{}' but required in type 'Config'.",
    "Argument of type '{ host: string; }' is not assignable to parameter of type 'Options'. Property 'timeout' is missing in type '{ host: string; }' but required in type 'Options'.",
  ]),
  // TS2339: a typo versus calling an array method on the wrong type
  ...g('tsc:TS2339', 'typo', [
    "Property 'nmae' does not exist on type 'User'. Did you mean 'name'?",
    "Property 'emial' does not exist on type 'Account'. Did you mean 'email'?",
    "Property 'totl' does not exist on type 'Order'. Did you mean 'total'?",
    "Property 'prot' does not exist on type 'Config'. Did you mean 'port'?",
  ]),
  ...g('tsc:TS2339', 'wrong-receiver-type', [
    "Property 'map' does not exist on type 'string'.",
    "Property 'forEach' does not exist on type 'number'.",
    "Property 'filter' does not exist on type 'Record<string, number>'.",
    "Property 'push' does not exist on type 'string'.",
  ]),
];
