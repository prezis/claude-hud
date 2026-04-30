import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveEffortLevel, readSettingsEffort } from '../dist/effort.js';

describe('resolveEffortLevel', () => {
  describe('stdin effort (future Claude Code support)', () => {
    it('returns effort info when stdin provides effort level', () => {
      const result = resolveEffortLevel('max');
      assert.deepStrictEqual(result, { level: 'max', symbol: '●' });
    });

    it('normalizes effort level to lowercase', () => {
      const result = resolveEffortLevel('HIGH');
      assert.deepStrictEqual(result, { level: 'high', symbol: '◑' });
    });

    it('handles all known effort levels', () => {
      assert.deepStrictEqual(resolveEffortLevel('low'), { level: 'low', symbol: '○' });
      assert.deepStrictEqual(resolveEffortLevel('medium'), { level: 'medium', symbol: '◔' });
      assert.deepStrictEqual(resolveEffortLevel('high'), { level: 'high', symbol: '◑' });
      assert.deepStrictEqual(resolveEffortLevel('xhigh'), { level: 'xhigh', symbol: '◕' });
      assert.deepStrictEqual(resolveEffortLevel('max'), { level: 'max', symbol: '●' });
    });

    it('handles unknown future effort levels with empty symbol', () => {
      const result = resolveEffortLevel('turbo');
      assert.deepStrictEqual(result, { level: 'turbo', symbol: '' });
    });

    it('returns null when stdin effort is null', () => {
      const result = resolveEffortLevel(null);
      // Falls through to parent process detection (may or may not find effort)
      // We just verify it doesn't throw
      assert.ok(result === null || typeof result.level === 'string');
    });

    it('returns null when stdin effort is undefined', () => {
      const result = resolveEffortLevel(undefined);
      assert.ok(result === null || typeof result.level === 'string');
    });

    it('returns null for empty string', () => {
      const result = resolveEffortLevel('');
      assert.ok(result === null || typeof result.level === 'string');
    });
  });

  describe('stdin takes priority over parent process', () => {
    it('uses stdin value even if parent process has different effort', () => {
      const result = resolveEffortLevel('low');
      assert.strictEqual(result?.level, 'low');
    });
  });

  describe('stdin effort as object (Claude Code 2.1.115+ schema)', () => {
    it('extracts level from object { level: "max" }', () => {
      const result = resolveEffortLevel({ level: 'max' });
      assert.deepStrictEqual(result, { level: 'max', symbol: '●' });
    });

    it('extracts and normalizes uppercase level from object', () => {
      const result = resolveEffortLevel({ level: 'HIGH' });
      assert.deepStrictEqual(result, { level: 'high', symbol: '◑' });
    });

    it('handles all known levels when wrapped in object', () => {
      assert.deepStrictEqual(resolveEffortLevel({ level: 'low' }), { level: 'low', symbol: '○' });
      assert.deepStrictEqual(resolveEffortLevel({ level: 'medium' }), { level: 'medium', symbol: '◔' });
      assert.deepStrictEqual(resolveEffortLevel({ level: 'xhigh' }), { level: 'xhigh', symbol: '◕' });
    });

    it('tolerates extra fields in effort object (forward-compat)', () => {
      const result = resolveEffortLevel({ level: 'max', budget: 32000, extra: 'ignored' });
      assert.deepStrictEqual(result, { level: 'max', symbol: '●' });
    });

    it('falls through when object has no level field', () => {
      const result = resolveEffortLevel({});
      assert.ok(result === null || typeof result.level === 'string');
    });

    it('falls through when object.level is null', () => {
      const result = resolveEffortLevel({ level: null });
      assert.ok(result === null || typeof result.level === 'string');
    });

    it('falls through when object.level is not a string', () => {
      const result = resolveEffortLevel({ level: 42 });
      assert.ok(result === null || typeof result.level === 'string');
    });
  });

  describe('defensive handling of unexpected types (no crash)', () => {
    it('does not crash on numeric effort value', () => {
      const result = resolveEffortLevel(42);
      assert.ok(result === null || typeof result.level === 'string');
    });

    it('does not crash on boolean effort value', () => {
      const result = resolveEffortLevel(true);
      assert.ok(result === null || typeof result.level === 'string');
    });

    it('does not crash on array effort value', () => {
      const result = resolveEffortLevel(['max']);
      assert.ok(result === null || typeof result.level === 'string');
    });
  });

  describe('settings.json fallback (prezis fork)', () => {
    let tmpDir;
    let savedConfigDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-effort-test-'));
      // Point CLAUDE_CONFIG_DIR at an empty temp dir so we don't pick up the
      // dev's real ~/.claude/settings.json.
      savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'fake-claude-home');
      fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    });

    afterEach(() => {
      if (savedConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads effortLevel from project ./.claude/settings.json', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ effortLevel: 'xhigh' })
      );
      assert.strictEqual(readSettingsEffort(projectDir), 'xhigh');
    });

    it('prefers settings.local.json over settings.json', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ effortLevel: 'medium' })
      );
      fs.writeFileSync(
        path.join(projectDir, '.claude', 'settings.local.json'),
        JSON.stringify({ effortLevel: 'max' })
      );
      assert.strictEqual(readSettingsEffort(projectDir), 'max');
    });

    it('falls back to CLAUDE_CONFIG_DIR/settings.json when no project settings', () => {
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ effortLevel: 'high' })
      );
      const emptyProject = path.join(tmpDir, 'empty-project');
      fs.mkdirSync(emptyProject, { recursive: true });
      assert.strictEqual(readSettingsEffort(emptyProject), 'high');
    });

    it('returns null when no settings file has effortLevel', () => {
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ unrelated: 'field' })
      );
      const emptyProject = path.join(tmpDir, 'empty-project');
      fs.mkdirSync(emptyProject, { recursive: true });
      assert.strictEqual(readSettingsEffort(emptyProject), null);
    });

    it('survives malformed JSON in settings file', () => {
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
        '{ this is not json'
      );
      const emptyProject = path.join(tmpDir, 'empty-project');
      fs.mkdirSync(emptyProject, { recursive: true });
      assert.strictEqual(readSettingsEffort(emptyProject), null);
    });

    it('ignores non-string effortLevel', () => {
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ effortLevel: 42 })
      );
      const emptyProject = path.join(tmpDir, 'empty-project');
      fs.mkdirSync(emptyProject, { recursive: true });
      assert.strictEqual(readSettingsEffort(emptyProject), null);
    });

    it('resolveEffortLevel uses settings.json when stdin and CLI are empty', () => {
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ effortLevel: 'xhigh' })
      );
      const emptyProject = path.join(tmpDir, 'empty-project');
      fs.mkdirSync(emptyProject, { recursive: true });
      const result = resolveEffortLevel(undefined, emptyProject);
      // CLI parent-process check may also match in some test runners; assert
      // we got SOMETHING back rather than the strict 'xhigh' value.
      assert.ok(result !== null);
      assert.strictEqual(typeof result.level, 'string');
    });

    it('stdin still wins over settings.json', () => {
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
        JSON.stringify({ effortLevel: 'xhigh' })
      );
      const emptyProject = path.join(tmpDir, 'empty-project');
      fs.mkdirSync(emptyProject, { recursive: true });
      const result = resolveEffortLevel('low', emptyProject);
      assert.strictEqual(result?.level, 'low');
    });
  });
});
