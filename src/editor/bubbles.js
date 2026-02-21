/**
 * Voice Satellite Card — Editor: Transcription & Response Bubbles
 */

export const bubblesSchema = [
  // Bubble Style
  {
    type: 'expandable', name: '', title: 'Bubble Style', flatten: true,
    schema: [
      { name: 'bubble_style', selector: { select: { options: [
        { value: 'centered', label: 'Centered' },
        { value: 'chat', label: 'Chat style' },
      ], mode: 'dropdown' } } },
      { name: 'bubble_container_width', selector: { number: { min: 40, max: 100, step: 5, unit_of_measurement: '%', mode: 'slider' } } },
    ],
  },

  // Transcription Bubble
  {
    type: 'expandable', name: '', title: 'Transcription Bubble', flatten: true,
    schema: [
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'transcription_font_size', selector: { number: { min: 10, max: 48, step: 1, unit_of_measurement: 'px', mode: 'slider' } } },
          { name: 'transcription_font_family', selector: { text: {} } },
        ],
      },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'transcription_font_color', selector: { text: {} } },
          { name: 'transcription_background', selector: { text: {} } },
        ],
      },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'transcription_font_bold', selector: { boolean: {} } },
          { name: 'transcription_font_italic', selector: { boolean: {} } },
          { name: 'transcription_rounded', selector: { boolean: {} } },
        ],
      },
      { name: 'transcription_border_color', selector: { text: {} } },
      { name: 'transcription_padding', selector: { number: { min: 0, max: 32, step: 1, unit_of_measurement: 'px', mode: 'slider' } } },
    ],
  },

  // Response Bubble
  {
    type: 'expandable', name: '', title: 'Response Bubble', flatten: true,
    schema: [
      { name: 'show_response', selector: { boolean: {} } },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'response_font_size', selector: { number: { min: 10, max: 48, step: 1, unit_of_measurement: 'px', mode: 'slider' } } },
          { name: 'response_font_family', selector: { text: {} } },
        ],
      },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'response_font_color', selector: { text: {} } },
          { name: 'response_background', selector: { text: {} } },
        ],
      },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'response_font_bold', selector: { boolean: {} } },
          { name: 'response_font_italic', selector: { boolean: {} } },
          { name: 'response_rounded', selector: { boolean: {} } },
        ],
      },
      { name: 'response_border_color', selector: { text: {} } },
      { name: 'response_padding', selector: { number: { min: 0, max: 32, step: 1, unit_of_measurement: 'px', mode: 'slider' } } },
    ],
  },
];

export const bubblesLabels = {
  bubble_style: 'Bubble layout',
  bubble_container_width: 'Container width',
  transcription_font_size: 'Font size',
  transcription_font_family: 'Font family',
  transcription_font_color: 'Font color',
  transcription_background: 'Background color',
  transcription_font_bold: 'Bold',
  transcription_font_italic: 'Italic',
  transcription_rounded: 'Rounded corners',
  transcription_border_color: 'Border color',
  transcription_padding: 'Padding',
  show_response: 'Show response',
  response_font_size: 'Font size',
  response_font_family: 'Font family',
  response_font_color: 'Font color',
  response_background: 'Background color',
  response_font_bold: 'Bold',
  response_font_italic: 'Italic',
  response_rounded: 'Rounded corners',
  response_border_color: 'Border color',
  response_padding: 'Padding',
};

export const bubblesHelpers = {
  bubble_style: 'Centered: bubbles centered on screen. Chat: user right, assistant left',
  bubble_container_width: 'Width of the bubble area (useful for large screens)',
  transcription_font_family: 'CSS font-family value (e.g., inherit, Arial, monospace)',
  transcription_border_color: 'CSS color value (supports rgba)',
  response_font_family: 'CSS font-family value (e.g., inherit, Arial, monospace)',
  response_border_color: 'CSS color value (supports rgba)',
};