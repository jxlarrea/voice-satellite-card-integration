/**
 * Voice Satellite Mini Card - Editor Assembler
 *
 * Reuses the full card editor sections, excluding skin selection.
 */

import { DEFAULT_CONFIG } from '../constants.js';
import {
  behaviorSchema,
  microphoneSchema,
  debugSchema,
  behaviorLabels,
  behaviorHelpers,
} from '../editor/behavior.js';

const miniLayoutSchema = [
  {
    type: 'expandable', name: '', title: 'Layout', flatten: true,
    schema: [
      {
        name: 'mini_mode',
        default: 'compact',
        selector: {
          select: {
            mode: 'dropdown',
            options: [
              { value: 'compact', label: 'Compact' },
              { value: 'tall', label: 'Tall' },
            ],
          },
        },
      },
      {
        name: 'text_scale',
        default: 100,
        selector: {
          number: {
            min: 50,
            max: 200,
            step: 5,
            mode: 'slider',
            unit_of_measurement: '%',
          },
        },
      },
    ],
  },
];

const miniAdvancedSchema = [
  {
    type: 'expandable', name: '', title: 'Advanced', flatten: true,
    schema: [
      { name: 'custom_css', selector: { text: { multiline: true } } },
    ],
  },
];

const labels = {
  ...behaviorLabels,
  mini_mode: 'Mode',
  text_scale: 'Text Scale',
  custom_css: 'Custom CSS Override',
};

const helpers = {
  ...behaviorHelpers,
  mini_mode: 'Compact is a single scrolling line; Tall shows status and a scrolling transcript.',
  text_scale: 'Scales text sizes in the mini card while keeping Home Assistant theme typography as the base.',
  custom_css: 'Advanced: CSS overrides applied inside the mini card shadow DOM',
};

export function getMiniConfigForm() {
  return {
    schema: [
      ...behaviorSchema,
      ...miniLayoutSchema,
      ...miniAdvancedSchema,
      ...microphoneSchema,
      ...debugSchema,
    ],
    assertConfig(config) {
      const editor = this;
      Promise.resolve().then(() => {
        editor._config = Object.assign({}, DEFAULT_CONFIG, { mini_mode: 'compact' }, config);
      });
    },
    computeLabel(schema) {
      return labels[schema.name] || undefined;
    },
    computeHelper(schema) {
      return helpers[schema.name] || undefined;
    },
  };
}
