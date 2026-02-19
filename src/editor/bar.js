/**
 * Voice Satellite Card — Editor: Activity Bar
 */

export const barSchema = [
  {
    type: 'expandable', name: '', title: 'Activity Bar', flatten: true,
    schema: [
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          {
            name: 'bar_position',
            selector: {
              select: {
                options: [
                  { value: 'bottom', label: 'Bottom' },
                  { value: 'top', label: 'Top' },
                ],
                mode: 'dropdown',
              },
            },
          },
          { name: 'bar_height', selector: { number: { min: 2, max: 40, step: 1, unit_of_measurement: 'px', mode: 'slider' } } },
        ],
      },
      { name: 'bar_gradient', selector: { text: {} } },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'background_blur', selector: { boolean: {} } },
          { name: 'background_blur_intensity', selector: { number: { min: 0, max: 20, step: 1, mode: 'slider' } } },
        ],
      },
    ],
  },
];

export const barLabels = {
  bar_position: 'Bar position',
  bar_height: 'Bar height',
  bar_gradient: 'Gradient colors',
  background_blur: 'Background blur',
  background_blur_intensity: 'Blur intensity',
};

export const barHelpers = {
  bar_gradient: 'Comma-separated CSS color values',
};
