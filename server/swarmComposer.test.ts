import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackFeaturePlan, slugifyPromptFeature } from './swarmComposer';

test('slugifyPromptFeature extracts clean camelCase identifier from prompt', () => {
  assert.equal(slugifyPromptFeature('Add a rate limiter middleware with unit tests'), 'rateLimiterMiddleware');
  assert.equal(slugifyPromptFeature('Build CSV export utility'), 'csvExportUtility');
});

test('buildFallbackFeaturePlan generates rate limiter + test suite without path collisions', () => {
  const existing = {
    'src/pricing.ts': 'export const a = 1;',
  };
  const plan = buildFallbackFeaturePlan('Add rate limiter middleware and unit tests', existing);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].filePath, 'src/rateLimit.ts');
  assert.equal(plan.tasks[1].filePath, 'src/rateLimit.test.ts');
  assert.match(plan.tasks[0].content, /export class RateLimiter/);
  assert.match(plan.tasks[1].content, /import \{ RateLimiter \} from '\.\/rateLimit\.ts'/);
});

test('buildFallbackFeaturePlan creates distinct files for validation and custom prompts', () => {
  const existing = {
    'src/validation.ts': 'export const x = 1;',
  };
  const plan = buildFallbackFeaturePlan('Add input validation and sanitizer tests', existing);
  assert.equal(plan.tasks[0].filePath, 'src/validation2.ts');
  assert.equal(plan.tasks[1].filePath, 'src/validation2.test.ts');
});

test('buildFallbackFeaturePlan adapts to lib/ source root and extensionless tsconfig imports', () => {
  const existing = {
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
    'lib/router.ts': 'export const router = {};',
  };
  const plan = buildFallbackFeaturePlan('Add rate limiter middleware', existing);
  assert.equal(plan.tasks[0].filePath, 'lib/rateLimit.ts');
  assert.equal(plan.tasks[1].filePath, 'lib/rateLimit.test.ts');
  assert.match(plan.tasks[1].content, /import \{ RateLimiter \} from '\.\/rateLimit'/);
  assert.doesNotMatch(plan.tasks[1].content, /'\.\/rateLimit\.ts'/);
});
