// Self-check for reorder_map.js — run with: node reorder_map.test.js
import assert from 'assert';
import { buildReorderRenameMap, isNumberedProfile } from './reorder_map.js';

// No movement → empty map
assert.deepStrictEqual(
  buildReorderRenameMap(['Profile 1', 'Profile 2'], ['Profile 1', 'Profile 2']),
  {});

// Adjacent swap: Profile 3 moved up one slot
assert.deepStrictEqual(
  buildReorderRenameMap(
    ['Profile 1', 'Profile 2', 'Profile 3'],
    ['Profile 1', 'Profile 3', 'Profile 2']),
  { 'Profile 3': 'Profile 2', 'Profile 2': 'Profile 3' });

// Multi-step move across an ID gap: Profile 7 bubbled to the top of [1, 3, 7].
// It takes ID 1; the displaced ones shift down into 3 and 7.
assert.deepStrictEqual(
  buildReorderRenameMap(
    ['Profile 1', 'Profile 3', 'Profile 7'],
    ['Profile 7', 'Profile 1', 'Profile 3']),
  { 'Profile 7': 'Profile 1', 'Profile 1': 'Profile 3', 'Profile 3': 'Profile 7' });

// Non-numbered rows pinned at their position never enter the map
assert.deepStrictEqual(
  buildReorderRenameMap(
    ['Profile 1', 'Profile 2', 'Custom'],
    ['Profile 2', 'Profile 1', 'Custom']),
  { 'Profile 2': 'Profile 1', 'Profile 1': 'Profile 2' });

assert.ok(isNumberedProfile('Profile 12'));
assert.ok(!isNumberedProfile('Default'));
assert.ok(!isNumberedProfile('Profile 1_temp'));
assert.ok(!isNumberedProfile(''));
assert.ok(!isNumberedProfile(undefined));

console.log('reorder_map.test.js: all checks passed');
