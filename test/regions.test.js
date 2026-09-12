import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// regions.js reads REGIONS_DIR at module-load time, so point it at a scratch
// dir before importing (D7: overridable via MINDCRAFT_REGIONS_DIR).
const regionsDir = mkdtempSync(path.join(tmpdir(), 'mindcraft-regions-'));
process.env.MINDCRAFT_REGIONS_DIR = regionsDir;

const { protectRegion, unprotectRegion, listProtectedRegions, isProtected } =
    await import('../src/agent/library/regions.js');

test('protectRegion normalizes corners and isProtected matches only inside bounds', () => {
    protectRegion('house', { x: 5, y: 65, z: 5 }, { x: 0, y: 60, z: 0 });
    assert.equal(isProtected({ x: 2, y: 62, z: 2 }), true);
    assert.equal(isProtected({ x: 10, y: 62, z: 2 }), false);
});

test('unprotectRegion removes a region and reports whether it existed', () => {
    protectRegion('temp', { x: 100, y: 60, z: 100 }, { x: 101, y: 61, z: 101 });
    assert.equal(isProtected({ x: 100, y: 60, z: 100 }), true);
    assert.equal(unprotectRegion('temp'), true);
    assert.equal(isProtected({ x: 100, y: 60, z: 100 }), false);
    assert.equal(unprotectRegion('temp'), false);
});

test('listProtectedRegions reflects the persisted state', () => {
    const regions = listProtectedRegions();
    assert.ok(regions.some(r => r.name === 'house'));
    assert.ok(!regions.some(r => r.name === 'temp'));
});

after(() => {
    rmSync(regionsDir, { recursive: true, force: true });
});
