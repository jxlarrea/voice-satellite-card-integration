/**
 * Voice Satellite Card — Editor: Volume, Chimes & Announcements
 */

export const mediaSchema = [
  {
    type: 'expandable', name: '', title: 'Volume & Chimes', flatten: true,
    schema: [
      { name: 'tts_target', selector: { entity: { filter: { domain: 'media_player' } } } },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'chime_volume', selector: { number: { min: 0, max: 100, step: 1, unit_of_measurement: '%', mode: 'slider' } } },
          { name: 'tts_volume', selector: { number: { min: 0, max: 100, step: 1, unit_of_measurement: '%', mode: 'slider' } } },
        ],
      },
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'chime_on_wake_word', selector: { boolean: {} } },
          { name: 'chime_on_request_sent', selector: { boolean: {} } },
        ],
      },
    ],
  },

  // Announcements
  {
    type: 'expandable', name: '', title: 'Announcements (requires integration)', flatten: true,
    schema: [
      { name: 'announcement_display_duration', selector: { number: { min: 1, max: 60, step: 1, unit_of_measurement: 's', mode: 'slider' } } },
    ],
  },
];

export const mediaLabels = {
  tts_target: 'TTS output device',
  chime_volume: 'Chime volume',
  tts_volume: 'TTS volume',
  chime_on_wake_word: 'Chime on wake word',
  chime_on_request_sent: 'Chime on request sent',
  announcement_display_duration: 'Announcement display duration',
};

export const mediaHelpers = {
  tts_target: 'Leave empty for browser audio, or select a media player entity',
  announcement_display_duration: 'Seconds to show announcement bubble after playback',
};
