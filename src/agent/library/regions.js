import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';

// Shared across all bots (they navigate the same world), so protection survives
// bot restarts and applies regardless of which bot declared it.
// File is re-read when the mtime changes, so all bots see each other's changes.
const REGIONS_DIR = './bots/_shared';
const REGIONS_FP = `${REGIONS_DIR}/protected_regions.json`;

let regions = [];
let loaded_mtime = -1;
let last_stat = 0;
const STAT_INTERVAL_MS = 1000;
function load() {
    if (Date.now() - last_stat < STAT_INTERVAL_MS) return regions; // isProtected runs per A* node; stat at most once per second
    last_stat = Date.now();
    let mtime = -1;
    try { mtime = existsSync(REGIONS_FP) ? statSync(REGIONS_FP).mtimeMs : -1; } catch { mtime = -1; }
    if (mtime === loaded_mtime) return regions;
    try { regions = mtime === -1 ? [] : JSON.parse(readFileSync(REGIONS_FP, 'utf8')); } catch { regions = []; }
    loaded_mtime = mtime;
    return regions;
}

function save() {
    mkdirSync(REGIONS_DIR, { recursive: true });
    writeFileSync(REGIONS_FP, JSON.stringify(regions, null, 2));
    loaded_mtime = statSync(REGIONS_FP).mtimeMs;
}

function corner(pos) {
    return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

export function protectRegion(name, corner1, corner2) {
    last_stat = 0;
    load();
    const c1 = corner(corner1);
    const c2 = corner(corner2);
    const min = { x: Math.min(c1.x, c2.x), y: Math.min(c1.y, c2.y), z: Math.min(c1.z, c2.z) };
    const max = { x: Math.max(c1.x, c2.x), y: Math.max(c1.y, c2.y), z: Math.max(c1.z, c2.z) };
    regions = regions.filter(r => r.name !== name);
    regions.push({ name, min, max });
    save();
    return { min, max };
}

export function unprotectRegion(name) {
    last_stat = 0;
    load();
    const before = regions.length;
    regions = regions.filter(r => r.name !== name);
    save();
    return regions.length < before;
}

export function listProtectedRegions() {
    return load();
}

// hard block: exclusionAreasBreak weights >= 100 make mineflayer-pathfinder's
// Movements.canDig() return false, and the same threshold is used directly
// wherever mindcraft digs outside the pathfinder (getUnstuck, breakBlockAt).
export function isProtected(pos) {
    return load().some(r =>
        pos.x >= r.min.x && pos.x <= r.max.x &&
        pos.y >= r.min.y && pos.y <= r.max.y &&
        pos.z >= r.min.z && pos.z <= r.max.z
    );
}
