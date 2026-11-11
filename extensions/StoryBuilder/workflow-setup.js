import { extension_settings } from '/scripts/extensions.js';
import { eventSource, event_types } from '/scripts/events.js';
import { applyWorkflowDefaults } from './setup-config.js';

// Initialize missing preferences owned by these extensions. Existing values win.
// Public installs never load a local setup patch or rewrite a writing preset.
if (applyWorkflowDefaults(extension_settings)) {
    eventSource.on(event_types.APP_READY, () => SillyTavern.getContext().saveSettingsDebounced());
}
