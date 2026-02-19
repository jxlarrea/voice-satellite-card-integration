/**
 * Voice Satellite Card — Editor Assembler
 *
 * Combines all editor sections and their labels/helpers
 * into the schema returned by getConfigForm().
 */

import { behaviorSchema, behaviorLabels, behaviorHelpers } from './behavior.js';
import { mediaSchema, mediaLabels, mediaHelpers } from './media.js';
import { timerSchema, timerLabels, timerHelpers } from './timer.js';
import { barSchema, barLabels, barHelpers } from './bar.js';
import { bubblesSchema, bubblesLabels, bubblesHelpers } from './bubbles.js';

const allLabels = Object.assign({}, behaviorLabels, mediaLabels, timerLabels, barLabels, bubblesLabels);
const allHelpers = Object.assign({}, behaviorHelpers, mediaHelpers, timerHelpers, barHelpers, bubblesHelpers);

export function getConfigForm() {
  return {
    schema: [
      ...behaviorSchema,
      ...mediaSchema,
      ...timerSchema,
      ...barSchema,
      ...bubblesSchema,
    ],
    computeLabel(schema) {
      return allLabels[schema.name] || undefined;
    },
    computeHelper(schema) {
      return allHelpers[schema.name] || undefined;
    },
  };
}
