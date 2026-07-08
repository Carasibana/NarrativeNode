/**
 * dialogStore — Phase 1.13 reusable confirm / alert dialog system.
 *
 * Single-slot Zustand store holding whichever confirm dialog is
 * currently open (null when none). Call sites use the promise-based
 * helper `confirm({...})` to open a dialog and await the user's
 * choice; the returned promise resolves to the `value` of whichever
 * button they click, or `cancelValue` (default `'cancel'`) if they
 * dismiss via Escape / backdrop click / close button.
 *
 * Pattern modelled on the existing `DeleteEntityDialog` (portal-
 * mounted overlay with an entity-style accent strip, escape-to-close,
 * click-outside-to-close) but generalised so any call site can
 * present a dialog without duplicating the DOM / styling.
 *
 * Usage — in store actions (outside React):
 *
 *     import { confirm } from '../store/dialogStore'
 *
 *     async function newProject() {
 *       if (get().hasUnsavedChanges) {
 *         const result = await confirm({
 *           title: 'Unsaved changes',
 *           message: 'You have unsaved changes. What would you like to do?',
 *           buttons: [
 *             { label: 'Save', value: 'save', style: 'primary' },
 *             { label: 'Continue without saving', value: 'discard', style: 'danger' },
 *             { label: 'Cancel', value: 'cancel', style: 'neutral' },
 *           ],
 *         })
 *         if (result === 'save')    { ... }
 *         if (result === 'discard') { ... }
 *         if (result === 'cancel')  return
 *       }
 *       ...
 *     }
 *
 * Usage — in React components:
 *
 *     import { useConfirm } from '../store/dialogStore'
 *     const confirm = useConfirm()
 *     const result = await confirm({ title: ..., message: ..., buttons: [...] })
 *
 * Config shape:
 *
 *   {
 *     title:    string,                  // bold heading at the top
 *     message:  string | ReactNode,      // body text / JSX (newlines preserved)
 *     buttons:  Array<{                  // rendered left-to-right in the
 *       label:  string,                  // footer; first button is auto-
 *       value:  any,                     // focused so Enter triggers it.
 *       style?: 'primary' | 'danger' | 'neutral',  // default: 'neutral'
 *     }>,
 *     accentColour?: string,             // optional hex for the coloured
 *                                        // strip at the top of the dialog
 *                                        // (matches DeleteEntityDialog's
 *                                        // entity-colour strip). Defaults
 *                                        // to the accent colour.
 *     cancelValue?: any,                 // value the promise resolves to
 *                                        // on Escape / backdrop / ✕ close.
 *                                        // Defaults to `'cancel'`.
 *   }
 */

import { create } from 'zustand'

export const useDialogStore = create((set, get) => ({
  // The currently-open dialog config, or null when no dialog is shown.
  // Shape is whatever was passed to `confirm()` plus a private `_resolve`
  // field used by the dialog component to resolve the call site's
  // awaited promise when a button is clicked.
  confirmDialog: null,

  /**
   * Present a confirm dialog. Returns a promise that resolves to the
   * `value` of whichever button the user clicks, or the config's
   * `cancelValue` (default `'cancel'`) if the user dismisses without
   * clicking a button.
   */
  confirm: (config) => {
    return new Promise((resolve) => {
      set({
        confirmDialog: {
          title:        config?.title || 'Confirm',
          message:      config?.message ?? '',
          buttons:      Array.isArray(config?.buttons) && config.buttons.length > 0
            ? config.buttons
            : [{ label: 'OK', value: 'ok', style: 'primary' }],
          accentColour: config?.accentColour || null,
          cancelValue:  config?.cancelValue ?? 'cancel',
          _resolve:     resolve,
        },
      })
    })
  },

  /**
   * Close the currently-open dialog, resolving its promise with the
   * given value. If no dialog is open, this is a no-op. The dialog
   * component calls this with a button's value on click; it's also
   * called with `cancelValue` when the user presses Escape, clicks
   * the backdrop, or clicks the close button.
   */
  resolveDialog: (value) => {
    const d = get().confirmDialog
    if (!d) return
    d._resolve(value)
    set({ confirmDialog: null })
  },
}))

/**
 * Plain-function helper for store actions and other non-component call
 * sites. Equivalent to `useDialogStore.getState().confirm(config)`
 * but shorter at the call site.
 */
export const confirm = (config) => useDialogStore.getState().confirm(config)

/**
 * Hook variant returning a stable reference to the `confirm` method
 * for use inside React components. The returned function is the same
 * `confirm` action from the store — no new identity on each render.
 */
export const useConfirm = () => useDialogStore((s) => s.confirm)
