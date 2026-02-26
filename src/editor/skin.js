/**
 * Voice Satellite Card — Editor: Skin
 */

import { getSkinOptions } from '../skins/index.js';
import { t } from '../i18n/index.js';

export const skinSchema = [
  {
    type: 'expandable', name: '', title: t(null, 'editor.skin.appearance', 'Appearance'), flatten: true,
    schema: [
      {
        name: 'skin',
        default: 'default',
        selector: {
          select: {
            options: getSkinOptions(),
            mode: 'dropdown',
          },
        },
      },
      { name: 'reactive_bar', selector: { boolean: {} } },
      { name: 'text_scale', default: 100, selector: { number: { min: 50, max: 200, step: 5, mode: 'slider', unit_of_measurement: '%' } } },
      { name: 'background_opacity', default: 100, selector: { number: { min: 0, max: 100, step: 5, mode: 'slider', unit_of_measurement: '%' } } },
      { name: 'custom_css', selector: { text: { multiline: true } } },
    ],
  },
];

export const skinLabels = {
  skin: t(null, 'editor.skin.skin', 'Skin'),
  text_scale: t(null, 'editor.skin.text_scale', 'Text Scale'),
  background_opacity: t(null, 'editor.skin.background_opacity', 'Background Opacity'),
  reactive_bar: t(null, 'editor.skin.reactive_bar', 'Reactive activity bar'),
  custom_css: t(null, 'editor.skin.custom_css', 'Custom CSS'),
};

export const skinHelpers = {
  background_opacity: t(null, 'editor.skin.helper_background_opacity', 'If not set, the skin\'s default opacity level will be used'),
  reactive_bar: t(null, 'editor.skin.helper_reactive_bar', 'Activity bar reacts to audio levels. Disable on slow devices to save resources.'),
  custom_css: t(null, 'editor.skin.helper_custom_css', 'Advanced: CSS overrides applied on top of the selected skin'),
};
