/**
 * Voice Satellite Card — Editor: Skin
 */

import { getSkinOptions } from '../skins/index.js';

export const skinSchema = [
  {
    type: 'expandable', name: '', title: 'Appearance', flatten: true,
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
  skin: 'Skin',
  text_scale: 'Text Scale',
  background_opacity: 'Background Opacity',
  reactive_bar: 'Reactive activity bar',
  custom_css: 'Custom CSS',
};

export const skinHelpers = {
  background_opacity: 'If not set, the skin\'s default opacity level will be used',
  reactive_bar: 'Activity bar reacts to audio levels. Disable on slow devices to save resources.',
  custom_css: 'Advanced: CSS overrides applied on top of the selected skin',
};
