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
];

/**
 * The Screensaver sub-form is split into two halves so the Media
 * Browse widget can render between them (right below the Type
 * dropdown) instead of getting pushed to the end of the form.
 *
 *   [pre-form]  enable, (timer, type when enabled)
 *   [Browse]    visible only when enabled && type='media'
 *   [post-form] (type-specific fields when enabled) OR suppress_external
 *               when disabled — never both, since suppress_external is
 *               for users relying on an external screensaver instead of
 *               our built-in one.
 */

export function buildScreensaverPreSchema(cfg) {
  const enabled = cfg?.screensaver_enabled === true;
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
      {
        name: 'screensaver_type',
        default: 'black',
        selector: { select: { options: TYPE_OPTIONS, mode: 'dropdown' } },
      },
    );
  }
  return fields;
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
    );
  } else if (type === 'website') {
    fields.push(
      { name: 'screensaver_website_url', selector: { text: { type: 'url' } } },
    );
  }
  return fields;
}

/**
 * Schema for the Fully Kiosk Integration sub-form.  Rendered as its
 * own ha-form below the main screensaver fields so it can be
 * disabled wholesale when Fully Kiosk is not detected.
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
  screensaver_media_interval_s: t(null, 'editor.screensaver.media_interval', 'Item interval'),
  screensaver_media_shuffle: t(null, 'editor.screensaver.media_shuffle', 'Shuffle folder items'),
  screensaver_website_url: t(null, 'editor.screensaver.website_url', 'Website URL'),
  screensaver_suppress_external: t(null, 'editor.screensaver.suppress_external', 'External screensaver'),
};

export const screensaverHelpers = {
  screensaver_dim_percent: t(null, 'editor.screensaver.helper_dim_percent', 'Hardware backlight level while the screensaver is showing. The previous brightness is restored on dismiss. 0% = fully dark, 100% = leave the backlight untouched (default).'),
  screensaver_fk_motion_dismiss: t(null, 'editor.screensaver.helper_fk_motion_dismiss', "Dismiss the screensaver when Fully Kiosk's camera-based motion detection fires. Requires Motion Detection to be enabled in the Fully Kiosk settings."),
  screensaver_timer_s: t(null, 'editor.screensaver.helper_timer', 'Idle seconds before the screensaver activates.'),
  screensaver_type: t(null, 'editor.screensaver.helper_type', 'Black: solid overlay. Media: image/video file, folder, or camera feed from the HA media library. Website: embed any URL (e.g. immich-kiosk, a photo frame app, a dashboard).'),
  screensaver_media_interval_s: t(null, 'editor.screensaver.helper_media_interval', 'Seconds per image when cycling through a folder. Videos play to completion regardless of this value.'),
  screensaver_suppress_external: t(null, 'editor.screensaver.helper_suppress_external', "The selected switch is turned off for the duration of each voice interaction, then left alone so its owner (e.g. Fully Kiosk) can resume its own idle timer. Useful to manage Fully Kiosk's screensaver."),
};
