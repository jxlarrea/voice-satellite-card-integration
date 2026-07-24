/**
 * Editor: Screensaver
 *
 * The schema is type-driven: fields specific to Media (URI, interval,
 * shuffle) only appear when type='media', and the Camera entity only
 * appears when type='camera'.  Call buildScreensaverSchema(config) to
 * get the appropriate schema for the current config.
 */

import { t } from '../i18n/index.js';

const TYPE_OPTIONS = [
  { value: 'black', label: 'Black overlay' },
  { value: 'media', label: 'Media (file, folder, or camera)' },
  { value: 'website', label: 'Website' },
  { value: 'clock', label: 'Digital clock' },
];

const SMALL_CLOCK_POSITION_OPTIONS = [
  { value: 'top_right', label: 'Top right' },
  { value: 'top_left', label: 'Top left' },
  { value: 'bottom_right', label: 'Bottom right' },
  { value: 'bottom_left', label: 'Bottom left' },
];

/**
 * The Screensaver sub-form is split into three parts so custom widgets
 * can render between them:
 *
 *   [pre-form]   enable, (timer, pixel shift, small clock fields when
 *                enabled — the small clock color renders as a custom
 *                swatch row right below this form)
 *   [type-form]  Type dropdown (when enabled)
 *   [Browse]     visible only when enabled && type='media'
 *   [post-form]  (type-specific fields when enabled) OR suppress_external
 *                when disabled — never both, since suppress_external is
 *                for users relying on an external screensaver instead of
 *                our built-in one.
 */

export function buildScreensaverPreSchema(cfg) {
  const enabled = cfg?.screensaver_enabled === true;
  const type = cfg?.screensaver_type || 'black';
  const fields = [
    { name: 'screensaver_enabled', selector: { boolean: {} } },
  ];
  if (enabled) {
    fields.push(
      {
        name: 'screensaver_timer_s',
        default: 60,
        selector: { number: { min: 10, max: 600, step: 5, mode: 'slider', unit_of_measurement: 's' } },
      },
      { name: 'screensaver_pixel_shift', default: false, selector: { boolean: {} } },
    );
    // Small corner clock - available on every type except the digital
    // clock, which is already a clock.
    if (type !== 'clock') {
      fields.push(
        { name: 'screensaver_small_clock', default: false, selector: { boolean: {} } },
      );
      if (cfg?.screensaver_small_clock === true) {
        fields.push(
          {
            name: 'screensaver_small_clock_position',
            default: 'top_right',
            selector: { select: { options: SMALL_CLOCK_POSITION_OPTIONS, mode: 'dropdown' } },
          },
          { name: 'screensaver_small_clock_show_date', default: false, selector: { boolean: {} } },
          // Small clock color follows the same custom-swatch-row pattern
          // as the digital clock color (see buildScreensaverPostSchema).
        );
      }
    }
  }
  return fields;
}

export function buildScreensaverTypeSchema(cfg) {
  if (cfg?.screensaver_enabled !== true) return [];
  return [
    {
      name: 'screensaver_type',
      default: 'black',
      selector: { select: { options: TYPE_OPTIONS, mode: 'dropdown' } },
    },
  ];
}

export function buildScreensaverPostSchema(cfg) {
  const enabled = cfg?.screensaver_enabled === true;
  const type = cfg?.screensaver_type || 'black';

  if (!enabled) {
    return [
      {
        name: 'screensaver_suppress_external',
        selector: { entity: { domain: ['switch', 'input_boolean'] } },
      },
    ];
  }

  const fields = [];
  if (type === 'media') {
    fields.push(
      {
        name: 'screensaver_media_interval_s',
        default: 10,
        selector: { number: { min: 2, max: 600, step: 1, mode: 'slider', unit_of_measurement: 's' } },
      },
      { name: 'screensaver_media_shuffle', selector: { boolean: {} } },
      { name: 'screensaver_media_recursive', default: false, selector: { boolean: {} } },
    );
  } else if (type === 'website') {
    fields.push(
      { name: 'screensaver_website_url', selector: { text: { type: 'url' } } },
    );
  } else if (type === 'clock') {
    fields.push(
      { name: 'screensaver_clock_24h', selector: { boolean: {} } },
      { name: 'screensaver_clock_seconds', selector: { boolean: {} } },
      { name: 'screensaver_clock_show_date', default: true, selector: { boolean: {} } },
      {
        name: 'screensaver_clock_scale',
        default: 100,
        selector: { number: { min: 50, max: 300, step: 10, mode: 'slider', unit_of_measurement: '%' } },
      },
      // Clock color is deliberately NOT part of this schema: ha-form
      // stretches the color_rgb selector to the full form width. It is
      // rendered as a custom label + square swatch row in the panel
      // instead (like the Media Browse widget).
    );
  }
  return fields;
}

/**
 * Schema for the Kiosk Browser Integration sub-form (Fully Kiosk on
 * Android, Kiosker Pro on iOS).  Rendered as its own ha-form below the
 * main screensaver fields so it can be disabled wholesale when no
 * supported kiosk browser is detected.
 */
export const screensaverFkSchema = [
  {
    name: 'screensaver_dim_percent',
    default: 100,
    selector: { number: { min: 0, max: 100, step: 5, mode: 'slider', unit_of_measurement: '%' } },
  },
  { name: 'screensaver_fk_motion_dismiss', selector: { boolean: {} } },
];

export const screensaverLabels = {
  screensaver_enabled: t(null, 'editor.screensaver.enabled', 'Enable Voice Satellite screensaver'),
  screensaver_dim_percent: t(null, 'editor.screensaver.dim_percent', 'Screen brightness while active'),
  screensaver_fk_motion_dismiss: t(null, 'editor.screensaver.fk_motion_dismiss', 'Dismiss on motion'),
  screensaver_timer_s: t(null, 'editor.screensaver.timer', 'Idle timeout'),
  screensaver_type: t(null, 'editor.screensaver.type', 'Screensaver type'),
  screensaver_pixel_shift: t(null, 'editor.screensaver.pixel_shift', 'Pixel shift (OLED protection)'),
  screensaver_media_interval_s: t(null, 'editor.screensaver.media_interval', 'Item interval'),
  screensaver_media_shuffle: t(null, 'editor.screensaver.media_shuffle', 'Shuffle folder items'),
  screensaver_media_recursive: t(null, 'editor.screensaver.media_recursive', 'Include subfolders'),
  screensaver_website_url: t(null, 'editor.screensaver.website_url', 'Website URL'),
  screensaver_clock_24h: t(null, 'editor.screensaver.clock_24h', '24-hour clock'),
  screensaver_clock_seconds: t(null, 'editor.screensaver.clock_seconds', 'Show seconds'),
  screensaver_clock_show_date: t(null, 'editor.screensaver.clock_show_date', 'Show date'),
  screensaver_clock_scale: t(null, 'editor.screensaver.clock_scale', 'Clock size'),
  screensaver_small_clock: t(null, 'editor.screensaver.small_clock', 'Small clock'),
  screensaver_small_clock_position: t(null, 'editor.screensaver.small_clock_position', 'Clock position'),
  screensaver_small_clock_show_date: t(null, 'editor.screensaver.small_clock_show_date', 'Show date'),
  screensaver_suppress_external: t(null, 'editor.screensaver.suppress_external', 'External screensaver'),
};

export const screensaverHelpers = {
  screensaver_dim_percent: t(null, 'editor.screensaver.helper_dim_percent', 'Hardware backlight level while the screensaver is showing (Fully Kiosk or Kiosker Pro). The previous brightness is restored on dismiss. 0% = fully dark, 100% = leave the backlight untouched (default).'),
  screensaver_fk_motion_dismiss: t(null, 'editor.screensaver.helper_fk_motion_dismiss', "Treat Fully Kiosk's camera-based motion detection as activity: motion dismisses the screensaver and also resets the idle timer, so it won't activate while someone is moving in front of the camera. Fully Kiosk only (Kiosker Pro has no motion API). Requires Motion Detection to be enabled in the Fully Kiosk settings."),
  screensaver_timer_s: t(null, 'editor.screensaver.helper_timer', 'Idle seconds before the screensaver activates.'),
  screensaver_type: t(null, 'editor.screensaver.helper_type', 'Black: solid overlay. Media: image/video file, folder, or camera feed from the HA media library (cameras stream over WebRTC with sub-second latency when available). Website: embed any URL (e.g. immich-kiosk, a photo frame app, a dashboard). Digital clock: large time and date on a black background.'),
  screensaver_media_interval_s: t(null, 'editor.screensaver.helper_media_interval', 'Seconds per image when cycling through a folder. Videos play to completion regardless of this value.'),
  screensaver_pixel_shift: t(null, 'editor.screensaver.helper_pixel_shift', 'Slowly drift the screensaver content a few pixels once a minute to spread wear across OLED pixels. Applies to the clock, media, and website types.'),
  screensaver_media_recursive: t(null, 'editor.screensaver.helper_media_recursive', 'Also play media from subfolders of the selected folder. Combine with shuffle for random images from the whole tree. Very large libraries are capped (12000 items, 5 levels deep) to keep activation fast.'),
  screensaver_clock_scale: t(null, 'editor.screensaver.helper_clock_scale', 'Scales the time and date relative to the default size. Browsers and kiosk apps report their viewport differently, so the same clock can look smaller on some tablets (e.g. iPads) - raise this here to match your other devices. Stored per browser.'),
  screensaver_small_clock: t(null, 'editor.screensaver.helper_small_clock', 'Show a small clock in a corner of the screensaver.'),
  screensaver_small_clock_show_date: t(null, 'editor.screensaver.helper_small_clock_show_date', 'Show the date below the time (short format).'),
  screensaver_suppress_external: t(null, 'editor.screensaver.helper_suppress_external', "The selected switch is turned off for the duration of each voice interaction, then left alone so its owner (e.g. Fully Kiosk) can resume its own idle timer. Useful to manage Fully Kiosk's screensaver."),
};
