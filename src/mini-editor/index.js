/**
 * Voice Satellite Mini Card - Editor Assembler
 *
 * Reuses the full card editor sections, excluding skin selection.
 */

import { DEFAULT_CONFIG } from '../constants.js';
import { t } from '../i18n/index.js';
import {
  behaviorSchema,
  microphoneSchema,
  debugSchema,
  behaviorLabels,
  behaviorHelpers,
} from '../editor/behavior.js';

const miniLayoutSchema = [
  {
    type: 'expandable', name: '', title: t(null, 'mini_editor.layout', 'Layout'), flatten: true,
    schema: [
      {
        name: 'mini_mode',
        default: 'compact',
        selector: {
          select: {
            mode: 'dropdown',
            options: [
              { value: 'compact', label: t(null, 'mini_editor.mode_compact', 'Compact') },
              { value: 'tall', label: t(null, 'mini_editor.mode_tall', 'Tall') },
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
      {
        name: 'suppress_full_card',
        default: true,
        selector: { boolean: {} },
      },
    ],
  },
];

const miniAdvancedSchema = [
  {
    type: 'expandable', name: '', title: t(null, 'mini_editor.advanced', 'Advanced'), flatten: true,
    schema: [
      { name: 'custom_css', selector: { text: { multiline: true } } },
    ],
  },
];

const labels = {
  ...behaviorLabels,
  mini_mode: t(null, 'mini_editor.mode', 'Mode'),
  text_scale: t(null, 'mini_editor.text_scale', 'Text Scale'),
  suppress_full_card: t(null, 'mini_editor.suppress_full_card', 'Suppress Full Card'),
  custom_css: t(null, 'mini_editor.custom_css_override', 'Custom CSS Override'),
};

const helpers = {
  ...behaviorHelpers,
  mini_mode: t(null, 'mini_editor.helper_mode', 'Compact is a single scrolling line; Tall shows status and a scrolling transcript.'),
  text_scale: t(null, 'mini_editor.helper_text_scale', 'Scales text sizes in the mini card while keeping Home Assistant theme typography as the base.'),
  suppress_full_card: t(null, 'mini_editor.helper_suppress_full_card', 'Hides the full-screen voice satellite overlay when this mini card is active.'),
  custom_css: t(null, 'mini_editor.helper_custom_css', 'Advanced: CSS overrides applied inside the mini card shadow DOM'),
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
