/**
 * Voice Satellite Card — Editor: Timer Pill
 */

export const timerSchema = [
  {
    type: 'expandable', name: '', title: 'Timer Pill', flatten: true,
    schema: [
      {
        name: 'timer_position',
        selector: {
          select: {
            options: [
              { value: 'top-left', label: 'Top Left' },
              { value: 'top-right', label: 'Top Right' },
              { value: 'bottom-left', label: 'Bottom Left' },
              { value: 'bottom-right', label: 'Bottom Right' },
            ],
            mode: 'dropdown',
          },
        },
      },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'timer_font_size', selector: { number: { min: 10, max: 48, step: 1, unit_of_measurement: 'px', mode: 'slider' } } },
          { name: 'timer_font_family', selector: { text: {} } },
        ],
      },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'timer_font_color', selector: { text: {} } },
          { name: 'timer_background', selector: { text: {} } },
        ],
      },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'timer_font_bold', selector: { boolean: {} } },
          { name: 'timer_font_italic', selector: { boolean: {} } },
          { name: 'timer_rounded', selector: { boolean: {} } },
        ],
      },
      { name: 'timer_border_color', selector: { text: {} } },
      { name: 'timer_padding', selector: { number: { min: 0, max: 32, step: 1, unit_of_measurement: 'px', mode: 'slider' } } },
      { name: 'timer_finished_duration', selector: { number: { min: 0, max: 300, step: 1, unit_of_measurement: 's', mode: 'box' } } },
    ],
  },
];

export const timerLabels = {
  timer_position: 'Timer position',
  timer_font_size: 'Font size',
  timer_font_family: 'Font family',
  timer_font_color: 'Font color',
  timer_background: 'Background color',
  timer_font_bold: 'Bold',
  timer_font_italic: 'Italic',
  timer_rounded: 'Rounded corners',
  timer_border_color: 'Border color',
  timer_padding: 'Padding',
  timer_finished_duration: 'Auto-dismiss timer',
};

export const timerHelpers = {
  timer_font_family: 'CSS font-family value (e.g., inherit, Arial, monospace)',
  timer_border_color: 'CSS color value (supports rgba)',
  timer_finished_duration: 'Seconds to show finished timer alert (0 = until dismissed)',
};
