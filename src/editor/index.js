/**
 * Editor Assembler
 *
 * Combines all editor sections and their labels/helpers
 * into the schema returned by getConfigForm().
 */

import { DEFAULT_CONFIG } from '../constants.js';
import { behaviorSchema, microphoneSchema, debugSchema, behaviorLabels, behaviorHelpers } from './behavior.js';
import { skinSchema, skinLabels, skinHelpers } from './skin.js';

const allLabels = Object.assign({}, behaviorLabels, skinLabels);
const allHelpers = Object.assign({}, behaviorHelpers, skinHelpers);

export function getConfigForm() {
  return {
    schema: [
      ...behaviorSchema,
      ...skinSchema,
      ...microphoneSchema,
      ...debugSchema,
    ],
    assertConfig(config) {
      const editor = this;
      Promise.resolve().then(() => {
        editor._config = Object.assign({}, DEFAULT_CONFIG, config);
      });
    },
    computeLabel(schema) {
      return allLabels[schema.name] || undefined;
    },
    computeHelper(schema) {
      return allHelpers[schema.name] || undefined;
    },
  };
}
