/**
 * Voice Satellite Card — Editor
 *
 * Schema-based configuration using Home Assistant's built-in form editor.
 * Uses native HA selectors for entity pickers, toggles, sliders, etc.
 *
 * The schema is returned via getConfigForm() on the card class,
 * so no custom editor element is needed.
 */

export function getConfigForm() {
  return {
    schema: [
      // --- Behavior (always visible) ---
      {
        name: 'pipeline_id',
        selector: { assist_pipeline: {} },
      },
      {
        name: 'start_listening_on_load',
        selector: { boolean: {} },
      },
      {
        name: 'wake_word_switch',
        selector: {
          entity: {
            filter: [
              { domain: 'switch' },
              { domain: 'input_boolean' },
            ],
          },
        },
      },
      {
        name: 'state_entity',
        selector: {
          entity: {
            filter: { domain: 'input_text' },
          },
        },
      },
      {
        name: 'satellite_entity',
        selector: {
          entity: {
            filter: { domain: 'assist_satellite' },
          },
        },
      },
      {
        name: 'continue_conversation',
        selector: { boolean: {} },
      },
      {
        name: 'double_tap_cancel',
        selector: { boolean: {} },
      },
      {
        name: 'debug',
        selector: { boolean: {} },
      },

      // --- Volume & Chimes ---
      {
        type: 'expandable',
        name: '',
        title: 'Volume & Chimes',
        flatten: true,
        schema: [
          {
            name: 'tts_target',
            selector: {
              entity: {
                filter: { domain: 'media_player' },
              },
            },
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'chime_volume',
                selector: {
                  number: { min: 0, max: 100, step: 1, unit_of_measurement: '%', mode: 'slider' },
                },
              },
              {
                name: 'tts_volume',
                selector: {
                  number: { min: 0, max: 100, step: 1, unit_of_measurement: '%', mode: 'slider' },
                },
              },
            ],
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'chime_on_wake_word',
                selector: { boolean: {} },
              },
              {
                name: 'chime_on_request_sent',
                selector: { boolean: {} },
              },
            ],
          },
        ],
      },

      // --- Microphone Processing ---
      {
        type: 'expandable',
        name: '',
        title: 'Microphone Processing',
        flatten: true,
        schema: [
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'noise_suppression',
                selector: { boolean: {} },
              },
              {
                name: 'echo_cancellation',
                selector: { boolean: {} },
              },
              {
                name: 'auto_gain_control',
                selector: { boolean: {} },
              },
              {
                name: 'voice_isolation',
                selector: { boolean: {} },
              },
            ],
          },
        ],
      },

      // --- Timeouts ---
      {
        type: 'expandable',
        name: '',
        title: 'Timeouts',
        flatten: true,
        schema: [
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'pipeline_timeout',
                selector: {
                  number: { min: 0, max: 300, step: 1, unit_of_measurement: 's', mode: 'box' },
                },
              },
              {
                name: 'pipeline_idle_timeout',
                selector: {
                  number: { min: 0, max: 3600, step: 1, unit_of_measurement: 's', mode: 'box' },
                },
              },
            ],
          },
        ],
      },

      // --- Timer Pill ---
      {
        type: 'expandable',
        name: '',
        title: 'Timer Pill',
        flatten: true,
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
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'timer_font_size',
                selector: {
                  number: { min: 10, max: 48, step: 1, unit_of_measurement: 'px', mode: 'slider' },
                },
              },
              {
                name: 'timer_font_family',
                selector: { text: {} },
              },
            ],
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'timer_font_color',
                selector: { text: {} },
              },
              {
                name: 'timer_background',
                selector: { text: {} },
              },
            ],
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'timer_font_bold',
                selector: { boolean: {} },
              },
              {
                name: 'timer_font_italic',
                selector: { boolean: {} },
              },
              {
                name: 'timer_rounded',
                selector: { boolean: {} },
              },
            ],
          },
          {
            name: 'timer_border_color',
            selector: { text: {} },
          },
          {
            name: 'timer_padding',
            selector: {
              number: { min: 0, max: 32, step: 1, unit_of_measurement: 'px', mode: 'slider' },
            },
          },
          {
            name: 'timer_finished_duration',
            selector: {
              number: { min: 0, max: 300, step: 1, unit_of_measurement: 's', mode: 'box' },
            },
          },
        ],
      },

      // --- Announcements ---
      {
        type: 'expandable',
        name: '',
        title: 'Announcements',
        flatten: true,
        schema: [
          {
            name: 'announcement_display_duration',
            selector: {
              number: { min: 1, max: 60, step: 1, unit_of_measurement: 's', mode: 'slider' },
            },
          },
        ],
      },

      // --- Rainbow Bar ---
      {
        type: 'expandable',
        name: '',
        title: 'Activity Bar',
        flatten: true,
        schema: [
          {
            type: 'grid',
            name: '',
            flatten: true,
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
              {
                name: 'bar_height',
                selector: {
                  number: { min: 2, max: 40, step: 1, unit_of_measurement: 'px', mode: 'slider' },
                },
              },
            ],
          },
          {
            name: 'bar_gradient',
            selector: { text: {} },
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'background_blur',
                selector: { boolean: {} },
              },
              {
                name: 'background_blur_intensity',
                selector: {
                  number: { min: 0, max: 20, step: 1, mode: 'slider' },
                },
              },
            ],
          },
        ],
      },

      // --- Transcription Bubble ---
      {
        type: 'expandable',
        name: '',
        title: 'Transcription Bubble',
        flatten: true,
        schema: [
          {
            name: 'show_transcription',
            selector: { boolean: {} },
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'transcription_font_size',
                selector: {
                  number: { min: 10, max: 48, step: 1, unit_of_measurement: 'px', mode: 'slider' },
                },
              },
              {
                name: 'transcription_font_family',
                selector: { text: {} },
              },
            ],
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'transcription_font_color',
                selector: { text: {} },
              },
              {
                name: 'transcription_background',
                selector: { text: {} },
              },
            ],
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'transcription_font_bold',
                selector: { boolean: {} },
              },
              {
                name: 'transcription_font_italic',
                selector: { boolean: {} },
              },
              {
                name: 'transcription_rounded',
                selector: { boolean: {} },
              },
            ],
          },
          {
            name: 'transcription_border_color',
            selector: { text: {} },
          },
          {
            name: 'transcription_padding',
            selector: {
              number: { min: 0, max: 32, step: 1, unit_of_measurement: 'px', mode: 'slider' },
            },
          },
        ],
      },

      // --- Response Bubble ---
      {
        type: 'expandable',
        name: '',
        title: 'Response Bubble',
        flatten: true,
        schema: [
          {
            name: 'show_response',
            selector: { boolean: {} },
          },
          {
            name: 'streaming_response',
            selector: { boolean: {} },
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'response_font_size',
                selector: {
                  number: { min: 10, max: 48, step: 1, unit_of_measurement: 'px', mode: 'slider' },
                },
              },
              {
                name: 'response_font_family',
                selector: { text: {} },
              },
            ],
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'response_font_color',
                selector: { text: {} },
              },
              {
                name: 'response_background',
                selector: { text: {} },
              },
            ],
          },
          {
            type: 'grid',
            name: '',
            flatten: true,
            schema: [
              {
                name: 'response_font_bold',
                selector: { boolean: {} },
              },
              {
                name: 'response_font_italic',
                selector: { boolean: {} },
              },
              {
                name: 'response_rounded',
                selector: { boolean: {} },
              },
            ],
          },
          {
            name: 'response_border_color',
            selector: { text: {} },
          },
          {
            name: 'response_padding',
            selector: {
              number: { min: 0, max: 32, step: 1, unit_of_measurement: 'px', mode: 'slider' },
            },
          },
        ],
      },
    ],

    computeLabel: function (schema) {
      var labels = {
        pipeline_id: 'Assist Pipeline',
        start_listening_on_load: 'Start listening on load',
        wake_word_switch: 'Wake word switch entity',
        state_entity: 'State tracking entity',
        satellite_entity: 'Satellite entity',
        timer_font_size: 'Font size',
        timer_position: 'Timer position',
        timer_font_family: 'Font family',
        timer_font_color: 'Font color',
        timer_background: 'Background color',
        timer_font_bold: 'Bold',
        timer_font_italic: 'Italic',
        timer_rounded: 'Rounded corners',
        timer_border_color: 'Border color',
        timer_padding: 'Padding',
        timer_finished_duration: 'Auto-dismiss timer',
        announcement_display_duration: 'Announcement display duration',
        continue_conversation: 'Continue conversation mode',
        double_tap_cancel: 'Double-tap to cancel interaction',
        debug: 'Debug logging',
        tts_target: 'TTS output device',
        chime_volume: 'Chime volume',
        tts_volume: 'TTS volume',
        chime_on_wake_word: 'Chime on wake word',
        chime_on_request_sent: 'Chime on request sent',
        noise_suppression: 'Noise suppression',
        echo_cancellation: 'Echo cancellation',
        auto_gain_control: 'Auto gain control',
        voice_isolation: 'Voice isolation (Chrome only)',
        pipeline_timeout: 'Pipeline timeout',
        pipeline_idle_timeout: 'Idle restart timeout',
        bar_position: 'Bar position',
        bar_height: 'Bar height',
        bar_gradient: 'Gradient colors',
        background_blur: 'Background blur',
        background_blur_intensity: 'Blur intensity',
        show_transcription: 'Show transcription',
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
        streaming_response: 'Streaming response',
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
      return labels[schema.name] || undefined;
    },

    computeHelper: function (schema) {
      var helpers = {
        wake_word_switch: 'Turn OFF this switch when wake word is detected (e.g., Fully Kiosk screensaver)',
        state_entity: 'Updates with ACTIVE/IDLE for per-device automations',
        satellite_entity: 'Voice Satellite Card Integration entity for timer support',
        timer_font_family: 'CSS font-family value (e.g., inherit, Arial, monospace)',
        timer_border_color: 'CSS color value (supports rgba)',
        timer_finished_duration: 'Seconds to show finished timer alert (0 = until dismissed)',
        announcement_display_duration: 'Seconds to show announcement bubble after playback',
        tts_target: 'Leave empty for browser audio, or select a media player entity',
        pipeline_timeout: 'Max seconds to wait for pipeline response (0 = no timeout)',
        pipeline_idle_timeout: 'Seconds before pipeline restarts to keep connection fresh',
        bar_gradient: 'Comma-separated CSS color values',
        voice_isolation: 'AI-based voice isolation, currently only available in Chrome',
        transcription_font_family: 'CSS font-family value (e.g., inherit, Arial, monospace)',
        transcription_border_color: 'CSS color value (supports rgba)',
        response_font_family: 'CSS font-family value (e.g., inherit, Arial, monospace)',
        response_border_color: 'CSS color value (supports rgba)',
      };
      return helpers[schema.name] || undefined;
    },
  };
}