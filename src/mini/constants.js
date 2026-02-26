export const MINI_GRID_ROWS = Object.freeze({
  compact: Object.freeze({ default: 1, min: 1, max: 1 }),
  tall: Object.freeze({ default: 3, min: 2, max: 12 }),
});

export function getMiniModeKey(miniMode) {
  return miniMode === 'tall' ? 'tall' : 'compact';
}

export function getMiniGridRows(miniMode) {
  return MINI_GRID_ROWS[getMiniModeKey(miniMode)];
}

