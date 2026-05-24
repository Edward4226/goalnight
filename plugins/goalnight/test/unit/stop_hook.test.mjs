import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNewState } from '../../hooks/stop.js';

// Task #12 — Hook payload field name is unconfirmed on codex 0.130.0.
// The extractor tries several plausible candidates and falls back gracefully.

test('extractNewState reads payload.goal_state (primary documented candidate)', () => {
  assert.equal(extractNewState({ goal_state: 'usage_limited' }), 'usage_limited');
});

test('extractNewState reads camelCase goalState', () => {
  assert.equal(extractNewState({ goalState: 'blocked' }), 'blocked');
});

test('extractNewState reads session_state', () => {
  assert.equal(extractNewState({ session_state: 'complete' }), 'complete');
});

test('extractNewState reads thread_state', () => {
  assert.equal(extractNewState({ thread_state: 'active' }), 'active');
});

test('extractNewState reads bare state field', () => {
  assert.equal(extractNewState({ state: 'paused' }), 'paused');
});

test('extractNewState reads nested thread.status', () => {
  assert.equal(extractNewState({ thread: { status: 'usage_limited' } }), 'usage_limited');
});

test('extractNewState reads nested session.state', () => {
  assert.equal(extractNewState({ session: { state: 'blocked' } }), 'blocked');
});

test('extractNewState reads nested goal.state', () => {
  assert.equal(extractNewState({ goal: { state: 'complete' } }), 'complete');
});

test('extractNewState prefers goal_state over other keys when multiple present', () => {
  // Goal_state is the most documented candidate — pick it first if present.
  assert.equal(extractNewState({ goal_state: 'A', state: 'B', session_state: 'C' }), 'A');
});

test('extractNewState returns null on missing field', () => {
  assert.equal(extractNewState({}), null);
  assert.equal(extractNewState({ unrelated: 'value' }), null);
});

test('extractNewState returns null on null / non-object input', () => {
  assert.equal(extractNewState(null), null);
  assert.equal(extractNewState(undefined), null);
  assert.equal(extractNewState('a string'), null);
  assert.equal(extractNewState(42), null);
});

test('extractNewState ignores non-string values', () => {
  assert.equal(extractNewState({ goal_state: 42 }), null);
  assert.equal(extractNewState({ goal_state: null }), null);
  assert.equal(extractNewState({ goal_state: '' }), null);
  // Should fall through to next candidate
  assert.equal(extractNewState({ goal_state: null, state: 'fallback' }), 'fallback');
});
